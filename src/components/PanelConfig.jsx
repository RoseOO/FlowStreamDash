import React, { useState, useEffect, useRef } from 'react';

export default function PanelConfig({ apiFetch, sn }) {
  const [pv1, setPv1] = useState('');
  const [pv2, setPv2] = useState('');
  const [saved, setSaved] = useState('');
  const timerRef = useRef(null);

  useEffect(() => {
    apiFetch(`/settings/panels/${sn}`).then(d => {
      setPv1((d.pv1_rated_watts||0).toString());
      setPv2((d.pv2_rated_watts||0).toString());
    });
  }, [sn, apiFetch]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  async function save(e) {
    e.preventDefault();
    await apiFetch(`/settings/panels/${sn}`, {
      method:'POST',
      body:JSON.stringify({ pv1_rated_watts: parseInt(pv1)||0, pv2_rated_watts: parseInt(pv2)||0 }),
    });
    setSaved('Saved!');
    timerRef.current = setTimeout(() => setSaved(''), 2000);
  }

  return (
    <form onSubmit={save} style={{display:'flex',gap:8,alignItems:'flex-end'}}>
      <div className="form-group" style={{flex:1,marginBottom:0}}>
        <label>PV1 Rating (W)</label>
        <input type="number" min="0" step="1" value={pv1} onChange={e=>setPv1(e.target.value)} placeholder="e.g. 465"/>
      </div>
      <div className="form-group" style={{flex:1,marginBottom:0}}>
        <label>PV2 Rating (W)</label>
        <input type="number" min="0" step="1" value={pv2} onChange={e=>setPv2(e.target.value)} placeholder="e.g. 465"/>
      </div>
      <button className="btn btn-primary btn-sm" type="submit">{saved || 'Save'}</button>
    </form>
  );
}
