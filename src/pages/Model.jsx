import React, { useState, useEffect } from 'react';
import { useAuth } from '../App';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, BarChart, Bar, Legend } from 'recharts';

export default function Model() {
  const { apiFetch } = useAuth();
  const [devices, setDevices] = useState([]);
  const [selectedSn, setSelectedSn] = useState('');
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { apiFetch('/devices').then(setDevices); }, []);
  useEffect(() => { if (devices.length>0&&!selectedSn) setSelectedSn(devices[0].sn); }, [devices]);

  useEffect(() => {
    if (!selectedSn) return;
    setLoading(true);
    apiFetch(`/model/${selectedSn}`).then(setModel).finally(()=>setLoading(false));
  }, [selectedSn]);

  function fmt(v,d=2){return v!=null&&!isNaN(v)?v.toFixed(d):'--';}

  if (loading) return <div className="loading"><div className="spinner"></div></div>;

  return (
    <div>
      <h2 style={{marginBottom:16}}>☀ AI Prediction Model</h2>

      <div className="card" style={{marginBottom:16}}>
        <select value={selectedSn} onChange={e=>setSelectedSn(e.target.value)}
          style={{padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13}}>
          {devices.map(d=><option key={d.sn} value={d.sn}>{d.name||d.sn}</option>)}
        </select>
      </div>

      {model&&<>
        {/* Model Status */}
        <div className="grid-2" style={{marginBottom:16}}>
          <div className="card">
            <h3>Model Status</h3>
            <div style={{display:'flex',gap:20,flexWrap:'wrap'}}>
              <div className="stat-card" style={{flex:1,minWidth:80}}>
                <div className="label">Status</div>
                <div className="value" style={{fontSize:18,color:model.modelReady?'var(--accent)':'var(--warn)'}}>
                  {model.modelReady?'✅ Trained':'⏳ Learning'}
                </div>
              </div>
              <div className="stat-card" style={{flex:1,minWidth:80}}>
                <div className="label">Panel Factor</div>
                <div className="value" style={{color:'var(--accent2)'}}>{model.learnedFactor?fmt(model.learnedFactor,4):'--'}</div>
                <div className="sub">W output per W/m² radiation</div>
              </div>
              <div className="stat-card" style={{flex:1,minWidth:80}}>
                <div className="label">Training Pairs</div>
                <div className="value">{model.samples}</div>
                <div className="sub">hours of data</div>
              </div>
              <div className="stat-card" style={{flex:1,minWidth:80}}>
                <div className="label">Avg Radiation</div>
                <div className="value" style={{fontSize:18}}>{model.avgRadiationWm2?fmt(model.avgRadiationWm2,0):'--'}<span className="unit">W/m²</span></div>
              </div>
              <div className="stat-card" style={{flex:1,minWidth:80}}>
                <div className="label">Avg Production</div>
                <div className="value" style={{fontSize:18}}>{model.avgProductionW?fmt(model.avgProductionW,0):'--'}<span className="unit">W</span></div>
              </div>
              {model.accuracyDays>0&&<div className="stat-card" style={{flex:1,minWidth:80}}>
                <div className="label">Avg Accuracy</div>
                <div className="value" style={{fontSize:18,color:model.avgAbsErrorPct<15?'var(--accent)':model.avgAbsErrorPct<30?'var(--warn)':'var(--danger)'}}>
                  ±{fmt(model.avgAbsErrorPct,1)}%
                </div>
                <div className="sub">over {model.accuracyDays} days</div>
              </div>}
            </div>
          </div>

          {/* How it works */}
          <div className="card">
            <h3>How It Works</h3>
            <p style={{fontSize:13,color:'var(--text-dim)',lineHeight:1.7}}>
              For each daylight hour, the system pairs <strong>actual solar radiation (W/m²)</strong> from Open-Meteo
              with <strong>your real production (W)</strong>. It computes a <strong>conversion factor</strong>:
            </p>
            <pre style={{background:'var(--bg-card2)',padding:12,borderRadius:8,fontSize:13,margin:'10px 0',color:'var(--accent2)'}}>
  your_watts = radiation_wm² × factor</pre>
            <p style={{fontSize:12,color:'var(--text-dim)'}}>
              This single number absorbs panel efficiency, tilt, orientation, shading, wiring losses —
              everything about your specific installation. Used for generation forecasts.
            </p>
          </div>
        </div>

        {/* Radiation vs Production scatter */}
        {model.historyPairs?.length>5&&<div className="grid-2" style={{marginBottom:16}}>
          <div className="card">
            <h3>Radiation vs Production (all training pairs)</h3>
            <div style={{width:'100%',height:320}}><ResponsiveContainer>
              <ScatterChart><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="radiation" name="Radiation" unit=" W/m²" tick={{fontSize:10,fill:'var(--text-dim)'}} label={{value:'Radiation W/m²',position:'bottom',offset:-2,style:{fill:'var(--text-dim)',fontSize:11}}}/>
                <YAxis dataKey="production" name="Production" unit=" W" tick={{fontSize:10,fill:'var(--text-dim)'}} label={{value:'Production W',angle:-90,position:'left',offset:-2,style:{fill:'var(--text-dim)',fontSize:11}}}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} formatter={(v,name)=>[`${v}`,name]}/>
                <Scatter data={model.historyPairs} fill="#2196F3" opacity={0.6}/>
              </ScatterChart>
            </ResponsiveContainer></div>
          </div>

          {/* Factor over time */}
          <div className="card">
            <h3>Learned Factor Per Hour</h3>
            <div style={{width:'100%',height:320}}><ResponsiveContainer>
              <LineChart data={model.historyPairs}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={s=>new Date(s).toLocaleDateString().slice(0,5)}/>
                <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} labelFormatter={s=>new Date(s).toLocaleString()} formatter={v=>[v,'factor']}/>
                <Line isAnimationActive={false} connectNulls={true} type="monotone" dataKey="factor" stroke="#4CAF50" dot={false} strokeWidth={1.5} name="Factor"/>
              </LineChart>
            </ResponsiveContainer></div>
          </div>
        </div>}

        {/* Prediction Accuracy History */}
        {model.accuracyHistory?.length>0&&<div className="card" style={{marginBottom:16}}>
          <h3>Prediction Accuracy — Predicted vs Actual (kWh)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <BarChart data={model.accuracyHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
              <Legend wrapperStyle={{fontSize:11}}/>
              <Bar isAnimationActive={false} dataKey="predicted" fill="#2196F3" name="Predicted kWh" radius={[2,2,0,0]}/>
              <Bar isAnimationActive={false} dataKey="actual" fill="#4CAF50" name="Actual kWh" radius={[2,2,0,0]}/>
            </BarChart>
          </ResponsiveContainer></div>
        </div>}

        {/* Recent training pairs table */}
        {model.recentPairs?.length>0&&<div className="card">
          <h3>Recent Training Pairs</h3>
          <div className="table-wrap">
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{color:'var(--text-dim)',textAlign:'left'}}>
                <th style={{padding:'6px 10px'}}>Hour</th>
                <th style={{padding:'6px 10px',textAlign:'right'}}>Radiation (W/m²)</th>
                <th style={{padding:'6px 10px',textAlign:'right'}}>Production (W)</th>
                <th style={{padding:'6px 10px',textAlign:'right'}}>Factor</th>
              </tr></thead>
              <tbody>
                {model.recentPairs.map((r,i)=>(
                  <tr key={i} style={{background:i%2===0?'var(--bg-card2)':'transparent'}}>
                    <td style={{padding:'6px 10px',color:'var(--text-dim)',fontSize:11}}>{new Date(r.hour).toLocaleString()}</td>
                    <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace'}}>{fmt(r.radiation,0)}</td>
                    <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace'}}>{fmt(r.production,1)}</td>
                    <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace',color:'var(--accent2)'}}>{fmt(r.factor,4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>}
      </>}
    </div>
  );
}
