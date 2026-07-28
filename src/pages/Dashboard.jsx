import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useLiveData } from '../App';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart, Line, Legend, Brush } from 'recharts';
import { DAY } from '../utils/constants';
import { fmt, tsToDate, minuteToStr } from '../utils/format';
import StatCard from '../components/StatCard';

export default function Dashboard() {
  const { apiFetch } = useAuth();
  const { liveData, connected, gridPower } = useLiveData();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [savings, setSavings] = useState(null);
  const [panelConfig, setPanelConfig] = useState({});
  const [weather, setWeather] = useState(null);
  const [monthly, setMonthly] = useState([]);
  const [forecast, setForecast] = useState(null);
  const [health, setHealth] = useState(null);
  const [overlay, setOverlay] = useState(null);
  const [gridStats, setGridStats] = useState(null);
  const [todayProfile, setTodayProfile] = useState([]);
  const [tab, setTab] = useState('today');
  const [snapshots, setSnapshots] = useState({});
  const navigate = useNavigate();

  useEffect(() => { apiFetch('/devices').then(setDevices).finally(() => setLoading(false)); }, [apiFetch]);

  // Fetch latest snapshot for all devices (cold-start data)
  useEffect(() => {
    if (devices.length === 0) return;
    Promise.all(devices.map(d => apiFetch(`/data/${d.sn}/latest`).catch(()=>{}))).then(results => {
      const map = {};
      devices.forEach((d, i) => { map[d.sn] = { ...(results[i]?.latest || {}), _idle: results[i]?.idle || false }; });
      setSnapshots(map);
    });
  }, [devices.length, apiFetch]);

  function getDeviceData(sn) {
    return { ...(snapshots[sn] || {}), ...(liveData[sn] || {}) };
  }

  useEffect(() => {
    if (devices.length === 0) return;
    const now = Math.floor(Date.now()/1000);
    const todayStart = Math.floor(now/DAY)*DAY;
    Promise.all([
      apiFetch(`/stats/${devices[0].sn}/enhanced?from=${todayStart}&to=${now}`).catch(() => null),
      apiFetch(`/savings/calculate/${devices[0].sn}?from=${todayStart}&to=${now}`).catch(() => null),
      apiFetch(`/stats/${devices[0].sn}/monthly`).catch(() => null),
      apiFetch(`/settings/panels/${devices[0].sn}`).catch(() => null),
      apiFetch('/weather').catch(() => null),
      apiFetch(`/forecast/${devices[0].sn}`).catch(() => null),
    ]).then(([enhanced, todaySave, monthlyData, panels, weatherData, forecastData]) => {
      setStats(enhanced); setSavings(todaySave); setMonthly(monthlyData||[]);
      setPanelConfig(panels); setWeather(weatherData); setForecast(forecastData);
      // Also fetch system health
      apiFetch('/system/health').then(setHealth).catch(()=>{});
        // Fetch grid meter stats + merge hourly into today profile
      apiFetch(`/grid-meter/stats?from=${todayStart}&to=${now}`).then(gs => {
        setGridStats(gs);
        if (gs?.hourly) {
          setTodayProfile(prev => prev.map((p,i) => ({...p, gridImport: gs.hourly[i]?.avgW||0})));
        }
      }).catch(()=>{});
      // Fetch 7-day hourly overlay
      apiFetch(`/stats/${devices[0].sn}/hourly-overlay?days=7`).then(setOverlay).catch(()=>{});
      if (enhanced.today?.hourlyProfile) {
        setTodayProfile(Array.from({length:24},(_,h)=>({
          hour:`${h}h`,
          today:enhanced.today.hourlyProfile[h]?.avg||0,
          yesterday:enhanced.yesterday?.hourlyProfile?.[h]?.avg||0,
          pv1:enhanced.today.pv1HourlyProfile?.[h]?.avg||0,
          pv2:enhanced.today.pv2HourlyProfile?.[h]?.avg||0,
        })));
      }
    }).catch(()=>{});
  }, [devices, apiFetch]);

  if (loading) return <div className="loading"><div className="spinner"></div></div>;
  if (devices.length === 0) return (
    <div className="card" style={{textAlign:'center',padding:60}}>
      <h2>No Devices</h2><p style={{color:'var(--text-dim)',margin:'12px 0 20px'}}>Add a device in Setup.</p>
      <button className="btn btn-primary" onClick={()=>navigate('/setup')}>Go to Setup</button>
    </div>
  );

  let livePV=0;
  for(const d of devices){const ld=getDeviceData(d.sn);livePV+=(ld[361]||0)+(ld[70]||0);}
  const pv1Rated=parseInt(panelConfig.pv1_rated_watts)||0;
  const pv2Rated=parseInt(panelConfig.pv2_rated_watts)||0;
  const d=getDeviceData(devices[0]?.sn);
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
  const gridImport = gridPower?.w || 0;
  const totalPv = livePV;
  const totalDemand = totalPv + (gridImport > 0 ? gridImport : 0);
  const pvPct = totalDemand > 0 ? Math.round(totalPv / Math.max(1, totalDemand) * 100) : 0;
  const gridPct = totalDemand > 0 ? Math.round(gridImport / Math.max(1, totalDemand) * 100) : 0;
  const isExporting = gridPower?.w != null && gridImport <= 5;

  return (
    <div>
      {/* ── Live Power Flow Diagram ── */}
      <div className="card" style={{marginBottom:12,padding:'14px 16px',background:'linear-gradient(135deg, var(--bg-card) 0%, var(--bg-card2) 100%)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:0,flexWrap:'wrap',minHeight:80}}>
          {/* Solar source */}
          <div style={{textAlign:'center',minWidth:110,flexShrink:0}}>
            <div style={{fontSize:28}}>☀</div>
            <div style={{fontSize:20,fontWeight:700,color:'var(--pv2)'}}>{totalPv.toFixed(0)}<span style={{fontSize:12,fontWeight:400,color:'var(--text-dim)'}}>W</span></div>
            <div style={{fontSize:10,color:'var(--text-dim)'}}>
              {totalPv > 5 ? <>Solar · {fmt((d[380]||0)+(d[442]||0),0)}V · {fmt((d[381]||0)+(d[71]||0),1)}A</> : 'Idle'}
            </div>
          </div>

          {/* Flow bar: Solar → Home */}
          <div style={{flex:'1 1 100px',minWidth:60,height:24,margin:'0 8px',position:'relative'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,bottom:0,borderRadius:12,background:'var(--bg-card2)',overflow:'hidden',border:'1px solid var(--border)'}}>
              <div className="flow-bar" style={{width:`${Math.max(5,pvPct)}%`,height:'100%',background:'linear-gradient(90deg, var(--pv2), #66BB6A)',borderRadius:12,transition:'width .5s',position:'relative'}}>
                <div className="flow-dot" style={{position:'absolute',right:2,top:'50%',transform:'translateY(-50%)',width:8,height:8,borderRadius:'50%',background:'#fff',boxShadow:'0 0 8px #4CAF50'}}></div>
              </div>
            </div>
          </div>

          {/* Center: Home/Load */}
          <div style={{textAlign:'center',minWidth:100,flexShrink:0,background:totalDemand>0?'rgba(33,150,243,.1)':'transparent',borderRadius:12,padding:'6px 12px',border:'1px solid var(--border)'}}>
            <div style={{fontSize:24}}>🏠</div>
            <div style={{fontSize:22,fontWeight:700}}>{totalDemand>0?totalDemand.toFixed(0):'--'}<span style={{fontSize:13,fontWeight:400,color:'var(--text-dim)'}}>W</span></div>
            <div style={{fontSize:10,color:'var(--text-dim)'}}>
              {gridPower?.w!=null?<>{pvPct}% solar {isExporting?'· exporting':'· '+gridPct+'% grid'}</>:'Load'}
            </div>
          </div>

          {/* Flow bar: Grid → Home or Home → Grid */}
          <div style={{flex:'1 1 100px',minWidth:60,height:24,margin:'0 8px',position:'relative'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,bottom:0,borderRadius:12,background:'var(--bg-card2)',overflow:'hidden',border:'1px solid var(--border)'}}>
              {gridImport > 5 ? (
                <div className="flow-bar" style={{width:'100%',height:'100%',background:'linear-gradient(90deg, var(--warn), #FFA726)',borderRadius:12,transition:'width .5s'}}>
                  <div className="flow-dot" style={{position:'absolute',animation:'flowRight .8s linear infinite',width:8,height:8,borderRadius:'50%',background:'#FF9800',boxShadow:'0 0 8px #FF9800'}}></div>
                </div>
              ) : isExporting ? (
                <div className="flow-bar" style={{width:`${Math.max(5,100-pvPct)}%`,height:'100%',background:'linear-gradient(90deg, var(--accent), #66BB6A)',borderRadius:12,transition:'width .5s'}}>
                  <div className="flow-dot" style={{position:'absolute',animation:'flowLeft .8s linear infinite',width:8,height:8,borderRadius:'50%',background:'#4CAF50',boxShadow:'0 0 8px #4CAF50'}}></div>
                </div>
              ) : (
                <div style={{width:'0%',height:'100%',borderRadius:12}}></div>
              )}
            </div>
          </div>

          {/* Grid endpoint */}
          <div style={{textAlign:'center',minWidth:110,flexShrink:0}}>
            <div style={{fontSize:28}}>⚡</div>
            <div style={{fontSize:20,fontWeight:700,color:gridImport>5?'var(--warn)':'var(--accent)'}}>
              {gridImport>5?gridImport.toFixed(0):gridPower?.w!=null?'0':'--'}<span style={{fontSize:12,fontWeight:400,color:'var(--text-dim)'}}>W</span>
            </div>
            <div style={{fontSize:10,color:'var(--text-dim)'}}>{gridImport>5?'Importing':gridPower?.w!=null?(isExporting?'Exporting':'Idle'):'Grid'}
              {gridPower?.v!=null && <span> · {gridPower.v.toFixed(0)}V</span>}
              {gridPower?.a!=null && <span> · {gridPower.a.toFixed(1)}A</span>}
            </div>
          </div>
        </div>
      </div>
      {/* ── Hero Banner ── */}
      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
        <StatCard label="Live Solar" value={livePV.toFixed(0)} unit="W" color="var(--pv2)" className="flex-stat" />
        <StatCard label="Today" value={todayKwh.toFixed(2)} unit="kWh" fontSize={20} sub={vsYesterday!=null?`${vsYesterday>=0?'+':''}${fmt(vsYesterday,0)}% vs yest`:null} className="flex-stat" />
        <StatCard label="Saving" value={`£${fmt(totalSaving,2)}`} color="var(--accent)" fontSize={20} sub={`${Math.round(totalSaving*100)}p · ${fmt(todayKwh,2)}kWh`} className="flex-stat" />
        {gridPower?.w!=null && <StatCard label="Grid Meter" value={`${gridPower.w>0?'Import ':'Export '}${Math.abs(gridPower.w).toFixed(0)}`} unit="W" color={gridPower.w>0?'var(--warn)':'var(--accent)'} fontSize={20} sub={`${gridPower.w>0?'Importing':'Exporting'} from grid`} className="flex-stat" />}
        {gridStats?.importCost!=null && <StatCard label="Import Cost Today" value={`£${fmt(gridStats.importCost,2)}`} color="var(--warn)" fontSize={20} className="flex-stat" />}
        <StatCard label="CO₂" value={fmt(co2Today,3)} unit="kg" color="var(--accent)" fontSize={20} className="flex-stat" />
        {forecast && <StatCard label={forecast.usingLearnedModel?'☀ AI Forecast':'Forecast'} value={`${forecast.predictedTotalKwh.toFixed(0)}`} unit="kWh" color="var(--accent2)" fontSize={20} sub={forecast.usingLearnedModel?`×${forecast.modelFactor} · ${forecast.modelSamples} samples`:`${forecast.alreadyProducedKwh}kWh done`} className="flex-stat" />}
        <StatCard label="Projected/yr" value={annualKwh.toFixed(0)} unit="kWh" fontSize={20} sub={`£${fmt(annualKwh*rate,0)}·${fmt(rate,2)}/kWh`} className="flex-stat" />
      </div>

      {/* ── PV Performance Cards ── */}
      {(pv1Rated>0||pv2Rated>0) && (() => {
        function genInfo(dl, ydl) {
          let genText = dl?.window || '--';
          let genLabel = 'Gen Window';
          const hasStarted = dl?.firstMinute != null;
          const hasStopped = dl?.lastMinute != null;
          if (hasStarted && !hasStopped && ydl?.lastMinute) {
            genText = `${minuteToStr(dl.firstMinute)}~${minuteToStr(ydl.lastMinute)}`;
            genLabel = 'Gen Window (est)';
          } else if (!hasStarted && ydl?.window) {
            genText = `Yesterday: ${ydl.window}`;
            genLabel = 'Gen Window (yest)';
          }
          return { genText, genLabel };
        }
        const pv1dl = stats?.today?.daylight?.pv1;
        const pv2dl = stats?.today?.daylight?.pv2;
        const pv1ydl = stats?.yesterday?.daylight?.pv1;
        const pv2ydl = stats?.yesterday?.daylight?.pv2;
        const g1 = genInfo(pv1dl, pv1ydl);
        const g2 = genInfo(pv2dl, pv2ydl);
        return (<div className="grid-2" style={{marginBottom:12}}>
          {pv1Rated>0 && <div className="card" style={{padding:16}}>
            <div style={{fontSize:12,fontWeight:600,color:'var(--text-dim)',marginBottom:10,textTransform:'uppercase',letterSpacing:'.5px'}}>☀ PV1 Performance</div>
            <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
              <StatCard label="Live Power" value={fmt(pv1,0)} unit="W" color="var(--pv1)" fontSize={26} />
              <StatCard label="Live Eff" value={fmt(pv1Eff,1)} unit="%" color={pv1Eff>70?'var(--accent)':pv1Eff>30?'var(--warn)':'var(--text-dim)'} fontSize={26} />
              <StatCard label="D.Light Avg Eff" value={pv1dl?.daylightEff!=null?fmt(pv1dl.daylightEff,1):'--'} unit="%" color={pv1dl?.daylightEff>70?'var(--accent)':pv1dl?.daylightEff>30?'var(--warn)':'var(--text-dim)'} fontSize={22} />
              <StatCard label={g1.genLabel} value={g1.genText} fontSize={14} sub={`${pv1dl?.genHours||0} daylight hrs · ${pv1Rated}W rated · ${fmt(pv1v,1)}V · ${fmt(pv1a,2)}A`} className="flex-stat" />
            </div>
          </div>}
          {pv2Rated>0 && <div className="card" style={{padding:16}}>
            <div style={{fontSize:12,fontWeight:600,color:'var(--text-dim)',marginBottom:10,textTransform:'uppercase',letterSpacing:'.5px'}}>☀ PV2 Performance</div>
            <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
              <StatCard label="Live Power" value={fmt(pv2,0)} unit="W" color="var(--pv2)" fontSize={26} />
              <StatCard label="Live Eff" value={fmt(pv2Eff,1)} unit="%" color={pv2Eff>70?'var(--accent)':pv2Eff>30?'var(--warn)':'var(--text-dim)'} fontSize={26} />
              <StatCard label="D.Light Avg Eff" value={pv2dl?.daylightEff!=null?fmt(pv2dl.daylightEff,1):'--'} unit="%" color={pv2dl?.daylightEff>70?'var(--accent)':pv2dl?.daylightEff>30?'var(--warn)':'var(--text-dim)'} fontSize={22} />
              <StatCard label={g2.genLabel} value={g2.genText} fontSize={14} sub={`${pv2dl?.genHours||0} daylight hrs · ${pv2Rated}W rated · ${fmt(pv2v,1)}V · ${fmt(pv2a,2)}A`} className="flex-stat" />
            </div>
          </div>}
        </div>);
      })()}

      {/* ── Secondary Row ── */}
      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
        {bestDay&&<StatCard label="🏆 Best Day" value={`${bestDay.kwh}kWh`} color="var(--accent2)" fontSize={16} sub={tsToDate(bestDay.date)} className="flex-stat" />}
        {streak>0&&<StatCard label="Generation Streak" value={`${streak} days`} color="var(--warn)" fontSize={16} className="flex-stat" />}
      </div>

      {/* ── Tabbed Charts ── */}
      <div className="tabs" style={{borderBottom:'2px solid var(--border)'}}>
        {[{key:'today',label:'Today vs Yesterday'},{key:'overlay',label:'Last 7 Days'},{key:'weather',label:'Cloud Cover'},{key:'compare',label:'PV1 vs PV2'},{key:'monthly',label:'Monthly'}].map(t=>(
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
            <Area isAnimationActive={false} connectNulls={true} type="monotone" dataKey="today" stroke="#4CAF50" fill="#4CAF50" fillOpacity={0.2} name="Today"/>
            <Line isAnimationActive={false} connectNulls={true} type="monotone" dataKey="yesterday" stroke="#8890a5" strokeDasharray="6 3" name="Yesterday" dot={false}/>
            <Line isAnimationActive={false} connectNulls={true} type="monotone" dataKey="gridImport" stroke="#FF9800" name="Grid Import" dot={false} strokeWidth={1.5}/>
          <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </ComposedChart></ResponsiveContainer>}
          {tab==='overlay'&&(()=>{
            if (!overlay || overlay.length < 2) return <p style={{color:'var(--text-dim)',textAlign:'center',paddingTop:100}}>Need more days of data for overlay.</p>;
            const DAY_COLORS = ['#4CAF50','#2196F3','#FF9800','#9C27B0','#E91E63','#00BCD4','#FFC107'];
            const chartData = Array.from({length:24},(_,h)=>{
              const pt = { hour: `${h}h` };
              for (let d = 0; d < overlay.length; d++) {
                pt[`d${d}`] = overlay[d].hourly?.[h]?.avg || 0;
              }
              return pt;
            });
            const lineProps = overlay.filter(p=>p.hourly&&Object.keys(p.hourly).length>0).map((p,i)=>{
              const color = p.isToday ? '#4CAF50' : DAY_COLORS[(i+1)%DAY_COLORS.length];
              const opacity = p.isToday ? 1 : 0.4;
              return { dataKey:`d${i}`, name: p.label, stroke: color, opacity, dot:false, connectNulls:true,
                strokeWidth: p.isToday ? 3 : 1.5, type: 'monotone' };
            });
            return <ResponsiveContainer><ComposedChart animationDuration={0} data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Legend wrapperStyle={{fontSize:10}}/>
              {lineProps.map(lp => {
                const isToday = overlay.find((p,i) => `d${i}`===lp.dataKey)?.isToday;
                return isToday
                  ? <Area isAnimationActive={false} key={lp.dataKey} connectNulls={true} type="monotone" dataKey={lp.dataKey} stroke={lp.stroke} fill={lp.stroke} fillOpacity={0.15} name={lp.name}/>
                  : <Line isAnimationActive={false} key={lp.dataKey} connectNulls={true} type="monotone" dataKey={lp.dataKey} stroke={lp.stroke} strokeWidth={lp.strokeWidth||1.5} name={lp.name} dot={false} opacity={lp.opacity||1}/>;
              })}
              <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}
                tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}}/>
            </ComposedChart></ResponsiveContainer>;
          })()}
          {tab==='weather'&&(weather?<ResponsiveContainer><AreaChart animationDuration={0} data={weather.map(w=>({hour:`${w.hour}h`,cloud:w.cloudCover}))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
            <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}} domain={[0,100]}/>
            <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
            <Area isAnimationActive={false} connectNulls={true} type="monotone" dataKey="cloud" stroke="#607D8B" fill="#607D8B" fillOpacity={0.25} name="Cloud %"/>
          <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </AreaChart></ResponsiveContainer>:<p style={{color:'var(--text-dim)',textAlign:'center',paddingTop:100}}>Set lat/lon in Setup ☀ Weather for cloud data</p>)}
          {tab==='compare'&&todayProfile.length>0&&<ResponsiveContainer><AreaChart animationDuration={0} data={todayProfile}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
            <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
            <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend wrapperStyle={{fontSize:11}}/>
            <Area isAnimationActive={false} connectNulls={true} type="monotone" dataKey="pv1" stroke="#2196F3" fill="#2196F3" fillOpacity={0.15} name="PV1"/>
            <Area isAnimationActive={false} connectNulls={true} type="monotone" dataKey="pv2" stroke="#4CAF50" fill="#4CAF50" fillOpacity={0.15} name="PV2"/>
          <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </AreaChart></ResponsiveContainer>}
          {tab==='monthly'&&(monthly.length>0?<ResponsiveContainer><BarChart animationDuration={0} data={monthly.slice().reverse()}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
            <XAxis dataKey="month" tick={{fontSize:10,fill:'var(--text-dim)'}}/><YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
            <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} formatter={v=>[`${v}kWh`]}/>
            <Bar isAnimationActive={false} dataKey="kwh" fill="#2196F3" radius={[3,3,0,0]}/>
          <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </BarChart></ResponsiveContainer>:<p style={{color:'var(--text-dim)',textAlign:'center',paddingTop:100}}>Need more data for monthly totals.</p>)}
        </div>
      </div>

      {/* ── System Health ── */}
      {health && (
        <div className="card" style={{marginBottom:12,padding:14}}>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
            <h3 style={{margin:0}}>System Health</h3>
            <span style={{fontSize:11,color:health.mqttConnected?'var(--accent)':'var(--danger)'}}>{health.mqttConnected?'● MQTT':'○ MQTT Off'}</span>
            {health.haMqttConnected&&<span style={{fontSize:11,color:'var(--accent)'}}>● HA Bridge</span>}
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:8,fontSize:12,color:'var(--text-dim)'}}>
            <span>Uptime: {health.uptimeDisplay}</span>
            <span>|</span>
            <span>DB: {health.dbSizeMb}MB · {health.totalRows?.toLocaleString()} rows</span>
            <span>|</span>
            <span>Mem: {health.memoryMb}/{health.memoryTotalMb}MB</span>
            <span>|</span>
            <span>Msgs: {health.msgCount?.toLocaleString()}</span>
            <span>|</span>
            <span>Disk free: {health.diskFree}</span>
            <span>|</span>
            <span>Node {health.nodeVersion}</span>
          </div>
        </div>
      )}

      {/* ── Devices ── */}
      <div className="device-list" style={{marginBottom:12}}>
        {devices.map(d=>{
          const ld=getDeviceData(d.sn);
          const pv1=ld[361]||0,pv2=ld[70]||0,grid=ld[616]||0,temp=ld[371],volt=ld[613];
          const isIdle = ld._idle || false;
          const totalPower = pv1 + pv2;
          return (
            <div key={d.sn} className="device-card" onClick={()=>navigate(`/device/${d.sn}`)}>
              <div className="sn">{d.sn}{isIdle&&<span style={{marginLeft:8,fontSize:10,color:'var(--text-dim)',fontStyle:'italic'}}>Idle</span>}</div>
              <div className="name">{d.name||d.sn}</div>
              <div className="power" style={{color:isIdle?'var(--text-dim)':'var(--pv2)'}}>
                {totalPower>0?totalPower.toFixed(0):'--'}<span style={{fontSize:14,fontWeight:400,color:'var(--text-dim)'}}>{totalPower>0?'W':'Stopped'}</span>
              </div>
              <div className="meta">{totalPower>0&&<>{pv1>0&&<span style={{color:'var(--pv1)'}}>☀ PV1 {fmt(pv1,0)}W</span>}{pv2>0&&<span style={{color:'var(--pv2)'}}>☀ PV2 {fmt(pv2,0)}W</span>}</>}</div>
              <div className="meta" style={{marginTop:4}}>{grid!==0&&<span>⚡ {fmt(grid,0)}W</span>}{temp>0&&<span>🌡 {fmt(temp,1)}°C</span>}{volt>0&&<span>🔌 {fmt(volt,0)}V</span>}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
