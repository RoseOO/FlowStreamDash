// EcoFlow Developer API — HMAC-signed HTTP access to device quota data
// Provides richer data than App Mode MQTT alone (named quota keys, cumulative energy, etc.)

import { createHmac, randomInt } from 'crypto';
import { getSetting, setSetting } from './db.js';

const API_BASE = 'https://api-e.ecoflow.com';

// ── HMAC Signing ────────────────────────────────────────────
function flattenParams(obj, prefix = '') {
  const flat = {};
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const child = prefix ? `${prefix}.${k}` : k;
      Object.assign(flat, flattenParams(v, child));
    }
  } else {
    flat[prefix] = String(obj);
  }
  return flat;
}

function buildSignString(params, accessKey, nonce, timestamp) {
  const flat = flattenParams(params || {});
  const sorted = Object.keys(flat).sort().map(k => `${k}=${flat[k]}`).join('&');
  const suffix = `accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  return sorted ? `${sorted}&${suffix}` : suffix;
}

function signedHeaders(accessKey, secretKey, params = {}) {
  const nonce = String(randomInt(100000, 999999));
  const timestamp = String(Date.now());
  const signStr = buildSignString(params, accessKey, nonce, timestamp);
  const sign = createHmac('sha256', secretKey).update(signStr).digest('hex');
  return { accessKey, nonce, timestamp, sign };
}

// ── API Calls ───────────────────────────────────────────────
async function apiCall(path, params = {}) {
  const accessKey = getSetting('dev_api_access_key');
  const secretKey = getSetting('dev_api_secret_key');
  if (!accessKey || !secretKey) throw new Error('Developer API credentials not configured');

  const headers = signedHeaders(accessKey, secretKey, params);
  const query = new URLSearchParams({
    ...flattenParams(params),
    accessKey: headers.accessKey,
    nonce: headers.nonce,
    timestamp: headers.timestamp,
    sign: headers.sign,
  });
  const url = `${API_BASE}${path}?${query}`;
  console.log('[DevAPI] Calling:', url.substring(0, 100) + '...');
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    const body = await res.text();
    console.error('[DevAPI] Error response:', res.status, body.substring(0, 500));
    const err = JSON.parse(body || '{}');
    throw new Error(err.message || err.returnMsg || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Quota Key → Field Number Mapping ────────────────────────
// Maps Developer API quota keys to our internal field numbers
const QUOTA_TO_FIELD = {
  'plugInInfoPvVol': 380,     plugInInfoPvAmp: 381,
  'plugInInfoPv2Vol': 442,    plugInInfoPv2Amp: 71,
  'plugInInfoPv3Vol': 999,    plugInInfoPv3Amp: 998,
  'plugInInfoPv4Vol': 997,    plugInInfoPv4Amp: 996,
  'powGetPv': 361,            'powGetPv2': 70,
  'powGetPvSum': '_pvSum',    // computed: sum of all PV
  'gridConnectionPower': 616, 'gridConnectionVol': 613,
  'gridConnectionAmp': 614,   'gridConnectionFreq': 615,
  'gridConnectionSta': 619,   'gridConnectionPowerFactor': 618,
  'gridConnectionReactivePower': 617,
  'invNtcTemp3': 371,         'invTargetPwr': 638,
  'moduleWifiRssi': 602,      'moduleWifiSnr': 601,
  'feedGridModePowLimit': 727, 'feedGridModePowMax': 521,
  'devErrcodeList': 627,      'countryCode': 731,
  'townCode': 729,            'gridCodeVersion': 730,
  'acTotalActivePower': '_acTotal',
  'cloudMetter.phaseAPower': '_meterPhase',
  'sysGridConnectionPower': 515,
  'plugInInfoPvFlag': '_pv1Flag', 'plugInInfoPv2Flag': '_pv2Flag',
  // Legacy names (some devices use different keys)
  'invTempNtc': 371,          'wifiRssi': 602,
  'powGetPv1': 361,
};

// Quota keys that are strings (not numbers)
const STRING_KEYS = new Set(['countryCode', 'gridCodeVersion']);

export async function fetchQuotaData(sn) {
  try {
    const resp = await apiCall('/iot-open/sign/device/quota', { sn });
    const quota = resp?.data || resp?.quota || resp || {};
    // Map named keys to field numbers
    const fields = {};
    for (const [key, value] of Object.entries(quota)) {
      if (value == null) continue;
      const fnum = QUOTA_TO_FIELD[key];
      if (fnum && fnum[0] !== '_') {
        // Standard numeric field
        const num = Number(value);
        fields[fnum] = isNaN(num) ? String(value) : Math.round(num * 100) / 100;
      } else if (fnum && fnum[0] === '_') {
        // Computed/internal field
        const num = Number(value);
        if (!isNaN(num)) fields[`_quota_${fnum.slice(1)}`] = Math.round(num * 100) / 100;
      } else {
        // Unknown key — store as-is with prefix
        const num = Number(value);
        fields[`_quota_${key}`] = isNaN(num) ? String(value) : Math.round(num * 100) / 100;
      }
    }
    // Compute PV sum if we have individual strings
    const pvPowers = [fields[361], fields[70], fields['_quota_pv3'], fields['_quota_pv4']].filter(v => typeof v === 'number');
    if (pvPowers.length > 0) {
      fields['_pvTotal'] = Math.round(pvPowers.reduce((a, b) => a + b, 0) * 100) / 100;
    }
    return fields;
  } catch (e) {
    console.error(`[DevAPI] Quota fetch failed for ${sn}:`, e.message);
    return null;
  }
}

export async function listDevices() {
  try {
    const resp = await apiCall('/iot-open/sign/device/list');
    const devices = resp?.data || [];
    return devices.map(d => ({
      sn: d.sn, name: d.deviceName || d.sn,
      online: d.online, model: d.productName,
    }));
  } catch (e) {
    console.error('[DevAPI] List devices failed:', e.message);
    return [];
  }
}

export async function verifyCredentials(accessKey, secretKey) {
  if (!accessKey || !secretKey) return false;
  const oldAccess = getSetting('dev_api_access_key');
  const oldSecret = getSetting('dev_api_secret_key');
  setSetting('dev_api_access_key', accessKey);
  setSetting('dev_api_secret_key', secretKey);
  try {
    const devices = await listDevices();
    console.log('[DevAPI] Credential check: got', devices.length, 'devices');
    if (devices.length >= 0) return devices;
    setSetting('dev_api_access_key', oldAccess || '');
    setSetting('dev_api_secret_key', oldSecret || '');
    return false;
  } catch (e) {
    console.error('[DevAPI] Credential check failed:', e.message);
    setSetting('dev_api_access_key', oldAccess || '');
    setSetting('dev_api_secret_key', oldSecret || '');
    return false;
  }
}

// ── Developer MQTT Certification ────────────────────────────
// The Developer API provides its own MQTT broker with JSON data (not protobuf)
export async function getDevMqttCert() {
  try {
    const resp = await apiCall('/iot-open/sign/certification');
    const data = resp?.data || resp;
    if (!data?.certificateAccount) throw new Error('No MQTT cert in response');
    return {
      host: data.url,
      port: data.port,
      username: data.certificateAccount,
      password: data.certificatePassword,
      protocol: data.protocol || 'mqtts',
    };
  } catch (e) {
    console.error('[DevAPI] Certification failed:', e.message);
    return null;
  }
}
