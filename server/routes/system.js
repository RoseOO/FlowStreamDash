import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { DB_PATH } from '../config.js';
import { isHaMqttConnected } from '../ha-mqtt.js';
import { encodeVarintField, buildProtoHeader, wrapHeaderMessage } from '../utils.js';
import fs from 'fs';

export default function(app, deps) {
  const { mqttClient } = deps;

  app.get('/api/system/health', authMiddleware, (req, res) => {
    const { size: dbStats } = fs.statSync(DB_PATH);
    const dbSizeMb = (dbStats / 1024 / 1024).toFixed(1);
    const totalRows = db.default ? db.default.prepare('SELECT COUNT(*) as c FROM data').get().c : 0;
    const devices = db.getDevices().length;
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const diskFree = (() => {
      try {
        if (typeof fs.statfsSync === 'function') {
          const s = fs.statfsSync(DB_PATH);
          return ((s.bsize * s.bavail) / 1024 / 1024 / 1024).toFixed(1) + ' GB';
        }
      } catch {}
      return 'N/A';
    })();

    res.json({
      uptime: Math.floor(uptime),
      uptimeDisplay: `${Math.floor(uptime/86400)}d ${Math.floor(uptime%86400/3600)}h ${Math.floor(uptime%3600/60)}m`,
      memoryMb: (mem.heapUsed / 1024 / 1024).toFixed(1),
      memoryTotalMb: (mem.heapTotal / 1024 / 1024).toFixed(1),
      nodeVersion: process.version,
      dbSizeMb, totalRows, devices,
      diskFree,
      mqttConnected: mqttClient.connected,
      haMqttConnected: isHaMqttConnected(),
      msgCount: mqttClient.msgCount,
    });
  });

  app.post('/api/device/:sn/full-upload', authMiddleware, (req, res) => {
    const config = db.getMqttConfig();
    if (!config || !mqttClient.connected) return res.status(503).json({ error: 'MQTT not connected' });
    const pdata = encodeVarintField(71, 1);
    const header = buildProtoHeader({ pdata, cmd_func: 254, cmd_id: 17, need_ack: 1 });
    const msg = wrapHeaderMessage(header);
    const topic = `/app/${config.user_id}/${req.params.sn}/thing/property/set`;
    mqttClient.client.publish(topic, msg, { qos: 0 });
    console.log(`[Device] Sent full-upload trigger to ${req.params.sn}`);
    res.json({ success: true, message: 'Full upload trigger sent' });
  });

  app.post('/api/device/:sn/debug-mode', authMiddleware, (req, res) => {
    const config = db.getMqttConfig();
    if (!config || !mqttClient.connected) return res.status(503).json({ error: 'MQTT not connected' });
    const enable = req.body.enable !== false;
    const pdata = encodeVarintField(223, enable ? 1 : 0);
    const header = buildProtoHeader({ pdata, cmd_func: 254, cmd_id: 17, need_ack: 1 });
    const msg = wrapHeaderMessage(header);
    const topic = `/app/${config.user_id}/${req.params.sn}/thing/property/set`;
    mqttClient.client.publish(topic, msg, { qos: 0 });
    console.log(`[Device] Set debug mode=${enable} on ${req.params.sn}`);
    res.json({ success: true, debugMode: enable });
  });
}
