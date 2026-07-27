// Bright/Glowmarkt API — SMETS2 smart meter data via DCC
// Provides historical grid import/export data that predates live monitoring
// API docs: GET /api/v0-1/auth → JWT → GET /virtualentity → GET /resource/{id}/readings

import { getSetting, setSetting } from './db.js';

const API_BASE = 'https://api.glowmarkt.com/api/v0-1';
const APP_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const username = getSetting('bright_username');
  const password = getSetting('bright_password');
  if (!username || !password) throw new Error('Bright credentials not configured');

  const res = await fetch(`${API_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'applicationId': APP_ID },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Bright auth failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error('No token in Bright response');

  cachedToken = data.token;
  tokenExpiry = Date.now() + (data.exp ? (data.exp * 1000 - Date.now() - 60000) : 6 * 86400 * 1000);
  return data.token;
}

async function brightGet(path) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', 'token': token, 'applicationId': APP_ID },
  });
  if (!res.ok) throw new Error(`Bright API ${res.status}: ${await res.text().catch(()=>'')}`);
  return res.json();
}

export async function getVirtualEntities() {
  const data = await brightGet('/virtualentity');
  return data || [];
}

export async function getResources(veId) {
  const data = await brightGet(`/virtualentity/${veId}/resources`);
  return data?.resources || [];
}

export async function getReadings(resourceId, from, to, period = 'P1D') {
  const fromStr = new Date(from * 1000).toISOString().replace(/\.\d+Z$/, '');
  const toStr = new Date(to * 1000).toISOString().replace(/\.\d+Z$/, '');
  const data = await brightGet(
    `/resource/${resourceId}/readings?from=${fromStr}&to=${toStr}&period=${period}&offset=-60&function=sum`
  );
  return data?.data || [];
}

// Backfill historical grid import data from Bright into our DB
export async function backfillGridData(fromTs, toTs) {
  try {
    const ves = await getVirtualEntities();
    if (!ves.length) return { error: 'No virtual entities found' };

    let consumptionResId = null;
    let exportResId = null;

    for (const ve of ves) {
      const resources = await getResources(ve.veId);
      for (const r of resources) {
        if (r.classifier === 'electricity.consumption') consumptionResId = r.resourceId;
        if (r.classifier === 'electricity.export') exportResId = r.resourceId;
      }
      if (consumptionResId) break;
    }

    if (!consumptionResId) return { error: 'No electricity consumption resource found' };

    // Batch into 31-day chunks (Bright API limit)
    const CHUNK_DAYS = 30;
    const chunkSec = CHUNK_DAYS * 86400;
    let totalReadings = 0;
    const allRows = [];

    for (let chunkStart = fromTs; chunkStart < toTs; chunkStart += chunkSec) {
      const chunkEnd = Math.min(chunkStart + chunkSec, toTs);
      try {
        const readings = await getReadings(consumptionResId, chunkStart, chunkEnd, 'P1D');
        for (const [ts, kwh] of readings) {
          const avgWatts = Math.round((kwh / 24) * 1000);
          allRows.push({ ts, power_w: avgWatts, energy_kwh: kwh, source: 'bright' });
          totalReadings++;
        }
        console.log(`[Bright] Backfilled ${new Date(chunkStart*1000).toLocaleDateString()} - ${new Date(chunkEnd*1000).toLocaleDateString()}: ${readings.length} readings`);
      } catch {}
      // Small delay between chunks
      await new Promise(r => setTimeout(r, 500));
    }

    return { readings: totalReadings, exportReadings: 0, sample: allRows[0], rows: allRows };
  } catch (e) {
    return { error: e.message };
  }
}

// Verify credentials
export async function verifyBrightCredentials(username, password) {
  if (!username || !password) return false;
  const oldU = getSetting('bright_username'), oldP = getSetting('bright_password');
  setSetting('bright_username', username);
  setSetting('bright_password', password);
  cachedToken = null;
  try {
    const ves = await getVirtualEntities();
    if (ves.length > 0) return true;
    setSetting('bright_username', oldU || '');
    setSetting('bright_password', oldP || '');
    return false;
  } catch (e) {
    setSetting('bright_username', oldU || '');
    setSetting('bright_password', oldP || '');
    return false;
  }
}
