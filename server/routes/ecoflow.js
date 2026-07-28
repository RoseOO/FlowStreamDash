import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { ecoflowLogin } from '../auth.js';
import { getDevMqttCert, verifyCredentials, listDevices, fetchAllQuota } from '../dev-api.js';
import { verifyBrightCredentials, backfillGridData } from '../bright-api.js';

export default function(app, deps) {
  const { mqttClient, restartMqtt } = deps;

  app.post('/api/ecoflow/login', authMiddleware, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    try {
      const creds = await ecoflowLogin(email, password);
      db.saveMqttConfig({
        host: creds.mqttHost,
        port: creds.mqttPort,
        username: creds.mqttUsername,
        password: creds.mqttPassword,
        user_id: creds.userId,
        email: creds.email,
        updated_at: Math.floor(Date.now() / 1000),
      });
      db.setSetting('ecoflow_email', email);
      db.setSetting('ecoflow_password', password);
      restartMqtt();
      res.json({ success: true, userId: creds.userId });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/ecoflow/status', authMiddleware, (req, res) => {
    const config = db.getMqttConfig();
    res.json({
      configured: !!config,
      email: config?.email || db.getSetting('ecoflow_email'),
      hasStoredPassword: !!(db.getSetting('ecoflow_password')),
      connected: mqttClient.connected,
      stats: mqttClient.getStats(),
    });
  });

  app.get('/api/devapi/status', authMiddleware, (req, res) => {
    res.json({
      configured: !!(db.getSetting('dev_api_access_key')),
      devices: [],
    });
  });

  app.post('/api/devapi/configure', authMiddleware, async (req, res) => {
    const { accessKey, secretKey } = req.body;
    if (!accessKey || !secretKey) return res.status(400).json({ error: 'Access key and secret key required' });
    try {
      const devices = await verifyCredentials(accessKey, secretKey);
      if (devices === false) return res.status(400).json({ error: 'Invalid credentials' });
      db.setSetting('dev_api_access_key', accessKey);
      db.setSetting('dev_api_secret_key', secretKey);
      res.json({ success: true, devices: devices || [] });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/devapi/sync-devices', authMiddleware, async (req, res) => {
    try {
      const apiDevices = await listDevices();
      if (apiDevices.length === 0) return res.json({ added: 0, devices: [] });
      let added = 0;
      for (const d of apiDevices) {
        const existing = db.getDevices().find(x => x.sn === d.sn);
        if (!existing) {
          db.addDevice(d.sn, d.name || d.sn, 'stream_inverter');
          added++;
        }
      }
      restartMqtt();
      res.json({ added, devices: apiDevices });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/bright/configure', authMiddleware, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    try {
      const ok = await verifyBrightCredentials(username, password);
      if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
      res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/bright/status', authMiddleware, (req, res) => {
    res.json({
      configured: !!(db.getSetting('bright_username')),
      username: db.getSetting('bright_username') || '',
    });
  });

  app.post('/api/bright/backfill', authMiddleware, async (req, res) => {
    const { from, to } = req.body;
    const fromTs = from || Math.floor(Date.now()/1000 - 365*86400);
    const toTs = to || Math.floor(Date.now()/1000);
    try {
      const result = await backfillGridData(fromTs, toTs);
      if (result.error) return res.status(400).json(result);
      if (result.rows) {
        for (const r of result.rows) {
          try { db.insertGridReading(r.ts, r.power_w, r.energy_kwh); } catch {}
        }
      }
      res.json({ success: true, readings: result.readings, sample: result.sample });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}
