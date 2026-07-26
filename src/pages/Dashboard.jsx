import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useLiveData } from '../App';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart, Line, Legend } from 'recharts';

const DAY = 86400;

export default function Dashboard() {
  const { apiFetch } = useAuth();
  const { liveData, connected } = useLiveData();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [savings, setSavings] = useState(null);
  const [panelConfig, setPanelConfig] = useState({});
  const [weather, setWeather] = useState(null);
  const [monthly, setMonthly] = useState([]);
  const [forecast, setForecast] = useState(null);
  const [todayProfile, setTodayProfile] = useState([]);
  const [tab, setTab] = useState('today');
  const navigate = useNavigate();

  useEffect(() => { apiFetch('/devices').then(setDevices).finally(() => setLoading(false)); }, []);

  useEffect(() => {
    if (devices.length === 0) return;
    const now = Math.floor(Date.now()/1000);
    const todayStart = Math.floor(now/DAY)*DAY;
    Promise.all([
      apiFetch(`/stats/${devices[0].sn}/enhanced?from=${todayStart}&to=${now}`),
      apiFetch(`/savings/calculate/${devices[0].sn}?from=${todayStart}&to=${now}`),
      apiFetch(`/stats/${devices[0].sn}/monthly`),
      apiFetch(`/settings/panels/${devices[0].sn}`),
      apiFetch('/weather'),
      apiFetch(`/forecast/${devices[0].sn}`),
    ]).then(([enhanced, todaySave, monthlyData, panels, weatherData, forecastData]) => {
      setStats(enhanced); setSavings(todaySave); setMonthly(monthlyData||[]);
      setPanelConfig(panels); setWeather(weatherData); setForecast(forecastData);
      if (enhanced.today?.hourlyProfile) {
        setTodayProfile(Array.from({length:24},(_,h)=>({
          hour:`${h}h`, today:enhanced.today.hourlyProfile[h]?.avg||0,
          yesterday:enhanced.yesterday?.hourlyProfile?.[h]?.avg||0,
        })));
      }
    }).catch(()=>{});
  }, [devices]);

  if (loading) return <div className="loading"><div className="spinner"></div></div>;
  if (devices.length === 0) return (
    <div className="card" style={{textAlign:'center',padding:60}}>
      <h2>No Devices</h2><p style={{color:'var(--text-dim)',margin:'12px 0 20px'}}>Add a device in Setup.</p>
      <button className="btn btn-primary" onClick={()=>navigate('/setup')}>Go to Setup</button>
    </div>
  );

  let livePV=0;
  for(const d of devices){const ld=liveData[d.sn]||{};livePV+=(ld[361]||0)+(ld[70]||0);}
  const pv1Rated=parseInt(panelConfig.pv1_rated_watts)||0;
  const pv2Rated=parseInt(panelConfig.pv2_rated_watts)||0;
  const d=liveData[devices[0]?.sn]||{};
  const pv1=d[361]||0,pv1v=d[380],pv1a=d[381];
  const pv2=d[70]||0,pv2v=d[442],pv2a=d[71];
  const grid=d[616]||0,temp=d[371],volt=d[613];
  const pv1Eff=pv1Rated?(pv1/pv1Rated*100):null;
  const pv2Eff=pv2Rated?(pv2/pv2Rated*100):null;
  const todayKwh=stats?.today?.totalKwh||0;
  const vsYesterday=stats?.vsYesterdayPct;
  const co2Today=stats?.co2SavingKgToday||0;
  const bestDay=stats?.bestDayAllTime;
  const streak=stats?.generationStreak||0;
  const rate=savings?.rate||0;
  const totalSaving=savings?.totalSaving||0;
  const avgDaily=stats?.avgDailyKwh||todayKwh;
  const annualKwh=avgDaily*365;

  function fmt(v,d=1){return v!=null&&!isNaN(v)?v.toFixed(d):'--';}
  function date(t){return t?new Date(t*1000).toLocaleDateString():'';}

  return (
    <div>
      {/* ── Hero Banner ── */}
      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
        {[{label:'Live Solar',val:livePV,unit:'W',color:'var(--pv2)'},
          {label:'Today',val:todayKwh,unit:'kWh',fmt:2,sub:vsYesterday!=null?`${vsYesterday>=0?'+':''}${fmt(vsYesterday,0)}% vs yest`:null},
          {label:'Saving',val:totalSaving,unit:'£',color:'var(--accent)',fmt:2,prefix:'£'},
          {label:'CO₂',val:co2Today,unit:'kg',color:'var(--accent)',fmt:3},
          forecast&&{label:'Forecast',val:forecast.predictedTotalKwh,unit:'kWh',color:'var(--accent2)',sub:`${forecast.alreadyProducedKwh}kWh done`},
          {label:'Projected/yr',val:annualKwh,unit:'kWh',sub:`£${fmt(annualKwh*rate,0)}·${fmt(rate,2)}/kWh`},
        ].filter(Boolean).map(s=>(
          <div key={s.label} className="stat-card" style={{flex:'1 1 80px',minWidth:70,textAlign:'center'}}>
            <div className="label">{s.label}</div>
            <div className="value" style={{fontSize:20,color:s.color||'var(--text)'}}>{s.prefix||''}{s.fmt!=null?fmt(s.val,s.fmt):s.val.toFixed(0)}<span style={{fontSize:11,fontWeight:400,color:'var(--text-dim)'}}>{s.unit}</span></div>
            {s.sub&&<div style={{fontSize:10,color:'var(--text-dim)'}}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── PV Performance Cards ── */}
      {(pv1Rated>0||pv2Rated>0) && (
        <div className="grid-2" style={{marginBottom:12}}>
          {pv1Rated>0 && (()=>{const dl=stats?.today?.daylight?.pv1;return(
            <div className="card" style={{padding:16}}>
              <div style={{fontSize:12,fontWeight:600,color:'var(--text-dim)',marginBottom:10,textTransform:'uppercase',letterSpacing:'.5px'}}>☀ PV1 Performance</div>
              <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
                <div style={{flex:1,minWidth:70}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>Live Power</div>
                  <div style={{fontSize:26,fontWeight:700,color:'var(--pv1)',lineHeight:1.1}}>{fmt(pv1,0)}<span style={{fontSize:13,fontWeight:400,color:'var(--text-dim)'}}>W</span></div>
                </div>
                <div style={{flex:1,minWidth:70}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>Live Eff</div>
                  <div style={{fontSize:26,fontWeight:700,color:pv1Eff>70?'var(--accent)':pv1Eff>30?'var(--warn)':'var(--text-dim)',lineHeight:1.1}}>{fmt(pv1Eff,1)}<span style={{fontSize:13,fontWeight:400,color:'var(--text-dim)'}}>%</span></div>
                </div>
                <div style={{flex:1,minWidth:80}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>D.Light Avg Eff</div>
                  <div style={{fontSize:22,fontWeight:600,color:dl?.daylightEff>70?'var(--accent)':dl?.daylightEff>30?'var(--warn)':'var(--text-dim)'}}>{dl?.daylightEff!=null?fmt(dl.daylightEff,1):'--'}<span style={{fontSize:12,fontWeight:400,color:'var(--text-dim)'}}>%</span></div>
                </div>
                <div style={{flex:1,minWidth:90}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>Gen Window</div>
                  <div style={{fontSize:14,fontWeight:600,color:'var(--text)'}}>{dl?.window||'--'}</div>
                  <div style={{fontSize:10,color:'var(--text-dim)'}}>{dl?.genHours||0} daylight hrs · {pv1Rated}W rated · {fmt(pv1v,1)}V · {fmt(pv1a,2)}A</div>
                </div>
              </div>
            </div>
          )})()}
          {pv2Rated>0 && (()=>{const dl=stats?.today?.daylight?.pv2;return(
            <div className="card" style={{padding:16}}>
              <div style={{fontSize:12,fontWeight:600,color:'var(--text-dim)',marginBottom:10,textTransform:'uppercase',letterSpacing:'.5px'}}>☀ PV2 Performance</div>
              <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
                <div style={{flex:1,minWidth:70}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>Live Power</div>
                  <div style={{fontSize:26,fontWeight:700,color:'var(--pv2)',lineHeight:1.1}}>{fmt(pv2,0)}<span style={{fontSize:13,fontWeight:400,color:'var(--text-dim)'}}>W</span></div>
                </div>
                <div style={{flex:1,minWidth:70}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>Live Eff</div>
                  <div style={{fontSize:26,fontWeight:700,color:pv2Eff>70?'var(--accent)':pv2Eff>30?'var(--warn)':'var(--text-dim)',lineHeight:1.1}}>{fmt(pv2Eff,1)}<span style={{fontSize:13,fontWeight:400,color:'var(--text-dim)'}}>%</span></div>
                </div>
                <div style={{flex:1,minWidth:80}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>D.Light Avg Eff</div>
                  <div style={{fontSize:22,fontWeight:600,color:dl?.daylightEff>70?'var(--accent)':dl?.daylightEff>30?'var(--warn)':'var(--text-dim)'}}>{dl?.daylightEff!=null?fmt(dl.daylightEff,1):'--'}<span style={{fontSize:12,fontWeight:400,color:'var(--text-dim)'}}>%</span></div>
                </div>
                <div style={{flex:1,minWidth:90}}>
                  <div style={{fontSize:10,color:'var(--text-dim)',textTransform:'uppercase'}}>Gen Window</div>
                  <div style={{fontSize:14,fontWeight:600,color:'var(--text)'}}>{dl?.window||'--'}</div>
                  <div style={{fontSize:10,color:'var(--text-dim)'}}>{dl?.genHours||0} daylight hrs · {pv2Rated}W rated · {fmt(pv2v,1)}V · {fmt(pv2a,2)}A</div>
                </div>
              </div>
            </div>
          )})()}
        </div>
      )}

      {/* ── Secondary Row ── */}
      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
        {bestDay&&<div className="stat-card" style={{flex:'1',minWidth:70,textAlign:'center'}}>
          <div className="label">🏆 Best Day</div><div style={{fontSize:16,fontWeight:700,color:'var(--accent2)'}}>{bestDay.kwh}kWh</div>
          <div style={{fontSize:10,color:'var(--text-dim)'}}>{date(bestDay.date)}</div>
        </div>}
        {streak>0&&<div className="stat-card" style={{flex:'1',minWidth:70,textAlign:'center'}}>
          <div className="label">Generation Streak</div><div style={{fontSize:16,fontWeight:700,color:'var(--warn)'}}>{streak} days</div>
        </div>}
        <div className="stat-card" style={{flex:'1',minWidth:70,textAlign:'center'}}>
          <div className="label">🌳 CO₂ Equivalent</div><div style={{fontSize:16,fontWeight:600,color:'var(--accent)'}}>≈{fmt(co2Today*1000/7.5,0)} trees today</div>
        </div>
      </div>

      {/* ── Tabbed Charts ── */}
      <div className="tabs" style={{borderBottom:'2px solid var(--border)'}}>
        {[{key:'today',label:'Today vs Yesterday'},{key:'weather',label:'Cloud Cover'},{key:'compare',label:'PV1 vs PV2'},{key:'monthly',label:'Monthly'}].map(t=>(
          <button key={t.key} className={`tab ${tab===t.key?'active':''}`}
            onClick={()=>setTab(t.key)}
            style={{padding:'10px 18px',fontSize:13,background:'none',border:'none',color:tab===t.key?'var(--accent2)':'var(--text-dim)',borderBottom:tab===t.key?'2px solid var(--accent2)':'2px solid transparent',cursor:'pointer',transition:'all .15s',marginBottom:-2}}>{t.label}</button>
        ))}
      </div>

      <div className="card" style={{marginBottom:16,padding:'14px 14px 8px'}}>
        <div className="chart-container" style={{height:280}}>
          {tab==='today'&&todayProfile.length>0&&<ResponsiveContainer><ComposedChart animationDuration={0} data={todayProfile}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
            <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
            <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend wrapperStyle={{fontSize:11}}/>
            <Area type="monotone" dataKey="today" stroke="#4CAF50" fill="#4CAF50" fillOpacity={0.2} name="Today"/>
            <Line type="monotone" dataKey="yesterday" stroke="#8890a5" strokeDasharray="6 3" name="Yesterday" dot={false}/>
          </ComposedChart></ResponsiveContainer>}
          {tab==='weather'&&(weather?<ResponsiveContainer><AreaChart animationDuration={0} data={weather.map(w=>({hour:`${w.hour}h`,cloud:w.cloudCover}))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
            <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}} domain={[0,100]}/>
            <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
            <Area type="monotone" dataKey="cloud" stroke="#607D8B" fill="#607D8B" fillOpacity={0.25} name="Cloud %"/>
          </AreaChart></ResponsiveContainer>:<p style={{color:'var(--text-dim)',textAlign:'center',paddingTop:100}}>Set lat/lon in Setup ☀ Weather for cloud data</p>)}
          {tab==='compare'&&todayProfile.length>0&&<ResponsiveContainer><AreaChart animationDuration={0} data={todayProfile}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
            <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
            <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend wrapperStyle={{fontSize:11}}/>
            <Area type="monotone" dataKey="today" stroke="#2196F3" fill="#2196F3" fillOpacity={0.15} name="PV1"/>
            <Area type="baseline" dataKey="today" stroke="#4CAF50" fill="#4CAF50" fillOpacity={0.15} name="PV2"/>
          </AreaChart></ResponsiveContainer>}
          {tab==='monthly'&&(monthly.length>0?<ResponsiveContainer><BarChart animationDuration={0} data={monthly.slice().reverse()}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
            <XAxis dataKey="month" tick={{fontSize:10,fill:'var(--text-dim)'}}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
            <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} formatter={v=>[`${v}kWh`]}/>
            <Bar dataKey="kwh" fill="#2196F3" radius={[3,3,0,0]}/>
          </BarChart></ResponsiveContainer>:<p style={{color:'var(--text-dim)',textAlign:'center',paddingTop:100}}>Need more data for monthly totals.</p>)}
        </div>
      </div>

      {/* ── Devices ── */}
      <div className="device-list" style={{marginBottom:12}}>
        {devices.map(d=>{
          const ld=liveData[d.sn]||{};
          const pv1=ld[361]||0,pv2=ld[70]||0,grid=ld[616]||0,temp=ld[371],volt=ld[613];
          return (
            <div key={d.sn} className="device-card" onClick={()=>navigate(`/device/${d.sn}`)}>
              <div className="sn">{d.sn}</div><div className="name">{d.name||d.sn}</div>
              <div className="power" style={{color:'var(--pv2)'}}>{(pv1+pv2).toFixed(0)}<span style={{fontSize:14,fontWeight:400,color:'var(--text-dim)'}}>W</span></div>
              <div className="meta">{pv1>0&&<span style={{color:'var(--pv1)'}}>☀ PV1 {fmt(pv1,0)}W</span>}{pv2>0&&<span style={{color:'var(--pv2)'}}>☀ PV2 {fmt(pv2,0)}W</span>}</div>
              <div className="meta" style={{marginTop:4}}>{grid!==0&&<span>⚡ {fmt(grid,0)}W</span>}{temp>0&&<span>🌡 {fmt(temp,1)}°C</span>}{volt>0&&<span>🔌 {fmt(volt,0)}V</span>}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
