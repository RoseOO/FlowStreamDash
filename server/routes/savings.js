import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { calculateSavings, calculateDailySavings } from '../aggregator.js';
import { round2 } from '../utils.js';

export default function(app) {
  app.post('/api/savings/rate', authMiddleware, (req, res) => {
    const { price_per_kwh, currency } = req.body;
    if (!price_per_kwh) return res.status(400).json({ error: 'Rate required' });
    db.addRate(parseFloat(price_per_kwh), currency || 'GBP');
    res.json({ success: true });
  });

  app.get('/api/savings/rate', authMiddleware, (req, res) => {
    const rate = db.getCurrentRate();
    res.json(rate || { price_per_kwh: 0, currency: 'GBP' });
  });

  app.get('/api/savings/calculate/:sn', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const result = calculateSavings(req.params.sn, fromTs, toTs);
    res.json(result);
  });

  app.get('/api/savings/daily/:sn', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const result = calculateDailySavings(req.params.sn, fromTs, toTs);
    res.json(result);
  });

  app.get('/api/savings/aggregate', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const fromTs = from ? parseInt(from) : Math.floor(Date.now()/1000-86400*30);
    const toTs = to ? parseInt(to) : Math.floor(Date.now()/1000);
    const devices = db.getDevices();
    let totalPvKwh=0, totalImportKwh=0, totalExportKwh=0, totalSelfConsKwh=0;
    const dailyMap = {};

    for (const d of devices) {
      const r = calculateSavings(d.sn, fromTs, toTs);
      if (!r.error) {
        totalPvKwh += r.totalPvKwh || 0;
        totalImportKwh += r.totalImportKwh || 0;
        totalExportKwh += r.totalExportKwh || 0;
        totalSelfConsKwh += (r.totalPvKwh||0) - (r.totalExportKwh||0);
      }
      const daily = calculateDailySavings(d.sn, fromTs, toTs);
      for (const day of daily) {
        if (!dailyMap[day.date]) {
          dailyMap[day.date] = { date: day.date, exportValue:0, importCost:0, selfConsumptionSaving:0, totalSaving:0, totalPvKwh:0 };
        }
        dailyMap[day.date].exportValue += day.exportValue || 0;
        dailyMap[day.date].importCost += day.importCost || 0;
        dailyMap[day.date].selfConsumptionSaving += day.selfConsumptionSaving || 0;
        dailyMap[day.date].totalSaving += day.totalSaving || 0;
        dailyMap[day.date].totalPvKwh += day.totalPvKwh || 0;
      }
    }
    const rate = db.getCurrentRate();
    const price = rate ? rate.price_per_kwh : 0;
    const dailyArr = Object.values(dailyMap).sort((a,b) => a.date - b.date);
    res.json({
      totalPvKwh: round2(totalPvKwh), totalImportKwh: round2(totalImportKwh),
      totalExportKwh: round2(totalExportKwh), totalSelfConsKwh: round2(totalSelfConsKwh),
      totalSaving: round2(totalPvKwh * price),
      importCost: round2(totalImportKwh * price),
      exportValue: round2(totalExportKwh * price),
      netSaving: round2((totalSelfConsKwh - totalImportKwh + totalExportKwh) * price),
      selfConsumptionSaving: round2(totalSelfConsKwh * price),
      rate: price, deviceCount: devices.length,
      daily: dailyArr.map(d => ({
        date: d.date,
        totalPvKwh: round2(d.totalPvKwh || 0),
        totalSaving: round2(d.totalSaving || 0),
      })),
    });
  });

  app.post('/api/savings/night-rate', authMiddleware, (req, res) => {
    const { price_per_kwh, start_hour, end_hour } = req.body;
    if (price_per_kwh) db.setSetting('night_rate', String(price_per_kwh));
    if (start_hour != null) db.setSetting('night_start', String(start_hour));
    if (end_hour != null) db.setSetting('night_end', String(end_hour));
    res.json({ success: true });
  });

  app.get('/api/savings/night-rate', authMiddleware, (req, res) => {
    res.json({
      enabled: db.getSetting('night_rate') ? true : false,
      price_per_kwh: parseFloat(db.getSetting('night_rate') || '0'),
      start_hour: parseInt(db.getSetting('night_start') || '23'),
      end_hour: parseInt(db.getSetting('night_end') || '6'),
    });
  });
}
