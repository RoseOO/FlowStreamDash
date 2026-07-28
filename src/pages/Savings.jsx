import React, { useState, useEffect } from 'react';
import { useAuth } from '../App';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';

const DAY = 86400;

export default function Savings() {
  const { apiFetch } = useAuth();
  const [devices, setDevices] = useState([]);
  const [selectedSn, setSelectedSn] = useState('__all__');
  const [rate, setRate] = useState('');
  const [currentRate, setCurrentRate] = useState(null);
  const [nightRateVal, setNightRateVal] = useState('');
  const [nightStart, setNightStart] = useState('23');
  const [nightEnd, setNightEnd] = useState('6');
  const [nightEnabled, setNightEnabled] = useState(false);
  const [range, setRange] = useState('7d');
  const [savings, setSavings] = useState(null);
  const [dailyData, setDailyData] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { apiFetch('/devices').then(setDevices); }, [apiFetch]);
  useEffect(() => { apiFetch('/savings/rate').then(r => { setCurrentRate(r); if(r)setRate(r.price_per_kwh.toString()); }); }, [apiFetch]);
  useEffect(() => {
    apiFetch('/savings/night-rate').then(r => {
      if (r.enabled) { setNightEnabled(true); setNightRateVal(r.price_per_kwh.toString()); setNightStart(String(r.start_hour)); setNightEnd(String(r.end_hour)); }
    });
  }, [apiFetch]);

  useEffect(() => {
    if (!rate) return;
    setLoading(true);
    const now = Math.floor(Date.now()/1000);
    const ranges={'24h':DAY,'7d':7*DAY,'30d':30*DAY,'90d':90*DAY,'365d':365*DAY};
    const from=now-(ranges[range]||7*DAY);

    const fetchFn = selectedSn === '__all__'
      ? apiFetch(`/savings/aggregate?from=${from}&to=${now}`).then(r => ({ summary: r, daily: r.daily || [] }))
      : Promise.all([
          apiFetch(`/savings/calculate/${selectedSn}?from=${from}&to=${now}`),
          apiFetch(`/savings/daily/${selectedSn}?from=${from}&to=${now}`),
        ]).then(([summary,daily])=>({summary,daily}));

    fetchFn.then(({summary,daily}) => {
      setSavings(summary);
      if (daily) setDailyData(daily.map(d => ({
        ...d,
        date: typeof d.date === 'string' ? d.date : new Date(d.date * 1000).toLocaleDateString().slice(0,5),
      })));
    }).finally(()=>setLoading(false));
  }, [selectedSn, rate, range, apiFetch]);

  async function saveRate(e) {
    e.preventDefault();
    const p=parseFloat(rate);
    if(isNaN(p)||p<=0)return;
    await apiFetch('/savings/rate',{method:'POST',body:JSON.stringify({price_per_kwh:p})});
    apiFetch('/savings/rate').then(r=>{setCurrentRate(r);if(r)setRate(r.price_per_kwh.toString());});
  }

  return (
    <div>
      <h2 style={{marginBottom:16}}>Savings & Economics</h2>
      <div className="grid-2">
        <div className="card">
          <h3>Electricity Rate</h3>
          <form onSubmit={saveRate} style={{display:'flex',gap:8,alignItems:'flex-end'}}>
            <div className="form-group" style={{flex:1,marginBottom:0}}>
              <label>Day Rate (£/kWh)</label>
              <input type="number" step="0.01" min="0" value={rate} onChange={e=>setRate(e.target.value)} required/>
            </div>
            <button className="btn btn-primary btn-sm" style={{marginBottom:0}}>Save</button>
          </form>
          {currentRate&&<p style={{marginTop:10,fontSize:13,color:'var(--text-dim)'}}>Current: <strong>£{currentRate.price_per_kwh}/kWh</strong></p>}
          
          <div style={{marginTop:14,borderTop:'1px solid var(--border)',paddingTop:12}}>
            <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13,marginBottom:8}}>
              <input type="checkbox" checked={nightEnabled} onChange={e=>setNightEnabled(e.target.checked)}/>
              Night Rate (off-peak)
            </label>
            {nightEnabled && <form onSubmit={async e=>{e.preventDefault();await apiFetch('/savings/night-rate',{method:'POST',body:JSON.stringify({price_per_kwh:parseFloat(nightRateVal),start_hour:parseInt(nightStart),end_hour:parseInt(nightEnd)})});}} style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
              <div className="form-group" style={{width:100,marginBottom:0}}><label>Rate (£/kWh)</label><input type="number" step="0.01" min="0" value={nightRateVal} onChange={e=>setNightRateVal(e.target.value)}/></div>
              <div className="form-group" style={{width:60,marginBottom:0}}><label>Start hr</label><input type="number" min="0" max="23" value={nightStart} onChange={e=>setNightStart(e.target.value)}/></div>
              <div className="form-group" style={{width:60,marginBottom:0}}><label>End hr</label><input type="number" min="0" max="23" value={nightEnd} onChange={e=>setNightEnd(e.target.value)}/></div>
              <button className="btn btn-primary btn-sm" style={{marginBottom:0}}>Save Night Rate</button>
            </form>}
          </div>
        </div>
        <div className="card">
          <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
            <select value={selectedSn} onChange={e=>setSelectedSn(e.target.value)}
              style={{padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13}}>
              <option value="__all__">All Devices (Aggregate)</option>
              {devices.map(d=><option key={d.sn} value={d.sn}>{d.name||d.sn}</option>)}
            </select>
            {['24h','7d','30d','90d','365d'].map(r=>(
              <button key={r} className={`btn btn-sm ${range===r?'btn-primary':''}`}
                style={range!==r?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}} onClick={()=>setRange(r)}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      {loading&&<div className="loading"><div className="spinner"></div></div>}

      {savings&&!savings.error&&<>
        <div className="grid-4" style={{margin:'16px 0'}}>
          <div className="stat-card"><div className="label">Solar Saving</div><div className="value" style={{color:'var(--accent)'}}>£{savings.totalSaving}</div>
            <div className="sub">£{savings.rate}/kWh × {savings.totalPvKwh}kWh</div></div>
          <div className="stat-card"><div className="label">Grid Import Cost</div><div className="value" style={{color:'var(--warn)'}}>£{savings.importCost}</div>
            <div className="sub">{savings.totalImportKwh} kWh</div></div>
          <div className="stat-card"><div className="label">Export Value</div><div className="value" style={{color:'var(--accent2)'}}>£{savings.exportValue}</div>
            <div className="sub">{savings.totalExportKwh} kWh</div></div>
          <div className="stat-card"><div className="label">Net Position</div><div className="value" style={{color:savings.netPosition>=0?'var(--accent)':'var(--warn)'}}>£{savings.netPosition}</div>
            <div className="sub">{savings.hasGridMeter?'With grid meter':'Solar estimate only'}</div></div>
        </div>
      </>}

      {dailyData.length>0&&<>
        <div className="card"><h3>Daily Solar Production (kWh)</h3>
          <div style={{width:'100%',height:350}}><ResponsiveContainer>
            <BarChart animationDuration={0} data={dailyData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Bar isAnimationActive={false} dataKey="totalPvKwh" fill="#4CAF50" name="kWh" radius={[2,2,0,0]}/>
            </BarChart>
          </ResponsiveContainer></div>
        </div>
        <div className="card"><h3>Cumulative Saving (£)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <LineChart animationDuration={0} data={dailyData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:11,fill:'var(--text-dim)'}}/><YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Line isAnimationActive={false} type="monotone" dataKey="totalSaving" stroke="#4CAF50" name="Cumulative £" strokeWidth={2} dot={false} connectNulls={true}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>
      </>}
    </div>
  );
}
