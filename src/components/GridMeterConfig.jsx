import React, { useState, useEffect } from 'react';

export default function GridMeterConfig({ apiFetch }) {
  const [enabled, setEnabled] = useState(false);
  const [ip, setIp] = useState('');
  const [connected, setConnected] = useState(false);
  const [lastPower, setLastPower] = useState(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/settings/grid-meter').then(d => {
      setEnabled(d.enabled); setIp(d.ip);
      setConnected(d.connected); setLastPower(d.lastPower);
    });
  }, []);

  async function save(e) {
    e.preventDefault(); setError(''); setSaved('');
    try {
      await apiFetch('/settings/grid-meter', {
        method:'POST', body:JSON.stringify({ enabled, ip }),
      });
      setSaved('Saved');
      setTimeout(() => setSaved(''), 3000);
    } catch(err) { setError(err.message); }
  }

  return (
    <form onSubmit={save}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
        <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13}}>
          <input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>
          Enable Grid Meter (ESPHome)
        </label>
        {connected && <span style={{fontSize:11,color:'var(--accent)'}}>● {lastPower != null ? `${lastPower.toFixed(0)}W` : 'Connected'}</span>}
      </div>
      {enabled && <>
        <div className="form-group" style={{marginBottom:8}}>
          <label>ESPHome Device IP</label>
          <input value={ip} onChange={e=>setIp(e.target.value)} placeholder="192.168.150.202" required/>
        </div>
        <p style={{fontSize:11,color:'var(--text-dim)',marginBottom:8}}>
          Uses persistent SSE connection to ESPHome web_server /events. No polling needed — real-time updates.
        </p>
      </>}
      {error && <div className="error">{error}</div>}
      {saved && <div style={{background:'rgba(76,175,80,.1)',padding:'8px 14px',borderRadius:6,fontSize:12,marginBottom:8,color:'var(--accent)'}}>{saved}</div>}
      <button className="btn btn-primary btn-sm" type="submit">Save</button>
    </form>
  );
}
