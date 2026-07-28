// Grid Meter — Persistent SSE connection to ESPHome web_server events
// Sonoff POWCT via ESPHome v3 web_server /events endpoint
// No polling needed — events stream pushes real-time sensor updates

import { EventEmitter } from 'events';

export class GridMeter extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.controller = null;
    this.lastData = null;
    this.running = false;
    this._knownSensors = new Set();
    this._lastEmitTime = 0;
    this._emitTimer = null;
  }

  configure(cfg) {
    this.config = cfg;
    this.start();
  }

  start() {
    this.stop();
    if (!this.config?.enabled || !this.config?.ip) return;
    this.running = true;
    this._connect();
    console.log(`[GridMeter] SSE streaming from ${this.config.ip}`);
  }

  stop() {
    this.running = false;
    if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
    if (this.controller) { this.controller.abort(); this.controller = null; }
  }

  async _connect() {
    if (!this.running || !this.config?.ip) return;
    const base = `http://${this.config.ip}`;
    this.controller = new AbortController();

    try {
      const res = await fetch(`${base}/events`, {
        signal: this.controller.signal,
        headers: { 'Accept': 'text/event-stream' },
      });

      if (!res.ok) {
        console.error(`[GridMeter] SSE connection failed: HTTP ${res.status}`);
        if (this.running) setTimeout(() => this._connect(), 5000);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const results = {};

      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload.startsWith('{')) continue; // skip non-JSON log events
          try {
            const d = JSON.parse(payload);
            if (d.id && d.value != null) {
              const name = d.id.replace('sensor-', '').replace('binary_sensor-', '');
              results[name] = d.value;
            }
          } catch {}
        }

        // Emit: either all known sensors reported, or 3s since last emit
        const now = Date.now();
        this._knownSensors.add('power');
        this._knownSensors.add('total_daily_energy');
        this._knownSensors.add('voltage');
        this._knownSensors.add('current');
        const allReported = [...this._knownSensors].every(k => k in results);
        const timeToEmit = (now - this._lastEmitTime) >= 3000;
        if (allReported || (timeToEmit && Object.keys(results).length > 0)) {
          this._lastEmitTime = now;
          if (this._emitTimer) { clearTimeout(this._emitTimer); this._emitTimer = null; }
          const ts = Math.floor(now / 1000);
          this.lastData = {
            ts,
            power_w: results.power ?? null,
            energy_kwh: results.total_daily_energy ?? null,
            voltage_v: results.voltage ?? null,
            current_a: results.current ?? null,
          };
          this.emit('data', this.lastData);
          // Clear for next batch
          for (const k of Object.keys(results)) delete results[k];
        } else if (!this._emitTimer && Object.keys(results).length > 0) {
          this._emitTimer = setTimeout(() => {
            if (!results.power && !results.total_daily_energy && !results.voltage && !results.current) return;
            const ts = Math.floor(Date.now() / 1000);
            this._lastEmitTime = Date.now();
            this.lastData = {
              ts,
              power_w: results.power ?? null,
              energy_kwh: results.total_daily_energy ?? null,
              voltage_v: results.voltage ?? null,
              current_a: results.current ?? null,
            };
            this.emit('data', this.lastData);
            for (const k of Object.keys(results)) delete results[k];
            this._emitTimer = null;
          }, 3000);
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!this._lastErrLog || Date.now() - this._lastErrLog > 60000) {
        console.error(`[GridMeter] SSE error: ${e.message} — reconnecting in 5s`);
        this._lastErrLog = Date.now();
      }
    }

    // Reconnect after delay
    if (this.running) {
      this.controller = null;
      setTimeout(() => this._connect(), 5000);
    }
  }
}
