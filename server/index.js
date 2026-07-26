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
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'ecoflow.db');
const DIST_DIR = join(__dirname, '..', 'dist');

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
    // Restart MQTT with new creds
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
    email: config?.email,
    connected: mqttClient.connected,
    stats: mqttClient.getStats(),
  });
});

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
  res.json({ latest, range });
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

  for (const r of pvRows) {
    if (r.value_num == null || r.value_num <= 0) continue;
    const hour = new Date(r.ts * 1000).getHours();
    if (hour >= firstHour && hour <= lastHour) {
      daylightSum += r.value_num;
      daylightCount++;
      if (r.value_num > daylightPeak) daylightPeak = r.value_num;
    }
  }

  return {
    firstHour, lastHour,
    window: `${String(firstHour).padStart(2,'0')}:00-${String(lastHour).padStart(2,'0')}:00`,
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
    db.default.close();
    const bakPath = DB_PATH + '.bak';
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, bakPath);
    fs.writeFileSync(DB_PATH, body);
    const Database = (await import('better-sqlite3')).default;
    db.default = new Database(DB_PATH);
    db.default.pragma('journal_mode = WAL');
    db.default.pragma('foreign_keys = ON');
    setImmediate(restartMqtt);
    res.json({ success: true, size: body.length });
  } catch (e) {
    try {
      const Database = (await import('better-sqlite3')).default;
      db.default = new Database(DB_PATH);
      db.default.pragma('journal_mode = WAL');
    } catch {}
    setImmediate(restartMqtt);
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
});

mqttClient.on('state', (state) => {
  const msg = JSON.stringify({ type: 'status', ...state, stats: mqttClient.getStats() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

// ── MQTT restart helper ─────────────────────────────────────
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

// ── Data logger ─────────────────────────────────────────────
mqttClient.on('data', ({ sn, fields }) => {
  const ts = Math.floor(Date.now() / 1000);
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
}, 15 * 60 * 1000); // every 15 min

// ── MQTT watchdog ───────────────────────────────────────────
setInterval(() => {
  if (mqttClient.connected && mqttClient.lastDataTime) {
    const idle = (Date.now() / 1000) - mqttClient.lastDataTime;
    if (idle > 45) {
      console.log(`[MQTT] No data for ${Math.round(idle)}s — reconnecting`);
      restartMqtt();
    }
  }
}, 5000);

// ── Auto-connect on startup ─────────────────────────────────
restartMqtt();

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
