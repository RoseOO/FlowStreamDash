import React, { useState, useEffect } from 'react';

export default function WeatherConfig({ apiFetch }) {
  const [lat, setLat] = useState('51.5');
  const [lon, setLon] = useState('-0.13');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    apiFetch('/settings/weather').then(d => { setLat(d.lat||'52.5'); setLon(d.lon||'-1.5'); });
  }, []);

  async function save(e) {
    e.preventDefault();
    await apiFetch('/settings/weather', { method:'POST', body:JSON.stringify({ lat, lon }) });
    setSaved('Saved!'); setTimeout(() => setSaved(''), 2000);
  }

  return (
    <form onSubmit={save} style={{display:'flex',gap:8,alignItems:'flex-end'}}>
      <div className="form-group" style={{flex:1,marginBottom:0}}><label>Latitude</label><input value={lat} onChange={e=>setLat(e.target.value)} placeholder="51.5" step="any"/></div>
      <div className="form-group" style={{flex:1,marginBottom:0}}><label>Longitude</label><input value={lon} onChange={e=>setLon(e.target.value)} placeholder="-0.13" step="any"/></div>
      <button className="btn btn-primary btn-sm" type="submit">{saved||'Save'}</button>
    </form>
  );
}
