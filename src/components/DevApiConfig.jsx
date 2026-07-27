import React, { useState, useEffect } from 'react';

export default function DevApiConfig({ apiFetch }) {
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [saved, setSaved] = useState('');
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/devapi/status').then(d => setConfigured(d.configured)).catch(()=>{});
  }, []);

  async function save(e) {
    e.preventDefault(); setError(''); setSaved('');
    try {
      const result = await apiFetch('/devapi/configure', {
        method:'POST', body:JSON.stringify({ accessKey, secretKey }),
      });
      setConfigured(true);
      if (result.devices?.length) {
        setDevices(result.devices);
        setSaved(`Verified! Found ${result.devices.length} device(s).`);
      } else {
        setSaved('Credentials verified ✓');
      }
      setTimeout(() => setSaved(''), 5000);
    } catch(err) { setError(err.message); }
  }

  async function syncDevices() {
    try {
      const result = await apiFetch('/devapi/sync-devices', { method:'POST' });
      if (result.added > 0) {
        setSaved(`Auto-added ${result.added} device(s)!`);
      } else {
        setSaved('All API devices already registered.');
      }
      setTimeout(() => setSaved(''), 3000);
    } catch(err) { setError(err.message); }
  }

  return (
    <form onSubmit={save}>
      <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>
        The Developer API provides richer data via HTTP polling (named quota keys, cumulative energy, extra diagnostics). 
        Get keys at <a href="https://developer-eu.ecoflow.com" target="_blank" rel="noreferrer" style={{color:'var(--accent2)'}}>developer-eu.ecoflow.com</a>.
        Data is polled every 30 seconds and merged with live MQTT.
      </p>
      {configured && (
        <div style={{background:'rgba(76,175,80,.1)',padding:'10px 14px',borderRadius:8,marginBottom:14,fontSize:13}}>
          ✅ Developer API configured — polling active
          {devices.length>0 && <span> · {devices.length} device(s) found</span>}
        </div>
      )}
      <div className="form-group">
        <label>Access Key</label>
        <input value={accessKey} onChange={e=>setAccessKey(e.target.value)} placeholder="Enter your Developer API access key" required/>
      </div>
      <div className="form-group">
        <label>Secret Key</label>
        <input type="password" value={secretKey} onChange={e=>setSecretKey(e.target.value)} placeholder="Enter your Developer API secret key" required/>
      </div>
      {error && <div className="error">{error}</div>}
      {saved && <div style={{background:'rgba(76,175,80,.1)',padding:'8px 14px',borderRadius:6,fontSize:12,marginBottom:8,color:'var(--accent)'}}>{saved}</div>}
      <div style={{display:'flex',gap:8}}>
        <button className="btn btn-primary btn-sm" type="submit">Save & Verify</button>
        {configured && <button type="button" className="btn btn-sm" style={{background:'var(--bg-card2)',color:'var(--text)'}} onClick={syncDevices}>Auto-Add Devices</button>}
      </div>
    </form>
  );
}
