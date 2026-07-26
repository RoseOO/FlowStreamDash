import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useLiveData } from '../App';
import { getFieldLabel } from '../../server/fields';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, LineChart, Line } from 'recharts';

const DAY = 86400;

export default function Dashboard() {
  const { apiFetch } = useAuth();
  const { liveData, connected } = useLiveData();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [todayProfile, setTodayProfile] = useState([]);
  const [weekProfile, setWeekProfile] = useState([]);
  const [stats, setStats] = useState(null);
  const [savings, setSavings] = useState(null);
  const [panelConfig, setPanelConfig] = useState({});
  const navigate = useNavigate();

  useEffect(() => { apiFetch('/devices').then(setDevices).finally(() => setLoading(false)); }, []);

  useEffect(() => {
    if (devices.length === 0) return;
    const now = Math.floor(Date.now()/1000);
    const todayStart = Math.floor(now / DAY) * DAY;
    const weekStart = todayStart - 6 * DAY;

    // Fetch stats + savings + panel config for first device
    Promise.all([
      apiFetch(`/stats/${devices[0].sn}?from=${todayStart}&to=${now}`),
      apiFetch(`/savings/calculate/${devices[0].sn}?from=${todayStart}&to=${now}`),
      apiFetch(`/stats/${devices[0].sn}?from=${weekStart}&to=${now}`),
      apiFetch(`/settings/panels/${devices[0].sn}`),
    ]).then(([todayStats, todaySave, weekStats, panels]) => {
      setStats({ today: todayStats, week: weekStats });
      setSavings(todaySave);
      setPanelConfig(panels);

      // Today's hourly profile
      if (todayStats.hourlyProfile) {
        setTodayProfile(Array.from({length:24},(_,h)=>({
          hour:`${h}h`, avg:todayStats.hourlyProfile[h]?.avg||0,
        })));
      }
      // Weekly daily totals
      if (weekStats.daily) {
        setWeekProfile(weekStats.daily.map(d => ({
          date: new Date(d.ts*1000).toLocaleDateString().slice(0,5),
          kwh: d.totalKwh, peak: d.peakW,
        })));
      }
    });
  }, [devices]);

  if (loading) return <div className="loading"><div className="spinner"></div></div>;
  if (devices.length === 0) return (
    <div className="card" style={{textAlign:'center',padding:60}}>
      <h2>No Devices</h2><p style={{color:'var(--text-dim)',margin:'12px 0 20px'}}>Add a device in Setup to start monitoring.</p>
      <button className="btn btn-primary" onClick={()=>navigate('/setup')}>Go to Setup</button>
    </div>
  );

  // Live totals
  let livePV=0, liveGrid=0;
  for(const d of devices){const ld=liveData[d.sn];if(ld){livePV+=(ld[361]||0)+(ld[70]||0);liveGrid+=(ld[616]||0);}}

  const pv1Rated = parseInt(panelConfig.pv1_rated_watts) || 0;
  const pv2Rated = parseInt(panelConfig.pv2_rated_watts) || 0;
  const d = liveData[devices[0]?.sn] || {};
  const pv1 = d[361]||0, pv2 = d[70]||0;
  const pv1Eff = pv1Rated ? (pv1/pv1Rated*100) : null;
  const pv2Eff = pv2Rated ? (pv2/pv2Rated*100) : null;
  const todayPeak = stats?.today?.bestDay?.peakW || stats?.week?.daily?.slice(-1)[0]?.peakW || 0;
  const daylight1 = stats?.today?.daylight?.pv1;
  const daylight2 = stats?.today?.daylight?.pv2;

  function fmt(v,d=1){return v!=null&&!isNaN(v)?v.toFixed(d):'--';}

  return (
    <div>
      {/* ── Top Stats Banner ── */}
      <div className="grid-4" style={{marginBottom:12}}>
        <div className="stat-card">
          <div className="label">Live Solar Power</div>
          <div className="value" style={{color:'var(--pv2)'}}>{livePV.toFixed(0)}<span className="unit">W</span></div>
        </div>
        <div className="stat-card">
          <div className="label">Live Grid Power</div>
          <div className="value" style={{color:liveGrid<0?'var(--accent)':'var(--warn)'}}>{liveGrid>0?'+':''}{liveGrid.toFixed(0)}<span className="unit">W</span></div>
        </div>
        <div className="stat-card">
          <div className="label">Today Peak</div>
          <div className="value" style={{color:'var(--accent2)'}}>{fmt(todayPeak,0)}<span className="unit">W</span></div>
        </div>
        <div className="stat-card">
          <div className="label">Today Production</div>
          <div className="value">{fmt(stats?.today?.totalKwh,2)}<span className="unit">kWh</span></div>
        </div>
      </div>

      {/* ── Second row ── */}
      <div className="grid-4" style={{marginBottom:16}}>
        <div className="stat-card">
          <div className="label">Today Saved</div>
          <div className="value" style={{color:'var(--accent)'}}>£{fmt(savings?.totalSaving,2)}</div>
        </div>
        <div className="stat-card">
          <div className="label">7-Day Total</div>
          <div className="value">{fmt(stats?.week?.totalKwh,2)}<span className="unit">kWh</span></div>
        </div>
        <div className="stat-card">
          <div className="label">Avg Daily</div>
          <div className="value">{fmt(stats?.week?.avgDailyKwh,2)}<span className="unit">kWh</span></div>
        </div>
        <div className="stat-card">
          <div className="label">MQTT Status</div>
          <div className="value" style={{fontSize:22,color:connected?'var(--accent)':'var(--danger)'}}>{connected?'🟢 Live':'🔴 Off'}</div>
        </div>
      </div>

      {/* ── Charts Row ── */}
      <div className="grid-2" style={{marginBottom:16}}>
        {/* Today's generation profile */}
        <div className="card">
          <h3>Today's Generation Profile</h3>
          {todayProfile.some(p=>p.avg>0) ? (
            <div style={{width:'100%',height:220}}><ResponsiveContainer>
              <AreaChart data={todayProfile}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/>
                <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} formatter={v=>[`${v}W`]}/>
                <Area type="monotone" dataKey="avg" stroke="#4CAF50" fill="#4CAF50" fillOpacity={0.2} name="Avg W"/>
              </AreaChart>
            </ResponsiveContainer></div>
          ) : <p style={{color:'var(--text-dim)',textAlign:'center',padding:40,fontSize:13}}>Waiting for daylight data...</p>}
        </div>

        {/* Weekly daily kWh */}
        <div className="card">
          <h3>This Week (kWh per day)</h3>
          {weekProfile.length>0 ? (
            <div style={{width:'100%',height:220}}><ResponsiveContainer>
              <BarChart data={weekProfile}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} formatter={v=>[`${v}kWh`]}/>
                <Bar dataKey="kwh" fill="#2196F3" radius={[3,3,0,0]} name="kWh"/>
              </BarChart>
            </ResponsiveContainer></div>
          ) : <p style={{color:'var(--text-dim)',textAlign:'center',padding:40,fontSize:13}}>Collecting data...</p>}
        </div>
      </div>

      {/* ── Panel Efficiency Cards ── */}
      {(pv1Rated>0||pv2Rated>0) && (
        <div className="grid-2" style={{marginBottom:16}}>
          {pv1Rated>0 && (
            <div className="card">
              <h3>☀ PV1 Performance</h3>
              <div style={{display:'flex',gap:16,alignItems:'center',flexWrap:'wrap'}}>
                <div style={{flex:1,minWidth:80}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>Live Power</div>
                  <div style={{fontSize:28,fontWeight:700,color:'var(--pv1)'}}>{fmt(pv1,0)}<span style={{fontSize:14,fontWeight:400}}>W</span></div>
                </div>
                <div style={{flex:1,minWidth:80}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>Live Eff</div>
                  <div style={{fontSize:28,fontWeight:700,color:pv1Eff>70?'var(--accent)':pv1Eff>30?'var(--warn)':'var(--text-dim)'}}>
                    {pv1Eff!=null?fmt(pv1Eff,1):'--'}<span style={{fontSize:14,fontWeight:400}}>%</span>
                  </div>
                </div>
                <div style={{flex:1,minWidth:80}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>D.Light Avg Eff</div>
                  <div style={{fontSize:22,fontWeight:600,color:'var(--accent2)'}}>
                    {daylight1?.daylightEff!=null?fmt(daylight1.daylightEff,1):'--'}<span style={{fontSize:13,fontWeight:400}}>%</span>
                  </div>
                </div>
                <div style={{flex:1,minWidth:110}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>Gen Window</div>
                  <div style={{fontSize:15,fontWeight:600,color:'var(--text)'}}>{daylight1?.window||'--'}</div>
                  <div className="label" style={{fontSize:10,color:'var(--text-dim)'}}>{pv1Rated}W · {fmt(d[380],1)}V · {fmt(d[381],2)}A</div>
                </div>
              </div>
            </div>
          )}
          {pv2Rated>0 && (
            <div className="card">
              <h3>☀ PV2 Performance</h3>
              <div style={{display:'flex',gap:16,alignItems:'center',flexWrap:'wrap'}}>
                <div style={{flex:1,minWidth:80}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>Live Power</div>
                  <div style={{fontSize:28,fontWeight:700,color:'var(--pv2)'}}>{fmt(pv2,0)}<span style={{fontSize:14,fontWeight:400}}>W</span></div>
                </div>
                <div style={{flex:1,minWidth:80}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>Live Eff</div>
                  <div style={{fontSize:28,fontWeight:700,color:pv2Eff>70?'var(--accent)':pv2Eff>30?'var(--warn)':'var(--text-dim)'}}>
                    {pv2Eff!=null?fmt(pv2Eff,1):'--'}<span style={{fontSize:14,fontWeight:400}}>%</span>
                  </div>
                </div>
                <div style={{flex:1,minWidth:80}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>D.Light Avg Eff</div>
                  <div style={{fontSize:22,fontWeight:600,color:'var(--accent2)'}}>
                    {daylight2?.daylightEff!=null?fmt(daylight2.daylightEff,1):'--'}<span style={{fontSize:13,fontWeight:400}}>%</span>
                  </div>
                </div>
                <div style={{flex:1,minWidth:110}}>
                  <div className="label" style={{fontSize:11,color:'var(--text-dim)'}}>Gen Window</div>
                  <div style={{fontSize:15,fontWeight:600,color:'var(--text)'}}>{daylight2?.window||'--'}</div>
                  <div className="label" style={{fontSize:10,color:'var(--text-dim)'}}>{pv2Rated}W · {fmt(d[442],1)}V · {fmt(d[71],2)}A</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Device Cards ── */}
      <div className="card" style={{marginBottom:16}}>
        <h2>Devices ({devices.length})</h2>
        <div className="device-list" style={{marginTop:8}}>
          {devices.map(d=>{
            const ld=liveData[d.sn]||{};
            const pv1=ld[361]||0,pv1v=ld[380],pv1a=ld[381];
            const pv2=ld[70]||0,pv2v=ld[442],pv2a=ld[71];
            const grid=ld[616]||0,temp=ld[371],volt=ld[613];
            return (
              <div key={d.sn} className="device-card" onClick={()=>navigate(`/device/${d.sn}`)}>
                <div className="sn">{d.sn}</div>
                <div className="name">{d.name||d.sn}</div>
                <div className="power" style={{color:grid<0?'var(--accent)':'var(--warn)'}}>{(pv1+pv2).toFixed(0)}<span style={{fontSize:14,fontWeight:400}}>W</span></div>
                <div className="meta">{pv1>0&&<span style={{color:'var(--pv1)'}}>☀ PV1 {fmt(pv1,0)}W {fmt(pv1v,1)}V {fmt(pv1a,2)}A</span>}</div>
                <div className="meta">{pv2>0&&<span style={{color:'var(--pv2)'}}>☀ PV2 {fmt(pv2,0)}W {fmt(pv2v,1)}V {fmt(pv2a,2)}A</span>}</div>
                <div className="meta" style={{marginTop:4}}>{grid!==0&&<span style={{color:grid<0?'var(--accent)':'var(--warn)'}}>⚡ {fmt(grid,0)}W</span>}{temp>0&&<span>🌡 {fmt(temp,1)}°C</span>}{volt>0&&<span>🔌 {fmt(volt,0)}V</span>}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
