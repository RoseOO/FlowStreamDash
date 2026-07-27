// Grid Meter Poller — polls ESPHome web_server REST API for real grid data
// Sonoff POWCT sensors: power, voltage, current, total_daily_energy
// REST API format: GET http://<ip>/sensor/<id> → {"id":"sensor-xxx","value":123,"state":"123 W"}

import { EventEmitter } from 'events';

export class GridMeter extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.timer = null;
    this.lastData = null;
  }

  configure(cfg) {
    this.config = cfg;
    this.start();
  }

  start() {
    this.stop();
    if (!this.config?.enabled || !this.config?.ip) return;
    const interval = (this.config.interval || 2) * 1000;
    this.timer = setInterval(() => this.poll(), interval);
    this.poll();
    console.log(`[GridMeter] Polling ESPHome at ${this.config.ip} every ${interval/1000}s`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async poll() {
    if (!this.config?.ip) return;
    try {
      const base = `http://${this.config.ip}`;
      const results = {};

      // Fetch known ESPHome POWCT sensors
      const sensors = ['power', 'voltage', 'current', 'total_daily_energy', 'power_factor'];
      for (const id of sensors) {
        try {
          const r = await fetch(`${base}/sensor/${id}`, { signal: AbortSignal.timeout(3000) });
          if (!r.ok) continue;
          const data = await r.json();
          if (data.value != null) results[id] = data.value;
        } catch { /* sensor may not exist */ }
      }

      if (Object.keys(results).length === 0) return;

      const now = Math.floor(Date.now() / 1000);
      const power = results.power ?? null; // Raw value now directly reflects import (positive=import)
      const energy = results.total_daily_energy ?? null;
      const voltage = results.voltage ?? null;
      const current = results.current ?? null;

      this.lastData = { ts: now, power_w: power, energy_kwh: energy, voltage_v: voltage, current_a: current };
      this.emit('data', this.lastData);
    } catch (e) {
      // Silent — device might be offline
    }
  }
}
