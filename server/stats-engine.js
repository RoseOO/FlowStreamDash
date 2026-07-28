import * as db from './db.js';
import { round2 } from './utils.js';
import { round4 } from './utils.js';

export function computeHourlyProfile(pvRows, fromTs, toTs) {
  const hourlyByDay = {};
  for (const r of pvRows) {
    if (r.value_num == null || r.value_num <= 0) continue;
    const day = Math.floor(r.ts / 86400) * 86400;
    const hour = new Date(r.ts * 1000).getHours();
    if (!hourlyByDay[day]) hourlyByDay[day] = {};
    if (!hourlyByDay[day][hour]) hourlyByDay[day][hour] = { sum: 0, count: 0 };
    hourlyByDay[day][hour].sum += r.value_num;
    hourlyByDay[day][hour].count += 1;
  }
  const profile = {};
  for (let h = 0; h < 24; h++) {
    let totalAvg = 0, maxAvg = 0, dayCount = 0;
    for (const day of Object.values(hourlyByDay)) {
      const hd = day[h];
      if (hd && hd.count > 0) {
        const avg = hd.sum / hd.count;
        totalAvg += avg;
        maxAvg = Math.max(maxAvg, avg);
        dayCount++;
      }
    }
    profile[h] = { avg: round2(dayCount ? totalAvg / dayCount : 0), max: round2(maxAvg) };
  }
  return profile;
}

export function computeDailyTotals(pvRows) {
  const daily = {};
  for (const r of pvRows) {
    if (r.value_num == null) continue;
    const day = Math.floor(r.ts / 86400) * 86400;
    const hour = new Date(r.ts * 1000).getHours();
    if (!daily[day]) daily[day] = { totalKwh: 0, peakW: 0, peakHour: null, count: 0 };
    daily[day].totalKwh += (r.value_num * 2) / 3600000;
    daily[day].count++;
    if (r.value_num > daily[day].peakW) {
      daily[day].peakW = r.value_num;
      daily[day].peakHour = hour;
    }
  }
  return daily;
}

export function computeDaylightStats(pvRows, hourlyProfile, panelRating) {
  const genHours = [];
  for (let h = 0; h < 24; h++) {
    if (hourlyProfile[h]?.avg > 5) genHours.push(h);
  }
  if (genHours.length === 0) return null;

  const firstHour = genHours[0];
  const lastHour = genHours[genHours.length - 1];
  let daylightSum = 0, daylightCount = 0, daylightPeak = 0;

  let firstMinute = null, lastMinute = null;
  const THRESHOLD = 5;

  for (const r of pvRows) {
    if (r.value_num == null || r.value_num <= 0) continue;
    const hour = new Date(r.ts * 1000).getHours();
    if (hour >= firstHour && hour <= lastHour) {
      daylightSum += r.value_num;
      daylightCount++;
      if (r.value_num > daylightPeak) daylightPeak = r.value_num;
    }
    if (r.value_num > THRESHOLD) {
      const d = new Date(r.ts * 1000);
      const minuteTs = d.getHours() * 60 + d.getMinutes();
      if (firstMinute === null || minuteTs < firstMinute) firstMinute = minuteTs;
      if (lastMinute === null || minuteTs > lastMinute) lastMinute = minuteTs;
    }
  }

  function minuteToStr(m) {
    if (m === null) return '--';
    const h = Math.floor(m / 60), min = m % 60;
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  }

  return {
    firstHour, lastHour,
    firstMinute, lastMinute,
    window: minuteToStr(firstMinute) + '-' + minuteToStr(lastMinute),
    genHours: genHours.length,
    daylightAvgW: round2(daylightCount > 0 ? daylightSum / daylightCount : 0),
    daylightPeakW: round2(daylightPeak),
    daylightEff: panelRating > 0 ? round2(daylightPeak / panelRating * 100) : null,
  };
}

export function getStats(sn, fromTs, toTs) {
  const pv1Rows = db.getHistoricalData(sn, fromTs, toTs, [361]);
  const pv2Rows = db.getHistoricalData(sn, fromTs, toTs, [70]);
  const allPv = [...pv1Rows, ...pv2Rows];

  const daily = computeDailyTotals(allPv);
  const hourlyProfile = computeHourlyProfile(allPv, fromTs, toTs);
  const dailyArr = Object.entries(daily).map(([ts, d]) => ({
    ts: parseInt(ts), totalKwh: round2(d.totalKwh), peakW: d.peakW,
  })).sort((a, b) => a.ts - b.ts);

  const bestDay = [...dailyArr].sort((a, b) => b.totalKwh - a.totalKwh)[0];
  const peakHourEntry = Object.entries(hourlyProfile).sort((a, b) => b[1].avg - a[1].avg)[0];

  const pv1W = parseInt(db.getDeviceConfig(sn, 'pv1_rated_watts') || '0');
  const pv2W = parseInt(db.getDeviceConfig(sn, 'pv2_rated_watts') || '0');
  const efficiency = {};
  if (pv1W > 0) {
    const peaks = pv1Rows.filter(r => r.value_num > 0);
    const maxPv1 = peaks.length ? Math.max(...peaks.map(r => r.value_num)) : 0;
    efficiency.pv1 = { rated: pv1W, peak: round2(maxPv1), pct: round2(maxPv1 / pv1W * 100) };
  }
  if (pv2W > 0) {
    const peaks = pv2Rows.filter(r => r.value_num > 0);
    const maxPv2 = peaks.length ? Math.max(...peaks.map(r => r.value_num)) : 0;
    efficiency.pv2 = { rated: pv2W, peak: round2(maxPv2), pct: round2(maxPv2 / pv2W * 100) };
  }

  const daylight = {};
  if (pv1W > 0) {
    daylight.pv1 = computeDaylightStats(pv1Rows, hourlyProfile, pv1W);
  }
  if (pv2W > 0) {
    daylight.pv2 = computeDaylightStats(pv2Rows, hourlyProfile, pv2W);
  }

  return {
    daily: dailyArr.slice(-30),
    hourlyProfile,
    pv1HourlyProfile: computeHourlyProfile(pv1Rows, fromTs, toTs),
    pv2HourlyProfile: computeHourlyProfile(pv2Rows, fromTs, toTs),
    bestDay: bestDay || null,
    peakHour: peakHourEntry ? { hour: parseInt(peakHourEntry[0]), avg: peakHourEntry[1].avg, max: peakHourEntry[1].max } : null,
    totalKwh: round2(dailyArr.reduce((a, b) => a + b.totalKwh, 0)),
    avgDailyKwh: round2(dailyArr.reduce((a, b) => a + b.totalKwh, 0) / (dailyArr.length || 1)),
    dayCount: dailyArr.length,
    efficiency,
    daylight,
  };
}
