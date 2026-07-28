import React, { useState, useEffect, useRef } from 'react';

export default function HaMqttConfig({ apiFetch }) {
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('1883');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [prefix, setPrefix] = useState('homeassistant');
  const [connected, setConnected] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const timerRef = useRef(null);

  useEffect(() => {
    apiFetch('/settings/ha-mqtt').then(d => {
      setEnabled(d.enabled); setHost(d.host); setPort(String(d.port));
      setUsername(d.username); setPrefix(d.discovery_prefix); setConnected(d.connected);
    });
  }, [apiFetch]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  async function save(e) {
    e.preventDefault(); setError(''); setSaved('');
    try {
      const result = await apiFetch('/settings/ha-mqtt', {
        method:'POST', body:JSON.stringify({ enabled, host, port, username, password, discovery_prefix:prefix }),
      });
      setConnected(result.connected);
      setSaved(result.connected ? 'Connected! ✓' : 'Saved');
      timerRef.current = setTimeout(() => setSaved(''), 3000);
    } catch(err) { setError(err.message); }
  }

  return (
    <form onSubmit={save}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
        <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13}}>
          <input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>
          Enable Home Assistant MQTT
        </label>
        {connected && <span style={{fontSize:11,color:'var(--accent)'}}>● Connected</span>}
      </div>
      {enabled && <>
        <div className="flex-row gap-sm" style={{flexWrap:'wrap'}}>
          <div className="form-group" style={{flex:1,minWidth:120,marginBottom:8}}><label>MQTT Host</label><input value={host} onChange={e=>setHost(e.target.value)} placeholder="192.168.1.10" required/></div>
          <div className="form-group" style={{width:80,marginBottom:8}}><label>Port</label><input value={port} onChange={e=>setPort(e.target.value)} placeholder="1883"/></div>
        </div>
        <div className="flex-row gap-sm" style={{flexWrap:'wrap'}}>
          <div className="form-group" style={{flex:1,minWidth:120,marginBottom:8}}><label>Username (optional)</label><input value={username} onChange={e=>setUsername(e.target.value)}/></div>
          <div className="form-group" style={{flex:1,minWidth:120,marginBottom:8}}><label>Password (optional)</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Leave blank to keep existing"/></div>
        </div>
        <div className="form-group" style={{marginBottom:8}}><label>Discovery Prefix</label><input value={prefix} onChange={e=>setPrefix(e.target.value)} placeholder="homeassistant"/></div>
      </>}
      {error && <div className="error">{error}</div>}
      {saved && <div style={{background:'rgba(76,175,80,.1)',padding:'8px 14px',borderRadius:6,fontSize:12,marginBottom:8,color:'var(--accent)'}}>{saved}</div>}
      <button className="btn btn-primary btn-sm" type="submit">{enabled?'Save & Connect':'Save'}</button>
    </form>
  );
}
