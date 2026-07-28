import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { IDLE_TIMEOUT } from '../config.js';

export default function(app, deps) {
  const { mqttClient, restartMqtt, dataLogger } = deps;

  app.get('/api/devices', authMiddleware, (req, res) => {
    const devices = db.getDevices();
    const enriched = devices.map(d => {
      const latest = db.getLatestData(d.sn);
      return { ...d, latest };
    });
    res.json(enriched);
  });

  app.post('/api/devices', authMiddleware, (req, res) => {
    const { sn, name, type } = req.body;
    if (!sn) return res.status(400).json({ error: 'Serial number required' });
    db.addDevice(sn, name, type);
    restartMqtt();
    res.json({ success: true, sn });
  });

  app.delete('/api/devices/:sn', authMiddleware, (req, res) => {
    db.removeDevice(req.params.sn);
    restartMqtt();
    res.json({ success: true });
  });
}
