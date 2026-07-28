import * as db from '../db.js';
import { getCsvLabel, DISPLAY_ORDER } from '../fields.js';
import { apiKeyAuth } from '../middleware/auth.js';
import { getStats } from '../stats-engine.js';
import { round2, round4 } from '../utils.js';
import { DEFAULT_LAT, DEFAULT_LON } from '../config.js';
import { calculateSavings } from '../aggregator.js';

function labeledLatest(sn) {
  const raw = db.getLatestData(sn);
  const out = { device_sn: sn, ...Object.fromEntries(
    Object.entries(raw).map(([fnum, val]) => [getCsvLabel(parseInt(fnum)), val])
  )};
  return out;
}

export default function(app) {
  app.get('/api/public/devices', apiKeyAuth, (req, res) => {
    const devices = db.getDevices();
    res.json(devices.map(d => {
      const ld = db.getLatestData(d.sn);
      const labeled = {};
      for (const [fnum, val] of Object.entries(ld)) {
        labeled[getCsvLabel(parseInt(fnum))] = val;
      }
      if (labeled['PV1_Power_W'] != null && labeled['PV1_Current_A'] != null && labeled['PV1_Current_A'] > 0.01) {
        labeled['PV1_Voltage_est_V'] = round2(labeled['PV1_Power_W'] / labeled['PV1_Current_A']);
      }
      if (labeled['PV2_Power_W'] != null && labeled['PV2_Current_A'] != null && labeled['PV2_Current_A'] > 0.01) {
        labeled['PV2_Voltage_est_V'] = round2(labeled['PV2_Power_W'] / labeled['PV2_Current_A']);
      }
      const pv1Rated = parseInt(db.getDeviceConfig(d.sn, 'pv1_rated_watts')||'0');
      const pv2Rated = parseInt(db.getDeviceConfig(d.sn, 'pv2_rated_watts')||'0');
      if (pv1Rated && labeled['PV1_Power_W']) labeled['PV1_Efficiency_Pct'] = round2(labeled['PV1_Power_W']/pv1Rated*100);
      if (pv2Rated && labeled['PV2_Power_W']) labeled['PV2_Efficiency_Pct'] = round2(labeled['PV2_Power_W']/pv2Rated*100);
      return { sn: d.sn, name: d.name, type: d.type, values: labeled };
    }));
  });

  app.get('/api/public/device/:sn/latest', apiKeyAuth, (req, res) => {
    res.json(labeledLatest(req.params.sn));
  });

  app.get('/api/public/device/:sn/history', apiKeyAuth, (req, res) => {
    const { from, to, fields } = req.query;
    const fromTs = from ? parseInt(from) : 0;
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const fieldNums = fields ? fields.split(',').map(Number).filter(n=>!isNaN(n)) : null;
    const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, fieldNums);
    const byTs = {};
    for (const r of rows) {
      if (!byTs[r.ts]) byTs[r.ts] = { timestamp: new Date(r.ts*1000).toISOString() };
      byTs[r.ts][getCsvLabel(r.field_num)] = r.value_text || r.value_num;
    }
    res.json(Object.values(byTs).sort((a,b) => a.timestamp < b.timestamp ? -1 : 1));
  });

  app.get('/api/public/device/:sn/stats', apiKeyAuth, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*7);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    res.json(getStats(req.params.sn, fromTs, toTs));
  });

  app.get('/api/public/savings/:sn', apiKeyAuth, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const result = calculateSavings(req.params.sn, fromTs, toTs);
    res.json({
      device_sn: req.params.sn,
      total_produced_kwh: result.totalPvKwh,
      savings_gbp: result.totalSaving,
      rate_per_kwh: result.rate,
      currency: result.currency,
      period_from: new Date(fromTs*1000).toISOString(),
      period_to: new Date(toTs*1000).toISOString(),
    });
  });

  app.get('/api/public/savings/aggregate', apiKeyAuth, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const devices = db.getDevices();
    let totalKwh=0;
    for (const d of devices) {
      const r = calculateSavings(d.sn, fromTs, toTs);
      if (!r.error) totalKwh += r.totalPvKwh || 0;
    }
    const rate = db.getCurrentRate();
    const price = rate ? rate.price_per_kwh : 0;
    res.json({
      total_produced_kwh: round2(totalKwh),
      savings_gbp: round2(totalKwh*price),
      rate_per_kwh: price,
      device_count: devices.length,
      period_from: new Date(fromTs*1000).toISOString(),
      period_to: new Date(toTs*1000).toISOString(),
    });
  });

  app.get('/api/public/export/:sn', apiKeyAuth, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : 0;
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, null);
    if (!rows || rows.length===0) return res.status(404).json({error:'No data'});
    const allFieldNums=new Set(); for(const r of rows)allFieldNums.add(r.field_num);
    const orderedFields=[...DISPLAY_ORDER.filter(f=>allFieldNums.has(f)),...[...allFieldNums].filter(f=>!DISPLAY_ORDER.includes(f)).sort((a,b)=>a-b)];
    const header=['timestamp',...orderedFields.map(f=>getCsvLabel(f))];
    const byTs={};
    for(const r of rows){
      if(!byTs[r.ts])byTs[r.ts]={};
      byTs[r.ts][r.field_num]=r.value_text||r.value_num;
    }
    const csvRows=[header.join(',')];
    for(const ts of Object.keys(byTs).sort()){
      const row=[new Date(parseInt(ts)*1000).toISOString()];
      for(const f of orderedFields)row.push(byTs[ts][f]!==undefined?byTs[ts][f]:'');
      csvRows.push(row.join(','));
    }
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename="ecoflow_${req.params.sn}.csv"`);
    res.send(csvRows.join('\n'));
  });

  app.get('/api/public/device/:sn/pr', apiKeyAuth, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-30*86400);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
    const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
    const totalKW = (pv1W + pv2W) / 1000;
    if (totalKW <= 0) return res.json({ error: 'Set panel ratings in Setup first' });
    const stats = getStats(req.params.sn, fromTs, toTs);
    const peakSunHours = round2(stats.totalKwh / totalKW * 0.8);
    const expectedKwh = round2(totalKW * peakSunHours);
    const pr = expectedKwh > 0 ? round2(stats.totalKwh / expectedKwh * 100) : null;
    res.json({ actualKwh: stats.totalKwh, peakSunHours, totalKwRated: round2(totalKW),
      expectedKwh, performanceRatioPct: pr, rating: pr ? (pr>80?'Excellent':pr>60?'Good':pr>40?'Fair':'Poor') : null });
  });

  app.get('/api/public/device/:sn/quality', apiKeyAuth, (req, res) => {
    const stats = getStats(req.params.sn, Math.floor(Date.now()/1000)-7*86400, Math.floor(Date.now()/1000));
    if (!stats.hourlyProfile) return res.json({ error: 'Not enough data' });
    let genHours = 0, dataHours = 0;
    for (let h=0;h<24;h++) if (stats.hourlyProfile[h]?.avg>5) genHours++;
    if (genHours>0){
      const rows = db.getHistoricalData(req.params.sn, Math.floor(Date.now()/1000)-7*86400, Math.floor(Date.now()/1000), [361]);
      const hwd = new Set();
      for (const r of rows) { if (r.value_num>0) hwd.add(new Date(r.ts*1000).getHours()); }
      for (let h=0;h<24;h++) if (stats.hourlyProfile[h]?.avg>5&&hwd.has(h)) dataHours++;
    }
    res.json({ generatingHoursPerDay: genHours, hoursWithData: dataHours,
      uptimePct: genHours>0?round2(dataHours/genHours*100):null });
  });

  app.get('/api/public/device/:sn/degradation', apiKeyAuth, (req, res) => {
    const pv1W = parseInt(db.getDeviceConfig(req.params.sn,'pv1_rated_watts')||'0');
    const pv2W = parseInt(db.getDeviceConfig(req.params.sn,'pv2_rated_watts')||'0');
    if (pv1W<=0&&pv2W<=0) return res.json({error:'Set panel ratings first'});
    const rows = db.default.prepare(
      `SELECT CAST(ts/86400/30 AS INTEGER) as m, AVG(value_num) as avg_w, MAX(value_num) as peak_w
       FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 GROUP BY m ORDER BY m ASC LIMIT 36`
    ).all(req.params.sn);
    const totalRated=pv1W+pv2W;
    res.json(rows.map(r=>({month:new Date(r.m*30*86400*1000).toLocaleDateString('en',{year:'numeric',month:'short'}),
      avgEfficiencyPct:round2(r.avg_w/totalRated*100),peakEfficiencyPct:round2(r.peak_w/totalRated*100)})));
  });

  app.get('/api/public/device/:sn/model', apiKeyAuth, (req, res) => {
    const model = db.getModelStats(req.params.sn);
    const recent = db.getRadiationPairs(req.params.sn, 24);
    res.json({ learnedFactor: model?.avg_factor?round2(model.avg_factor):null, samples: model?.samples||0,
      modelReady: (model?.samples||0)>10, recentPairs: recent.slice(0,24).map(r=>({
        hour: new Date(r.hour_ts*1000).toISOString(), radiation: r.radiation_wm2, production: r.production_w, factor: round4(r.factor),
      }))});
  });

  app.get('/api/public/device/:sn/daylight', apiKeyAuth, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const stats = getStats(req.params.sn, fromTs, toTs);
    const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
    const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
    res.json({
      pv1: stats.daylight?.pv1 || null,
      pv2: stats.daylight?.pv2 || null,
      pv1RatedW: pv1W, pv2RatedW: pv2W,
      period_from: new Date(fromTs*1000).toISOString(),
      period_to: new Date(toTs*1000).toISOString(),
    });
  });

  app.get('/api/public/weather', apiKeyAuth, async (req, res) => {
    const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
    const lon = db.getSetting('weather_lon') || DEFAULT_LON;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=cloud_cover,shortwave_radiation&timezone=auto&forecast_days=1`;
      const resp = await fetch(url); const data = await resp.json();
      const hours = data.hourly?.time?.map((t,i) => ({
        time: t, hour: new Date(t).getHours(),
        cloudCoverPct: data.hourly.cloud_cover?.[i],
        radiationWm2: data.hourly.shortwave_radiation?.[i],
      })) || [];
      res.json({ lat, lon, hours });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/public/grid-meter', apiKeyAuth, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const rows = db.getGridData(fromTs, toTs);
    res.json(rows);
  });
  app.get('/api/public/grid-meter/latest', apiKeyAuth, (req, res) => {
    res.json(db.getLatestGridReading() || { power_w: null, energy_kwh: null });
  });
}
