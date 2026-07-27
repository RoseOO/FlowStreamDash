// EcoFlow Developer API — HMAC-signed HTTP access
// Auth: HTTP headers (accessKey, nonce, timestamp, sign)
// Host: https://api.ecoflow.com
// Key endpoints: /iot-open/sign/device/list, /iot-open/sign/device/quota/all, /iot-open/sign/certification

import { createHmac, randomInt } from 'crypto';
import { getSetting, setSetting } from './db.js';

const API_BASE = 'https://api.ecoflow.com';

// ── HMAC Signing ────────────────────────────────────────────
function flattenParams(obj, prefix = '') {
  if (obj == null || typeof obj !== 'object') return { [prefix]: String(obj) };
  const flat = {};
  for (const [k, v] of Object.entries(obj)) {
    const child = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      Object.assign(flat, flattenParams(v, child));
    } else {
      flat[child] = String(v);
    }
  }
  return flat;
}

function buildSignStr(params, accessKey, nonce, timestamp) {
  const parts = [];
  if (params) {
    const flat = flattenParams(params);
    for (const k of Object.keys(flat).sort()) parts.push(`${k}=${flat[k]}`);
  }
  parts.push(`accessKey=${accessKey}`);
  parts.push(`nonce=${nonce}`);
  parts.push(`timestamp=${timestamp}`);
  return parts.join('&');
}

function authHeaders(accessKey, secretKey, params = null) {
  const nonce = String(randomInt(100000, 999999));
  const timestamp = String(Date.now());
  const signStr = buildSignStr(params, accessKey, nonce, timestamp);
  const sign = createHmac('sha256', secretKey).update(signStr).digest('hex');
  return { accessKey, nonce, timestamp, sign, signStr };
}

// ── API Calls ───────────────────────────────────────────────
async function apiGet(path, params = null) {
  const accessKey = getSetting('dev_api_access_key');
  const secretKey = getSetting('dev_api_secret_key');
  if (!accessKey || !secretKey) throw new Error('Developer API credentials not configured');

  const auth = authHeaders(accessKey, secretKey, params);
  let url = `${API_BASE}${path}`;
  if (params) {
    const flat = flattenParams(params);
    const qs = Object.keys(flat).sort().map(k => `${k}=${encodeURIComponent(flat[k])}`).join('&');
    url += `?${qs}`;
  }
  console.log('[DevAPI] GET', url.substring(0, 130) + '...');
  const res = await fetch(url, { headers: { 'Accept': 'application/json', ...auth } });
  if (!res.ok) {
    const body = await res.text();
    console.error('[DevAPI] Error:', res.status, body.substring(0, 300));
    throw new Error(JSON.parse(body || '{}').message || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const accessKey = getSetting('dev_api_access_key');
  const secretKey = getSetting('dev_api_secret_key');
  if (!accessKey || !secretKey) throw new Error('Developer API credentials not configured');

  const auth = authHeaders(accessKey, secretKey, body);
  const url = `${API_BASE}${path}`;
  console.log('[DevAPI] POST', url.substring(0, 100) + '...');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json;charset=UTF-8', ...auth },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    console.error('[DevAPI] Error:', res.status, bodyText.substring(0, 300));
    throw new Error(JSON.parse(bodyText || '{}').message || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Public Functions ────────────────────────────────────────
export async function listDevices() {
  try {
    const resp = await apiGet('/iot-open/sign/device/list');
    const devices = resp?.data || [];
    return devices.map(d => ({ sn: d.sn, name: d.deviceName || d.sn, online: d.online }));
  } catch (e) { console.error('[DevAPI] List failed:', e.message); return []; }
}

export async function fetchAllQuota(sn) {
  try {
    const resp = await apiGet('/iot-open/sign/device/quota/all', { sn });
    const data = resp?.data || {};
    return data;
  } catch (e) { console.error('[DevAPI] Quota fetch failed:', e.message); return null; }
}

export async function getDevMqttCert() {
  try {
    const resp = await apiGet('/iot-open/sign/certification');
    const data = resp?.data;
    if (!data?.certificateAccount) throw new Error('No cert in response');
    return {
      host: data.url, port: data.port,
      username: data.certificateAccount,
      password: data.certificatePassword,
      protocol: data.protocol || 'mqtts',
    };
  } catch (e) { console.error('[DevAPI] Cert failed:', e.message); return null; }
}

export async function verifyCredentials(accessKey, secretKey) {
  if (!accessKey || !secretKey) return false;
  const oldA = getSetting('dev_api_access_key'), oldS = getSetting('dev_api_secret_key');
  setSetting('dev_api_access_key', accessKey);
  setSetting('dev_api_secret_key', secretKey);
  try {
    const devices = await listDevices();
    console.log('[DevAPI] Verified —', devices.length, 'devices');
    setSetting('dev_api_access_key', accessKey);
    setSetting('dev_api_secret_key', secretKey);
    return devices;
  } catch (e) {
    setSetting('dev_api_access_key', oldA || '');
    setSetting('dev_api_secret_key', oldS || '');
    return false;
  }
}
