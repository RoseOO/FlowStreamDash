// EcoFlow Monitor — Express server with MQTT, SQLite, REST API, WebSocket

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import { EcoFlowMqttClient } from './mqtt-client.js';
import { ecoflowLogin } from './auth.js';
import * as db from './db.js';
import { FIELD_META, DISPLAY_ORDER, DISPLAY_SECTIONS, getFieldLabel, getCsvLabel, formatValue, KNOWN_FIELDS, GRAPH_FIELDS } from './fields.js';
import { runHourlyRollup, calculateSavings, calculateDailySavings } from './aggregator.js';
import { startHaMqtt, stopHaMqtt, publishState, publishHaGridMeter, publishHaStats, publishHaPrediction, isHaMqttConnected } from './ha-mqtt.js';
import { GridMeter } from './grid-meter.js';
import { getDevMqttCert, verifyCredentials, listDevices, fetchAllQuota } from './dev-api.js';
import { verifyBrightCredentials, backfillGridData } from './bright-api.js';
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'ecoflow.db');
const DIST_DIR = join(__dirname, '..', 'dist');
const DEFAULT_LAT = '52.5';
const DEFAULT_LON = '-1.5';

// ── Get or create persistent JWT secret ─────────────────────
const JWT_SECRET = (() => {
  let secret = db.getSetting('jwt_secret');
  if (secret) return secret;
  secret = randomBytes(64).toString('hex');
  db.setSetting('jwt_secret', secret);
  return secret;
})();
const PORT = process.env.PORT || 3000;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const mqttClient = new EcoFlowMqttClient();

app.use(cors());
app.use(express.json());

// Serve Vite build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(DIST_DIR));
}

// ── Auth Middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function hashPassword(pw) {
  return createHash('sha256').update(pw + JWT_SECRET).digest('hex');
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    const user = db.getUser(req.user.username);
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ── Auth Routes ──────────────────────────────────────────────
// Registration: open when no accounts exist; after that, admin-only
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const count = db.userCount();
  // If accounts exist, must be logged in as admin
  if (count > 0) {
    return authMiddleware(req, res, () => {
      const admin = db.getUser(req.user.username);
      if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Admin only' });
      doRegister(req, res);
    });
  }
  doRegister(req, res);
});

function doRegister(req, res) {
  const { username, password } = req.body;
  const existing = db.getUser(username);
  if (existing) return res.status(409).json({ error: 'User already exists' });
  db.createUser(username, hashPassword(password));
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.getUser(username);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, is_admin: user.is_admin });
});

app.get('/api/auth/check', authMiddleware, (req, res) => {
  const user = db.getUser(req.user.username);
  res.json({ valid: true, username: req.user.username, is_admin: user?.is_admin || false });
});

// ── User Management (admin only) ─────────────────────────────
app.get('/api/auth/users', adminMiddleware, (req, res) => {
  res.json(db.listUsers());
});

app.delete('/api/auth/users/:username', adminMiddleware, (req, res) => {
  if (req.params.username === req.user.username) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  try {
    db.deleteUser(req.params.username);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/change-password', adminMiddleware, (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'Username and new password required' });
  const user = db.getUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.changePassword(username, hashPassword(newPassword));
  res.json({ success: true });
});

// User can change their own password
app.post('/api/auth/change-my-password', authMiddleware, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'New password required' });
  db.changePassword(req.user.username, hashPassword(newPassword));
  res.json({ success: true });
});

// ── API Key Management (admin only) ──────────────────────────
app.get('/api/auth/apikeys', adminMiddleware, (req, res) => {
  res.json(db.listApiKeys());
});

app.post('/api/auth/apikeys', adminMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const key = 'ef_' + randomBytes(24).toString('hex');
  db.createApiKey(name, key);
  res.json({ name, key });
});

app.delete('/api/auth/apikeys/:id', adminMiddleware, (req, res) => {
  db.deleteApiKey(parseInt(req.params.id));
  res.json({ success: true });
});

// ── Public API (API key auth, read-only) ─────────────────────
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'X-API-Key header required' });
  const valid = db.validateApiKey(key);
  if (!valid) return res.status(401).json({ error: 'Invalid API key' });
  req.apiKeyName = valid.name;
  next();
}

// Labeled field mapping for public API
function labeledLatest(sn) {
  const raw = db.getLatestData(sn);
  const out = { device_sn: sn, ...Object.fromEntries(
    Object.entries(raw).map(([fnum, val]) => [getCsvLabel(parseInt(fnum)), val])
  )};
  return out;
}

app.get('/api/public/devices', apiKeyAuth, (req, res) => {
  const devices = db.getDevices();
  res.json(devices.map(d => {
    const ld = db.getLatestData(d.sn);
    const labeled = {};
    for (const [fnum, val] of Object.entries(ld)) {
      labeled[getCsvLabel(parseInt(fnum))] = val;
    }
    // Add computed values
    if (labeled['PV1_Power_W'] != null && labeled['PV1_Current_A'] != null && labeled['PV1_Current_A'] > 0.01) {
      labeled['PV1_Voltage_est_V'] = round2(labeled['PV1_Power_W'] / labeled['PV1_Current_A']);
    }
    if (labeled['PV2_Power_W'] != null && labeled['PV2_Current_A'] != null && labeled['PV2_Current_A'] > 0.01) {
      labeled['PV2_Voltage_est_V'] = round2(labeled['PV2_Power_W'] / labeled['PV2_Current_A']);
    }
    const pv1Rated = parseInt(db.getDeviceConfig(d.sn, 'pv1_rated_watts')||'0');
    const pv2Rated = parseInt(db.getDeviceConfig(d.sn, 'pv2_rated_watts')||'0');
    if (pv1Rated && labeled['PV1_Power_W']) labeled['PV1_Efficiency_Pct'] = round2(labeled['PV1_Power_W']/pv1Rated*100);
    if (pv2Rated && labeled['PV2_Power_W']) labeled['PV2_Efficiency_Pct'] = round2(labeled['PV2_Power_W']/pv2Rated*100);
    return { sn: d.sn, name: d.name, type: d.type, values: labeled };
  }));
});

app.get('/api/public/device/:sn/latest', apiKeyAuth, (req, res) => {
  res.json(labeledLatest(req.params.sn));
});

app.get('/api/public/device/:sn/history', apiKeyAuth, (req, res) => {
  const { from, to, fields } = req.query;
  const fromTs = from ? parseInt(from) : 0;
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const fieldNums = fields ? fields.split(',').map(Number).filter(n=>!isNaN(n)) : null;
  const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, fieldNums);
  // Group by timestamp and label
  const byTs = {};
  for (const r of rows) {
    if (!byTs[r.ts]) byTs[r.ts] = { timestamp: new Date(r.ts*1000).toISOString() };
    byTs[r.ts][getCsvLabel(r.field_num)] = r.value_text || r.value_num;
  }
  res.json(Object.values(byTs).sort((a,b) => a.timestamp < b.timestamp ? -1 : 1));
});

app.get('/api/public/device/:sn/stats', apiKeyAuth, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*7);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  res.json(getStats(req.params.sn, fromTs, toTs));
});

app.get('/api/public/savings/:sn', apiKeyAuth, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const result = calculateSavings(req.params.sn, fromTs, toTs);
  // Label the result
  res.json({
    device_sn: req.params.sn,
    total_produced_kwh: result.totalPvKwh,
    savings_gbp: result.totalSaving,
    rate_per_kwh: result.rate,
    currency: result.currency,
    period_from: new Date(fromTs*1000).toISOString(),
    period_to: new Date(toTs*1000).toISOString(),
  });
});

app.get('/api/public/savings/aggregate', apiKeyAuth, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const devices = db.getDevices();
  let totalKwh=0;
  for (const d of devices) {
    const r = calculateSavings(d.sn, fromTs, toTs);
    if (!r.error) totalKwh += r.totalPvKwh || 0;
  }
  const rate = db.getCurrentRate();
  const price = rate ? rate.price_per_kwh : 0;
  res.json({
    total_produced_kwh: round2(totalKwh),
    savings_gbp: round2(totalKwh*price),
    rate_per_kwh: price,
    device_count: devices.length,
    period_from: new Date(fromTs*1000).toISOString(),
    period_to: new Date(toTs*1000).toISOString(),
  });
});

app.get('/api/public/export/:sn', apiKeyAuth, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : 0;
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, null);
  if (!rows || rows.length===0) return res.status(404).json({error:'No data'});
  const allFieldNums=new Set(); for(const r of rows)allFieldNums.add(r.field_num);
  const orderedFields=[...DISPLAY_ORDER.filter(f=>allFieldNums.has(f)),...[...allFieldNums].filter(f=>!DISPLAY_ORDER.includes(f)).sort((a,b)=>a-b)];
  const header=['timestamp',...orderedFields.map(f=>getCsvLabel(f))];
  const byTs={};
  for(const r of rows){
    if(!byTs[r.ts])byTs[r.ts]={};
    byTs[r.ts][r.field_num]=r.value_text||r.value_num;
  }
  const csvRows=[header.join(',')];
  for(const ts of Object.keys(byTs).sort()){
    const row=[new Date(parseInt(ts)*1000).toISOString()];
    for(const f of orderedFields)row.push(byTs[ts][f]!==undefined?byTs[ts][f]:'');
    csvRows.push(row.join(','));
  }
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="ecoflow_${req.params.sn}.csv"`);
  res.send(csvRows.join('\n'));
});

// ── Public API: New analysis endpoints ─────────────────────
app.get('/api/public/device/:sn/pr', apiKeyAuth, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-30*86400);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
  const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
  const totalKW = (pv1W + pv2W) / 1000;
  if (totalKW <= 0) return res.json({ error: 'Set panel ratings in Setup first' });
  const stats = getStats(req.params.sn, fromTs, toTs);
  // Approximate PR from historical data (peak sun hours ≈ radiation data / 1000)
  const peakSunHours = round2(stats.totalKwh / totalKW * 0.8); // quick approximation
  const expectedKwh = round2(totalKW * peakSunHours);
  const pr = expectedKwh > 0 ? round2(stats.totalKwh / expectedKwh * 100) : null;
  res.json({ actualKwh: stats.totalKwh, peakSunHours, totalKwRated: round2(totalKW),
    expectedKwh, performanceRatioPct: pr, rating: pr ? (pr>80?'Excellent':pr>60?'Good':pr>40?'Fair':'Poor') : null });
});

app.get('/api/public/device/:sn/quality', apiKeyAuth, (req, res) => {
  const stats = getStats(req.params.sn, Math.floor(Date.now()/1000)-7*86400, Math.floor(Date.now()/1000));
  if (!stats.hourlyProfile) return res.json({ error: 'Not enough data' });
  let genHours = 0, dataHours = 0;
  for (let h=0;h<24;h++) if (stats.hourlyProfile[h]?.avg>5) genHours++;
  if (genHours>0){
    const rows = db.getHistoricalData(req.params.sn, Math.floor(Date.now()/1000)-7*86400, Math.floor(Date.now()/1000), [361]);
    const hwd = new Set();
    for (const r of rows) { if (r.value_num>0) hwd.add(new Date(r.ts*1000).getHours()); }
    for (let h=0;h<24;h++) if (stats.hourlyProfile[h]?.avg>5&&hwd.has(h)) dataHours++;
  }
  res.json({ generatingHoursPerDay: genHours, hoursWithData: dataHours,
    uptimePct: genHours>0?round2(dataHours/genHours*100):null });
});

app.get('/api/public/device/:sn/degradation', apiKeyAuth, (req, res) => {
  const pv1W = parseInt(db.getDeviceConfig(req.params.sn,'pv1_rated_watts')||'0');
  const pv2W = parseInt(db.getDeviceConfig(req.params.sn,'pv2_rated_watts')||'0');
  if (pv1W<=0&&pv2W<=0) return res.json({error:'Set panel ratings first'});
  const rows = db.default.prepare(
    `SELECT CAST(ts/86400/30 AS INTEGER) as m, AVG(value_num) as avg_w, MAX(value_num) as peak_w
     FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 GROUP BY m ORDER BY m ASC LIMIT 36`
  ).all(req.params.sn);
  const totalRated=pv1W+pv2W;
  res.json(rows.map(r=>({month:new Date(r.m*30*86400*1000).toLocaleDateString('en',{year:'numeric',month:'short'}),
    avgEfficiencyPct:round2(r.avg_w/totalRated*100),peakEfficiencyPct:round2(r.peak_w/totalRated*100)})));
});

app.get('/api/public/device/:sn/model', apiKeyAuth, (req, res) => {
  const model = db.getModelStats(req.params.sn);
  const recent = db.getRadiationPairs(req.params.sn, 24);
  res.json({ learnedFactor: model?.avg_factor?round2(model.avg_factor):null, samples: model?.samples||0,
    modelReady: (model?.samples||0)>10, recentPairs: recent.slice(0,24).map(r=>({
      hour: new Date(r.hour_ts*1000).toISOString(), radiation: r.radiation_wm2, production: r.production_w, factor: round4(r.factor),
    }))});
});

// PV Gen Window / Daylight endpoint
app.get('/api/public/device/:sn/daylight', apiKeyAuth, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const stats = getStats(req.params.sn, fromTs, toTs);
  const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
  const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
  res.json({
    pv1: stats.daylight?.pv1 || null,
    pv2: stats.daylight?.pv2 || null,
    pv1RatedW: pv1W, pv2RatedW: pv2W,
    period_from: new Date(fromTs*1000).toISOString(),
    period_to: new Date(toTs*1000).toISOString(),
  });
});

// Weather & cloud data
app.get('/api/public/weather', apiKeyAuth, async (req, res) => {
  const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
  const lon = db.getSetting('weather_lon') || DEFAULT_LON;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover,shortwave_radiation&timezone=auto&forecast_days=1`;
    const resp = await fetch(url); const data = await resp.json();
    const hours = data.hourly?.time?.map((t,i) => ({
      time: t, hour: new Date(t).getHours(),
      cloudCoverPct: data.hourly.cloud_cover?.[i],
      radiationWm2: data.hourly.shortwave_radiation?.[i],
    })) || [];
    res.json({ lat, lon, hours });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Grid meter data
app.get('/api/public/grid-meter', apiKeyAuth, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const rows = db.getGridData(fromTs, toTs);
  res.json(rows);
});
app.get('/api/public/grid-meter/latest', apiKeyAuth, (req, res) => {
  res.json(db.getLatestGridReading() || { power_w: null, energy_kwh: null });
});

// ── EcoFlow Login Route ─────────────────────────────────────
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
    // Store credentials for auto-refresh
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

// ── Developer API Integration ───────────────────────────────
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
    // If credentials also return device list, offer to auto-add them
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

// ── Bright/Glowmarkt SMETS2 Meter ──────────────────────────
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
    // Store backfilled data in DB
    if (result.rows) {
      for (const r of result.rows) {
        try { db.insertGridReading(r.ts, r.power_w, r.energy_kwh); } catch {}
      }
    }
    res.json({ success: true, readings: result.readings, sample: result.sample });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Dev API quota poller (every 60s, GET quota/all) ────────
let quotaTimer = null;
async function pollQuotaData() {
  const devices = db.getDevices();
  for (const d of devices) {
    try {
      const data = await fetchAllQuota(d.sn);
      if (!data || Object.keys(data).length === 0) continue;
      // Pass raw quota data to frontend via WebSocket
      const wsMsg = JSON.stringify({ type: 'devapi', sn: d.sn, fields: data, ts: Math.floor(Date.now()/1000) });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(wsMsg);
      }
    } catch {}
  }
}
setTimeout(() => {
  if (db.getSetting('dev_api_access_key')) {
    console.log('[DevAPI] Starting quota/all poller (60s)');
    quotaTimer = setInterval(pollQuotaData, 60000);
    pollQuotaData();
  }
}, 20000);

// ── Device Routes ───────────────────────────────────────────
app.get('/api/devices', authMiddleware, (req, res) => {
  const devices = db.getDevices();
  // Attach latest data for each device
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

// ── Data Routes ─────────────────────────────────────────────
app.get('/api/data/:sn/latest', authMiddleware, (req, res) => {
  const latest = db.getLatestData(req.params.sn);
  const range = db.getDataRange(req.params.sn);
  // Include idle status so cold-start shows it immediately
  const now = Date.now() / 1000;
  const lastMsg = deviceMsgTimes[req.params.sn] || 0;
  const idle = (now - lastMsg) > IDLE_TIMEOUT;
  res.json({ latest, range, idle });
});

app.get('/api/data/:sn/history', authMiddleware, (req, res) => {
  const { from, to, fields } = req.query;
  const fromTs = from ? parseInt(from) : 0;
  const toTs = to ? parseInt(to) : Math.floor(Date.now() / 1000);
  const fieldNums = fields ? fields.split(',').map(Number).filter(n => !isNaN(n)) : null;
  const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, fieldNums);
  res.json(rows);
});

app.get('/api/data/:sn/aggregates', authMiddleware, (req, res) => {
  const { from, to, fields, table } = req.query;
  const fromTs = from ? parseInt(from) : 0;
  const toTs = to ? parseInt(to) : Math.floor(Date.now() / 1000);
  const fieldNums = fields ? fields.split(',').map(Number).filter(n => !isNaN(n)) : null;
  const rows = db.getAggregates(req.params.sn, fromTs, toTs, fieldNums, table || 'hourly');
  res.json(rows);
});

app.get('/api/data/:sn/fields', authMiddleware, (req, res) => {
  res.json({
    meta: FIELD_META,
    displayOrder: DISPLAY_ORDER,
    sections: DISPLAY_SECTIONS,
    graphFields: GRAPH_FIELDS,
  });
});

// ── Savings Routes ──────────────────────────────────────────
app.post('/api/savings/rate', authMiddleware, (req, res) => {
  const { price_per_kwh, currency } = req.body;
  if (!price_per_kwh) return res.status(400).json({ error: 'Rate required' });
  db.addRate(parseFloat(price_per_kwh), currency || 'GBP');
  res.json({ success: true });
});

app.get('/api/savings/rate', authMiddleware, (req, res) => {
  const rate = db.getCurrentRate();
  res.json(rate || { price_per_kwh: 0, currency: 'GBP' });
});

// Savings: self-consumption = total PV produced (avoided grid import)
// Export/import handled separately if meter data is present
app.get('/api/savings/calculate/:sn', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const result = calculateSavings(req.params.sn, fromTs, toTs);
  res.json(result);
});

app.get('/api/savings/daily/:sn', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const result = calculateDailySavings(req.params.sn, fromTs, toTs);
  res.json(result);
});

// Aggregate savings across all devices
app.get('/api/savings/aggregate', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const devices = db.getDevices();
  let totalPvKwh=0, totalImportKwh=0, totalExportKwh=0, totalSelfConsKwh=0;
  // Merge daily data across devices
  const dailyMap = {};

  for (const d of devices) {
    const r = calculateSavings(d.sn, fromTs, toTs);
    if (!r.error) {
      totalPvKwh += r.totalPvKwh || 0;
      totalImportKwh += r.totalImportKwh || 0;
      totalExportKwh += r.totalExportKwh || 0;
      totalSelfConsKwh += (r.totalPvKwh||0) - (r.totalExportKwh||0);
    }
    // Get daily breakdown per device
    const daily = calculateDailySavings(d.sn, fromTs, toTs);
    for (const day of daily) {
      if (!dailyMap[day.date]) {
        dailyMap[day.date] = { date: day.date, exportValue:0, importCost:0, selfConsumptionSaving:0, totalSaving:0, totalPvKwh:0 };
      }
      dailyMap[day.date].exportValue += day.exportValue || 0;
      dailyMap[day.date].importCost += day.importCost || 0;
      dailyMap[day.date].selfConsumptionSaving += day.selfConsumptionSaving || 0;
      dailyMap[day.date].totalSaving += day.totalSaving || 0;
      dailyMap[day.date].totalPvKwh += day.totalPvKwh || 0;
    }
  }
  const rate = db.getCurrentRate();
  const price = rate ? rate.price_per_kwh : 0;
  const dailyArr = Object.values(dailyMap).sort((a,b) => a.date - b.date);
  res.json({
    totalPvKwh: round2(totalPvKwh), totalImportKwh: round2(totalImportKwh),
    totalExportKwh: round2(totalExportKwh), totalSelfConsKwh: round2(totalSelfConsKwh),
    selfConsumptionSaving: round2(totalSelfConsKwh * price),
    importCost: round2(totalImportKwh * price),
    exportValue: round2(totalExportKwh * price),
    netSaving: round2((totalSelfConsKwh - totalImportKwh + totalExportKwh) * price),
    rate: price, deviceCount: devices.length,
    daily: dailyArr.map(d => ({
      date: d.date,
      totalPvKwh: round2(d.totalPvKwh || 0),
      totalSaving: round2(d.totalSaving || 0),
    })),
  });
});

function round2(v) { return Math.round(v * 100) / 100; }

function computeHourlyProfile(pvRows, fromTs, toTs) {
  // For each day, compute average power per hour, then average across days
  const hourlyByDay = {}; // day -> hour -> { sum, count }
  for (const r of pvRows) {
    if (r.value_num == null || r.value_num <= 0) continue;
    const day = Math.floor(r.ts / 86400) * 86400;
    const hour = new Date(r.ts * 1000).getHours();
    if (!hourlyByDay[day]) hourlyByDay[day] = {};
    if (!hourlyByDay[day][hour]) hourlyByDay[day][hour] = { sum: 0, count: 0 };
    hourlyByDay[day][hour].sum += r.value_num;
    hourlyByDay[day][hour].count += 1;
  }
  const profile = {};
  for (let h = 0; h < 24; h++) {
    let totalAvg = 0, maxAvg = 0, dayCount = 0;
    for (const day of Object.values(hourlyByDay)) {
      const hd = day[h];
      if (hd && hd.count > 0) {
        const avg = hd.sum / hd.count;
        totalAvg += avg;
        maxAvg = Math.max(maxAvg, avg);
        dayCount++;
      }
    }
    profile[h] = { avg: round2(dayCount ? totalAvg / dayCount : 0), max: round2(maxAvg) };
  }
  return profile;
}

function computeDailyTotals(pvRows) {
  const daily = {};
  for (const r of pvRows) {
    if (r.value_num == null) continue;
    const day = Math.floor(r.ts / 86400) * 86400;
    const hour = new Date(r.ts * 1000).getHours();
    if (!daily[day]) daily[day] = { totalKwh: 0, peakW: 0, peakHour: null, count: 0 };
    daily[day].totalKwh += (r.value_num * 2) / 3600000; // ~2s intervals
    daily[day].count++;
    if (r.value_num > daily[day].peakW) {
      daily[day].peakW = r.value_num;
      daily[day].peakHour = hour;
    }
  }
  return daily;
}

function getStats(sn, fromTs, toTs) {
  const pv1Rows = db.getHistoricalData(sn, fromTs, toTs, [361]);
  const pv2Rows = db.getHistoricalData(sn, fromTs, toTs, [70]);
  const allPv = [...pv1Rows, ...pv2Rows];

  const daily = computeDailyTotals(allPv);
  const hourlyProfile = computeHourlyProfile(allPv, fromTs, toTs);
  const dailyArr = Object.entries(daily).map(([ts, d]) => ({
    ts: parseInt(ts), totalKwh: round2(d.totalKwh), peakW: d.peakW,
  })).sort((a, b) => a.ts - b.ts);

  const bestDay = [...dailyArr].sort((a, b) => b.totalKwh - a.totalKwh)[0];
  const peakHourEntry = Object.entries(hourlyProfile).sort((a, b) => b[1].avg - a[1].avg)[0];

  // Per-device panel config
  const pv1W = parseInt(db.getDeviceConfig(sn, 'pv1_rated_watts') || '0');
  const pv2W = parseInt(db.getDeviceConfig(sn, 'pv2_rated_watts') || '0');
  const efficiency = {};
  if (pv1W > 0) {
    const peaks = pv1Rows.filter(r => r.value_num > 0);
    const maxPv1 = peaks.length ? Math.max(...peaks.map(r => r.value_num)) : 0;
    efficiency.pv1 = { rated: pv1W, peak: round2(maxPv1), pct: round2(maxPv1 / pv1W * 100) };
  }
  if (pv2W > 0) {
    const peaks = pv2Rows.filter(r => r.value_num > 0);
    const maxPv2 = peaks.length ? Math.max(...peaks.map(r => r.value_num)) : 0;
    efficiency.pv2 = { rated: pv2W, peak: round2(maxPv2), pct: round2(maxPv2 / pv2W * 100) };
  }

  // Daylight stats (only during generating hours, excludes nighttime zeros)
  const daylight = {};
  if (pv1W > 0) {
    daylight.pv1 = computeDaylightStats(pv1Rows, hourlyProfile, pv1W);
  }
  if (pv2W > 0) {
    daylight.pv2 = computeDaylightStats(pv2Rows, hourlyProfile, pv2W);
  }

  return {
    daily: dailyArr.slice(-30),
    hourlyProfile,
    pv1HourlyProfile: computeHourlyProfile(pv1Rows, fromTs, toTs),
    pv2HourlyProfile: computeHourlyProfile(pv2Rows, fromTs, toTs),
    bestDay: bestDay || null,
    peakHour: peakHourEntry ? { hour: parseInt(peakHourEntry[0]), avg: peakHourEntry[1].avg, max: peakHourEntry[1].max } : null,
    totalKwh: round2(dailyArr.reduce((a, b) => a + b.totalKwh, 0)),
    avgDailyKwh: round2(dailyArr.reduce((a, b) => a + b.totalKwh, 0) / (dailyArr.length || 1)),
    dayCount: dailyArr.length,
    efficiency,
    daylight,
  };
}

function computeDaylightStats(pvRows, hourlyProfile, panelRating) {
  // Find generating hours (where hourly average > 5W)
  const genHours = [];
  for (let h = 0; h < 24; h++) {
    if (hourlyProfile[h]?.avg > 5) genHours.push(h);
  }
  if (genHours.length === 0) return null;

  const firstHour = genHours[0];
  const lastHour = genHours[genHours.length - 1];
  let daylightSum = 0, daylightCount = 0, daylightPeak = 0;

  // Find exact start/stop time from raw data (minute-level precision)
  let firstMinute = null, lastMinute = null;
  const THRESHOLD = 5; // watts - considered "generating"

  for (const r of pvRows) {
    if (r.value_num == null || r.value_num <= 0) continue;
    const hour = new Date(r.ts * 1000).getHours();
    if (hour >= firstHour && hour <= lastHour) {
      daylightSum += r.value_num;
      daylightCount++;
      if (r.value_num > daylightPeak) daylightPeak = r.value_num;
    }
    // Track exact start/stop minute
    if (r.value_num > THRESHOLD) {
      const d = new Date(r.ts * 1000);
      const minuteTs = d.getHours() * 60 + d.getMinutes();
      if (firstMinute === null || minuteTs < firstMinute) firstMinute = minuteTs;
      if (lastMinute === null || minuteTs > lastMinute) lastMinute = minuteTs;
    }
  }

  function minuteToStr(m) {
    if (m === null) return '--';
    const h = Math.floor(m / 60), min = m % 60;
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  }

  return {
    firstHour, lastHour,
    firstMinute, lastMinute,
    window: minuteToStr(firstMinute) + '-' + minuteToStr(lastMinute),
    genHours: genHours.length,
    daylightAvgW: round2(daylightCount > 0 ? daylightSum / daylightCount : 0),
    daylightPeakW: round2(daylightPeak),
    daylightEff: panelRating > 0 ? round2(daylightPeak / panelRating * 100) : null,
  };
}

// ── Stats / Panel Config / Analysis ────────────────────────
app.get('/api/stats/:sn', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*7);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  res.json(getStats(req.params.sn, fromTs, toTs));
});

app.get('/api/stats/aggregate/all', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*7);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const devices = db.getDevices();
  // Merge daily/hours from all devices
  const mergedDaily = {};
  const mergedHourly = {};
  let totalKwh = 0, bestDay = null, allDays = 0;

  for (const d of devices) {
    const pv1Rows = db.getHistoricalData(d.sn, fromTs, toTs, [361]);
    const pv2Rows = db.getHistoricalData(d.sn, fromTs, toTs, [70]);
    const allPv = [...pv1Rows, ...pv2Rows];
    const daily = computeDailyTotals(allPv);
    const hourly = computeHourlyProfile(allPv, fromTs, toTs);

    for (const [ts, val] of Object.entries(daily)) {
      if (!mergedDaily[ts]) mergedDaily[ts] = { totalKwh: 0, peakW: 0 };
      mergedDaily[ts].totalKwh += val.totalKwh;
      mergedDaily[ts].peakW = Math.max(mergedDaily[ts].peakW, val.peakW);
    }
    for (let h = 0; h < 24; h++) {
      if (!mergedHourly[h]) mergedHourly[h] = { avg: 0, max: 0 };
      mergedHourly[h].avg += hourly[h]?.avg || 0;
      mergedHourly[h].max = Math.max(mergedHourly[h].max, hourly[h]?.max || 0);
    }
    totalKwh += Object.values(daily).reduce((a, b) => a + b.totalKwh, 0);
    allDays = Math.max(allDays, Object.keys(daily).length);
  }

  const deviceCount = devices.length || 1;
  // Average the hourly profiles across devices
  for (let h = 0; h < 24; h++) {
    mergedHourly[h].avg = round2(mergedHourly[h].avg / deviceCount);
  }

  const dailyArr = Object.entries(mergedDaily).map(([ts, d]) => ({
    ts: parseInt(ts), ...d, totalKwh: round2(d.totalKwh),
  })).sort((a, b) => a.ts - b.ts);
  const best = [...dailyArr].sort((a, b) => b.totalKwh - a.totalKwh)[0];
  const peakH = Object.entries(mergedHourly).sort((a, b) => b[1].avg - a[1].avg)[0];

  res.json({
    daily: dailyArr.slice(-30),
    hourlyProfile: mergedHourly,
    bestDay: best || null,
    peakHour: peakH ? { hour: parseInt(peakH[0]), avg: peakH[1].avg, max: peakH[1].max } : null,
    totalKwh: round2(totalKwh),
    avgDailyKwh: round2(allDays ? totalKwh / allDays : 0),
    dayCount: allDays,
    deviceCount,
  });
});

// ── Performance Ratio (industry-standard solar metric) ──────
// PR = actual_kWh / (rated_kW × peak_sun_hours_in_range)
app.get('/api/stats/:sn/pr', authMiddleware, async (req, res) => {
  const { from, to } = req.query;
  const now = Math.floor(Date.now()/1000);
  const fromTs = from ? parseInt(from) : now - 30*86400;
  const toTs = to ? parseInt(to) : now;
  const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
  const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
  const totalKW = (pv1W + pv2W) / 1000;
  if (totalKW <= 0) return res.json({ error: 'Set panel ratings in Setup first' });

  const stats = getStats(req.params.sn, fromTs, toTs);
  const actualKwh = stats.totalKwh;

  // Get peak sun hours from Open-Meteo for each day
  const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
  const lon = db.getSetting('weather_lon') || DEFAULT_LON;
  let totalPeakSunHours = 0, days = 0;

  try {
    for (let dayTs = Math.floor(fromTs/86400)*86400; dayTs < toTs; dayTs += 86400) {
      const date = new Date(dayTs*1000).toISOString().slice(0,10);
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
      const resp = await fetch(url); const data = await resp.json();
      if (data.hourly) {
        const dailyRadiation = data.hourly.shortwave_radiation.reduce((a,b)=>a+(b||0),0);
        totalPeakSunHours += dailyRadiation / 1000; // W/m² sum / 1000 = peak sun hours
        days++;
      }
      if (days % 3 === 0) await new Promise(r => setTimeout(r, 200));
    }
  } catch {}

  const peakSunHours = round2(totalPeakSunHours);
  const expectedKwh = round2(totalKW * peakSunHours);
  const pr = expectedKwh > 0 ? round2(actualKwh / expectedKwh * 100) : null;

  res.json({
    actualKwh, peakSunHours, totalKwRated: round2(totalKW),
    expectedKwh, performanceRatioPct: pr,
    days, rating: pr ? (pr > 80 ? 'Excellent' : pr > 65 ? 'Good' : pr > 50 ? 'Fair' : 'Poor') : null,
  });
});

// ── Comparison mode ─────────────────────────────────────────
app.get('/api/stats/:sn/compare', authMiddleware, (req, res) => {
  const { from1, to1, from2, to2 } = req.query;
  if (!from1 || !to1 || !from2 || !to2) return res.status(400).json({ error: 'Both date ranges required' });
  const s1 = getStats(req.params.sn, parseInt(from1), parseInt(to1));
  const s2 = getStats(req.params.sn, parseInt(from2), parseInt(to2));
  res.json({
    period1: { from: from1, to: to1, ...s1 },
    period2: { from: from2, to: to2, ...s2 },
    deltaKwh: round2(s2.totalKwh - s1.totalKwh),
    deltaPct: s1.totalKwh > 0 ? round2((s2.totalKwh - s1.totalKwh) / s1.totalKwh * 100) : null,
  });
});

// ── Data quality / Uptime ───────────────────────────────────
app.get('/api/stats/:sn/quality', authMiddleware, (req, res) => {
  const stats = getStats(req.params.sn, Math.floor(Date.now()/1000)-7*86400, Math.floor(Date.now()/1000));
  if (!stats.hourlyProfile) return res.json({ error: 'Not enough data' });

  // Count generating hours (where avg > 5W) and check if we have data for them
  let genHours = 0, dataHours = 0;
  for (let h = 0; h < 24; h++) {
    if (stats.hourlyProfile[h]?.avg > 5) genHours++;
  }
  // Check how many of those gen hours have actual data points in the last 7 days
  if (genHours > 0) {
    const now = Math.floor(Date.now()/1000);
    const rows = db.getHistoricalData(req.params.sn, now-7*86400, now, [361]);
    const hoursWithData = new Set();
    for (const r of rows) { if (r.value_num > 0) hoursWithData.add(new Date(r.ts*1000).getHours()); }
    for (let h = 0; h < 24; h++) {
      if (stats.hourlyProfile[h]?.avg > 5 && hoursWithData.has(h)) dataHours++;
    }
  }

  res.json({
    generatingHoursPerDay: genHours,
    hoursWithData: dataHours,
    uptimePct: genHours > 0 ? round2(dataHours / genHours * 100) : null,
    rating: dataHours >= genHours * 0.95 ? 'Excellent' : dataHours >= genHours * 0.8 ? 'Good' : dataHours >= genHours * 0.5 ? 'Fair' : 'Poor',
    period: '7 days',
  });
});

// ── Degradation tracking ────────────────────────────────────
app.get('/api/stats/:sn/degradation', authMiddleware, (req, res) => {
  const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
  const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
  if (pv1W <= 0 && pv2W <= 0) return res.json({ error: 'Set panel ratings first' });

  // Get monthly average efficiency since data began
  const rows = db.default.prepare(
    `SELECT CAST(ts/86400/30 AS INTEGER) as m, AVG(value_num) as avg_w, MAX(value_num) as peak_w
     FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0
     GROUP BY m ORDER BY m ASC LIMIT 36`
  ).all(req.params.sn);

  const totalRated = pv1W + pv2W;
  res.json(rows.map(r => ({
    month: new Date(r.m * 30 * 86400 * 1000).toLocaleDateString('en',{year:'numeric',month:'short'}),
    avgEfficiencyPct: round2(r.avg_w / totalRated * 100),
    peakEfficiencyPct: round2(r.peak_w / totalRated * 100),
    avgWatts: round2(r.avg_w),
    peakWatts: round2(r.peak_w),
    monthBlock: r.m,
  })));
});

// Per-device panel config
app.get('/api/settings/panels/:sn', authMiddleware, (req, res) => {
  res.json({
    pv1_rated_watts: parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts') || '0'),
    pv2_rated_watts: parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts') || '0'),
  });
});
app.post('/api/settings/panels/:sn', authMiddleware, (req, res) => {
  const { pv1_rated_watts, pv2_rated_watts } = req.body;
  if (pv1_rated_watts !== undefined) db.setDeviceConfig(req.params.sn, 'pv1_rated_watts', String(pv1_rated_watts));
  if (pv2_rated_watts !== undefined) db.setDeviceConfig(req.params.sn, 'pv2_rated_watts', String(pv2_rated_watts));
  res.json({ success: true });
});

// ── Enhanced Stats (yesterday, CO2, monthly, best day) ─────
const CO2_KG_PER_KWH = 0.233; // UK grid average

app.get('/api/stats/:sn/enhanced', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const now = Math.floor(Date.now()/1000);
  const todayStart = Math.floor(now/86400)*86400;
  const yesterdayStart = todayStart - 86400;
  const fromTs = from ? parseInt(from) : todayStart;
  const toTs = to ? parseInt(to) : now;

  const today = getStats(req.params.sn, todayStart, now);
  const yesterday = getStats(req.params.sn, yesterdayStart, todayStart);
  const rangeStats = getStats(req.params.sn, fromTs, toTs);

  // CO2
  const co2Kg = round2(today.totalKwh * CO2_KG_PER_KWH);
  const co2TotalKg = round2(rangeStats.totalKwh * CO2_KG_PER_KWH);

  // Comparison
  const vsYesterday = yesterday.totalKwh > 0 ? round2((today.totalKwh - yesterday.totalKwh) / yesterday.totalKwh * 100) : null;

  // Best day of all time
  const allTime = db.default.prepare(
    `SELECT ts, SUM(value_num*2)/3600000 as kwh FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 GROUP BY (ts/86400) ORDER BY kwh DESC LIMIT 1`
  ).get(req.params.sn);
  const bestDay = allTime ? { date: allTime.ts, kwh: round2(allTime.kwh) } : null;

  // Consecutive days streak
  const days = db.default.prepare(
    `SELECT DISTINCT CAST(ts/86400 AS INTEGER) as day FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num > 0 ORDER BY day DESC LIMIT 365`
  ).all(req.params.sn);
  let streak=0;
  for(let i=0;i<days.length-1;i++){
    if(days[i].day-days[i+1].day===1)streak++;
    else break;
  }
  streak=Math.max(0,streak);

  res.json({
    today,
    yesterday,
    vsYesterdayPct: vsYesterday,
    co2SavingKgToday: co2Kg,
    co2SavingKgTotal: co2TotalKg,
    co2PerKwh: CO2_KG_PER_KWH,
    bestDayAllTime: bestDay,
    generationStreak: streak,
    ...rangeStats,
  });
});

// Hourly overlay — last N days for week-overlay chart
app.get('/api/stats/:sn/hourly-overlay', authMiddleware, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 30);
  const now = Math.floor(Date.now()/1000);
  const todayStart = Math.floor(now/86400)*86400;
  const profiles = [];
  for (let d = 0; d < days; d++) {
    const dayStart = todayStart - d * 86400;
    const dayEnd = dayStart + 86400;
    const stats = getStats(req.params.sn, dayStart, Math.min(dayEnd, now));
    const date = new Date(dayStart*1000);
    const label = d === 0 ? 'Today' : date.toLocaleDateString('en',{weekday:'short'});
    profiles.push({
      dayTs: dayStart,
      label,
      date: date.toISOString().slice(0,10),
      isToday: d === 0,
      hourly: stats.hourlyProfile,
      totalKwh: stats.totalKwh,
    });
  }
  res.json(profiles.reverse());
});

// Monthly aggregates
app.get('/api/stats/:sn/monthly', authMiddleware, (req, res) => {
  const rows = db.default.prepare(
    `SELECT CAST(ts/86400 AS INTEGER)/30 as month_block, SUM(value_num*2)/3600000 as kwh, MAX(value_num) as peak
     FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0
     GROUP BY month_block ORDER BY month_block DESC LIMIT 24`
  ).all(req.params.sn);
  res.json(rows.map(r => ({
    month: new Date(r.month_block*30*86400*1000).toLocaleDateString('en',{year:'numeric',month:'short'}),
    kwh: round2(r.kwh), peakW: round2(r.peak),
  })));
});

// Weather proxy (Open-Meteo free API)
app.get('/api/weather', authMiddleware, (req, res) => {
  const lat = req.query.lat || db.getSetting('weather_lat') || DEFAULT_LAT;
  const lon = req.query.lon || db.getSetting('weather_lon') || DEFAULT_LON;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover,shortwave_radiation&timezone=auto&forecast_days=1`;
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

// Generation forecast using learned radiation model
app.get('/api/forecast/:sn', authMiddleware, async (req, res) => {
  const now = Math.floor(Date.now()/1000);
  const todayStart = Math.floor(now/86400)*86400;
  const currentHour = new Date().getHours();
  const stats = getStats(req.params.sn, todayStart, now);
  const model = db.getModelStats(req.params.sn);
  const factor = model?.avg_factor || 0.42; // fallback: typical UK panel factor

  const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
  const lon = db.getSetting('weather_lon') || DEFAULT_LON;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation,cloud_cover&timezone=auto&forecast_days=1`;
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
      // radiation (W/m²) × factor = predicted watts
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

// ── Radiation Model Training ─────────────────────────────────
// Backfill historical radiation data and compute learned conversion factor
app.post('/api/model/:sn/train', authMiddleware, async (req, res) => {
  try {
    const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
    const lon = db.getSetting('weather_lon') || DEFAULT_LON;
    let trained = 0;

    // Get each day's hourly production data
    const days = db.default.prepare(
      `SELECT DISTINCT CAST(ts/86400 AS INTEGER) as day FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 ORDER BY day DESC LIMIT 14`
    ).all(req.params.sn);

    for (const { day } of days) {
      const dayStart = day * 86400;
      const dayEnd = dayStart + 86400;

      // Check if we already have data for this day
      const existing = db.default.prepare(
        'SELECT COUNT(*) as c FROM radiation_data WHERE device_sn=? AND hour_ts >= ? AND hour_ts < ?'
      ).get(req.params.sn, dayStart, dayEnd);
      if (existing?.c > 0) continue;

      // Fetch historical radiation for this day
      const date = new Date(dayStart * 1000).toISOString().slice(0,10);
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data.hourly) continue;

      // Build radiation map for this day
      const radByHour = {};
      data.hourly.time.forEach((t, i) => {
        const h = new Date(t).getHours();
        const rad = data.hourly.shortwave_radiation[i] || 0;
        radByHour[h] = rad;
      });

      // Get actual production for each hour
      for (let h = 0; h < 24; h++) {
        const hourTs = dayStart + h * 3600;
        const rows = db.getHistoricalData(req.params.sn, hourTs, hourTs + 3599, [361, 70]);
        const prodSum = rows.reduce((sum, r) => sum + (r.value_num || 0), 0);
        const prodCount = rows.filter(r => r.value_num > 0).length;
        if (prodCount < 10) continue; // skip hours with no real data
        const avgProd = prodSum / prodCount;
        const rad = radByHour[h] || 0;
        if (rad < 10) continue; // skip nighttime / no radiation
        const factor = round4(avgProd / rad);
        db.upsertRadiationPair(req.params.sn, hourTs, rad, round2(avgProd), factor);
        trained++;
      }

      // Rate limit: 1 request per second
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
    // Recent hourly pairs
    recentPairs: recent.slice(0, 24).map(r => ({
      hour: new Date(r.hour_ts*1000).toISOString(),
      radiation: r.radiation_wm2,
      production: r.production_w,
      factor: round4(r.factor),
    })),
    // Full history for scatter chart
    historyPairs: history.map(r => ({
      hour: new Date(r.hour_ts*1000).toISOString(),
      radiation: r.radiation_wm2,
      production: r.production_w,
      factor: round4(r.factor),
    })),
    // Prediction accuracy
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

function round4(v) { return Math.round(v * 10000) / 10000; }

// ── Weather location settings ────────────────────────────────
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

// ── Home Assistant MQTT Bridge ─────────────────────────────
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

// ── System Health ──────────────────────────────────────────
app.get('/api/system/health', authMiddleware, (req, res) => {
  const { size: dbStats } = fs.statSync(DB_PATH);
  const dbSizeMb = (dbStats / 1024 / 1024).toFixed(1);
  const totalRows = db.default ? db.default.prepare('SELECT COUNT(*) as c FROM data').get().c : 0;
  const devices = db.getDevices().length;
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const diskFree = (() => {
    try {
      // statfs is Linux-only, fall back gracefully
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

// ── Start HA MQTT on startup ──────────────────────────────
(async () => {
  const enabled = db.getSetting('ha_mqtt_enabled') === 'true';
  if (enabled) {
    const host = db.getSetting('ha_mqtt_host');
    if (host) {
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

// ── Grid Meter (ESPHome Sonoff POWCT) ──────────────────────
const gridMeter = new GridMeter();

gridMeter.on('data', (data) => {
  const { ts, power_w, energy_kwh, voltage_v, current_a } = data;
  if (power_w != null || energy_kwh != null) {
    try { db.insertGridReading(ts, power_w, energy_kwh, voltage_v, current_a); } catch {}
  }
  // Broadcast to WebSocket clients
  const msg = JSON.stringify({ type: 'grid', ts, power_w, energy_kwh, voltage_v, current_a });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  // Home Assistant MQTT
  publishHaGridMeter(data);
});

app.get('/api/settings/grid-meter', authMiddleware, (req, res) => {
  res.json({
    enabled: db.getSetting('grid_meter_enabled') === 'true',
    ip: db.getSetting('grid_meter_ip') || '',
    interval: parseInt(db.getSetting('grid_meter_interval') || '10'),
    connected: !!gridMeter.lastData,
    lastPower: gridMeter.lastData?.power_w || null,
    lastEnergy: gridMeter.lastData?.energy_kwh || null,
    lastTs: gridMeter.lastData?.ts || null,
  });
});
app.post('/api/settings/grid-meter', authMiddleware, (req, res) => {
  const { enabled, ip, interval } = req.body;
  db.setSetting('grid_meter_enabled', enabled ? 'true' : 'false');
  if (ip) db.setSetting('grid_meter_ip', ip);
  if (interval) db.setSetting('grid_meter_interval', String(interval));
  if (enabled && ip) {
    gridMeter.configure({ enabled: true, ip, interval: parseInt(interval||'10') });
  } else {
    gridMeter.stop();
  }
  res.json({ success: true });
});
app.get('/api/grid-meter/latest', authMiddleware, (req, res) => {
  const latest = db.getLatestGridReading();
  res.json(latest || { power_w: null, energy_kwh: null });
});
app.get('/api/grid-meter/test', authMiddleware, async (req, res) => {
  const ip = db.getSetting('grid_meter_ip') || '192.168.150.202';
  const results = {};
  for (const id of ['power', 'voltage', 'current', 'total_daily_energy']) {
    try {
      const r = await fetch(`http://${ip}/sensor/${id}`, { signal: AbortSignal.timeout(3000) });
      results[id] = { status: r.status, body: await r.text().catch(()=>'parse error') };
    } catch(e) { results[id] = { error: e.message }; }
    try {
      // Also try with full sensor- prefix
      const r2 = await fetch(`http://${ip}/sensor/sensor-${id}`, { signal: AbortSignal.timeout(2000) });
      if (r2.ok) {
        const d = await r2.json().catch(()=>({}));
        results[`sensor-${id}`] = { status: r2.status, value: d.value, state: d.state };
      }
    } catch {}
    try {
      // Try root /
      const r3 = await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(2000) });
      results['_root'] = { status: r3.status, length: (await r3.text()).length };
    } catch {}
  }
  res.json({ ip, results, lastData: gridMeter.lastData });
});
app.get('/api/grid-meter/history', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  res.json(db.getGridData(fromTs, toTs));
});

// Grid meter stats
app.get('/api/grid-meter/stats', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
  const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
  const rows = db.getGridData(fromTs, toTs);
  if (!rows || rows.length < 2) return res.json({ error: 'No grid data' });

  let totalImport = 0, totalExport = 0, peakImport = 0, lastTs = null;
  const daily = {}, hourly = {};
  for (const r of rows) {
    if (r.power_w == null) continue;
    if (lastTs !== null) {
      const intervalHours = (r.ts - lastTs) / 3600;
      if (intervalHours > 0 && intervalHours < 1) {
        if (r.power_w > 5) totalImport += (r.power_w * intervalHours) / 1000;
        else if (r.power_w < -5) totalExport += (Math.abs(r.power_w) * intervalHours) / 1000;
        if (r.power_w > peakImport) peakImport = r.power_w;
      }
    }
    lastTs = r.ts;
    // Daily breakdown
    const day = Math.floor(r.ts / 86400) * 86400;
    if (!daily[day]) daily[day] = { importKwh: 0, exportKwh: 0, peakW: 0 };
    const h = new Date(r.ts * 1000).getHours();
    if (!hourly[h]) hourly[h] = { sum: 0, count: 0 };
    hourly[h].sum += r.power_w;
    hourly[h].count++;
  }

  // Complete daily tracking
  let lastDayTs = null;
  for (const r of rows) {
    if (r.power_w == null) continue;
    const day = Math.floor(r.ts / 86400) * 86400;
    if (lastDayTs !== null && lastDayTs !== day) {
      const intervalH = (r.ts - lastDayTs) / 3600;
      if (intervalH > 0 && intervalH < 1) {
        if (r.power_w > 5) daily[day].importKwh += (r.power_w * intervalH) / 1000;
        else if (r.power_w < -5) daily[day].exportKwh += (Math.abs(r.power_w) * intervalH) / 1000;
        if (r.power_w > daily[day].peakW) daily[day].peakW = r.power_w;
      }
    }
    lastDayTs = r.ts;
  }

  const dailyArr = Object.entries(daily).map(([ts, d]) => ({
    date: new Date(parseInt(ts)*1000).toLocaleDateString().slice(0,5),
    ts: parseInt(ts),
    importKwh: round2(d.importKwh),
    exportKwh: round2(d.exportKwh),
    peakW: round2(d.peakW),
  })).sort((a,b) => a.ts - b.ts);

  const hourlyArr = Array.from({length: 24}, (_, h) => ({
    hour: `${h}:00`,
    avgW: hourly[h] ? round2(hourly[h].sum / hourly[h].count) : 0,
    peakW: hourly[h] ? round2(Math.max(...rows.filter(r=>new Date(r.ts*1000).getHours()===h).map(r=>r.power_w||0))) : 0,
  }));

  const rate = db.getCurrentRate();
  const price = rate ? rate.price_per_kwh : 0;

  res.json({
    totalImportKwh: round2(totalImport),
    totalExportKwh: round2(totalExport),
    peakImportW: round2(peakImport),
    importCost: round2(totalImport * price),
    exportValue: round2(totalExport * price),
    netCost: round2((totalImport - totalExport) * price),
    rate: price,
    daily: dailyArr.slice(-30),
    hourly: hourlyArr,
    sampleCount: rows.length,
  });
});

// Auto-start grid meter on startup (delay for server init)
setTimeout(() => {
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

// ── Export Routes ───────────────────────────────────────────
app.get('/api/export/:sn', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const fromTs = from ? parseInt(from) : 0;
  const toTs = to ? parseInt(to) : Math.floor(Date.now() / 1000);

  const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, null);
  if (!rows || rows.length === 0) {
    return res.status(404).json({ error: 'No data for this period' });
  }

  // Build CSV with labeled columns in display order
  const allFieldNums = new Set();
  for (const r of rows) allFieldNums.add(r.field_num);

  // Column order: timestamp, then display order fields, then unknown fields
  const orderedFields = [
    ...DISPLAY_ORDER.filter(f => allFieldNums.has(f)),
    ...[...allFieldNums].filter(f => !DISPLAY_ORDER.includes(f)).sort((a, b) => a - b),
  ];

  const header = ['timestamp', ...orderedFields.map(f => getCsvLabel(f))];

  // Group rows by timestamp
  const byTs = {};
  for (const r of rows) {
    if (!byTs[r.ts]) byTs[r.ts] = {};
    const val = r.value_text || r.value_num;
    byTs[r.ts][r.field_num] = val != null ? val : '';
  }

  const csvRows = [header.join(',')];
  for (const ts of Object.keys(byTs).sort()) {
    const row = [new Date(parseInt(ts) * 1000).toISOString()];
    for (const f of orderedFields) {
      const val = byTs[ts][f];
      row.push(val !== undefined ? val : '');
    }
    csvRows.push(row.join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="ecoflow_${req.params.sn}.csv"`);
  res.send(csvRows.join('\n'));
});

// ── Grid Meter Export ──────────────────────────────────────
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

// ── DB Backup / Restore ────────────────────────────────────
app.get('/api/db/export', adminMiddleware, (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'Database not found' });
  try {
    // Flush WAL to main DB file so we get a consistent snapshot
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
    // Validate it's a SQLite file by checking magic header
    if (body.slice(0,16).toString('utf8') !== 'SQLite format 3\0') {
      return res.status(400).json({ error: 'Not a valid SQLite database file' });
    }
    const bakPath = DB_PATH + '.bak';
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, bakPath);
    fs.writeFileSync(DB_PATH, body);
    // Send success, then exit — systemd/process manager will restart us with the new DB
    res.json({ success: true, size: body.length, message: 'Database restored. Server restarting...' });
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket ───────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'status', connected: mqttClient.connected, stats: mqttClient.getStats() }));

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// Broadcast live data to all WebSocket clients
mqttClient.on('data', ({ sn, fields }) => {
  const msg = JSON.stringify({ type: 'data', sn, fields, ts: Math.floor(Date.now() / 1000) });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  // Also publish to Home Assistant MQTT if configured
  publishState(sn, fields, true);
});

mqttClient.on('state', (state) => {
  const msg = JSON.stringify({ type: 'status', ...state, stats: mqttClient.getStats() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

// ── Device Control: Trigger full data upload ────────────────
app.post('/api/device/:sn/full-upload', authMiddleware, (req, res) => {
  const config = db.getMqttConfig();
  if (!config || !mqttClient.connected) return res.status(503).json({ error: 'MQTT not connected' });
  // Build ConfigWrite protobuf with activeDisplayPropertyFullUpload=true (field 71)
  const pdata = encodeVarintField(71, 1); // field 71, varint true=1
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
  // cfgDebugModeEnable = field 223
  const pdata = encodeVarintField(223, enable ? 1 : 0);
  const header = buildProtoHeader({ pdata, cmd_func: 254, cmd_id: 17, need_ack: 1 });
  const msg = wrapHeaderMessage(header);
  const topic = `/app/${config.user_id}/${req.params.sn}/thing/property/set`;
  mqttClient.client.publish(topic, msg, { qos: 0 });
  console.log(`[Device] Set debug mode=${enable} on ${req.params.sn}`);
  res.json({ success: true, debugMode: enable });
});

// Proto encoding helpers
function encodeVarintField(fieldNum, value) {
  const buf = [];
  // Tag: (fieldNum << 3) | wire_type (0 for varint)
  let tag = (fieldNum << 3) | 0;
  while (tag > 0x7f) { buf.push((tag & 0x7f) | 0x80); tag >>>= 7; }
  buf.push(tag);
  // Value as varint
  let v = value;
  while (v > 0x7f) { buf.push((v & 0x7f) | 0x80); v >>>= 7; }
  buf.push(v);
  return Buffer.from(buf);
}

function buildProtoHeader({ pdata, cmd_func, cmd_id, need_ack, seq }) {
  // Encode inner Header proto with pdata, cmd_func, cmd_id, need_ack
  let inner = pdata ? Buffer.concat([
    encodeVarintField(1, pdata.length), pdata // field 1 (pdata, length-delimited)
  ]) : Buffer.alloc(0);
  inner = Buffer.concat([
    inner,
    encodeVarintField(8, cmd_func || 254),  // cmd_func
    encodeVarintField(9, cmd_id || 17),      // cmd_id
    need_ack ? encodeVarintField(11, 1) : Buffer.alloc(0), // need_ack
    encodeVarintField(14, seq || Math.floor(Date.now() / 1000) % 100000), // seq
    encodeVarintField(2, 32),  // src = 32 (app)
    encodeVarintField(3, 2),   // dest = 2 (device)
    encodeVarintField(16, 3),  // version = 3
    encodeVarintField(17, 1),  // payload_ver = 1
  ]);
  return inner;
}

function wrapHeaderMessage(header) {
  // Outer HeaderMessage with repeated Header
  return Buffer.concat([encodeVarintField(1, header.length), header]);
}

// ── MQTT restart helper ─────────────────────────────────────
let mqttFailCount = 0;
let mqttLastFailTime = 0;

function restartMqtt() {
  const config = db.getMqttConfig();
  const devices = db.getDevices();
  if (!config || devices.length === 0) {
    mqttClient.disconnect();
    return;
  }
  mqttClient.disconnect();
  mqttClient.connect(config, devices);
}

// Auto-refresh MQTT credentials when connection keeps failing
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

// ── Data logger ─────────────────────────────────────────────
const deviceMsgTimes = {};
const deviceLastPower = {};

// Seed with known devices on startup so idle detection covers them immediately
const knownDevices = db.getDevices() || [];
for (const d of knownDevices) {
  deviceMsgTimes[d.sn] = Math.floor(Date.now() / 1000);
}

mqttClient.on('data', ({ sn, fields }) => {
  const ts = Math.floor(Date.now() / 1000);
  deviceMsgTimes[sn] = ts;
  // Track if we had actual generation
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

// ── Hourly rollup scheduler ────────────────────────────────
setInterval(() => {
  const devices = db.getDevices();
  for (const d of devices) {
    try { runHourlyRollup(d.sn); } catch (e) { /* skip */ }
  }
}, 15 * 60 * 1000);

// ── Model auto-train (every 6 hours, offset from rollup) ───
async function autoTrain() {
  const devices = db.getDevices();
  if (devices.length === 0) return;
  const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
  const lon = db.getSetting('weather_lon') || DEFAULT_LON;
  for (const d of devices) {
    try {
      const model = db.getModelStats(d.sn);
      const hourAgo = Math.floor(Date.now()/1000) - 3600;
      // Check if we need training: less than 50 samples, or last trained > 6h ago
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
          const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
          try {
            const resp = await fetch(url);
            const data = await resp.json();
            if (!data.hourly) continue;
            const radByHour = {};
            data.hourly.time.forEach((t, i) => {
              radByHour[new Date(t).getHours()] = data.hourly.shortwave_radiation[i] || 0;
});

app.post('/api/savings/night-rate', authMiddleware, (req, res) => {
  const { price_per_kwh, start_hour, end_hour } = req.body;
  if (price_per_kwh) db.setSetting('night_rate', String(price_per_kwh));
  if (start_hour != null) db.setSetting('night_start', String(start_hour));
  if (end_hour != null) db.setSetting('night_end', String(end_hour));
  res.json({ success: true });
});

app.get('/api/savings/night-rate', authMiddleware, (req, res) => {
  res.json({
    enabled: db.getSetting('night_rate') ? true : false,
    price_per_kwh: parseFloat(db.getSetting('night_rate') || '0'),
    start_hour: parseInt(db.getSetting('night_start') || '23'),
    end_hour: parseInt(db.getSetting('night_end') || '6'),
  });
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
            await new Promise(r => setTimeout(r, 1200));
          } catch { continue; }
        }
        if (trained > 0) console.log(`[Model] Trained ${d.sn}: ${trained} new pairs`);
      }
    } catch (e) { /* skip */ }
  }
}
setTimeout(() => autoTrain().catch(()=>{}), 30000); // run 30s after startup
setInterval(() => autoTrain().catch(()=>{}), 6 * 3600 * 1000);

// Track daily prediction vs actual accuracy
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
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
      const resp = await fetch(url); const data = await resp.json();
      if (!data.hourly) continue;
      let predictedKwh = 0;
      for (let h = 0; h < 24; h++) predictedKwh += (data.hourly.shortwave_radiation?.[h]||0) * factor / 1000;
      db.upsertAccuracy(d.sn, yesterdayStart, round2(predictedKwh), round2(actualKwh));
    } catch (e) { /* skip */ }
  }
}
setInterval(() => trackDailyAccuracy().catch(()=>{}), 2 * 3600 * 1000);
setTimeout(() => trackDailyAccuracy().catch(()=>{}), 60000);

// ── Periodic HA stats publish ──────────────────────────────
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
      const co2Kg = stats.totalKwh * 0.233; // UK grid carbon intensity kg/kWh
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
setInterval(() => publishPeriodicHaStats().catch(()=>{}), 5 * 60 * 1000);
setTimeout(() => publishPeriodicHaStats().catch(()=>{}), 30000);

// ── Periodic HA prediction publish ─────────────────────────
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&timezone=auto&forecast_days=1`;
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
setInterval(() => publishPeriodicHaPrediction().catch(()=>{}), 15 * 60 * 1000);
setTimeout(() => publishPeriodicHaPrediction().catch(()=>{}), 60000);

// ── MQTT watchdog ───────────────────────────────────────────
setInterval(async () => {
  if (mqttClient.connected && mqttClient.lastDataTime) {
    const idle = (Date.now() / 1000) - mqttClient.lastDataTime;
    if (idle > 45) {
      const hour = new Date().getHours();
      const isDaytime = hour >= 6 && hour <= 21;
      if (isDaytime) console.log(`[MQTT] No data for ${Math.round(idle)}s — reconnecting`);
      mqttFailCount++;
      mqttLastFailTime = Date.now();
      if (mqttFailCount >= 3 && idle > 60 && isDaytime) {
        const refreshed = await autoRefreshCredentials();
        if (!refreshed) restartMqtt();
      } else {
        restartMqtt();
      }
    }
  } else if (!mqttClient.connected) {
    if (!mqttLastFailTime) mqttLastFailTime = Date.now();
    const disconnectedSec = (Date.now() - mqttLastFailTime) / 1000;
    if (disconnectedSec > 90 && mqttFailCount < 3) {
      mqttFailCount = 3;
      await autoRefreshCredentials();
    }
  } else {
    if (mqttFailCount > 0 && mqttClient.lastDataTime && (Date.now()/1000 - mqttClient.lastDataTime) < 10) {
      mqttFailCount = 0;
      mqttLastFailTime = 0;
    }
  }
}, 5000);

// ── Device idle detection ──────────────────────────────────
const POWER_FIELDS = [361, 70, 616]; // PV1, PV2, Grid
const IDLE_TIMEOUT = 120;
const idleSent = {}; // track last time we sent idle zeros per device

setInterval(() => {
  const now = Date.now() / 1000;
  const devices = db.getDevices();
  for (const d of devices) {
    const sn = d.sn;
    // Ensure we have an entry
    if (!deviceMsgTimes[sn]) deviceMsgTimes[sn] = 0;
    const idle = now - deviceMsgTimes[sn];
    if (idle > IDLE_TIMEOUT) {
      const lastSent = idleSent[sn] || 0;
      if (now - lastSent < 55) continue; // only emit every ~60s
      idleSent[sn] = now;
      const zeros = {};
      for (const f of POWER_FIELDS) zeros[f] = 0;
      const msg = JSON.stringify({ type: 'data', sn, fields: zeros, ts: Math.floor(now), idle: true });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(msg);
      }
      // Alert only if device was generating recently (within last 6 hours) and suddenly stopped
      // Don't alert at night or if already alerted recently
      const alertCooldown = {}; // sn -> last alert timestamp
      const hour = new Date().getHours();
      const wasGenerating = deviceLastPower[sn] && (now - deviceLastPower[sn]) < 21600; // 6 hours
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
}, 5000);

// ── Auto-connect on startup ─────────────────────────────────
restartMqtt();

// ── Developer API MQTT (JSON broker, richer data) ──────────
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

      // Unwrap nested JSON to flat key→value
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

      // Pass labeled data directly — field numbers resolved on frontend
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

setTimeout(() => {
  if (db.getSetting('dev_api_access_key')) startDevMqtt().catch(e => console.error('[DevMQTT] Start failed:', e));
}, 15000);

// ── SPA fallback ────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return;
  if (process.env.NODE_ENV === 'production') {
    res.sendFile(join(DIST_DIR, 'index.html'));
  } else {
    res.json({ message: 'EcoFlow Monitor API — frontend dev server handles UI' });
  }
});

server.listen(PORT, () => {
  console.log(`[Server] EcoFlow Monitor running on http://localhost:${PORT}`);
  console.log(`[Server] JWT secret: ${JWT_SECRET.substring(0, 8)}...`);
});
