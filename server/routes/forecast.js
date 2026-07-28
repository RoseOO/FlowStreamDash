import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getStats } from '../stats-engine.js';
import { round2, round4 } from '../utils.js';
import { DEFAULT_LAT, DEFAULT_LON } from '../config.js';
import { isHaMqttConnected, startHaMqtt, stopHaMqtt } from '../ha-mqtt.js';
import { publishHaPrediction } from '../ha-mqtt.js';

export default function(app) {
  app.get('/api/weather', authMiddleware, (req, res) => {
    const lat = req.query.lat || db.getSetting('weather_lat') || DEFAULT_LAT;
    const lon = req.query.lon || db.getSetting('weather_lon') || DEFAULT_LON;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=cloud_cover,shortwave_radiation&timezone=auto&forecast_days=1`;
    fetch(url).then(r=>r.json()).then(data => {
      const now = new Date();
      const hours = data.hourly?.time?.map((t,i) => ({
        hour: new Date(t).getHours(),
        cloudCover: data.hourly.cloud_cover?.[i],
        radiation: data.hourly.shortwave_radiation?.[i],
      })).filter(h => h.hour <= now.getHours()) || [];
      res.json(hours);
    }).catch(e => res.status(500).json({ error: e.message }));
  });

  app.get('/api/forecast/:sn', authMiddleware, async (req, res) => {
    const now = Math.floor(Date.now()/1000);
    const todayStart = Math.floor(now/86400)*86400;
    const currentHour = new Date().getHours();
    const stats = getStats(req.params.sn, todayStart, now);
    const model = db.getModelStats(req.params.sn);
    const factor = model?.avg_factor || 0.42;

    const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
    const lon = db.getSetting('weather_lon') || DEFAULT_LON;

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=shortwave_radiation,cloud_cover&timezone=auto&forecast_days=1`;
      const resp = await fetch(url);
      const data = await resp.json();
      const radMap = {}, cloudMap = {};
      if (data.hourly) {
        data.hourly.time.forEach((t, i) => {
          const h = new Date(t).getHours();
          if (h > currentHour) {
            radMap[h] = data.hourly.shortwave_radiation?.[i] || 0;
            cloudMap[h] = data.hourly.cloud_cover?.[i] || 0;
          }
        });
      }

      let predictedRemainingKwh = 0;
      const hourlyPred = {};
      for (let h = currentHour + 1; h <= 23; h++) {
        const rad = radMap[h] || 0;
        const predW = rad * factor;
        hourlyPred[h] = round2(predW);
        predictedRemainingKwh += predW / 1000;
      }

      const result = {
        currentHour,
        remainingHours: 23 - currentHour,
        modelFactor: round2(factor),
        modelSamples: model?.samples || 0,
        usingLearnedModel: model?.samples > 10,
        radiationWm2: radMap,
        cloudCoverPct: cloudMap,
        predictedWattsByHour: hourlyPred,
        predictedRemainingKwh: round2(predictedRemainingKwh),
        alreadyProducedKwh: stats.totalKwh || 0,
        predictedTotalKwh: round2((stats.totalKwh||0) + predictedRemainingKwh),
      };
      publishHaPrediction(req.params.sn, result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/model/:sn/train', authMiddleware, async (req, res) => {
    try {
      const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
      const lon = db.getSetting('weather_lon') || DEFAULT_LON;
      let trained = 0;

      const days = db.default.prepare(
        `SELECT DISTINCT CAST(ts/86400 AS INTEGER) as day FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 ORDER BY day DESC LIMIT 14`
      ).all(req.params.sn);

      for (const { day } of days) {
        const dayStart = day * 86400;
        const dayEnd = dayStart + 86400;

        const existing = db.default.prepare(
          'SELECT COUNT(*) as c FROM radiation_data WHERE device_sn=? AND hour_ts >= ? AND hour_ts < ?'
        ).get(req.params.sn, dayStart, dayEnd);
        if (existing?.c > 0) continue;

        const date = new Date(dayStart * 1000).toISOString().slice(0,10);
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!data.hourly) continue;

        const radByHour = {};
        data.hourly.time.forEach((t, i) => {
          const h = new Date(t).getHours();
          const rad = data.hourly.shortwave_radiation[i] || 0;
          radByHour[h] = rad;
        });

        for (let h = 0; h < 24; h++) {
          const hourTs = dayStart + h * 3600;
          const rows = db.getHistoricalData(req.params.sn, hourTs, hourTs + 3599, [361, 70]);
          const prodSum = rows.reduce((sum, r) => sum + (r.value_num || 0), 0);
          const prodCount = rows.filter(r => r.value_num > 0).length;
          if (prodCount < 10) continue;
          const avgProd = prodSum / prodCount;
          const rad = radByHour[h] || 0;
          if (rad < 10) continue;
          const factor = round4(avgProd / rad);
          db.upsertRadiationPair(req.params.sn, hourTs, rad, round2(avgProd), factor);
          trained++;
        }

        await new Promise(r => setTimeout(r, 1200));
      }

      const model = db.getModelStats(req.params.sn);
      res.json({
        trained,
        modelFactor: model?.avg_factor ? round2(model.avg_factor) : null,
        samples: model?.samples || 0,
        avgProdW: model?.avg_prod ? round2(model.avg_prod) : null,
        avgRadWm2: model?.avg_rad ? round2(model.avg_rad) : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/model/:sn', authMiddleware, (req, res) => {
    const model = db.getModelStats(req.params.sn);
    const recent = db.getRadiationPairs(req.params.sn, 48);
    const history = db.getRadiationHistory(req.params.sn, 200);
    const accuracy = db.getAccuracyHistory(req.params.sn, 90);
    const accuracyStats = db.getAccuracyStats(req.params.sn, 30);

    res.json({
      learnedFactor: model?.avg_factor ? round2(model.avg_factor) : null,
      samples: model?.samples || 0,
      avgProductionW: model?.avg_prod ? round2(model.avg_prod) : null,
      avgRadiationWm2: model?.avg_rad ? round2(model.avg_rad) : null,
      modelReady: (model?.samples || 0) > 10,
      recentPairs: recent.slice(0, 24).map(r => ({
        hour: new Date(r.hour_ts*1000).toISOString(),
        radiation: r.radiation_wm2,
        production: r.production_w,
        factor: round4(r.factor),
      })),
      historyPairs: history.map(r => ({
        hour: new Date(r.hour_ts*1000).toISOString(),
        radiation: r.radiation_wm2,
        production: r.production_w,
        factor: round4(r.factor),
      })),
      accuracyHistory: accuracy.map(r => ({
        date: new Date(r.day_ts*1000).toLocaleDateString().slice(0,5),
        predicted: round2(r.predicted_kwh),
        actual: round2(r.actual_kwh),
        errorPct: r.error_pct ? round2(r.error_pct) : null,
      })),
      avgAbsErrorPct: accuracyStats?.avg_abs_error ? round2(accuracyStats.avg_abs_error) : null,
      accuracyDays: accuracyStats?.days || 0,
    });
  });

  app.get('/api/settings/weather', authMiddleware, (req, res) => {
    res.json({
      lat: db.getSetting('weather_lat') || DEFAULT_LAT,
      lon: db.getSetting('weather_lon') || DEFAULT_LON,
    });
  });
  app.post('/api/settings/weather', authMiddleware, (req, res) => {
    if (req.body.lat) db.setSetting('weather_lat', String(req.body.lat));
    if (req.body.lon) db.setSetting('weather_lon', String(req.body.lon));
    res.json({ success: true });
  });

  app.get('/api/settings/ha-mqtt', authMiddleware, (req, res) => {
    res.json({
      enabled: db.getSetting('ha_mqtt_enabled') === 'true',
      host: db.getSetting('ha_mqtt_host') || '',
      port: parseInt(db.getSetting('ha_mqtt_port') || '1883'),
      username: db.getSetting('ha_mqtt_username') || '',
      discovery_prefix: db.getSetting('ha_mqtt_prefix') || 'homeassistant',
      connected: isHaMqttConnected(),
    });
  });
  app.post('/api/settings/ha-mqtt', authMiddleware, async (req, res) => {
    const { enabled, host, port, username, password, discovery_prefix } = req.body;
    db.setSetting('ha_mqtt_enabled', enabled ? 'true' : 'false');
    if (host) db.setSetting('ha_mqtt_host', host);
    if (port) db.setSetting('ha_mqtt_port', String(port));
    if (username !== undefined) db.setSetting('ha_mqtt_username', username);
    if (password) db.setSetting('ha_mqtt_password', password);
    if (discovery_prefix) db.setSetting('ha_mqtt_prefix', discovery_prefix);

    if (enabled && host) {
      const pwd = password || db.getSetting('ha_mqtt_password') || '';
      const ok = await startHaMqtt({
        host, port: parseInt(port||'1883'),
        username: username || '', password: pwd,
        discovery_prefix: discovery_prefix || 'homeassistant',
      });
      res.json({ success: ok, connected: ok });
    } else {
      stopHaMqtt();
      res.json({ success: true, connected: false });
    }
  });
}
