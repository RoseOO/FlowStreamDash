import * as db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { FIELD_META, DISPLAY_ORDER, DISPLAY_SECTIONS, GRAPH_FIELDS } from '../fields.js';
import { IDLE_TIMEOUT } from '../config.js';

export default function(app, deps) {
  const { dataLogger } = deps;

  app.get('/api/data/:sn/latest', authMiddleware, (req, res) => {
    const latest = db.getLatestData(req.params.sn);
    const range = db.getDataRange(req.params.sn);
    const now = Date.now() / 1000;
    const idle = dataLogger ? dataLogger.getIdleStatus(req.params.sn) : false;
    res.json({ latest, range, idle });
  });

  app.get('/api/data/:sn/history', authMiddleware, (req, res) => {
    const { from, to, fields } = req.query;
    const fromTs = from ? parseInt(from) : 0;
    const toTs = to ? parseInt(to) : Math.floor(Date.now() / 1000);
    const fieldNums = fields ? fields.split(',').map(Number).filter(n => !isNaN(n)) : null;
    const rows = db.getHistoricalData(req.params.sn, fromTs, toTs, fieldNums);
    res.json(rows);
  });

  app.get('/api/data/:sn/aggregates', authMiddleware, (req, res) => {
    const { from, to, fields, table } = req.query;
    const fromTs = from ? parseInt(from) : 0;
    const toTs = to ? parseInt(to) : Math.floor(Date.now() / 1000);
    const fieldNums = fields ? fields.split(',').map(Number).filter(n => !isNaN(n)) : null;
    const rows = db.getAggregates(req.params.sn, fromTs, toTs, fieldNums, table || 'hourly');
    res.json(rows);
  });

  app.get('/api/data/:sn/fields', authMiddleware, (req, res) => {
    res.json({
      meta: FIELD_META,
      displayOrder: DISPLAY_ORDER,
      sections: DISPLAY_SECTIONS,
      graphFields: GRAPH_FIELDS,
    });
  });
}
