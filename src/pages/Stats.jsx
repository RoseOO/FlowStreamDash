import React, { useState, useEffect } from 'react';
import { useAuth } from '../App';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';

const DAY = 86400;

export default function Stats() {
  const { apiFetch } = useAuth();
  const [devices, setDevices] = useState([]);
  const [selectedSn, setSelectedSn] = useState('__all__');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState('7d');

  useEffect(() => { apiFetch('/devices').then(setDevices); }, []);
  useEffect(() => { if (devices.length>0&&!selectedSn) setSelectedSn(devices[0].sn); }, [devices]);

  useEffect(() => {
    if (!selectedSn) return;
    setLoading(true);
    const now = Math.floor(Date.now()/1000);
    const ranges={'24h':DAY,'7d':7*DAY,'30d':30*DAY};
    const from = now - (ranges[range]||7*DAY);
    const endpoint = selectedSn === '__all__'
      ? `/stats/aggregate/all?from=${from}&to=${now}`
      : `/stats/${selectedSn}?from=${from}&to=${now}`;
    apiFetch(endpoint)
      .then(setStats).finally(()=>setLoading(false));
  }, [selectedSn, range]);

  if (loading) return <div className="loading"><div className="spinner"></div></div>;

  const profileData = stats?.hourlyProfile
    ? Array.from({length:24},(_,h)=>({hour:`${h}:00`,avg:stats.hourlyProfile[h]?.avg||0,max:stats.hourlyProfile[h]?.max||0}))
    : [];

  const dailyData = stats?.daily?.map(d=>({
    date:new Date(d.ts*1000).toLocaleDateString().slice(0,5),
    kwh:d.totalKwh, peak:d.peakW,
  })) || [];

  return (
    <div>
      <h2 style={{marginBottom:16}}>Statistics & Analysis</h2>
      <div className="card" style={{marginBottom:16}}>
        <div style={{display:'flex',gap:12,alignItems:'center'}}>
          <select value={selectedSn} onChange={e=>setSelectedSn(e.target.value)}
            style={{padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13}}>
            {devices.length===0?<option>No devices</option>:<>
              <option value="__all__">All Devices (Aggregate)</option>
              {devices.map(d=><option key={d.sn} value={d.sn}>{d.name||d.sn}</option>)}
            </>}
          </select>
          {['24h','7d','30d'].map(r=>(
            <button key={r} className={`btn btn-sm ${range===r?'btn-primary':''}`}
              style={range!==r?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}} onClick={()=>setRange(r)}>{r}</button>
          ))}
        </div>
      </div>

      {stats&&<>
        {/* Summary */}
        <div className="grid-4" style={{marginBottom:16}}>
          <div className="stat-card"><div className="label">Total Production</div><div className="value">{stats.totalKwh}<span className="unit">kWh</span></div></div>
          <div className="stat-card"><div className="label">Avg Daily</div><div className="value">{stats.avgDailyKwh}<span className="unit">kWh</span></div></div>
          <div className="stat-card"><div className="label">Best Day</div><div className="value">{stats.bestDay?.totalKwh||0}<span className="unit">kWh</span></div></div>
          <div className="stat-card"><div className="label">Peak Hour</div>
            <div className="value" style={{fontSize:22}}>{stats.peakHour?`${stats.peakHour.hour}:00`:'--'}<span className="unit" style={{fontSize:13}}> {stats.peakHour?.avg||0}W avg</span></div></div>
        </div>

        {/* Panel Efficiency */}
        {(stats.efficiency?.pv1||stats.efficiency?.pv2)&&<div className="grid-2" style={{marginBottom:16}}>
          {stats.efficiency.pv1&&<div className="card">
            <h3>PV1 Efficiency</h3>
            <div className="stat-card"><div className="label">Rated Capacity</div><div className="value" style={{fontSize:22}}>{stats.efficiency.pv1.rated}<span className="unit">W</span></div></div>
            <div className="stat-card" style={{marginTop:8}}><div className="label">Peak Observed</div><div className="value" style={{fontSize:22,color:'var(--pv1)'}}>{stats.efficiency.pv1.peak}<span className="unit">W</span></div></div>
            <div className="stat-card" style={{marginTop:8}}><div className="label">Peak Efficiency</div>
              <div className="value" style={{fontSize:22,color:stats.efficiency.pv1.pct>80?'var(--accent)':'var(--warn)'}}>{stats.efficiency.pv1.pct}<span className="unit">%</span></div></div>
          </div>}
          {stats.efficiency.pv2&&<div className="card">
            <h3>PV2 Efficiency</h3>
            <div className="stat-card"><div className="label">Rated Capacity</div><div className="value" style={{fontSize:22}}>{stats.efficiency.pv2.rated}<span className="unit">W</span></div></div>
            <div className="stat-card" style={{marginTop:8}}><div className="label">Peak Observed</div><div className="value" style={{fontSize:22,color:'var(--pv2)'}}>{stats.efficiency.pv2.peak}<span className="unit">W</span></div></div>
            <div className="stat-card" style={{marginTop:8}}><div className="label">Peak Efficiency</div>
              <div className="value" style={{fontSize:22,color:stats.efficiency.pv2.pct>80?'var(--accent)':'var(--warn)'}}>{stats.efficiency.pv2.pct}<span className="unit">%</span></div></div>
          </div>}
        </div>}

        {/* Hourly generation profile */}
        <div className="card" style={{marginBottom:16}}>
          <h3>Generation Profile by Hour</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <AreaChart animationDuration={0} data={profileData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="hour" tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Area isAnimationActive={false} connectNulls={true} type="monotone" dataKey="avg" stroke="#2196F3" fill="#2196F3" fillOpacity={0.2} name="Avg Power (W)"/>
            </AreaChart>
          </ResponsiveContainer></div>
        </div>

        {/* Daily totals */}
        <div className="card">
          <h3>Daily Production (kWh)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <BarChart animationDuration={0} data={dailyData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Bar isAnimationActive={false} dataKey="kwh" fill="#4CAF50" name="kWh"/>
            </BarChart>
          </ResponsiveContainer></div>
        </div>
      </>}
    </div>
  );
}
