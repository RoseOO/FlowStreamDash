// Home Assistant MQTT Discovery Bridge
// Publishes auto-discovery configs + state updates so sensors appear in HA automatically

import mqtt from 'mqtt';
import { getCsvLabel } from './fields.js';

let client = null;
let config = null;

const SENSORS = [
  { field: 361, name: 'PV1 Power', deviceClass: 'power', unit: 'W', icon: 'mdi:solar-power' },
  { field: 380, name: 'PV1 Voltage', deviceClass: 'voltage', unit: 'V', icon: 'mdi:flash' },
  { field: 381, name: 'PV1 Current', deviceClass: 'current', unit: 'A', icon: 'mdi:current-dc' },
  { field: 70,  name: 'PV2 Power', deviceClass: 'power', unit: 'W', icon: 'mdi:solar-power' },
  { field: 442, name: 'PV2 Voltage', deviceClass: 'voltage', unit: 'V', icon: 'mdi:flash' },
  { field: 71,  name: 'PV2 Current', deviceClass: 'current', unit: 'A', icon: 'mdi:current-dc' },
  { field: 616, name: 'Grid Power', deviceClass: 'power', unit: 'W', icon: 'mdi:transmission-tower' },
  { field: 613, name: 'Grid Voltage', deviceClass: 'voltage', unit: 'V', icon: 'mdi:sine-wave' },
  { field: 614, name: 'Grid Current', deviceClass: 'current', unit: 'A', icon: 'mdi:current-ac' },
  { field: 615, name: 'Grid Frequency', deviceClass: 'frequency', unit: 'Hz', icon: 'mdi:sine-wave' },
  { field: 371, name: 'Inverter Temperature', deviceClass: 'temperature', unit: '°C', icon: 'mdi:thermometer' },
  { field: 602, name: 'WiFi Signal', deviceClass: 'signal_strength', unit: 'dBm', icon: 'mdi:wifi' },
];

export async function startHaMqtt(cfg) {
  stopHaMqtt();
  if (!cfg?.host) return false;
  config = cfg;

  return new Promise((resolve) => {
    client = mqtt.connect({
      host: cfg.host,
      port: cfg.port || 1883,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clientId: `ecoflow_monitor_${Date.now()}`,
      keepalive: 60,
      reconnectPeriod: 30000,
      connectTimeout: 10000,
    });

    client.on('connect', () => {
      console.log('[HA-MQTT] Connected to local broker');
      publishDiscovery();
      resolve(true);
    });

    client.on('error', (err) => {
      console.error('[HA-MQTT] Error:', err.message);
      resolve(false);
    });
  });
}

export function stopHaMqtt() {
  if (client) {
    try { client.end(true); } catch {}
    client = null;
  }
}

function publishDiscovery() {
  if (!client || !config) return;
  const prefix = config.discovery_prefix || 'homeassistant';

  // Publish a "Solar Production Today" sensor per device (non-field, computed)
  // We'll use a combined state topic for all sensors
  // Each sensor gets its own discovery config

  for (const s of SENSORS) {
    const uid = `ecoflow_${s.field}`;
    const stateTopic = `ecoflow/state`;
    const valueTemplate = `{{ value_json.f${s.field} }}`;
    const availTopic = `ecoflow/status`;

    const discovery = {
      name: s.name,
      unique_id: uid,
      state_topic: stateTopic,
      value_template: valueTemplate,
      availability_topic: availTopic,
      device_class: s.deviceClass,
      unit_of_measurement: s.unit,
      icon: s.icon,
      state_class: 'measurement',
      device: {
        identifiers: ['ecoflow_monitor'],
        name: 'EcoFlow Monitor',
        model: 'Stream Microinverter',
        manufacturer: 'EcoFlow',
      },
    };

    client.publish(`${prefix}/sensor/${uid}/config`, JSON.stringify(discovery), { retain: true });
  }
}

export function publishState(sn, fields, connected) {
  if (!client || !config) return;

  // Publish availability
  client.publish('ecoflow/status', connected ? 'online' : 'offline', { retain: true });

  if (!fields || !sn) return;

  // Publish state as JSON map: { f361: 22.5, f70: 23.1, ... }
  const state = {};
  for (const [fnum, value] of Object.entries(fields)) {
    state[`f${fnum}`] = value;
  }
  client.publish('ecoflow/state', JSON.stringify(state), { retain: false });
}

export function isHaMqttConnected() {
  return client?.connected || false;
}
