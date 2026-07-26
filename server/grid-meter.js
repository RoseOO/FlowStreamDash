// Grid Meter Poller — polls ESPHome REST API for real grid import/export data
// Sonoff POW Ring (POWCT) running ESPHome exposes data via:
//   GET http://<ip>/sensor/power  → {"value": 123.4, "state": "123.4 W"}
//   GET http://<ip>/sensor/energy → {"value": 1.23, "state": "1.23 kWh"}

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
    const interval = (this.config.interval || 10) * 1000;
    this.timer = setInterval(() => this.poll(), interval);
    this.poll(); // immediate first poll
    console.log(`[GridMeter] Polling ${this.config.ip} every ${interval/1000}s`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async poll() {
    if (!this.config?.ip) return;
    try {
      const base = `http://${this.config.ip}`;
      // Try common sensor IDs for ESPHome POWCT
      const sensors = ['power', 'total_power', 'energy', 'total_daily_energy', 'energy_total'];
      const results = {};

      for (const id of sensors) {
        try {
          const r = await fetch(`${base}/sensor/${id}`, { signal: AbortSignal.timeout(3000) });
          if (!r.ok) continue;
          const data = await r.json();
          results[id] = data.value;
        } catch { /* sensor might not exist */ }
      }

      if (Object.keys(results).length === 0) return;

      const now = Math.floor(Date.now() / 1000);
      const power = results.power ?? results.total_power ?? null;
      const energy = results.energy_total ?? results.energy ?? results.total_daily_energy ?? null;

      this.lastData = { ts: now, power_w: power, energy_kwh: energy };
      this.emit('data', this.lastData);
    } catch (e) {
      // Silent — device might be offline
    }
  }
}
