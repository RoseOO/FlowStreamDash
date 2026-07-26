// EcoFlow authentication: login with email/password → get MQTT broker credentials
// Same flow as the energychain.github.io tool and ecoflow_get_mqtt_login.sh

import { Buffer } from 'buffer';

const AUTH_URL = 'https://api.ecoflow.com/auth/login';
const CERT_URL = 'https://api.ecoflow.com/iot-auth/app/certification';

export async function ecoflowLogin(email, password) {
  // Step 1: Login to get token
  const loginBody = {
    os: 'linux',
    scene: 'IOT_APP',
    appVersion: '1.0.0',
    osVersion: '5.0',
    password: Buffer.from(password).toString('base64'),
    oauth: { bundleId: 'com.ef.EcoFlow' },
    email,
    userType: 'ECOFLOW',
  };

  const loginRes = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(loginBody),
  });
  const loginJson = await loginRes.json();

  if (!loginJson.data || !loginJson.data.token) {
    throw new Error(loginJson.message || 'Login failed');
  }

  const token = loginJson.data.token;
  const userId = loginJson.data.user?.userId;

  // Step 2: Get MQTT certificate
  const certRes = await fetch(CERT_URL, {
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
  });
  const certJson = await certRes.json();

  if (!certJson.data) {
    throw new Error(certJson.message || 'Failed to get MQTT certificate');
  }

  return {
    email,
    userId,
    mqttHost: certJson.data.url,
    mqttPort: certJson.data.port,
    mqttProtocol: certJson.data.protocol,
    mqttUsername: certJson.data.certificateAccount,
    mqttPassword: certJson.data.certificatePassword,
  };
}
