import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { round2 } from '../utils.js';

export default function(app, deps) {
  const { gridMeter } = deps;

  app.get('/api/settings/grid-meter', authMiddleware, (req, res) => {
    res.json({
      enabled: db.getSetting('grid_meter_enabled') === 'true',
      ip: db.getSetting('grid_meter_ip') || '',
      interval: parseInt(db.getSetting('grid_meter_interval') || '10'),
      connected: !!gridMeter.lastData,
      lastPower: gridMeter.lastData?.power_w || null,
      lastEnergy: gridMeter.lastData?.energy_kwh || null,
      lastTs: gridMeter.lastData?.ts || null,
    });
  });
  app.post('/api/settings/grid-meter', authMiddleware, (req, res) => {
    const { enabled, ip, interval } = req.body;
    db.setSetting('grid_meter_enabled', enabled ? 'true' : 'false');
    if (ip) db.setSetting('grid_meter_ip', ip);
    if (interval) db.setSetting('grid_meter_interval', String(interval));
    if (enabled && ip) {
      gridMeter.configure({ enabled: true, ip, interval: parseInt(interval||'10') });
    } else {
      gridMeter.stop();
    }
    res.json({ success: true });
  });
  app.get('/api/grid-meter/latest', authMiddleware, (req, res) => {
    const latest = db.getLatestGridReading();
    res.json(latest || { power_w: null, energy_kwh: null });
  });
  app.get('/api/grid-meter/test', authMiddleware, async (req, res) => {
    const ip = db.getSetting('grid_meter_ip') || '192.168.150.202';
    const results = {};
    for (const id of ['power', 'voltage', 'current', 'total_daily_energy']) {
      try {
        const r = await fetch(`http://${ip}/sensor/${id}`, { signal: AbortSignal.timeout(3000) });
        results[id] = { status: r.status, body: await r.text().catch(()=>'parse error') };
      } catch(e) { results[id] = { error: e.message }; }
      try {
        const r2 = await fetch(`http://${ip}/sensor/sensor-${id}`, { signal: AbortSignal.timeout(2000) });
        if (r2.ok) {
          const d = await r2.json().catch(()=>({}));
          results[`sensor-${id}`] = { status: r2.status, value: d.value, state: d.state };
        }
      } catch {}
      try {
        const r3 = await fetch(`http://${ip}/`, { signal: AbortSignal.timeout(2000) });
        results['_root'] = { status: r3.status, length: (await r3.text()).length };
      } catch {}
    }
    res.json({ ip, results, lastData: gridMeter.lastData });
  });
  app.get('/api/grid-meter/history', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    res.json(db.getGridData(fromTs, toTs));
  });

  app.get('/api/grid-meter/stats', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const rows = db.getGridData(fromTs, toTs);
    if (!rows || rows.length < 2) return res.json({ error: 'No grid data' });

    let totalImport = 0, totalExport = 0, peakImport = 0, lastTs = null;
    const daily = {}, hourly = {};
    for (const r of rows) {
      if (r.power_w == null) continue;
      if (lastTs !== null) {
        const intervalHours = (r.ts - lastTs) / 3600;
        if (intervalHours > 0 && intervalHours < 1) {
          if (r.power_w > 5) totalImport += (r.power_w * intervalHours) / 1000;
          else if (r.power_w < -5) totalExport += (Math.abs(r.power_w) * intervalHours) / 1000;
          if (r.power_w > peakImport) peakImport = r.power_w;
        }
      }
      lastTs = r.ts;
      const day = Math.floor(r.ts / 86400) * 86400;
      if (!daily[day]) daily[day] = { importKwh: 0, exportKwh: 0, peakW: 0 };
      const h = new Date(r.ts * 1000).getHours();
      if (!hourly[h]) hourly[h] = { sum: 0, count: 0 };
      hourly[h].sum += r.power_w;
      hourly[h].count++;
    }

    let lastDayTs = null;
    for (const r of rows) {
      if (r.power_w == null) continue;
      const day = Math.floor(r.ts / 86400) * 86400;
      if (lastDayTs !== null && lastDayTs !== day) {
        const intervalH = (r.ts - lastDayTs) / 3600;
        if (intervalH > 0 && intervalH < 1) {
          if (r.power_w > 5) daily[day].importKwh += (r.power_w * intervalH) / 1000;
          else if (r.power_w < -5) daily[day].exportKwh += (Math.abs(r.power_w) * intervalH) / 1000;
          if (r.power_w > daily[day].peakW) daily[day].peakW = r.power_w;
        }
      }
      lastDayTs = r.ts;
    }

    const dailyArr = Object.entries(daily).map(([ts, d]) => ({
      date: new Date(parseInt(ts)*1000).toLocaleDateString().slice(0,5),
      ts: parseInt(ts),
      importKwh: round2(d.importKwh),
      exportKwh: round2(d.exportKwh),
      peakW: round2(d.peakW),
    })).sort((a,b) => a.ts - b.ts);

    const hourlyArr = Array.from({length: 24}, (_, h) => ({
      hour: `${h}:00`,
      avgW: hourly[h] ? round2(hourly[h].sum / hourly[h].count) : 0,
      peakW: hourly[h] ? round2(Math.max(...rows.filter(r=>new Date(r.ts*1000).getHours()===h).map(r=>r.power_w||0))) : 0,
    }));

    const rate = db.getCurrentRate();
    const price = rate ? rate.price_per_kwh : 0;

    res.json({
      totalImportKwh: round2(totalImport),
      totalExportKwh: round2(totalExport),
      peakImportW: round2(peakImport),
      importCost: round2(totalImport * price),
      exportValue: round2(totalExport * price),
      netCost: round2((totalImport - totalExport) * price),
      rate: price,
      daily: dailyArr.slice(-30),
      hourly: hourlyArr,
      sampleCount: rows.length,
    });
  });
}
