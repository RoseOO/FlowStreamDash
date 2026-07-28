import React from 'react';
export default function RangeSelector({ range, setRange, customFrom, setCustomFrom, customTo, setCustomTo, options = ['1h','6h','24h','7d','30d','90d'] }) {
  return (
    <>
      <div className="flex-row gap-sm" style={{ marginBottom: 12 }}>
        {options.map(r => (
          <button key={r} className={`btn btn-sm ${range === r ? 'btn-primary' : ''}`}
            style={range !== r ? { background: 'var(--bg-card2)', color: 'var(--text-dim)' } : {}}
            onClick={() => setRange(r)}>{r}</button>
        ))}
        <button className={`btn btn-sm ${range === 'custom' ? 'btn-primary' : ''}`}
          style={range !== 'custom' ? { background: 'var(--bg-card2)', color: 'var(--text-dim)' } : {}}
          onClick={() => setRange('custom')}>Custom</button>
      </div>
      {range === 'custom' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <input type="datetime-local" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12 }} />
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>to</span>
          <input type="datetime-local" value={customTo} onChange={e => setCustomTo(e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12 }} />
        </div>
      )}
    </>
  );
}
