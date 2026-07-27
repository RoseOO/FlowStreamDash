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
      let firstError = null;

      // Primary: use the SSE events endpoint (works with ESPHome v3)
      try {
        const r = await fetch(`${base}/events`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const start = Date.now();
          while (Date.now() - start < 800) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('data:')) {
                try {
                  const d = JSON.parse(line.slice(5).trim());
                  if (d.id && d.value != null) {
                    const name = d.id.replace('sensor-', '').replace('binary_sensor-', '');
                    results[name] = d.value;
                  }
                } catch {}
              }
            }
          }
          try { reader.cancel(); } catch {}
        }
      } catch(e) { firstError = e.message; }

      // Fallback: individual sensor endpoints
      if (Object.keys(results).length === 0) {
        const sensors = ['power', 'voltage', 'current', 'total_daily_energy', 'power_factor'];
        for (const id of sensors) {
          try {
            const r = await fetch(`${base}/sensor/${id}`, { signal: AbortSignal.timeout(1500) });
            if (!r.ok) continue;
            const text = await r.text();
            if (!text) continue;
            try {
              const data = JSON.parse(text);
              if (data.value != null) results[id] = data.value;
            } catch {}
          } catch {}
        }
      }

      if (Object.keys(results).length === 0) {
        if (!this._lastErrLog || Date.now() - this._lastErrLog > 60000) {
          console.error(`[GridMeter] No data (${firstError || 'empty'}) — curl http://${this.config.ip}/`);
          this._lastErrLog = Date.now();
        }
        return;
      }

      this._lastErrLog = 0;
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
