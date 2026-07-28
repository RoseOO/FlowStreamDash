import React from 'react';
export default function DeviceSelector({ devices, selectedSn, setSelectedSn }) {
  return (
    <select value={selectedSn} onChange={e => setSelectedSn(e.target.value)}
      style={{ padding: '8px 12px', background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 13 }}>
      {devices.map(d => <option key={d.sn} value={d.sn}>{d.name || d.sn}</option>)}
    </select>
  );
}
