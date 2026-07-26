import React, { useState, useEffect } from 'react';
import { useAuth } from '../App';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, LineChart, Line, Legend, ComposedChart, Brush } from 'recharts';

const DAY = 86400;

export default function Stats() {
  const { apiFetch } = useAuth();
  const [devices, setDevices] = useState([]);
  const [selectedSn, setSelectedSn] = useState('');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState('7d');
  const [pr, setPr] = useState(null);
  const [quality, setQuality] = useState(null);
  const [degradation, setDegradation] = useState(null);
  const [tab, setTab] = useState('profile');

  useEffect(() => { apiFetch('/devices').then(setDevices); }, []);
  useEffect(() => { if (devices.length>0&&!selectedSn) setSelectedSn(devices[0].sn); }, [devices]);

  useEffect(() => {
    if (!selectedSn) return;
    setLoading(true);
    const now = Math.floor(Date.now()/1000);
    const ranges={'24h':DAY,'7d':7*DAY,'30d':30*DAY};
    const from=now-(ranges[range]||7*DAY);
    const endpoint = selectedSn==='__all__'?'/stats/aggregate/all':`/stats/${selectedSn}`;
    Promise.all([
      apiFetch(`${endpoint}?from=${from}&to=${now}`),
      selectedSn!=='__all__'&&apiFetch(`/stats/${selectedSn}/pr?from=${now-30*DAY}&to=${now}`),
      selectedSn!=='__all__'&&apiFetch(`/stats/${selectedSn}/quality`),
      selectedSn!=='__all__'&&apiFetch(`/stats/${selectedSn}/degradation`),
    ]).then(([s,p,q,d])=>{setStats(s);setPr(p||null);setQuality(q||null);setDegradation(d||null);})
    .finally(()=>setLoading(false));
  }, [selectedSn, range]);

  if (loading&&!stats) return <div className="loading"><div className="spinner"></div></div>;

  const profileData = stats?.hourlyProfile
    ? Array.from({length:24},(_,h)=>({hour:`${h}:00`,avg:stats.hourlyProfile[h]?.avg||0,max:stats.hourlyProfile[h]?.max||0}))
    : [];
  const dailyData = stats?.daily?.map(d=>({date:new Date(d.ts*1000).toLocaleDateString().slice(0,5),kwh:d.totalKwh,peak:d.peakW}))||[];
  const degData = degradation?.map(d=>({...d,month:d.month}))||[];

  function fmt(v,d=1){return v!=null&&!isNaN(v)?v.toFixed(d):'--';}

  return (
    <div>
      <h2 style={{marginBottom:16}}>Statistics & Analysis</h2>
      <div className="card" style={{marginBottom:12}}>
        <div className="flex-row gap-sm">
          <select value={selectedSn} onChange={e=>setSelectedSn(e.target.value)}
            style={{padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13}}>
            <option value="__all__">All Devices</option>
            {devices.map(d=><option key={d.sn} value={d.sn}>{d.name||d.sn}</option>)}
          </select>
          {['24h','7d','30d'].map(r=>(<button key={r} className={`btn btn-sm ${range===r?'btn-primary':''}`}
            style={range!==r?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}} onClick={()=>setRange(r)}>{r}</button>))}
        </div>
      </div>

      {stats&&<>
        <div className="grid-4" style={{marginBottom:12}}>
          <div className="stat-card"><div className="label">Total Production</div><div className="value">{stats.totalKwh}<span className="unit">kWh</span></div></div>
          <div className="stat-card"><div className="label">Avg Daily</div><div className="value">{stats.avgDailyKwh}<span className="unit">kWh</span></div></div>
          <div className="stat-card"><div className="label">Best Day</div><div className="value">{stats.bestDay?.totalKwh||0}<span className="unit">kWh</span></div></div>
          <div className="stat-card"><div className="label">Peak Hour</div><div className="value" style={{fontSize:20}}>{stats.peakHour?`${stats.peakHour.hour}:00`:'--'}<span className="unit"> {stats.peakHour?.avg||0}W</span></div></div>
        </div>

        {/* PR + Quality cards */}
        <div className="grid-2" style={{marginBottom:12}}>
          {pr&&!pr.error&&<div className="card" style={{padding:16}}>
            <h3>Performance Ratio</h3>
            <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
              <div style={{flex:1,minWidth:70}}><div className="label">PR Score</div>
                <div className="value" style={{fontSize:28,color:pr.performanceRatioPct>80?'var(--accent)':pr.performanceRatioPct>60?'var(--warn)':'var(--danger)'}}>{pr.performanceRatioPct}%</div>
                <div className="sub">{pr.rating}</div></div>
              <div style={{flex:1,minWidth:70}}><div className="label">Actual</div><div style={{fontSize:22,fontWeight:700}}>{pr.actualKwh} kWh</div></div>
              <div style={{flex:1,minWidth:70}}><div className="label">Expected</div><div style={{fontSize:22,fontWeight:700,color:'var(--text-dim)'}}>{pr.expectedKwh} kWh</div></div>
              <div style={{flex:1,minWidth:70}}><div className="label">Peak Sun Hours</div><div style={{fontSize:18,fontWeight:600}}>{pr.peakSunHours}h</div>
                <div className="sub">{pr.totalKwRated}kW rated · {pr.days} days</div></div>
            </div>
          </div>}
          {quality&&!quality.error&&<div className="card" style={{padding:16}}>
            <h3>Data Quality</h3>
            <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
              <div style={{flex:1,minWidth:70}}><div className="label">Uptime</div>
                <div className="value" style={{fontSize:28,color:quality.uptimePct>90?'var(--accent)':quality.uptimePct>70?'var(--warn)':'var(--danger)'}}>{quality.uptimePct}%</div>
                <div className="sub">{quality.rating}</div></div>
              <div style={{flex:1,minWidth:70}}><div className="label">Gen Hours/Day</div><div style={{fontSize:22,fontWeight:700}}>{quality.generatingHoursPerDay}h</div></div>
              <div style={{flex:1,minWidth:70}}><div className="label">Data Coverage</div><div style={{fontSize:22,fontWeight:700}}>{quality.hoursWithData}/{quality.generatingHoursPerDay}<span className="unit">hrs</span></div></div>
            </div>
          </div>}
        </div>

        {/* Degradation */}
        {degData.length>1&&<div className="card" style={{marginBottom:12}}>
          <h3>Degradation Tracking — Monthly Avg Efficiency (%)</h3>
          <div style={{width:'100%',height:260}}><ResponsiveContainer>
            <ComposedChart data={degData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="month" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}} domain={['auto','auto']}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend/>
              <Bar isAnimationActive={false} dataKey="avgEfficiencyPct" fill="#2196F3" name="Avg Eff %" radius={[2,2,0,0]}/>
              <Line isAnimationActive={false} connectNulls={true} type="monotone" dataKey="peakEfficiencyPct" stroke="#4CAF50" name="Peak Eff %" dot={false} strokeWidth={2}/>
            <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </ComposedChart>
          </ResponsiveContainer></div>
        </div>}

        {/* Tabs for charts */}
        <div className="tabs">
          {[{key:'profile',label:'Hourly Profile'},{key:'daily',label:'Daily kWh'}].map(t=>(<button key={t.key} className={`tab ${tab===t.key?'active':''}`}
            onClick={()=>setTab(t.key)} style={{padding:'10px 18px',fontSize:13,background:'none',border:'none',color:tab===t.key?'var(--accent2)':'var(--text-dim)',borderBottom:tab===t.key?'2px solid var(--accent2)':'2px solid transparent',cursor:'pointer',marginBottom:-2}}>{t.label}</button>))}
        </div>

        <div className="card">
          {tab==='profile'&&<div style={{width:'100%',height:300}}><ResponsiveContainer>
            <AreaChart animationDuration={0} data={profileData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Area isAnimationActive={false} connectNulls={true} type="monotone" dataKey="avg" stroke="#2196F3" fill="#2196F3" fillOpacity={0.2} name="Avg Power (W)"/>
            <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </AreaChart></ResponsiveContainer></div>}
          {tab==='daily'&&<div style={{width:'100%',height:300}}><ResponsiveContainer>
            <BarChart animationDuration={0} data={dailyData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-dim)'}}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Bar isAnimationActive={false} dataKey="kwh" fill="#4CAF50" name="kWh" radius={[2,2,0,0]}/>
            <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </BarChart></ResponsiveContainer></div>}
        </div>
      </>}
    </div>
  );
}
