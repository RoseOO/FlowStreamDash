import * as db from '../db.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';
import { buildCsvData } from '../csv-export.js';
import fs from 'fs';
import express from 'express';
import { DB_PATH } from '../config.js';

export default function(app, deps) {
  const { mqttClient } = deps;

  app.get('/api/export/:sn', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : 0;
    const toTs = to ? parseInt(to) : Math.floor(Date.now() / 1000);

    const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, null);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No data for this period' });
    }

    const csvData = buildCsvData(rows);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ecoflow_${req.params.sn}.csv"`);
    res.send(csvData);
  });

  app.get('/api/export/grid-meter', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : 0;
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const rows = db.getGridData(fromTs, toTs);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'No grid meter data' });
    const header = ['timestamp', 'power_w', 'energy_kwh'];
    const csvRows = [header.join(',')];
    for (const r of rows) {
      csvRows.push(`${new Date(r.ts*1000).toISOString()},${r.power_w??''},${r.energy_kwh??''}`);
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="grid_meter.csv"');
    res.send(csvRows.join('\n'));
  });

  app.get('/api/db/export', adminMiddleware, (req, res) => {
    if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'Database not found' });
    try {
      db.default.pragma('wal_checkpoint(TRUNCATE)');
      const data = fs.readFileSync(DB_PATH);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="ecoflow_backup_${ts}.db"`);
      res.send(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/db/import', adminMiddleware, express.raw({ type: 'application/octet-stream', limit: '200mb' }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (body.length === 0) return res.status(400).json({ error: 'No file uploaded' });
    try {
      mqttClient.disconnect();
      if (body.slice(0,16).toString('utf8') !== 'SQLite format 3\0') {
        return res.status(400).json({ error: 'Not a valid SQLite database file' });
      }
      const bakPath = DB_PATH + '.bak';
      if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, bakPath);
      fs.writeFileSync(DB_PATH, body);
      res.json({ success: true, size: body.length, message: 'Database restored. Server restarting...' });
      setTimeout(() => process.exit(0), 500);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
