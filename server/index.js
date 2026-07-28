import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { EcoFlowMqttClient } from './mqtt-client.js';
import { GridMeter } from './grid-meter.js';
import * as db from './db.js';
import { join } from 'path';
import { PORT, DIST_DIR } from './config.js';
import { publishState, publishHaGridMeter, stopHaMqtt } from './ha-mqtt.js';
import { createDataLogger } from './data-logger.js';
import { startAll, stopAll } from './scheduler.js';

import authRoutes from './routes/auth.js';
import publicApiRoutes from './routes/public-api.js';
import deviceRoutes from './routes/devices.js';
import dataRoutes from './routes/data.js';
import savingsRoutes from './routes/savings.js';
import statsRoutes from './routes/stats.js';
import forecastRoutes from './routes/forecast.js';
import gridMeterRoutes from './routes/grid-meter.js';
import exportRoutes from './routes/export-routes.js';
import ecoflowRoutes from './routes/ecoflow.js';
import systemRoutes from './routes/system.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const mqttClient = new EcoFlowMqttClient();
const gridMeter = new GridMeter();

app.use(cors());
app.use(express.json());

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(DIST_DIR));
}

const dataLogger = createDataLogger({ mqttClient, db, wss });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'status', connected: mqttClient.connected, stats: mqttClient.getStats() }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

mqttClient.on('data', ({ sn, fields }) => {
  const msg = JSON.stringify({ type: 'data', sn, fields, ts: Math.floor(Date.now() / 1000) });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  publishState(sn, fields, true);
});

mqttClient.on('state', (state) => {
  const msg = JSON.stringify({ type: 'status', ...state, stats: mqttClient.getStats() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

gridMeter.on('data', (data) => {
  const { ts, power_w, energy_kwh, voltage_v, current_a } = data;
  if (power_w != null || energy_kwh != null) {
    try { db.insertGridReading(ts, power_w, energy_kwh, voltage_v, current_a); } catch {}
  }
  const msg = JSON.stringify({ type: 'grid', ts, power_w, energy_kwh, voltage_v, current_a });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  publishHaGridMeter(data);
});

const { restartMqtt } = startAll({ mqttClient, wss, gridMeter, dataLogger });

const routeDeps = { mqttClient, restartMqtt, gridMeter, dataLogger };

authRoutes(app);
publicApiRoutes(app);
deviceRoutes(app, routeDeps);
dataRoutes(app, routeDeps);
savingsRoutes(app);
statsRoutes(app);
forecastRoutes(app);
gridMeterRoutes(app, routeDeps);
exportRoutes(app, routeDeps);
ecoflowRoutes(app, routeDeps);
systemRoutes(app, routeDeps);

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
  console.log(`[Server] JWT secret configured`);
});

function shutdown() {
  console.log('[Server] Shutting down gracefully...');
  stopAll();
  try { mqttClient.disconnect(); } catch {}
  try { gridMeter.stop(); } catch {}
  try { stopHaMqtt(); } catch {}
  server.close(() => { console.log('[Server] Shutdown complete'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
