import React, { useState, useEffect } from 'react';
import { useAuth } from '../App';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line } from 'recharts';

const DAY = 86400;

export default function Savings() {
  const { apiFetch } = useAuth();
  const [devices, setDevices] = useState([]);
  const [selectedSn, setSelectedSn] = useState('__all__');
  const [rate, setRate] = useState('');
  const [currentRate, setCurrentRate] = useState(null);
  const [range, setRange] = useState('7d');
  const [savings, setSavings] = useState(null);
  const [dailyData, setDailyData] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { apiFetch('/devices').then(setDevices); }, []);
  useEffect(() => { apiFetch('/savings/rate').then(r => { setCurrentRate(r); if(r)setRate(r.price_per_kwh.toString()); }); }, []);

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
  }, [selectedSn, rate, range]);

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
              <label>Price per kWh (£)</label>
              <input type="number" step="0.01" min="0" value={rate} onChange={e=>setRate(e.target.value)} required/>
            </div>
            <button className="btn btn-primary" style={{marginBottom:0}}>Save</button>
          </form>
          {currentRate&&<p style={{marginTop:10,fontSize:13,color:'var(--text-dim)'}}>Current: <strong>£{currentRate.price_per_kwh}/kWh</strong></p>}
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
          <div className="stat-card"><div className="label">Total Saved</div><div className="value" style={{color:'var(--accent)'}}>£{savings.totalSaving}</div>
            <div className="sub">{savings.hasGridMeter?'Based on grid meter data':'Based on solar production'}</div></div>
          <div className="stat-card"><div className="label">Solar Produced</div><div className="value">{savings.totalPvKwh}<span className="unit">kWh</span></div></div>
          <div className="stat-card"><div className="label">Grid Import</div><div className="value" style={{color:savings.totalImportKwh>0?'var(--warn)':'var(--text-dim)'}}>{savings.totalImportKwh}<span className="unit">kWh</span></div>
            <div className="sub">£{savings.importCost}</div></div>
          <div className="stat-card"><div className="label">Grid Export</div><div className="value" style={{color:'var(--accent2)'}}>{savings.totalExportKwh}<span className="unit">kWh</span></div>
            <div className="sub">£{savings.exportValue}</div></div>
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
