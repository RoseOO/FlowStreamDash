// Hourly/daily aggregator and savings calculator

import db, { getHistoricalData, saveHourly, getAggregates, getCurrentRate, getGridData, getSetting } from './db.js';

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

// Calculate savings using real grid meter data when available, falling back to PV-only estimate
export function calculateSavings(sn, fromTs, toTs) {
  const rate = getCurrentRate();
  if (!rate) return { error: 'No electricity rate configured' };
  let dayRate = rate.price_per_kwh;
  // Check for night rate
  const nightRateVal = parseFloat(getSetting('night_rate') || '0');
  const nightStart = parseInt(getSetting('night_start') || '23');
  const nightEnd = parseInt(getSetting('night_end') || '6');
  const hasNightRate = nightRateVal > 0;

  // Get PV production
  const pvRows = getHistoricalData(sn, fromTs, toTs, [361, 70]);
  let totalPvKwh = 0, lastTs = null;
  for (const row of pvRows) {
    if (row.value_num == null) continue;
    if (lastTs !== null) {
      const intervalHours = (row.ts - lastTs) / 3600;
      if (intervalHours > 0 && intervalHours < 1) totalPvKwh += (row.value_num * intervalHours) / 1000;
    }
    lastTs = row.ts;
  }
  if (totalPvKwh < 0.0001) return { error: 'No data for this period' };

  // Try to get real grid import data
  const gridRows = getGridData(fromTs, toTs);
  let totalImportKwh = 0, totalExportKwh = 0;
  let hasGridData = gridRows && gridRows.length > 5;

  if (hasGridData) {
    let lastGridTs = null;
    for (const row of gridRows) {
      if (row.power_w == null) continue;
      if (lastGridTs !== null) {
        const intervalHours = (row.ts - lastGridTs) / 3600;
        if (intervalHours > 0 && intervalHours < 1) {
          const h = new Date(row.ts * 1000).getHours();
          const isNight = nightStart > nightEnd
            ? (h >= nightStart || h < nightEnd)  // e.g. 23-6
            : (h >= nightStart && h < nightEnd);
          const effectiveRate = (hasNightRate && isNight) ? nightRateVal : dayRate;
          if (row.power_w > 5) totalImportKwh += (row.power_w * intervalHours) / 1000;
          else if (row.power_w < -5) totalExportKwh += (Math.abs(row.power_w) * intervalHours) / 1000;
        }
      }
      lastGridTs = row.ts;
    }
  } else {
    // No grid meter: all solar = avoided import (conservative estimate)
    // We assume ~30% self-consumption, ~70% export (typical UK microinverter)
    totalImportKwh = Math.max(0, totalPvKwh * 0.0); // won't show import without meter
    totalExportKwh = totalPvKwh * 0.0;                 // won't show export without meter
    totalImportKwh = 0;
    totalExportKwh = 0;
  }

  const importCost = totalImportKwh * rate.price_per_kwh;
  const exportValue = totalExportKwh * rate.price_per_kwh;
  const selfConsKwh = Math.max(0, totalPvKwh - totalExportKwh);
  const selfConsumptionSaving = selfConsKwh * rate.price_per_kwh;
  const totalSaving = hasGridData
    ? round(selfConsumptionSaving + exportValue - importCost)
    : round(totalPvKwh * rate.price_per_kwh); // no grid meter: simple PV × rate

  return {
    rate: rate.price_per_kwh, currency: rate.currency || 'GBP',
    nightRate: hasNightRate ? nightRateVal : null,
    nightStart, nightEnd,
    totalPvKwh: round(totalPvKwh),
    totalImportKwh: round(totalImportKwh),
    totalExportKwh: round(totalExportKwh),
    totalSelfConsKwh: round(selfConsKwh),
    importCost: round(importCost),
    exportValue: round(exportValue),
    selfConsumptionSaving: round(selfConsumptionSaving),
    totalSaving, netSaving: totalSaving,
    sampleCount: pvRows.length,
    hasGridMeter: hasGridData,
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
