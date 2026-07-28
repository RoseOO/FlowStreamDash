import { DISPLAY_ORDER, getCsvLabel } from './fields.js';

export function buildCsvData(rows) {
  const allFieldNums = new Set();
  for (const r of rows) allFieldNums.add(r.field_num);

  const orderedFields = [
    ...DISPLAY_ORDER.filter(f => allFieldNums.has(f)),
    ...[...allFieldNums].filter(f => !DISPLAY_ORDER.includes(f)).sort((a, b) => a - b),
  ];

  const header = ['timestamp', ...orderedFields.map(f => getCsvLabel(f))];

  const byTs = {};
  for (const r of rows) {
    if (!byTs[r.ts]) byTs[r.ts] = {};
    const val = r.value_text || r.value_num;
    byTs[r.ts][r.field_num] = val != null ? val : '';
  }

  const csvRows = [header.join(',')];
  for (const ts of Object.keys(byTs).sort()) {
    const row = [new Date(parseInt(ts) * 1000).toISOString()];
    for (const f of orderedFields) {
      const val = byTs[ts][f];
      row.push(val !== undefined ? val : '');
    }
    csvRows.push(row.join(','));
  }

  return csvRows.join('\n');
}
