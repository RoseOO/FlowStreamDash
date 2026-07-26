// Hourly/daily aggregator and savings calculator

import db, { getHistoricalData, saveHourly, getAggregates, getCurrentRate } from './db.js';

const HOUR = 3600;
const DAY = 86400;

// Roll up raw data → hourly aggregates for a device
export function rollupHourly(sn, hourTs) {
  const fromTs = hourTs;
  const toTs = hourTs + HOUR - 1;

  const rows = getHistoricalData(sn, fromTs, toTs, null);
  if (!rows || rows.length === 0) return;

  // Group by field_num
  const groups = {};
  for (const row of rows) {
    if (row.value_num == null && row.value_text == null) continue;
    const val = row.value_num != null ? row.value_num : parseFloat(row.value_text);
    if (isNaN(val)) continue;
    if (!groups[row.field_num]) groups[row.field_num] = [];
    groups[row.field_num].push(val);
  }

  for (const [fieldNum, vals] of Object.entries(groups)) {
    if (vals.length === 0) continue;
    const sum = vals.reduce((a, b) => a + b, 0);
    const avg = sum / vals.length;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    saveHourly(sn, hourTs, parseInt(fieldNum), avg, min, max, vals.length);
  }
}

// Run rollup for the previous hour
export function runHourlyRollup(sn) {
  const now = Math.floor(Date.now() / 1000);
  const prevHour = Math.floor(now / HOUR) * HOUR - HOUR;
  rollupHourly(sn, prevHour);
}

// Calculate savings: total kWh produced × electricity rate = money saved
// (Every kWh you generate is one you don't buy from the grid)
export function calculateSavings(sn, fromTs, toTs) {
  const rate = getCurrentRate();
  if (!rate) return { error: 'No electricity rate configured' };
  // Get PV1 + PV2 power data
  const pvRows = getHistoricalData(sn, fromTs, toTs, [361, 70]);
  if (!pvRows || pvRows.length === 0) return { error: 'No data for this period' };
  let totalPvKwh = 0, lastTs = null;
  for (const row of pvRows) {
    if (row.value_num == null) continue;
    if (lastTs !== null) {
      const intervalHours = (row.ts - lastTs) / 3600;
      if (intervalHours > 0 && intervalHours < 1) {
        totalPvKwh += (row.value_num * intervalHours) / 1000;
      }
    }
    lastTs = row.ts;
  }
  // Simple: all solar produced = avoided grid purchase
  const saving = totalPvKwh * rate.price_per_kwh;
  return {
    rate: rate.price_per_kwh, currency: rate.currency || 'GBP',
    totalPvKwh: round(totalPvKwh),
    totalSaving: round(saving),
    selfConsumptionSaving: round(saving),
    netSaving: round(saving),
    totalImportKwh: 0, totalExportKwh: 0, importCost: 0, exportValue: 0,
    totalSelfConsKwh: round(totalPvKwh),
    sampleCount: pvRows.length,
    fromTs, toTs,
  };
}

// Get savings breakdown by day
export function calculateDailySavings(sn, fromTs, toTs) {
  const DAY = 86400;
  const daily = [];
  let dayStart = Math.floor(fromTs / DAY) * DAY;

  while (dayStart < toTs) {
    const dayEnd = dayStart + DAY;
    const result = calculateSavings(sn, dayStart, Math.min(dayEnd, toTs));
    if (!result.error) {
      daily.push({ date: dayStart, ...result });
    }
    dayStart += DAY;
  }
  return daily;
}

function round(v) {
  return Math.round(v * 100) / 100;
}
