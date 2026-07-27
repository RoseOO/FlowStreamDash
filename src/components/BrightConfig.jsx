import React, { useState, useEffect } from 'react';

export default function BrightConfig({ apiFetch }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saved, setSaved] = useState('');
  const [backfilling, setBackfilling] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/bright/status').then(d => { setConfigured(d.configured); setUsername(d.username||''); }).catch(()=>{});
  }, []);

  async function save(e) {
    e.preventDefault(); setError(''); setSaved('');
    try {
      await apiFetch('/bright/configure', { method:'POST', body:JSON.stringify({ username, password }) });
      setConfigured(true); setSaved('Credentials verified ✓'); setPassword('');
      setTimeout(() => setSaved(''), 3000);
    } catch(err) { setError(err.message); }
  }

  async function doBackfill() {
    setBackfilling(true); setError('');
    try {
      const r = await apiFetch('/bright/backfill', { method:'POST', body:JSON.stringify({}) });
      setSaved(`Backfilled ${r.readings} days of historical meter data!`);
      setTimeout(() => setSaved(''), 5000);
    } catch(err) { setError(err.message); }
    setBackfilling(false);
  }

  return (
    <form onSubmit={save}>
      <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>
        Connect your SMETS2 smart meter via the Bright/Glowmarkt API for historical grid import/export data. 
        Backfills gaps in live monitoring. Register at <a href="https://glowmarkt.com" target="_blank" rel="noreferrer" style={{color:'var(--accent2)'}}>glowmarkt.com</a>.
      </p>
      {configured && (
        <div style={{background:'rgba(76,175,80,.1)',padding:'10px 14px',borderRadius:8,marginBottom:14,fontSize:13}}>
          ✅ Connected as <strong>{username}</strong>
        </div>
      )}
      <div className="form-group"><label>Bright Username</label><input value={username} onChange={e=>setUsername(e.target.value)} placeholder="email@example.com" required/></div>
      <div className="form-group"><label>Bright Password</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Your Bright app password" required/></div>
      {error && <div className="error">{error}</div>}
      {saved && <div style={{background:'rgba(76,175,80,.1)',padding:'8px 14px',borderRadius:6,fontSize:12,marginBottom:8,color:'var(--accent)'}}>{saved}</div>}
      <div style={{display:'flex',gap:8}}>
        <button className="btn btn-primary btn-sm" type="submit">Save & Verify</button>
        {configured && <button type="button" className="btn btn-sm" style={{background:'var(--bg-card2)',color:'var(--text)'}} onClick={doBackfill} disabled={backfilling}>
          {backfilling?'Backfilling...':'Backfill Historical Data'}
        </button>}
      </div>
    </form>
  );
}
