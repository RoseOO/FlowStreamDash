import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth, useLiveData } from '../App';
import { FIELD_META, DISPLAY_ORDER, DISPLAY_SECTIONS, getFieldLabel, formatValue } from '../../server/fields';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Brush } from 'recharts';

const RANGE_OPTIONS = { '1h': 3600, '6h': 21600, '24h': 86400, '2d': 172800, '7d': 604800 };
const LIVE_COLORS = ['#2196F3','#4CAF50','#F44336','#FF9800','#9C27B0','#E91E63','#00BCD4','#795548'];

export default function DeviceDetail() {
  const { sn } = useParams();
  const { apiFetch } = useAuth();
  const { liveData } = useLiveData();
  const [history, setHistory] = useState([]);
  const [device, setDevice] = useState(null);
  const [customGraphFields, setCustomGraphFields] = useState([]);
  const [panelConfig, setPanelConfig] = useState({});
  const [snapshot, setSnapshot] = useState({});
  const [flashFields, setFlashFields] = useState(new Set());
  const [graphRange, setGraphRange] = useState('6h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const prevLdRef = useRef({});

  // Merge: latest DB snapshot (fills cold-start gaps) + live MQTT data
  const ld = { ...snapshot, ...liveData[sn] };

  useEffect(() => {
    apiFetch('/devices').then(devs => { const d=devs.find(x=>x.sn===sn); if(d)setDevice(d); });
    apiFetch(`/settings/panels/${sn}`).then(setPanelConfig);
    // Fetch latest snapshot so we show data immediately on page load
    apiFetch(`/data/${sn}/latest`).then(r => setSnapshot({ ...(r.latest || {}), _idle: r.idle || false }));
  }, [sn]);

  const BASE_FIELDS = [361, 70, 616, 613, 371];
  const allGraphFields = [...new Set([...BASE_FIELDS, ...customGraphFields])];

  // Fetch history for graph fields
  useEffect(() => {
    if (!sn) return;
    const now = Math.floor(Date.now()/1000);
    let from, to;
    if (graphRange === 'custom' && customFrom) {
      from = Math.floor(new Date(customFrom).getTime()/1000);
      to = customTo ? Math.floor(new Date(customTo).getTime()/1000) : now;
    } else {
      const lookback = RANGE_OPTIONS[graphRange] || 21600;
      from = now - lookback; to = now;
    }
    const fieldList = allGraphFields.join(',');
    apiFetch(`/data/${sn}/history?from=${from}&to=${to}&fields=${fieldList}`)
      .then(rows => {
        const byTs={};
        for(const r of rows){
          if(!byTs[r.ts])byTs[r.ts]={ts:r.ts*1000};
          byTs[r.ts][`f${r.field_num}`]=r.value_num;
        }
        setHistory(Object.values(byTs).sort((a,b)=>a.ts-b.ts));
      })
      .catch(err => console.error('[DeviceDetail] History fetch failed:', err));
  }, [sn, customGraphFields.join(','), graphRange, customFrom, customTo]);

  // Merge live data (only for 1h/6h ranges where live updates matter)
  useEffect(() => {
    if(!ld._ts)return;
    const lookback = RANGE_OPTIONS[graphRange] || 21600;
    setHistory(prev=>{
      const pt={ts:ld._ts*1000};
      for(const f of allGraphFields) pt[`f${f}`]=ld[f];
      const next=[...prev,pt];
      return next.filter(p=>p.ts>=Date.now()-lookback*1000).slice(-3000);
    });
  }, [ld._ts, ld[361],ld[70],ld[616],ld[613],ld[371],ld[380],ld[381],ld[442],ld[71],ld[614],ld[615],ld[617],ld[618],ld[638], graphRange]);

  // Flash fields that changed on live update (skip idle zeros)
  useEffect(() => {
    if (ld._idle) return;
    const changed = [];
    for (const f of Object.keys(ld)) {
      if (f === '_ts' || f === '_idle') continue;
      if (ld[f] !== prevLdRef.current[f] && ld[f] != null && prevLdRef.current[f] !== undefined) {
        changed.push(parseInt(f));
      }
    }
    prevLdRef.current = { ...ld };
    if (changed.length === 0) return;
    const newSet = new Set(changed);
    setFlashFields(newSet);
    const timer = setTimeout(() => setFlashFields(new Set()), 600);
    return () => clearTimeout(timer);
  }, [ld]);

  function fmt(v,d=0){return v!=null?v.toFixed(d):'--';}

  function toggleCustomField(fnum) {
    setCustomGraphFields(prev => prev.includes(fnum) ? prev.filter(x=>x!==fnum) : [...prev,fnum]);
  }

  // Efficiency calc
  const pv1Rated = parseInt(panelConfig.pv1_rated_watts) || 0;
  const pv2Rated = parseInt(panelConfig.pv2_rated_watts) || 0;
  const pv1Eff = pv1Rated > 0 && ld[361] > 0 ? (ld[361] / pv1Rated * 100) : null;
  const pv2Eff = pv2Rated > 0 && ld[70] > 0 ? (ld[70] / pv2Rated * 100) : null;

  if(!device)return<div className="loading"><div className="spinner"></div></div>;
  const name=device.name||sn;

  return (
    <div>
      <h2 style={{marginBottom:16}}>{name} <span style={{fontSize:13,color:'var(--text-dim)',fontFamily:'monospace',fontWeight:400}}>{sn}</span>
        <span style={{marginLeft:12,fontSize:11,color:ld._idle?'var(--warn)':'var(--text-dim)',fontWeight:400}}>
          {ld._ts?`Last update: ${new Date(ld._ts * 1000).toLocaleTimeString()}`:'No data yet'}
          {ld._idle&&' · Idle'}
        </span>
        <span style={{marginLeft:'auto',display:'flex',gap:6}}>
          <button className="btn btn-sm" style={{background:'var(--bg-card2)',color:'var(--text-dim)',fontSize:10,padding:'3px 8px'}}
            onClick={async()=>{try{await apiFetch(`/device/${sn}/full-upload`,{method:'POST'});alert('Full upload triggered — watch for data')}catch(e){alert(e.message)}}}
            title="Request full data snapshot from device">Full Upload</button>
          <button className="btn btn-sm" style={{background:'var(--bg-card2)',color:'var(--text-dim)',fontSize:10,padding:'3px 8px'}}
            onClick={async()=>{try{const on=confirm('Enable debug mode on device?');await apiFetch(`/device/${sn}/debug-mode`,{method:'POST',body:JSON.stringify({enable:on})});alert(`Debug mode ${on?'ON':'OFF'}`)}catch(e){alert(e.message)}}}
            title="Toggle debug mode on device">Debug</button>
        </span>
      </h2>

      {/* Stat cards */}
      <div className="grid-4" style={{marginBottom:16}}>
        {[{l:'PV1 Power',v:ld[361],u:'W',c:'var(--pv1)',e:pv1Eff},{l:'PV1 Volt',v:ld[380],u:'V',c:'var(--pv1)'},{l:'PV1 Curr',v:ld[381],u:'A',c:'var(--pv1)'},
          {l:'PV2 Power',v:ld[70],u:'W',c:'var(--pv2)',e:pv2Eff},{l:'PV2 Volt',v:ld[442],u:'V',c:'var(--pv2)'},{l:'PV2 Curr',v:ld[71],u:'A',c:'var(--pv2)'},
          {l:'Grid Power',v:ld[616],u:'W',c:ld[616]<0?'var(--accent)':'var(--warn)'},{l:'Grid Volt',v:ld[613],u:'V',c:'var(--volt)'},
        ].map(s=>(
          <div key={s.l} className="stat-card" style={{padding:'10px 14px'}}>
            <div className="label">{s.l}{s.e!=null?<span style={{marginLeft:6,fontSize:10,color:s.e>70?'var(--accent)':'var(--warn)'}}>{fmt(s.e,1)}% eff</span>:null}</div>
            <div className="value" style={{fontSize:20,color:s.c}}>{fmt(s.v,s.u==='A'?2:1)}<span className="unit">{s.u}</span></div>
          </div>
        ))}
      </div>

      {/* Live graphs */}
      <div className="card" style={{marginBottom:16,padding:'10px 14px'}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,flexWrap:'wrap'}}>
          <h3 style={{margin:0,marginRight:8}}>Graphs</h3>
          {Object.keys(RANGE_OPTIONS).map(r=>(
            <button key={r} className={`btn btn-sm ${graphRange===r?'btn-primary':''}`}
              style={graphRange!==r?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}}
              onClick={()=>setGraphRange(r)}>{r}</button>
          ))}
          <button className={`btn btn-sm ${graphRange==='custom'?'btn-primary':''}`}
            style={graphRange!=='custom'?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}}
            onClick={()=>setGraphRange('custom')}>Custom</button>
          {graphRange==='custom'&&<>
            <input type="datetime-local" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}
              style={{padding:'4px 8px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontSize:12}}/>
            <span style={{color:'var(--text-dim)',fontSize:12}}>to</span>
            <input type="datetime-local" value={customTo} onChange={e=>setCustomTo(e.target.value)}
              style={{padding:'4px 8px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontSize:12}}/>
          </>}
        </div>
        <div className="grid-2" style={{marginBottom:0}}>
        <div className="card"><h3>PV & Grid Power (W)</h3>
          <div className="chart-container"><ResponsiveContainer>
            <LineChart animationDuration={0} data={history}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:11,fill:'var(--text-dim)'}} tickFormatter={ts=>new Date(ts).toLocaleTimeString().slice(0,5)}/>
              <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleTimeString()} contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend/>
              <Line isAnimationActive={false} type="monotone" dataKey="f361" stroke="#2196F3" name="PV1" dot={false} strokeWidth={1.5} connectNulls={true}/>
              <Line isAnimationActive={false} type="monotone" dataKey="f70" stroke="#4CAF50" name="PV2" dot={false} strokeWidth={1.5} connectNulls={true}/>
              <Line isAnimationActive={false} type="monotone" dataKey="f616" stroke="#F44336" name="Grid" dot={false} strokeWidth={2} connectNulls={true}/>
            <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </LineChart>
          </ResponsiveContainer></div>
        </div>
        <div className="card"><h3>Grid Voltage (V)</h3>
          <div className="chart-container"><ResponsiveContainer>
            <LineChart animationDuration={0} data={history}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:11,fill:'var(--text-dim)'}} tickFormatter={ts=>new Date(ts).toLocaleTimeString().slice(0,5)}/>
              <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}} domain={['auto','auto']}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleTimeString()} contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Line isAnimationActive={false} type="monotone" dataKey="f613" stroke="#FF9800" name="Voltage" dot={false} strokeWidth={1.5} connectNulls={true}/>
            <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </LineChart>
          </ResponsiveContainer></div>
        </div>
        <div className="card"><h3>Inverter Temperature (°C)</h3>
          <div className="chart-container"><ResponsiveContainer>
            <LineChart animationDuration={0} data={history}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:11,fill:'var(--text-dim)'}} tickFormatter={ts=>new Date(ts).toLocaleTimeString().slice(0,5)}/>
              <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleTimeString()} contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Line isAnimationActive={false} type="monotone" dataKey="f371" stroke="#E91E63" name="Temp" dot={false} strokeWidth={1.5} connectNulls={true}/>
            <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </LineChart>
          </ResponsiveContainer></div>
        </div>
        {/* Custom graph */}
        {customGraphFields.length>0&&(
          <div className="card"><h3>Selected Fields {customGraphFields.map(f=>(<span key={f} style={{fontSize:11,marginLeft:6,color:'var(--text-dim)',cursor:'pointer'}} onClick={()=>toggleCustomField(f)}>✕ {getFieldLabel(f)}</span>))}</h3>
            <div className="chart-container"><ResponsiveContainer>
              <LineChart animationDuration={0} data={history}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="ts" tick={{fontSize:11,fill:'var(--text-dim)'}} tickFormatter={ts=>new Date(ts).toLocaleTimeString().slice(0,5)}/>
                <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
                <Tooltip labelFormatter={ts=>new Date(ts).toLocaleTimeString()} contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend/>
                {customGraphFields.map((f,i)=><Line isAnimationActive={false} key={f} type="monotone" dataKey={`f${f}`} stroke={LIVE_COLORS[i%LIVE_COLORS.length]} name={getFieldLabel(f)} dot={false} strokeWidth={1.5} connectNulls={true}/>)}
              <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </LineChart>
            </ResponsiveContainer></div>
          </div>
        )}
        </div>
      </div>

      {/* Live data with click-to-graph */}
      <div className="card">
        <h2>Live Data <span style={{fontSize:11,color:'var(--text-dim)',fontWeight:400}}>(click a value to add to graph)</span></h2>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(200px, 1fr))',gap:'6px 20px',fontSize:13}}>
          {DISPLAY_ORDER.map(f=>{
            if(!FIELD_META[f])return null;
            const section=DISPLAY_SECTIONS[f];
            const val=ld[f];
            const selected=customGraphFields.includes(f);
            const flashing=flashFields.has(f);
            return (
              <React.Fragment key={f}>
                {section&&<div style={{gridColumn:'1/-1',color:'var(--text-dim)',fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',padding:'10px 0 2px',borderBottom:'1px solid var(--border)'}}>{section}</div>}
                <div onClick={()=>toggleCustomField(f)} style={{
                  display:'flex',justifyContent:'space-between',padding:'3px 8px',borderRadius:4,cursor:'pointer',
                  background:flashing?'rgba(76,175,80,.2)':selected?'rgba(33,150,243,.15)':(val!=null?'var(--bg-card2)':'transparent'),
                  border:flashing?'1px solid rgba(76,175,80,.4)':selected?'1px solid var(--accent2)':'1px solid transparent',
                  transition:'background .5s ease-out, border .5s ease-out',
                }}>
                  <span style={{color:'var(--text-dim)'}}>{getFieldLabel(f)}</span>
                  <span style={{fontWeight:600,fontVariantNumeric:'tabular-nums',color:val!=null?'var(--text)':'var(--text-dim)'}}>
                    {formatValue(f,val)} {FIELD_META[f].unit&&<span style={{fontSize:10,color:'var(--text-dim)',fontWeight:400}}>{FIELD_META[f].unit}</span>}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
