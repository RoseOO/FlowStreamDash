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
      let errors = 0;

      const sensors = ['power', 'voltage', 'current', 'total_daily_energy', 'power_factor'];
      for (const id of sensors) {
        try {
          const r = await fetch(`${base}/sensor/${id}`, { signal: AbortSignal.timeout(2000) });
          if (!r.ok) { errors++; continue; }
          const data = await r.json();
          if (data.value != null) {
            results[id] = data.value;
          } else if (data.state) {
            // Some ESPHome versions return state as string like "830 W"
            const num = parseFloat(data.state);
            if (!isNaN(num)) results[id] = num;
          }
        } catch { errors++; }
      }

      if (errors === sensors.length) {
        // All failed — log once per minute
        if (!this._lastErrLog || Date.now() - this._lastErrLog > 60000) {
          console.error(`[GridMeter] All ${errors} sensors failed — device unreachable at ${this.config.ip}`);
          this._lastErrLog = Date.now();
        }
        return;
      }

      if (Object.keys(results).length === 0) return;

      const now = Math.floor(Date.now() / 1000);
      const power = results.power ?? null;
      const energy = results.total_daily_energy ?? null;
      const voltage = results.voltage ?? null;
      const current = results.current ?? null;

      this.lastData = { ts: now, power_w: power, energy_kwh: energy, voltage_v: voltage, current_a: current };
      this.emit('data', this.lastData);
    } catch (e) {
      if (!this._lastErrLog || Date.now() - this._lastErrLog > 60000) {
        console.error(`[GridMeter] Poll error: ${e.message}`);
        this._lastErrLog = Date.now();
      }
    }
  }
}
