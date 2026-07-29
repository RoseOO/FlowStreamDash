import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { getStats, computeDailyTotals, computeHourlyProfile } from '../stats-engine.js';
import { round2, round3 } from '../utils.js';
import { DEFAULT_LAT, DEFAULT_LON, CO2_KG_PER_KWH } from '../config.js';
import { publishHaStats } from '../ha-mqtt.js';

export default function(app) {
  app.get('/api/stats/:sn', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*7);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    res.json(getStats(req.params.sn, fromTs, toTs));
  });

  app.get('/api/stats/aggregate/all', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*7);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const devices = db.getDevices();
    const mergedDaily = {};
    const mergedHourly = {};
    let totalKwh = 0, bestDay = null, allDays = 0;

    for (const d of devices) {
      const pv1Rows = db.getHistoricalData(d.sn, fromTs, toTs, [361]);
      const pv2Rows = db.getHistoricalData(d.sn, fromTs, toTs, [70]);
      const allPv = [...pv1Rows, ...pv2Rows];
      const daily = computeDailyTotals(allPv);
      const hourly = computeHourlyProfile(allPv, fromTs, toTs);

      for (const [ts, val] of Object.entries(daily)) {
        if (!mergedDaily[ts]) mergedDaily[ts] = { totalKwh: 0, peakW: 0 };
        mergedDaily[ts].totalKwh += val.totalKwh;
        mergedDaily[ts].peakW = Math.max(mergedDaily[ts].peakW, val.peakW);
      }
      for (let h = 0; h < 24; h++) {
        if (!mergedHourly[h]) mergedHourly[h] = { avg: 0, max: 0 };
        mergedHourly[h].avg += hourly[h]?.avg || 0;
        mergedHourly[h].max = Math.max(mergedHourly[h].max, hourly[h]?.max || 0);
      }
      totalKwh += Object.values(daily).reduce((a, b) => a + b.totalKwh, 0);
      allDays = Math.max(allDays, Object.keys(daily).length);
    }

    const deviceCount = devices.length || 1;
    for (let h = 0; h < 24; h++) {
      mergedHourly[h].avg = round2(mergedHourly[h].avg / deviceCount);
    }

    const dailyArr = Object.entries(mergedDaily).map(([ts, d]) => ({
      ts: parseInt(ts), ...d, totalKwh: round2(d.totalKwh),
    })).sort((a, b) => a.ts - b.ts);
    const best = [...dailyArr].sort((a, b) => b.totalKwh - a.totalKwh)[0];
    const peakH = Object.entries(mergedHourly).sort((a, b) => b[1].avg - a[1].avg)[0];

    res.json({
      daily: dailyArr.slice(-30),
      hourlyProfile: mergedHourly,
      bestDay: best || null,
      peakHour: peakH ? { hour: parseInt(peakH[0]), avg: peakH[1].avg, max: peakH[1].max } : null,
      totalKwh: round2(totalKwh),
      avgDailyKwh: round2(allDays ? totalKwh / allDays : 0),
      dayCount: allDays,
      deviceCount,
    });
  });

  app.get('/api/stats/:sn/pr', authMiddleware, async (req, res) => {
    const { from, to } = req.query;
    const now = Math.floor(Date.now()/1000);
    const fromTs = from ? parseInt(from) : now - 30*86400;
    const toTs = to ? parseInt(to) : now;
    const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
    const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
    const totalKW = (pv1W + pv2W) / 1000;
    if (totalKW <= 0) return res.json({ error: 'Set panel ratings in Setup first' });

    const stats = getStats(req.params.sn, fromTs, toTs);
    const actualKwh = stats.totalKwh;

    const lat = db.getSetting('weather_lat') || DEFAULT_LAT;
    const lon = db.getSetting('weather_lon') || DEFAULT_LON;
    let totalPeakSunHours = 0, days = 0;

    try {
      for (let dayTs = Math.floor(fromTs/86400)*86400; dayTs < toTs; dayTs += 86400) {
        const date = new Date(dayTs*1000).toISOString().slice(0,10);
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&start_date=${date}&end_date=${date}&hourly=shortwave_radiation&timezone=auto`;
        const resp = await fetch(url); const data = await resp.json();
        if (data.hourly) {
          const dailyRadiation = data.hourly.shortwave_radiation.reduce((a,b)=>a+(b||0),0);
          totalPeakSunHours += dailyRadiation / 1000;
          days++;
        }
        if (days % 3 === 0) await new Promise(r => setTimeout(r, 200));
      }
    } catch {}

    const peakSunHours = round2(totalPeakSunHours);
    const expectedKwh = round2(totalKW * peakSunHours);
    const pr = expectedKwh > 0 ? round2(actualKwh / expectedKwh * 100) : null;

    res.json({
      actualKwh, peakSunHours, totalKwRated: round2(totalKW),
      expectedKwh, performanceRatioPct: pr,
      days, rating: pr ? (pr > 80 ? 'Excellent' : pr > 65 ? 'Good' : pr > 50 ? 'Fair' : 'Poor') : null,
    });
  });

  app.get('/api/stats/:sn/compare', authMiddleware, (req, res) => {
    const { from1, to1, from2, to2 } = req.query;
    if (!from1 || !to1 || !from2 || !to2) return res.status(400).json({ error: 'Both date ranges required' });
    const s1 = getStats(req.params.sn, parseInt(from1), parseInt(to1));
    const s2 = getStats(req.params.sn, parseInt(from2), parseInt(to2));
    res.json({
      period1: { from: from1, to: to1, ...s1 },
      period2: { from: from2, to: to2, ...s2 },
      deltaKwh: round2(s2.totalKwh - s1.totalKwh),
      deltaPct: s1.totalKwh > 0 ? round2((s2.totalKwh - s1.totalKwh) / s1.totalKwh * 100) : null,
    });
  });

  app.get('/api/stats/:sn/quality', authMiddleware, (req, res) => {
    const stats = getStats(req.params.sn, Math.floor(Date.now()/1000)-7*86400, Math.floor(Date.now()/1000));
    if (!stats.hourlyProfile) return res.json({ error: 'Not enough data' });

    let genHours = 0, dataHours = 0;
    for (let h = 0; h < 24; h++) {
      if (stats.hourlyProfile[h]?.avg > 5) genHours++;
    }
    if (genHours > 0) {
      const now = Math.floor(Date.now()/1000);
      const rows = db.getHistoricalData(req.params.sn, now-7*86400, now, [361]);
      const hoursWithData = new Set();
      for (const r of rows) { if (r.value_num > 0) hoursWithData.add(new Date(r.ts*1000).getHours()); }
      for (let h = 0; h < 24; h++) {
        if (stats.hourlyProfile[h]?.avg > 5 && hoursWithData.has(h)) dataHours++;
      }
    }

    res.json({
      generatingHoursPerDay: genHours,
      hoursWithData: dataHours,
      uptimePct: genHours > 0 ? round2(dataHours / genHours * 100) : null,
      rating: dataHours >= genHours * 0.95 ? 'Excellent' : dataHours >= genHours * 0.8 ? 'Good' : dataHours >= genHours * 0.5 ? 'Fair' : 'Poor',
      period: '7 days',
    });
  });

  app.get('/api/stats/:sn/degradation', authMiddleware, (req, res) => {
    const pv1W = parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts')||'0');
    const pv2W = parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts')||'0');
    if (pv1W <= 0 && pv2W <= 0) return res.json({ error: 'Set panel ratings first' });

    const rows = db.default.prepare(
      `SELECT CAST(ts/86400/30 AS INTEGER) as m, AVG(value_num) as avg_w, MAX(value_num) as peak_w
       FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0
       GROUP BY m ORDER BY m ASC LIMIT 36`
    ).all(req.params.sn);

    const totalRated = pv1W + pv2W;
    res.json(rows.map(r => ({
      month: new Date(r.m * 30 * 86400 * 1000).toLocaleDateString('en',{year:'numeric',month:'short'}),
      avgEfficiencyPct: round2(r.avg_w / totalRated * 100),
      peakEfficiencyPct: round2(r.peak_w / totalRated * 100),
      avgWatts: round2(r.avg_w),
      peakWatts: round2(r.peak_w),
      monthBlock: r.m,
    })));
  });

  app.get('/api/settings/panels/:sn', authMiddleware, (req, res) => {
    res.json({
      pv1_rated_watts: parseInt(db.getDeviceConfig(req.params.sn, 'pv1_rated_watts') || '0'),
      pv2_rated_watts: parseInt(db.getDeviceConfig(req.params.sn, 'pv2_rated_watts') || '0'),
    });
  });
  app.post('/api/settings/panels/:sn', authMiddleware, (req, res) => {
    const { pv1_rated_watts, pv2_rated_watts } = req.body;
    if (pv1_rated_watts !== undefined) db.setDeviceConfig(req.params.sn, 'pv1_rated_watts', String(pv1_rated_watts));
    if (pv2_rated_watts !== undefined) db.setDeviceConfig(req.params.sn, 'pv2_rated_watts', String(pv2_rated_watts));
    res.json({ success: true });
  });

  app.get('/api/stats/:sn/enhanced', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const now = Math.floor(Date.now()/1000);
    const todayStart = Math.floor(now/86400)*86400;
    const yesterdayStart = todayStart - 86400;
    const fromTs = from ? parseInt(from) : todayStart;
    const toTs = to ? parseInt(to) : now;

    const today = getStats(req.params.sn, todayStart, now);
    const yesterday = getStats(req.params.sn, yesterdayStart, todayStart);
    const rangeStats = getStats(req.params.sn, fromTs, toTs);

    const co2Kg = round2(today.totalKwh * CO2_KG_PER_KWH);
    const co2TotalKg = round2(rangeStats.totalKwh * CO2_KG_PER_KWH);

    const vsYesterday = yesterday.totalKwh > 0 ? round2((today.totalKwh - yesterday.totalKwh) / yesterday.totalKwh * 100) : null;

    // Best day ever (last 2 years) — use ts-based integration, not hardcoded *2
    const twoYearsAgo = Math.floor(Date.now()/1000) - 730 * 86400;
    const allPvRows = db.default.prepare(
      `SELECT ts, value_num, field_num FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 AND ts>=? ORDER BY ts ASC`
    ).all(req.params.sn, twoYearsAgo);
    const allDaily = computeDailyTotals(allPvRows);
    const bestDayEntry = Object.entries(allDaily).sort((a, b) => b[1].totalKwh - a[1].totalKwh)[0];
    const bestDay = bestDayEntry ? { date: parseInt(bestDayEntry[0]), kwh: round2(bestDayEntry[1].totalKwh) } : null;

    const days = db.default.prepare(
      `SELECT DISTINCT CAST(ts/86400 AS INTEGER) as day FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num > 0 ORDER BY day DESC LIMIT 365`
    ).all(req.params.sn);
    let streak=0;
    for(let i=0;i<days.length-1;i++){
      if(days[i].day-days[i+1].day===1)streak++;
      else break;
    }
    streak=Math.max(0,streak);

    res.json({
      today,
      yesterday,
      vsYesterdayPct: vsYesterday,
      co2SavingKgToday: co2Kg,
      co2SavingKgTotal: co2TotalKg,
      co2PerKwh: CO2_KG_PER_KWH,
      bestDayAllTime: bestDay,
      generationStreak: streak,
      ...rangeStats,
    });
  });

  app.get('/api/stats/:sn/hourly-overlay', authMiddleware, (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const now = Math.floor(Date.now()/1000);
    const todayStart = Math.floor(now/86400)*86400;
    const profiles = [];
    for (let d = 0; d < days; d++) {
      const dayStart = todayStart - d * 86400;
      const dayEnd = dayStart + 86400;
      const stats = getStats(req.params.sn, dayStart, Math.min(dayEnd, now));
      const date = new Date(dayStart*1000);
      const label = d === 0 ? 'Today' : date.toLocaleDateString('en',{weekday:'short'});
      profiles.push({
        dayTs: dayStart,
        label,
        date: date.toISOString().slice(0,10),
        isToday: d === 0,
        hourly: stats.hourlyProfile,
        totalKwh: stats.totalKwh,
      });
    }
    res.json(profiles.reverse());
  });

  app.get('/api/stats/:sn/monthly', authMiddleware, (req, res) => {
    const now = Math.floor(Date.now()/1000);
    const twoYearsAgo = now - 730 * 86400;
    const pvRows = db.default.prepare(
      `SELECT ts, value_num, field_num FROM data WHERE device_sn=? AND field_num IN (361,70) AND value_num>0 AND ts>=? ORDER BY ts ASC`
    ).all(req.params.sn, twoYearsAgo);
    const daily = computeDailyTotals(pvRows);
    const monthly = {};
    for (const [dayTs, dayData] of Object.entries(daily)) {
      const d = new Date(parseInt(dayTs) * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (!monthly[key]) monthly[key] = { kwh: 0, peakW: 0 };
      monthly[key].kwh += d.totalKwh;
      if (d.peakW > monthly[key].peakW) monthly[key].peakW = d.peakW;
    }
    const result = Object.entries(monthly)
      .sort((a,b) => a[0].localeCompare(b[0]))
      .slice(-24)
      .map(([month, m]) => ({
        month, kwh: round2(m.kwh), peakW: round2(m.peakW),
      }));
    res.json(result);
  });
}
