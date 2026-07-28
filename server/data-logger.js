import { IDLE_TIMEOUT, POWER_FIELDS } from './config.js';

export function createDataLogger({ mqttClient, db, wss }) {
  const deviceMsgTimes = {};
  const deviceLastPower = {};
  const idleSent = {};
  const alertCooldown = {};

  const knownDevices = db.getDevices() || [];
  for (const d of knownDevices) {
    deviceMsgTimes[d.sn] = Math.floor(Date.now() / 1000);
  }

  mqttClient.on('data', ({ sn, fields }) => {
    const ts = Math.floor(Date.now() / 1000);
    deviceMsgTimes[sn] = ts;
    const hasPower = (fields[361] > 0 || fields[70] > 0 || fields[616] !== 0);
    if (hasPower) deviceLastPower[sn] = ts;

    const rows = [];
    for (const [fnum, value] of Object.entries(fields)) {
      const fieldNum = parseInt(fnum);
      if (isNaN(fieldNum)) continue;
      rows.push({
        ts, device_sn: sn, field_num: fieldNum,
        value_num: typeof value === 'number' ? value : null,
        value_text: typeof value === 'string' ? value : null,
      });
    }
    if (rows.length > 0) {
      try { db.insertData(rows); } catch (e) { console.error('[DB] Insert error:', e.message); }
    }
  });

  function checkIdle() {
    const now = Date.now() / 1000;
    const devices = db.getDevices();
    for (const d of devices) {
      const sn = d.sn;
      if (!deviceMsgTimes[sn]) deviceMsgTimes[sn] = 0;
      const idle = now - deviceMsgTimes[sn];
      if (idle > IDLE_TIMEOUT) {
        const lastSent = idleSent[sn] || 0;
        if (now - lastSent < 55) continue;
        idleSent[sn] = now;
        const zeros = {};
        for (const f of POWER_FIELDS) zeros[f] = 0;
        const msg = JSON.stringify({ type: 'data', sn, fields: zeros, ts: Math.floor(now), idle: true });
        for (const client of wss.clients) {
          if (client.readyState === 1) client.send(msg);
        }
        const hour = new Date().getHours();
        const wasGenerating = deviceLastPower[sn] && (now - deviceLastPower[sn]) < 21600;
        const lastAlert = alertCooldown[sn] || 0;
        if (hour >= 6 && hour <= 21 && wasGenerating && (now - lastAlert) > 7200) {
          alertCooldown[sn] = now;
          const alertMsg = JSON.stringify({ type: 'alert', sn, message: `No data from ${sn} for ${Math.round(idle/60)}min — possible fault`, level: 'warn' });
          for (const client of wss.clients) {
            if (client.readyState === 1) client.send(alertMsg);
          }
        }
      }
    }
  }

  function getIdleStatus(sn) {
    const now = Date.now() / 1000;
    const lastMsg = deviceMsgTimes[sn] || 0;
    return (now - lastMsg) > IDLE_TIMEOUT;
  }

  return { deviceMsgTimes, deviceLastPower, checkIdle, getIdleStatus };
}
