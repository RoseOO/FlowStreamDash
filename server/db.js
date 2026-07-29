import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'ecoflow.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS mqtt_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT, port INTEGER,
    username TEXT, password TEXT,
    user_id TEXT,
    email TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS devices (
    sn TEXT PRIMARY KEY,
    name TEXT,
    type TEXT DEFAULT 'stream_inverter',
    added_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    device_sn TEXT NOT NULL,
    field_num INTEGER NOT NULL,
    value_num REAL,
    value_text TEXT,
    FOREIGN KEY (device_sn) REFERENCES devices(sn)
  );
  CREATE INDEX IF NOT EXISTS idx_data_ts ON data(ts);
  CREATE INDEX IF NOT EXISTS idx_data_dev ON data(device_sn);
  CREATE INDEX IF NOT EXISTS idx_data_field ON data(device_sn, field_num, ts);

  CREATE TABLE IF NOT EXISTS hourly (
    device_sn TEXT NOT NULL,
    hour_ts INTEGER NOT NULL,
    field_num INTEGER NOT NULL,
    avg_val REAL, min_val REAL, max_val REAL, total_val REAL, count_val INTEGER,
    PRIMARY KEY (device_sn, hour_ts, field_num),
    FOREIGN KEY (device_sn) REFERENCES devices(sn)
  );

  CREATE TABLE IF NOT EXISTS daily (
    device_sn TEXT NOT NULL,
    day_ts INTEGER NOT NULL,
    field_num INTEGER NOT NULL,
    avg_val REAL, min_val REAL, max_val REAL, total_val REAL, count_val INTEGER,
    PRIMARY KEY (device_sn, day_ts, field_num),
    FOREIGN KEY (device_sn) REFERENCES devices(sn)
  );

  CREATE TABLE IF NOT EXISTS device_config (
    device_sn TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (device_sn, key),
    FOREIGN KEY (device_sn) REFERENCES devices(sn)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS radiation_data (
    device_sn TEXT NOT NULL,
    hour_ts INTEGER NOT NULL,
    radiation_wm2 REAL,
    production_w REAL,
    factor REAL,
    PRIMARY KEY (device_sn, hour_ts),
    FOREIGN KEY (device_sn) REFERENCES devices(sn)
  );

  CREATE TABLE IF NOT EXISTS model_accuracy (
    device_sn TEXT NOT NULL,
    day_ts INTEGER NOT NULL,
    predicted_kwh REAL,
    actual_kwh REAL,
    error_pct REAL,
    PRIMARY KEY (device_sn, day_ts),
    FOREIGN KEY (device_sn) REFERENCES devices(sn)
  );

  CREATE TABLE IF NOT EXISTS grid_meter_data (
    ts INTEGER PRIMARY KEY,
    power_w REAL,
    energy_kwh REAL,
    voltage_v REAL,
    current_a REAL
  );
  CREATE INDEX IF NOT EXISTS idx_grid_ts ON grid_meter_data(ts);

  CREATE TABLE IF NOT EXISTS rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    valid_from INTEGER NOT NULL,
    price_per_kwh REAL NOT NULL,
    currency TEXT DEFAULT 'GBP'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migrate: add total_val to hourly if missing (can happen on older DBs)
try { db.exec('ALTER TABLE hourly ADD COLUMN total_val REAL'); } catch (e) { if (!e.message?.includes('duplicate column name')) console.error('Migration error (hourly total_val):', e.message); }
try { db.exec('ALTER TABLE daily ADD COLUMN total_val REAL'); } catch (e) { if (!e.message?.includes('duplicate column name')) console.error('Migration error (daily total_val):', e.message); }
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch (e) { if (!e.message?.includes('duplicate column name')) console.error('Migration error (users is_admin):', e.message); }
try { db.exec('ALTER TABLE grid_meter_data ADD COLUMN voltage_v REAL'); } catch (e) { if (!e.message?.includes('duplicate column name')) console.error('Migration error (grid_meter_data voltage_v):', e.message); }
try { db.exec('ALTER TABLE grid_meter_data ADD COLUMN current_a REAL'); } catch (e) { if (!e.message?.includes('duplicate column name')) console.error('Migration error (grid_meter_data current_a):', e.message); }

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// Per-device config
export function getDeviceConfig(sn, key) {
  const row = db.prepare('SELECT value FROM device_config WHERE device_sn = ? AND key = ?').get(sn, key);
  return row ? row.value : null;
}
export function setDeviceConfig(sn, key, value) {
  db.prepare('INSERT OR REPLACE INTO device_config (device_sn, key, value) VALUES (?, ?, ?)').run(sn, key, value);
}

export function getDb() { return db; }

// ── API Keys ────────────────────────────────────────────────
export function listApiKeys() {
  return db.prepare('SELECT id, name, created_at FROM api_keys ORDER BY id').all();
}
export function createApiKey(name, key) {
  return db.prepare('INSERT INTO api_keys (name, key, created_at) VALUES (?, ?, ?)')
    .run(name, key, Math.floor(Date.now() / 1000));
}
export function deleteApiKey(id) {
  return db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}
export function validateApiKey(key) {
  return db.prepare('SELECT id, name FROM api_keys WHERE key = ?').get(key);
}

// ── Radiation Model ─────────────────────────────────────────
export function getRadiationPairs(sn, limit=500) {
  return db.prepare(
    'SELECT hour_ts, radiation_wm2, production_w, factor FROM radiation_data WHERE device_sn=? AND production_w>0 AND radiation_wm2>0 ORDER BY hour_ts DESC LIMIT ?'
  ).all(sn, limit);
}
export function upsertRadiationPair(sn, hourTs, radiation, production, factor) {
  db.prepare(
    'INSERT OR REPLACE INTO radiation_data (device_sn, hour_ts, radiation_wm2, production_w, factor) VALUES (?,?,?,?,?)'
  ).run(sn, hourTs, radiation, production, factor);
}
export function getModelStats(sn) {
  const rows = db.prepare(
    'SELECT AVG(factor) as avg_factor, COUNT(*) as samples, AVG(production_w) as avg_prod, AVG(radiation_wm2) as avg_rad FROM radiation_data WHERE device_sn=? AND production_w>0 AND radiation_wm2>0'
  ).get(sn);
  return rows?.samples ? rows : null;
}
export function getRadiationHistory(sn, limit=50) {
  return db.prepare(
    'SELECT hour_ts, radiation_wm2, production_w, factor FROM radiation_data WHERE device_sn=? ORDER BY hour_ts ASC LIMIT ?'
  ).all(sn, limit);
}
export function upsertAccuracy(sn, dayTs, predicted, actual) {
  const error = actual > 0 ? ((predicted - actual) / actual * 100) : null;
  db.prepare(
    'INSERT OR REPLACE INTO model_accuracy (device_sn, day_ts, predicted_kwh, actual_kwh, error_pct) VALUES (?,?,?,?,?)'
  ).run(sn, dayTs, predicted, actual, error);
}
export function getAccuracyHistory(sn, limit=90) {
  return db.prepare(
    'SELECT day_ts, predicted_kwh, actual_kwh, error_pct FROM model_accuracy WHERE device_sn=? ORDER BY day_ts DESC LIMIT ?'
  ).all(sn, limit);
}
export function getAccuracyStats(sn, days=30) {
  const cutoff = Math.floor(Date.now()/1000) - days * 86400;
  return db.prepare(
    'SELECT COUNT(*) as days, AVG(ABS(error_pct)) as avg_abs_error FROM model_accuracy WHERE device_sn=? AND day_ts>=? AND actual_kwh>0'
  ).get(sn, cutoff);
}

// ── Grid Meter ──────────────────────────────────────────────
export function insertGridReading(ts, powerW, energyKwh, voltageV, currentA) {
  db.prepare('INSERT OR REPLACE INTO grid_meter_data (ts, power_w, energy_kwh, voltage_v, current_a) VALUES (?,?,?,?,?)')
    .run(ts, powerW, energyKwh, voltageV, currentA);
}
export function getGridData(fromTs, toTs) {
  return db.prepare('SELECT ts, power_w, energy_kwh, voltage_v, current_a FROM grid_meter_data WHERE ts>=? AND ts<=? ORDER BY ts ASC')
    .all(fromTs, toTs);
}
export function getLatestGridReading() {
  return db.prepare('SELECT * FROM grid_meter_data ORDER BY ts DESC LIMIT 1').get();
}

// Prune grid meter data: merge to 1 row per minute (no retention limit — keeps all data)
export function pruneGridMeterData(onProgress) {
  // Find sub-minute duplicates and consolidate to minute averages
  // We'll do this in batches of 100k to avoid locking
  const batchSize = 100000;
  let totalConsolidated = 0;
  let offset = 0;
  let lastBatchCount = 0;

  do {
    const rows = db.prepare(`
      SELECT DISTINCT (ts/60)*60 as minute_ts
      FROM grid_meter_data
      GROUP BY minute_ts
      HAVING COUNT(*) > 1
      ORDER BY minute_ts
      LIMIT ? OFFSET ?
    `).all(batchSize, offset);

    lastBatchCount = rows.length;
    offset += batchSize;

    for (const row of rows) {
      const minuteTs = row.minute_ts;
      const agg = db.prepare(`
        SELECT
          AVG(power_w) as avg_power,
          AVG(voltage_v) as avg_voltage,
          AVG(current_a) as avg_current,
          MAX(energy_kwh) as last_energy,
          COUNT(*) as cnt
        FROM grid_meter_data
        WHERE ts >= ? AND ts < ?
      `).get(minuteTs, minuteTs + 60);

      if (agg && agg.cnt > 1) {
        db.prepare('DELETE FROM grid_meter_data WHERE ts >= ? AND ts < ?').run(minuteTs, minuteTs + 60);
        db.prepare('INSERT INTO grid_meter_data (ts, power_w, energy_kwh, voltage_v, current_a) VALUES (?,?,?,?,?)')
          .run(minuteTs, Math.round(agg.avg_power || 0), agg.last_energy,
               Math.round((agg.avg_voltage || 0) * 10) / 10,
               Math.round((agg.avg_current || 0) * 100) / 100);
        totalConsolidated += agg.cnt - 1;
      }
    }
  } while (lastBatchCount === batchSize);

  const remaining = db.prepare('SELECT COUNT(*) as c FROM grid_meter_data').get()?.c || 0;
  if (onProgress) {
    if (totalConsolidated > 0) onProgress(`Consolidated ${totalConsolidated.toLocaleString()} sub-minute rows into 1-per-minute`);
    onProgress(`Grid meter: ${remaining.toLocaleString()} rows (all time, 1/minute)`);
  }
  return { consolidated: totalConsolidated, remaining };
}

export function getGridDataStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM grid_meter_data').get()?.c || 0;
  const first = db.prepare('SELECT MIN(ts) as ts FROM grid_meter_data').get()?.ts || 0;
  const last = db.prepare('SELECT MAX(ts) as ts FROM grid_meter_data').get()?.ts || 0;
  return { total, firstTs: first, lastTs: last };
}

// MQTT config
export function getMqttConfig() {
  return db.prepare('SELECT * FROM mqtt_config WHERE id = 1').get();
}
export function saveMqttConfig(config) {
  db.prepare(`INSERT INTO mqtt_config (id, host, port, username, password, user_id, email, updated_at)
              VALUES (1, @host, @port, @username, @password, @user_id, @email, @updated_at)
              ON CONFLICT(id) DO UPDATE SET host=@host, port=@port, username=@username,
              password=@password, user_id=@user_id, email=@email, updated_at=@updated_at`).run(config);
}

// Users
export function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function listUsers() {
  return db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all();
}
export function userCount() {
  return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
}
export function createUser(username, passwordHash) {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const isAdmin = count === 0 ? 1 : 0; // first user is admin
  return db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, isAdmin, Math.floor(Date.now() / 1000));
}
export function changePassword(username, newHash) {
  return db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(newHash, username);
}
export function deleteUser(username) {
  // Don't allow deleting the last admin
  const admins = db.prepare("SELECT COUNT(*) as c FROM users WHERE is_admin = 1").get().c;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return { changes: 0 };
  if (user.is_admin && admins <= 1) {
    throw new Error('Cannot delete the last admin account');
  }
  return db.prepare('DELETE FROM users WHERE username = ?').run(username);
}

// Devices
export function getDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY added_at DESC').all();
}
export function addDevice(sn, name, type) {
  return db.prepare('INSERT OR IGNORE INTO devices (sn, name, type, added_at) VALUES (?, ?, ?, ?)')
    .run(sn, name || sn, type || 'stream_inverter', Math.floor(Date.now() / 1000));
}
export function removeDevice(sn) {
  db.prepare('DELETE FROM data WHERE device_sn = ?').run(sn);
  db.prepare('DELETE FROM hourly WHERE device_sn = ?').run(sn);
  db.prepare('DELETE FROM daily WHERE device_sn = ?').run(sn);
  return db.prepare('DELETE FROM devices WHERE sn = ?').run(sn);
}

// Data
export function insertData(rows) {
  const stmt = db.prepare('INSERT INTO data (ts, device_sn, field_num, value_num, value_text) VALUES (?, ?, ?, ?, ?)');
  const insertAll = db.transaction((rows) => {
    for (const r of rows) stmt.run(r.ts, r.device_sn, r.field_num, r.value_num, r.value_text);
  });
  insertAll(rows);
}

export function getHistoricalData(sn, fromTs, toTs, fieldNums) {
  let query = 'SELECT ts, field_num, value_num, value_text FROM data WHERE device_sn = ? AND ts >= ? AND ts <= ?';
  const params = [sn, fromTs, toTs || Math.floor(Date.now() / 1000)];
  if (fieldNums && fieldNums.length > 0) {
    query += ` AND field_num IN (${fieldNums.map(() => '?').join(',')})`;
    params.push(...fieldNums);
  }
  query += ' ORDER BY ts ASC, field_num ASC';
  return db.prepare(query).all(...params);
}

export function getLatestData(sn) {
  // Get the latest value of EACH field independently, not just fields from the most recent message
  const fields = db.prepare(
    `SELECT d.field_num, d.value_num, d.value_text FROM data d
     WHERE d.device_sn = ? AND d.id IN (
       SELECT MAX(id) FROM data WHERE device_sn = ? GROUP BY field_num
     )`
  ).all(sn, sn);
  const result = {};
  for (const f of fields) result[f.field_num] = f.value_text || f.value_num;
  return result;
}

export function getDataRange(sn) {
  return db.prepare('SELECT MIN(ts) as min_ts, MAX(ts) as max_ts, COUNT(*) as count FROM data WHERE device_sn = ?').get(sn);
}

// Hourly / Daily aggregates
export function saveHourly(sn, hourTs, fieldNum, avg, min, max, count, totalVal) {
  db.prepare(`INSERT OR REPLACE INTO hourly (device_sn, hour_ts, field_num, avg_val, min_val, max_val, total_val, count_val)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sn, hourTs, fieldNum, avg, min, max, totalVal, count);
}

export function getAggregates(sn, fromTs, toTs, fieldNums, table = 'hourly') {
  const tsCol = table === 'daily' ? 'day_ts' : 'hour_ts';
  let query = `SELECT ${tsCol} as ts, field_num, avg_val, min_val, max_val, total_val, count_val FROM ${table} WHERE device_sn = ? AND ${tsCol} >= ? AND ${tsCol} <= ?`;
  const params = [sn, fromTs, toTs || Math.floor(Date.now() / 1000)];
  if (fieldNums && fieldNums.length > 0) {
    query += ` AND field_num IN (${fieldNums.map(() => '?').join(',')})`;
    params.push(...fieldNums);
  }
  query += ` ORDER BY ${tsCol} ASC`;
  return db.prepare(query).all(...params);
}

// Rates
export function getCurrentRate() {
  return db.prepare('SELECT * FROM rates ORDER BY valid_from DESC LIMIT 1').get();
}
export function addRate(pricePerKwh, currency = 'GBP') {
  return db.prepare('INSERT INTO rates (valid_from, price_per_kwh, currency) VALUES (?, ?, ?)')
    .run(Math.floor(Date.now() / 1000), pricePerKwh, currency);
}

export default db;
