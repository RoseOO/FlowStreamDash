import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useLiveData } from '../App';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { DAY } from '../utils/constants';
import { fmt } from '../utils/format';
import useDevices from '../hooks/useDevices';

const BOX_W = 160;

function FlowArrow({ from, to, active, activeDir, power, color }) {
  return (
    <div style={{width:50,height:60,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
      <svg width={50} height={60}>
        {/* base line */}
        <line x1={0} y1={30} x2={50} y2={30} stroke="var(--border)" strokeWidth={2}/>
        {/* active arrow */}
        {active && (
          <line x1={activeDir==='fwd'?5:45} y1={30} x2={activeDir==='fwd'?45:5} y2={30}
            stroke={color} strokeWidth={4} strokeLinecap="round"
            className="flow-arrow-glow"/>
        )}
        {/* arrowhead */}
        {active && (
          <polygon
            points={activeDir==='fwd'?'45,22 50,30 45,38':'5,22 0,30 5,38'}
            fill={color}/>
        )}
      </svg>
    </div>
  );
}

export default function LiveDisplay() {
  const { apiFetch } = useAuth();
  const { liveData, connected, gridPower } = useLiveData();
  const { devices } = useDevices(apiFetch);
  const [stats, setStats] = useState(null);
  const [profile, setProfile] = useState([]);
  const [panelConfig, setPanelConfig] = useState({});
  const navigate = useNavigate();

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
  }, [devices, apiFetch]);

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
  const isGenerating = livePV > 5;
  const isImporting = gridW > 5;
  const isExporting = gridW < -5;
  const loadW = Math.max(livePV + (isImporting ? gridW : 0), 0);

  function fmtPence(amount) {
    const pence = Math.round(amount * 100);
    return `£${(pence/100).toFixed(2)}`;
  }

  return (
    <div className="live-display">
      {/* Subtle top bar */}
      <div className="live-top-bar">
        <div className="live-top-left">
          <span>⚡ EcoFlow Live</span>
          <span className={`status-dot ${connected?'on':'off'}`}></span>
          <span className="live-conn-label">{connected?'Live':'Offline'}</span>
        </div>
        <button className="btn btn-sm" style={{background:'var(--bg-card2)',color:'var(--text-dim)'}}
          onClick={()=>navigate('/')}>Exit Display</button>
      </div>

      <div className="live-main">
        {/* Power Flow */}
        <div className="live-flow-card">
          <div className="live-flow-row">
            {/* Solar */}
            <div className="live-box" style={{width:BOX_W}}>
              <div className="live-box-icon">☀</div>
              <div className="live-box-val" style={{color:isGenerating?'var(--pv2)':'var(--text-dim)'}}>
                {fmt(livePV,0)}<span className="live-box-unit">W</span>
              </div>
              <div className="live-box-sub">
                {isGenerating ? <>{fmt(pvV,0)}V · {fmt(pvA,1)}A{pvEff!=null?<> · {fmt(pvEff,1)}%</>:''}</> : 'Idle'}
              </div>
            </div>

            {/* Arrow Solar→Home */}
            <FlowArrow active={isGenerating} activeDir="fwd" power={livePV} color="var(--pv2)"/>

            {/* Home/Load */}
            <div className="live-box live-box-home" style={{width:BOX_W}}>
              <div className="live-box-icon">🏠</div>
              <div className="live-box-val" style={{color:'var(--text)'}}>
                {fmt(loadW,0)}<span className="live-box-unit">W</span>
              </div>
              <div className="live-box-sub">Load</div>
            </div>

            {/* Arrow Grid↔Home */}
            <FlowArrow active={isImporting||isExporting} activeDir={isImporting?'rev':'fwd'}
              power={Math.abs(gridW)} color={isImporting?'var(--warn)':'var(--accent)'}/>

            {/* Grid */}
            <div className="live-box" style={{width:BOX_W}}>
              <div className="live-box-icon">⚡</div>
              <div className="live-box-val" style={{color:isImporting?'var(--warn)':(isExporting?'var(--accent)':'var(--text-dim)')}}>
                {gridPower?.w!=null?Math.abs(gridPower.w).toFixed(0):'--'}<span className="live-box-unit">W</span>
              </div>
              <div className="live-box-sub">
                {isImporting?'Importing':(isExporting?'Exporting':'Grid')}
                {gridV!=null&&<span> · {fmt(gridV,0)}V</span>}
                {gridA!=null&&<span> · {fmt(gridA,1)}A</span>}
              </div>
            </div>
          </div>
        </div>

        {/* Stats row — fixed widths */}
        <div className="live-stats">
          {[
            {l:'Today kWh',v:todayKwh,f:2,c:'var(--pv2)'},
            {l:`Saved ${fmtPence(todaySave)}`,v:null,c:'var(--accent)'},
            {l:'Peak Today',v:stats?.today?.bestDay?.peakW||stats?.week?.daily?.slice(-1)[0]?.peakW,c:'var(--accent2)',unit:'W'},
            {l:'PV Efficiency',v:pvEff,c:'var(--accent2)',unit:'%',f:1},
            {l:'Grid Voltage',v:gridV,c:'var(--text)',unit:'V',f:0},
          ].map(s=>(
            <div key={s.l} className="live-stat-item">
              <div className="live-stat-label">{s.l}</div>
              {s.v!==null ? (
                <div className="live-stat-val" style={{color:s.c}}>{s.f!=null?fmt(s.v,s.f):fmt(s.v,0)}<span className="live-stat-unit">{s.unit}</span></div>
              ) : (
                <div className="live-stat-val-solo" style={{color:s.c}}>{s.l.replace('Saved ','')}</div>
              )}
            </div>
          ))}
        </div>

        {/* Graph */}
        <div className="live-chart-card">
          <h3 style={{fontSize:16,marginBottom:12,textAlign:'center'}}>Today's Generation</h3>
          <div className="live-chart-wrap">
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
