import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useLiveData } from '../App';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function LiveDisplay() {
  const { apiFetch } = useAuth();
  const { liveData, connected, gridPower } = useLiveData();
  const [devices, setDevices] = useState([]);
  const [stats, setStats] = useState(null);
  const [profile, setProfile] = useState([]);
  const [panelConfig, setPanelConfig] = useState({});
  const navigate = useNavigate();

  const DAY = 86400;

  useEffect(() => { apiFetch('/devices').then(setDevices); }, []);

  useEffect(() => {
    if (devices.length === 0) return;
    const now = Math.floor(Date.now()/1000);
    const todayStart = Math.floor(now/DAY)*DAY;
    Promise.all([
      apiFetch(`/stats/${devices[0].sn}/enhanced?from=${todayStart}&to=${now}`),
      apiFetch(`/settings/panels/${devices[0].sn}`),
    ]).then(([enhanced, panels]) => {
      setStats(enhanced);
      setPanelConfig(panels);
      if (enhanced.today?.hourlyProfile) {
        setProfile(Array.from({length:24},(_,h)=>({
          hour:`${h}h`, solar:enhanced.today.hourlyProfile[h]?.avg||0,
          yesterday:enhanced.yesterday?.hourlyProfile?.[h]?.avg||0,
        })));
      }
    });
  }, [devices]);

  let livePV = 0;
  for (const d of devices) { const ld = liveData[d.sn] || {}; livePV += (ld[361]||0)+(ld[70]||0); }

  const gridW = gridPower?.w ?? 0;
  const gridV = gridPower?.v ?? null;
  const gridA = gridPower?.a ?? null;
  const d = liveData[devices[0]?.sn] || {};
  const pvV = (d[380]||0)+(d[442]||0) || null;
  const pvA = (d[381]||0)+(d[71]||0) || null;
  const pv1Rated = parseInt(panelConfig.pv1_rated_watts)||0;
  const pv2Rated = parseInt(panelConfig.pv2_rated_watts)||0;
  const pvEff = (pv1Rated+pv2Rated)>0 ? livePV/(pv1Rated+pv2Rated)*100 : null;
  const todayKwh = stats?.today?.totalKwh||0;
  const todaySave = todayKwh * (stats?.rate || 0);
  const isImporting = gridW > 5;

  function fmt(v,d=1){return v!=null&&!isNaN(v)?v.toFixed(d):'--';}

  return (
    <div style={{minHeight:'100vh',background:'var(--bg)',padding:'16px 20px',fontFamily:'system-ui'}}>
      {/* Subtle top bar */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16,opacity:0.5}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:14,fontWeight:600,color:'var(--text-dim)'}}>⚡ EcoFlow Live</span>
          <span className={`status-dot ${connected?'on':'off'}`}></span>
          <span style={{fontSize:12,color:'var(--text-dim)'}}>{connected?'Live':'Offline'}</span>
        </div>
        <button className="btn btn-sm" style={{background:'var(--bg-card2)',color:'var(--text-dim)'}}
          onClick={()=>navigate('/')}>Exit Display</button>
      </div>

      {/* Main content — centered and large */}
      <div style={{maxWidth:900,margin:'0 auto'}}>
        {/* Power Flow — BIG */}
        <div style={{background:'linear-gradient(135deg, var(--bg-card) 0%, var(--bg-card2) 100%)',border:'1px solid var(--border)',borderRadius:16,padding:'24px 30px',marginBottom:16}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:20,flexWrap:'wrap'}}>
            {/* Solar */}
            <div style={{textAlign:'center',minWidth:130}}>
              <div style={{fontSize:48}}>☀</div>
              <div style={{fontSize:42,fontWeight:700,color:'var(--pv2)',lineHeight:1}}>{livePV.toFixed(0)}<span style={{fontSize:20,fontWeight:400,color:'var(--text-dim)'}}>W</span></div>
              <div style={{fontSize:15,color:'var(--text-dim)',marginTop:4}}>
                {livePV>5 ? <>Solar · {fmt(pvV,0)}V · {fmt(pvA,1)}A{pvEff!=null?<> · {fmt(pvEff,1)}%</>:''}</> : 'Idle'}
              </div>
            </div>

            {/* Flow arrows */}
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
              <div style={{fontSize:28,color:livePV>5?'var(--pv2)':'var(--text-dim)',lineHeight:1}}>{livePV>5?'⟶':'·'}</div>
              <div style={{fontSize:28,color:isImporting?'var(--warn)':'var(--accent)',lineHeight:1}}>{isImporting?'⟵':'·'}</div>
            </div>

            {/* Home center */}
            <div style={{textAlign:'center',minWidth:130,background:'rgba(33,150,243,.08)',borderRadius:16,padding:'14px 20px',border:'1px solid var(--border)'}}>
              <div style={{fontSize:36}}>🏠</div>
              <div style={{fontSize:38,fontWeight:700,lineHeight:1}}>{Math.max(livePV,gridW).toFixed(0)}<span style={{fontSize:18,fontWeight:400,color:'var(--text-dim)'}}>W</span></div>
              <div style={{fontSize:13,color:'var(--text-dim)',marginTop:4}}>Load</div>
            </div>

            {/* Grid */}
            <div style={{textAlign:'center',minWidth:130}}>
              <div style={{fontSize:48}}>⚡</div>
              <div style={{fontSize:42,fontWeight:700,color:isImporting?'var(--warn)':'var(--accent)',lineHeight:1}}>
                {gridPower?.w!=null?Math.abs(gridPower.w).toFixed(0):'--'}<span style={{fontSize:20,fontWeight:400,color:'var(--text-dim)'}}>W</span>
              </div>
              <div style={{fontSize:15,color:'var(--text-dim)',marginTop:4}}>
                {isImporting?'Importing':(gridPower?.w!=null?'Exporting':'Grid')}
                {gridV!=null&&<span> · {fmt(gridV,0)}V</span>}
                {gridA!=null&&<span> · {fmt(gridA,1)}A</span>}
              </div>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div style={{display:'flex',gap:12,marginBottom:16,flexWrap:'wrap'}}>
          {[{l:'Today kWh',v:todayKwh,f:2,c:'var(--pv2)'},
            {l:'Saved Today',v:todaySave,c:'var(--accent)',prefix:'£'},
            {l:'Peak Today',v:stats?.today?.bestDay?.peakW||stats?.week?.daily?.slice(-1)[0]?.peakW,c:'var(--accent2)',unit:'W'},
            {l:'PV Efficiency',v:pvEff,c:'var(--accent2)',unit:'%',f:1},
            {l:'Grid Voltage',v:gridV,c:'var(--text)',unit:'V',f:0},
          ].map(s=>(
            <div key={s.l} className="stat-card" style={{flex:'1',minWidth:100,textAlign:'center',padding:'16px 12px'}}>
              <div className="label">{s.l}</div>
              <div className="value" style={{fontSize:26,color:s.c}}>{s.prefix||''}{s.f!=null?fmt(s.v,s.f):fmt(s.v,0)}<span className="unit">{s.unit}</span></div>
            </div>
          ))}
        </div>

        {/* Graph — full width, big */}
        <div className="card" style={{padding:20,marginBottom:16}}>
          <h3 style={{fontSize:16,marginBottom:12}}>Today's Generation</h3>
          <div style={{width:'100%',height:320}}>
            {profile.length>0?<ResponsiveContainer>
              <AreaChart animationDuration={0} data={profile}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="hour" tick={{fontSize:12,fill:'var(--text-dim)'}} interval={2}/>
                <YAxis tick={{fontSize:12,fill:'var(--text-dim)'}}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,fontSize:14}}/>
                <Area isAnimationActive={false} connectNulls={true} type="monotone" dataKey="solar" stroke="#4CAF50" fill="#4CAF50" fillOpacity={0.25} name="Today"/>
              </AreaChart>
            </ResponsiveContainer>:<p style={{color:'var(--text-dim)',textAlign:'center',paddingTop:100,fontSize:16}}>Waiting for solar data...</p>}
          </div>
        </div>

        {/* Generation window & stats */}
        {stats?.today?.daylight?.pv1 && (
          <div style={{textAlign:'center',fontSize:15,color:'var(--text-dim)',padding:'8px 0 20px'}}>
            ☀ Gen window: {stats.today.daylight.pv1.window || '--'} · {stats.today.daylight.pv1.genHours||0}h daylight
            {stats.today.daylight.pv1.daylightEff!=null && <> · {fmt(stats.today.daylight.pv1.daylightEff,1)}% avg daylight eff</>}
          </div>
        )}
      </div>
    </div>
  );
}
