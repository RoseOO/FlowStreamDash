import * as db from './db.js';
import { ecoflowLogin } from './auth.js';
import { getDevMqttCert, fetchAllQuota } from './dev-api.js';
import { runHourlyRollup } from './aggregator.js';
import { getStats } from './stats-engine.js';
import { round2, round3 } from './utils.js';
import { DEFAULT_LAT, DEFAULT_LON, API_RATE_LIMIT_MS } from './config.js';
import { publishHaStats, publishHaPrediction } from './ha-mqtt.js';

const timers = [];

function _setInterval(fn, ms) {
  const id = setInterval(fn, ms);
  timers.push(id);
  return id;
}

function _setTimeout(fn, ms) {
  const id = setTimeout(fn, ms);
  timers.push(id);
  return id;
}

function createRestartMqtt(mqttClient) {
  return function restartMqtt() {
    const config = db.getMqttConfig();
    const devices = db.getDevices();
    if (!config || devices.length === 0) {
      mqttClient.disconnect();
      return;
    }
    mqttClient.disconnect();
    mqttClient.connect(config, devices);
  };
}

function createAutoRefreshCredentials(mqttClient, restartMqtt) {
  let mqttFailCount = 0;
  let mqttLastFailTime = 0;

  async function autoRefreshCredentials() {
    const email = db.getSetting('ecoflow_email');
    const password = db.getSetting('ecoflow_password');
    if (!email || !password) return false;
    try {
      console.log('[MQTT] Auto-refreshing credentials...');
      const creds = await ecoflowLogin(email, password);
      db.saveMqttConfig({
        host: creds.mqttHost, port: creds.mqttPort,
        username: creds.mqttUsername, password: creds.mqttPassword,
        user_id: creds.userId, email: creds.email,
        updated_at: Math.floor(Date.now()/1000),
      });
      console.log('[MQTT] Credentials refreshed, reconnecting...');
      mqttFailCount = 0;
      restartMqtt();
      return true;
    } catch (e) {
      console.error('[MQTT] Credential refresh failed:', e.message);
      return false;
    }
  }

  return { autoRefreshCredentials, getFailCount: () => mqttFailCount, setFailCount: (n) => { mqttFailCount = n; }, getFailTime: () => mqttLastFailTime, setFailTime: (t) => { mqttLastFailTime = t; } };
}

export function startAll(deps) {
  const { mqttClient, wss, gridMeter, dataLogger } = deps;

  const restartMqtt = createRestartMqtt(mqttClient);
  const { autoRefreshCredentials, getFailCount, setFailCount, getFailTime, setFailTime } = createAutoRefreshCredentials(mqttClient, restartMqtt);

  // 1. Quota poller (every 60s)
  async function pollQuotaData() {
    const devices = db.getDevices();
    for (const d of devices) {
      try {
        const data = await fetchAllQuota(d.sn);
        if (!data || Object.keys(data).length === 0) continue;
        const wsMsg = JSON.stringify({ type: 'devapi', sn: d.sn, fields: data, ts: Math.floor(Date.now()/1000) });
        for (const client of wss.clients) {
          if (client.readyState === 1) client.send(wsMsg);
        }
      } catch {}
    }
  }
  _setTimeout(() => {
    if (db.getSetting('dev_api_access_key')) {
      console.log('[DevAPI] Starting quota/all poller (60s)');
      _setInterval(pollQuotaData, 60000);
      pollQuotaData();
    }
  }, 20000);

  // 2. Hourly DB rollup (every 15 min)
  function hourlyRollup() {
    const devices = db.getDevices();
    for (const d of devices) {
      try { runHourlyRollup(d.sn); } catch (e) { /* skip */ }
    }
  }
  _setInterval(hourlyRollup, 15 * 60 * 1000);

  // 3. Model auto-train (every 6 hours)
  async function autoTrain() {
    const devices = db.getDevices();
    if (devices.length === 0) return;
    const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
    const lon = db.getSetting('weather_lon') || DEFAULT_LON;
    for (const d of devices) {
      try {
        const model = db.getModelStats(d.sn);
        const hourAgo = Math.floor(Date.now()/1000) - 3600;
        if (!model || model.samples < 50) {
          console.log(`[Model] Training ${d.sn}...`);
          let trained = 0;
          const days = db.default.prepare(
            `SELECT DISTINCT CAST(ts/86400 AS INTEGER) as day FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 ORDER BY day DESC LIMIT 14`
          ).all(d.sn);

          for (const { day } of days) {
            const dayStart = day * 86400;
            const existing = db.default.prepare(
              'SELECT COUNT(*) as c FROM radiation_data WHERE device_sn=? AND hour_ts >= ? AND hour_ts < ?'
            ).get(d.sn, dayStart, dayStart + 86400);
            if (existing?.c > 0) continue;

            const date = new Date(dayStart * 1000).toISOString().slice(0,10);
            const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
            try {
              const resp = await fetch(url);
              const data = await resp.json();
              if (!data.hourly) continue;
              const radByHour = {};
              data.hourly.time.forEach((t, i) => {
                radByHour[new Date(t).getHours()] = data.hourly.shortwave_radiation[i] || 0;
              });
              for (let h = 0; h < 24; h++) {
                const hourTs = dayStart + h * 3600;
                const rows = db.getHistoricalData(d.sn, hourTs, hourTs + 3599, [361, 70]);
                const prodSum = rows.reduce((s, r) => s + (r.value_num||0), 0);
                const prodCount = rows.filter(r => r.value_num > 0).length;
                if (prodCount < 10) continue;
                const rad = radByHour[h] || 0;
                if (rad < 10) continue;
                const factor = Math.round(prodSum / prodCount / rad * 10000) / 10000;
                db.upsertRadiationPair(d.sn, hourTs, rad, Math.round(prodSum / prodCount * 100) / 100, factor);
                trained++;
              }
              await new Promise(r => setTimeout(r, API_RATE_LIMIT_MS));
            } catch { continue; }
          }
          if (trained > 0) console.log(`[Model] Trained ${d.sn}: ${trained} new pairs`);
        }
      } catch (e) { /* skip */ }
    }
  }
  _setTimeout(() => autoTrain().catch(()=>{}), 30000);
  _setInterval(() => autoTrain().catch(()=>{}), 6 * 3600 * 1000);

  // 4. Daily accuracy tracking (every 2 hours)
  async function trackDailyAccuracy() {
    const devices = db.getDevices();
    const now = Math.floor(Date.now()/1000);
    const yesterdayStart = Math.floor(now/86400)*86400 - 86400;
    const yesterdayEnd = yesterdayStart + 86400;
    for (const d of devices) {
      try {
        const pvRows = db.getHistoricalData(d.sn, yesterdayStart, yesterdayEnd, [361, 70]);
        let actualKwh = 0, lastTs = null;
        for (const r of pvRows) {
          if (r.value_num == null) continue;
          if (lastTs !== null) {
            const intervalH = (r.ts - lastTs) / 3600;
            if (intervalH > 0 && intervalH < 1) actualKwh += (r.value_num * intervalH) / 1000;
          }
          lastTs = r.ts;
        }
        if (actualKwh < 0.001) continue;
        const model = db.getModelStats(d.sn);
        if (!model) continue;
        const factor = model.avg_factor;
        const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
        const lon = db.getSetting('weather_lon') || DEFAULT_LON;
        const date = new Date(yesterdayStart*1000).toISOString().slice(0,10);
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
        const resp = await fetch(url); const data = await resp.json();
        if (!data.hourly) continue;
        let predictedKwh = 0;
        for (let h = 0; h < 24; h++) predictedKwh += (data.hourly.shortwave_radiation?.[h]||0) * factor / 1000;
        db.upsertAccuracy(d.sn, yesterdayStart, round2(predictedKwh), round2(actualKwh));
      } catch (e) { /* skip */ }
    }
  }
  _setInterval(() => trackDailyAccuracy().catch(()=>{}), 2 * 3600 * 1000);
  _setTimeout(() => trackDailyAccuracy().catch(()=>{}), 60000);

  // 5. HA stats publish (every 5 min)
  async function publishPeriodicHaStats() {
    try {
      const devices = db.getDevices();
      if (devices.length === 0) return;
      const now = Math.floor(Date.now() / 1000);
      const todayStart = Math.floor(now / 86400) * 86400;
      const yesterdayStart = todayStart - 86400;
      for (const d of devices) {
        const stats = getStats(d.sn, todayStart, now);
        if (!stats || stats.totalKwh <= 0) continue;
        const pv1W = parseInt(db.getDeviceConfig(d.sn, 'pv1_rated_watts') || '0');
        const pv2W = parseInt(db.getDeviceConfig(d.sn, 'pv2_rated_watts') || '0');
        const totalRated = pv1W + pv2W;
        const eff1 = stats.efficiency?.pv1?.pct || 0;
        const eff2 = stats.efficiency?.pv2?.pct || 0;
        const pvEff = totalRated > 0 ? (eff1 * pv1W + eff2 * pv2W) / totalRated : null;
        const model = db.getModelStats(d.sn);
        const rate = parseFloat(db.getSetting('electricity_rate') || '0');
        const yesterday = getStats(d.sn, yesterdayStart, todayStart);
        const co2Kg = stats.totalKwh * 0.233;
        publishHaStats(d.sn, {
          totalKwh: stats.totalKwh,
          bestDay: stats.bestDay,
          pvEfficiency: pvEff,
          totalSaving: round2(stats.totalKwh * rate),
          co2SavingKgToday: round3(co2Kg),
          yesterday: { totalKwh: yesterday?.totalKwh || 0 },
          modelFactor: model?.avg_factor,
          modelSamples: model?.samples,
          modelR2: model?.r_squared,
        });
      }
    } catch (e) { /* skip */ }
  }
  _setInterval(() => publishPeriodicHaStats().catch(()=>{}), 5 * 60 * 1000);
  _setTimeout(() => publishPeriodicHaStats().catch(()=>{}), 30000);

  // 6. HA prediction publish (every 15 min)
  async function publishPeriodicHaPrediction() {
    try {
      const devices = db.getDevices();
      if (devices.length === 0) return;
      const now = Math.floor(Date.now() / 1000);
      const todayStart = Math.floor(now / 86400) * 86400;
      const currentHour = new Date().getHours();
      const model = db.getModelStats(devices[0].sn);
      const factor = model?.avg_factor || 0.42;
      const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
      const lon = db.getSetting('weather_lon') || DEFAULT_LON;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=shortwave_radiation&timezone=auto&forecast_days=1`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data.hourly) return;
      let predictedRemainingKwh = 0;
      const hourlyPred = {};
      for (let h = currentHour + 1; h <= 23; h++) {
        const rad = data.hourly.shortwave_radiation?.[h] || 0;
        const predW = rad * factor;
        hourlyPred[h] = round2(predW);
        predictedRemainingKwh += predW / 1000;
      }
      const stats = getStats(devices[0].sn, todayStart, now);
      const yesterdayStart = todayStart - 86400;
      const yesterdayEnd = todayStart;
      let yesterdayErrorPct = null;
      try {
        const accStats = db.getAccuracyStats(devices[0].sn, 1);
        if (accStats && accStats.avg_abs_error != null) {
          yesterdayErrorPct = accStats.avg_abs_error;
        }
      } catch {}
      publishHaPrediction(devices[0].sn, {
        predictedTotalKwh: round2((stats.totalKwh || 0) + predictedRemainingKwh),
        predictedRemainingKwh: round2(predictedRemainingKwh),
        alreadyProducedKwh: stats.totalKwh || 0,
        modelFactor: round2(factor),
        modelSamples: model?.samples || 0,
        usingLearnedModel: (model?.samples || 0) > 10,
        predictedWattsByHour: hourlyPred,
        currentHour,
        yesterdayErrorPct,
      });
    } catch (e) { /* skip */ }
  }
  _setInterval(() => publishPeriodicHaPrediction().catch(()=>{}), 15 * 60 * 1000);
  _setTimeout(() => publishPeriodicHaPrediction().catch(()=>{}), 60000);

  // 7. MQTT watchdog (every 5s)
  _setInterval(async () => {
    if (mqttClient.connected && mqttClient.lastDataTime) {
      const idle = (Date.now() / 1000) - mqttClient.lastDataTime;
      if (idle > 45) {
        const hour = new Date().getHours();
        const isDaytime = hour >= 6 && hour <= 21;
        if (isDaytime) console.log(`[MQTT] No data for ${Math.round(idle)}s — reconnecting`);
        setFailCount(getFailCount() + 1);
        setFailTime(Date.now());
        if (getFailCount() >= 3 && idle > 60 && isDaytime) {
          const refreshed = await autoRefreshCredentials();
          if (!refreshed) restartMqtt();
        } else {
          restartMqtt();
        }
      }
    } else if (!mqttClient.connected) {
      if (!getFailTime()) setFailTime(Date.now());
      const disconnectedSec = (Date.now() - getFailTime()) / 1000;
      // Try reconnect quickly on startup, then wait longer
      const retryDelay = getFailCount() < 3 ? 15 : 90;
      if (disconnectedSec > retryDelay) {
        setFailCount(Math.min(getFailCount() + 1, 10));
        if (getFailCount() >= 3) {
          await autoRefreshCredentials();
        }
        restartMqtt();
      }
    } else {
      if (getFailCount() > 0 && mqttClient.lastDataTime && (Date.now()/1000 - mqttClient.lastDataTime) < 10) {
        setFailCount(0);
        setFailTime(0);
      }
    }
  }, 5000);

  // 8. Idle detection (every 5s)
  if (dataLogger && dataLogger.checkIdle) {
    _setInterval(() => dataLogger.checkIdle(), 5000);
  }

  // 9. Grid meter auto-start (5s delay)
  _setTimeout(() => {
    try {
      if (db.getSetting('grid_meter_enabled') === 'true') {
        const ip = db.getSetting('grid_meter_ip');
        if (ip) {
          console.log(`[GridMeter] Auto-starting with IP ${ip}`);
          gridMeter.configure({
            enabled: true, ip,
            interval: parseInt(db.getSetting('grid_meter_interval') || '2'),
          });
        }
      }
    } catch(e) { console.error('[GridMeter] Auto-start error:', e); }
  }, 5000);

  // 10. HA MQTT auto-start (immediate)
  (async () => {
    const enabled = db.getSetting('ha_mqtt_enabled') === 'true';
    if (enabled) {
      const host = db.getSetting('ha_mqtt_host');
      if (host) {
        const { startHaMqtt } = await import('./ha-mqtt.js');
        await startHaMqtt({
          host,
          port: parseInt(db.getSetting('ha_mqtt_port') || '1883'),
          username: db.getSetting('ha_mqtt_username') || '',
          password: db.getSetting('ha_mqtt_password') || '',
          discovery_prefix: db.getSetting('ha_mqtt_prefix') || 'homeassistant',
        });
      }
    }
  })();

  // 11. DevMqtt auto-start (15s delay)
  let devMqttClient = null;
  async function startDevMqtt() {
    const cert = await getDevMqttCert();
    if (!cert) return console.log('[DevMQTT] No cert available — skipping');
    if (devMqttClient) { try { devMqttClient.end(true); } catch {} }
    const devices = db.getDevices();
    if (devices.length === 0) return;

    const { default: mqttModule } = await import('mqtt');
    devMqttClient = mqttModule.connect({
      host: cert.host, port: cert.port,
      protocol: cert.protocol === 'mqtts' ? 'mqtts' : 'mqtt',
      username: cert.username, password: cert.password,
      clientId: `ecoflow_dev_${Date.now()}`,
      keepalive: 60, reconnectPeriod: 30000,
      rejectUnauthorized: false,
    });

    devMqttClient.on('connect', () => {
      console.log('[DevMQTT] Connected, subscribing to', devices.length, 'devices');
      for (const d of devices) {
        devMqttClient.subscribe(`/open/${cert.username}/${d.sn}/quota`, { qos: 1 });
        devMqttClient.subscribe(`/open/${cert.username}/${d.sn}/get_reply`, { qos: 1 });
        devMqttClient.publish(`/open/${cert.username}/${d.sn}/get`, JSON.stringify({ id: String(Date.now()), version: '1.0' }), { qos: 1 });
      }
      console.log('[DevMQTT] Subscribed and requested quotas');
    });

    devMqttClient.on('message', (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        const parts = topic.split('/');
        const sn = parts[3];
        if (!sn) return;

        let flat = {};
        function unwrap(obj, prefix='') {
          if (!obj || typeof obj !== 'object') return;
          for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              unwrap(value, prefix ? `${prefix}.${key}` : key);
            } else {
              flat[prefix ? `${prefix}.${key}` : key] = value;
            }
          }
        }
        unwrap(data);

        if (Object.keys(flat).length > 0) {
          const wsMsg = JSON.stringify({ type: 'devapi', sn, fields: flat, ts: Math.floor(Date.now()/1000) });
          for (const client of wss.clients) {
            if (client.readyState === 1) client.send(wsMsg);
          }
        }
      } catch {}
    });

    devMqttClient.on('error', (err) => console.error('[DevMQTT] Error:', err.message));
    devMqttClient.on('close', () => console.log('[DevMQTT] Disconnected'));
  }

  _setTimeout(() => {
    if (db.getSetting('dev_api_access_key')) startDevMqtt().catch(e => console.error('[DevMQTT] Start failed:', e));
  }, 15000);

  // Start MQTT immediately (don't wait for watchdog)
  _setTimeout(() => restartMqtt(), 1000);

  return { restartMqtt, devMqttClient };
}

export function stopAll() {
  for (const id of timers) {
    try { clearInterval(id); } catch {}
    try { clearTimeout(id); } catch {}
  }
  timers.length = 0;
}
