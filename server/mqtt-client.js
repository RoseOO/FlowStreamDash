// MQTT client manager — connects to EcoFlow cloud, subscribes to all devices,
// decodes protobuf, emits events for data + connection state.

import mqtt from 'mqtt';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { decodeMqttPayload } from './protobuf.js';

export class EcoFlowMqttClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.config = null;
    this.devices = [];
    this.connected = false;
    this.lastDataTime = 0;
    this.msgCount = 0;
  }

  connect(config, devices) {
    this.config = config;
    this.devices = devices;

    const clientId = `ANDROID_${randomUUID().toUpperCase()}_${config.user_id}`;
    console.log(`[MQTT] Connecting to ${config.host}:${config.port} as ${clientId.substring(0, 40)}...`);

    this.client = mqtt.connect({
      host: config.host,
      port: config.port,
      protocol: 'mqtts',
      username: config.username,
      password: config.password,
      clientId,
      keepalive: 30,
      reconnectPeriod: 0, // we handle reconnect ourselves
      connectTimeout: 15000,
    });

    this.client.on('connect', () => {
      console.log('[MQTT] Connected');
      this.connected = true;
      this.lastDataTime = Date.now() / 1000;
      this.subscribeAll();
      this.emit('state', { connected: true });
    });

    this.client.on('message', (topic, payload) => {
      const decoded = decodeMqttPayload(payload);
      if (!decoded) return;
      this.msgCount++;
      this.lastDataTime = Date.now() / 1000;

      // Topic format: /app/device/property/{sn} or /app/{uid}/{sn}/thing/property/*
      const parts = topic.split('/');
      let sn = null;
      if (parts[2] === 'device') {
        sn = parts[4]; // /app/device/property/{sn}
      } else if (parts[1] === 'app') {
        sn = parts[3]; // /app/{uid}/{sn}/thing/property/*
      }
      this.emit('data', { sn, fields: decoded });
    });

    this.client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
      this.emit('state', { connected: false, error: err.message });
    });

    this.client.on('close', () => {
      console.log('[MQTT] Disconnected');
      this.connected = false;
      this.emit('state', { connected: false });
    });
  }

  subscribeAll() {
    if (!this.client || !this.connected) return;
    for (const dev of this.devices) {
      const sn = dev.sn;
      // Status topic
      this.client.subscribe(`/app/device/property/${sn}`, { qos: 0 });
      // Get/set replies
      this.client.subscribe(`/app/${this.config.user_id}/${sn}/thing/property/get_reply`, { qos: 0 });
      this.client.subscribe(`/app/${this.config.user_id}/${sn}/thing/property/set_reply`, { qos: 0 });
      // Trigger initial data fetch
      this.client.publish(`/app/${this.config.user_id}/${sn}/thing/property/get`, '{}', { qos: 0 });
      console.log(`[MQTT] Subscribed to ${sn}`);
    }
  }

  disconnect() {
    if (this.client) {
      try { this.client.end(true); } catch (e) { /* ignore */ }
      this.client = null;
    }
    this.connected = false;
  }

  getStats() {
    return {
      connected: this.connected,
      msgCount: this.msgCount,
      lastDataAgo: this.lastDataTime ? Math.round(Date.now() / 1000 - this.lastDataTime) : null,
      devices: this.devices.length,
    };
  }
}
