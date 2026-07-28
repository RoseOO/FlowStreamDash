import React, { useState, useEffect } from 'react';
import { useAuth } from '../App';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, BarChart, Bar, Legend, ComposedChart, Area, Brush } from 'recharts';
import { fmt } from '../utils/format';
import useDevices from '../hooks/useDevices';
import DeviceSelector from '../components/DeviceSelector';

export default function Model() {
  const { apiFetch } = useAuth();
  const { devices, selectedSn, setSelectedSn } = useDevices(apiFetch);
  const [model, setModel] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(false);

  async function trainModel() {
    if (!selectedSn) return;
    setLoading(true);
    try {
      const r = await apiFetch(`/model/${selectedSn}/train`, { method:'POST' });
      alert(`Training complete: ${r.trained} new pairs, factor ×${r.modelFactor}`);
      // Refresh
      const [m, f] = await Promise.all([apiFetch(`/model/${selectedSn}`), apiFetch(`/forecast/${selectedSn}`)]);
      setModel(m); setForecast(f);
    } catch(e) { alert('Training failed: ' + e.message); }
    setLoading(false);
  }

  useEffect(() => {
    if (!selectedSn) return;
    setLoading(true);
    Promise.all([
      apiFetch(`/model/${selectedSn}`),
      apiFetch(`/forecast/${selectedSn}`),
    ]).then(([m,f]) => { setModel(m); setForecast(f); })
    .finally(() => setLoading(false));
  }, [selectedSn, apiFetch]);

  function fmt(v,d=2){return v!=null&&!isNaN(v)?v.toFixed(d):'--';}

  // Compute extra stats from model data
  const factors = model?.historyPairs?.map(p=>p.factor).filter(f=>f>0) || [];
  const avgFactor = factors.length ? factors.reduce((a,b)=>a+b,0)/factors.length : 0;
  const minFactor = factors.length ? Math.min(...factors) : 0;
  const maxFactor = factors.length ? Math.max(...factors) : 0;
  const range = maxFactor - minFactor;
  const stability = avgFactor > 0 ? (1 - (range / avgFactor)) * 100 : 0;
  // R² approximation: variance explained
  const pairs = model?.historyPairs || [];
  let rSquared = null;
  if (pairs.length > 5) {
    const radMean = pairs.reduce((a,b)=>a+(b.radiation||0),0)/pairs.length;
    const prodMean = pairs.reduce((a,b)=>a+(b.production||0),0)/pairs.length;
    let ssRes=0, ssTot=0;
    for (const p of pairs) {
      const pred = (p.radiation||0) * avgFactor;
      ssRes += ((p.production||0) - pred) ** 2;
      ssTot += ((p.production||0) - prodMean) ** 2;
    }
    rSquared = ssTot > 0 ? 1 - ssRes/ssTot : 0;
  }

  if (loading && !model) return <div className="loading"><div className="spinner"></div></div>;

  return (
    <div>
      <h2 style={{marginBottom:16}}>☀ AI Prediction Model</h2>

      <div className="card" style={{marginBottom:16}}>
        <DeviceSelector devices={devices} selectedSn={selectedSn} setSelectedSn={setSelectedSn} />
        <button className="btn btn-sm" onClick={trainModel} disabled={loading}
          style={{marginLeft:8,background:'var(--accent2)',color:'#fff'}}>
          {loading?'Training...':'🔄 Train Model'}
        </button>
      </div>

      {model&&<>
        {/* Model Status — Verbose */}
        <div className="card" style={{marginBottom:16}}>
          <h3>Model Status</h3>
          <div className="grid-4" style={{marginBottom:12}}>
            <div className="stat-card" style={{textAlign:'center'}}><div className="label">Status</div>
              <div className="value" style={{fontSize:18,color:model.modelReady?'var(--accent)':'var(--warn)'}}>{model.modelReady?'✅ Trained':'⏳ Learning'}</div>
              <div className="sub">{model.samples} training pairs · needs 10+</div></div>
            <div className="stat-card" style={{textAlign:'center'}}><div className="label">Panel Factor</div>
              <div className="value" style={{color:'var(--accent2)'}}>{model.learnedFactor?fmt(model.learnedFactor,4):'--'}</div></div>
            <div className="stat-card" style={{textAlign:'center'}}><div className="label">Factor Range</div>
              <div className="value" style={{fontSize:18}}>{fmt(minFactor,4)} – {fmt(maxFactor,4)}</div><div className="sub">Stability: {fmt(stability,1)}%</div></div>
            <div className="stat-card" style={{textAlign:'center'}}><div className="label">R² Fit Quality</div>
              <div className="value" style={{fontSize:18,color:rSquared>0.8?'var(--accent)':rSquared>0.5?'var(--warn)':'var(--danger)'}}>{rSquared!=null?fmt(rSquared*100,1)+'%':'--'}</div>
              <div className="sub">{rSquared>0.8?'Excellent fit':'More data needed'}</div></div>
          </div>
          <div className="grid-4">
            <div className="stat-card" style={{textAlign:'center'}}><div className="label">Avg Radiation</div>
              <div className="value" style={{fontSize:18}}>{model.avgRadiationWm2?fmt(model.avgRadiationWm2,0):'--'}<span className="unit">W/m²</span></div></div>
            <div className="stat-card" style={{textAlign:'center'}}><div className="label">Avg Production</div>
              <div className="value" style={{fontSize:18}}>{model.avgProductionW?fmt(model.avgProductionW,0):'--'}<span className="unit">W</span></div></div>
            <div className="stat-card" style={{textAlign:'center'}}><div className="label">Training Samples</div>
              <div className="value" style={{fontSize:18}}>{model.samples}<span className="unit"> hours</span></div></div>
            {model.accuracyDays>0&&<div className="stat-card" style={{textAlign:'center'}}><div className="label">Avg Accuracy</div>
              <div className="value" style={{fontSize:18,color:model.avgAbsErrorPct<15?'var(--accent)':model.avgAbsErrorPct<30?'var(--warn)':'var(--danger)'}}>±{fmt(model.avgAbsErrorPct,1)}%</div>
              <div className="sub">over {model.accuracyDays} days</div></div>}
          </div>
        </div>

        {/* What does this mean? */}
        <div className="card" style={{marginBottom:16}}>
          <h3>What Your Model Means</h3>
          {model.learnedFactor ? (
            <div style={{fontSize:13,color:'var(--text-dim)',lineHeight:1.8}}>
              <p>Your panel factor of <strong style={{color:'var(--accent2)'}}>×{fmt(model.learnedFactor,4)}</strong> means:</p>
              <ul style={{paddingLeft:20,margin:'8px 0'}}>
                <li>For every <strong>1 W/m²</strong> of solar radiation hitting your location, your panels produce <strong>{fmt(model.learnedFactor,4)} W</strong></li>
                <li>At peak summer radiation (~800 W/m²), expect <strong>{fmt(800 * model.learnedFactor,0)} W</strong> of generation</li>
                <li>At typical midday radiation (~500 W/m²), expect <strong>{fmt(500 * model.learnedFactor,0)} W</strong></li>
                <li>At overcast levels (~150 W/m²), expect <strong>{fmt(150 * model.learnedFactor,0)} W</strong></li>
              </ul>
              <p style={{fontSize:11,marginTop:8}}>
                This factor includes <em>everything</em>: panel efficiency, tilt angle, orientation, dirt, shading, wiring losses, and inverter efficiency. 
                {rSquared>0.7 ? ` R² of ${fmt(rSquared*100,0)}% means ${fmt(rSquared*100,0)}% of your production variation is explained by radiation alone — a strong model.` : 
                rSquared>0.4 ? ` With R² of ${fmt(rSquared*100,0)}%, the model is improving but could benefit from more training data.` :
                ' The model needs more training pairs to stabilise.'}
              </p>
            </div>
          ) : (
            <p style={{color:'var(--text-dim)',fontSize:13}}>Not enough data yet. The model needs daylight hours with both radiation and production data. It auto-trains every 6 hours from your historical data.</p>
          )}
        </div>

        {/* Today's Forecast */}
        {forecast && !forecast.error && (
          <div className="card" style={{marginBottom:16}}>
            <h3>Today's Generation Forecast</h3>
            <div className="grid-3" style={{marginBottom:12}}>
              <div className="stat-card" style={{textAlign:'center'}}><div className="label">Already Produced</div><div className="value" style={{color:'var(--accent)'}}>{forecast.alreadyProducedKwh}<span className="unit">kWh</span></div></div>
              <div className="stat-card" style={{textAlign:'center'}}><div className="label">Predicted Remaining</div><div className="value" style={{color:'var(--accent2)'}}>{forecast.predictedRemainingKwh}<span className="unit">kWh</span></div></div>
              <div className="stat-card" style={{textAlign:'center'}}><div className="label">Predicted Total</div><div className="value" style={{color:'var(--accent2)',fontSize:28}}>{forecast.predictedTotalKwh}<span className="unit">kWh</span></div></div>
            </div>
            <p style={{fontSize:12,color:'var(--text-dim)',marginBottom:10}}>
              Using factor ×{fmt(forecast.modelFactor,4)} from {forecast.modelSamples} training pairs.
              {forecast.usingLearnedModel ? ' ✅ Learned model active.' : ' ⏳ Learning model — accuracy improves with more data.'}
            </p>
            <div style={{width:'100%',height:300}}><ResponsiveContainer>
              <ComposedChart animationDuration={0} data={Array.from({length:24},(_,h)=>{
                const rad = forecast.radiationWm2?.[h] || 0;
                const pred = forecast.predictedWattsByHour?.[h];
                const hist = h <= forecast.currentHour ? forecast.historicalAvgW?.[h] || 0 : null;
                return { hour:`${h}h`, radiation:rad, predicted:pred, historical:hist };
              })}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} interval={2}/>
                <YAxis yAxisId="left" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <YAxis yAxisId="right" orientation="right" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend/>
                <Area isAnimationActive={false} connectNulls={true} yAxisId="left" type="monotone" dataKey="historical" stroke="#4CAF50" fill="#4CAF50" fillOpacity={0.2} name="Historical Avg"/>
                <Line isAnimationActive={false} connectNulls={true} yAxisId="left" type="monotone" dataKey="predicted" stroke="#2196F3" strokeWidth={2} dot={{r:2}} name="Predicted"/>
                <Area isAnimationActive={false} connectNulls={true} yAxisId="right" type="monotone" dataKey="radiation" stroke="#FF9800" fill="#FF9800" fillOpacity={0.08} name="Radiation"/>
                <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}}/>
              </ComposedChart>
            </ResponsiveContainer></div>
          </div>
        )}

        {/* Scatter + Factor over time */}
        {model.historyPairs?.length>5&&<div className="grid-2" style={{marginBottom:16}}>
          <div className="card">
            <h3>Radiation vs Production <span style={{fontSize:11,color:'var(--text-dim)',fontWeight:400}}>— {model.historyPairs.length} training pairs</span></h3>
            {rSquared!=null&&<p style={{fontSize:11,color:'var(--text-dim)',marginBottom:4}}>R² = {fmt(rSquared*100,1)}% — {rSquared>0.8?'Strong correlation':rSquared>0.5?'Moderate correlation':'Weak — more data needed'}</p>}
            <div style={{width:'100%',height:300}}><ResponsiveContainer>
              <ScatterChart><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="radiation" name="Radiation" unit=" W/m²" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <YAxis dataKey="production" name="Production" unit=" W" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} formatter={(v,n)=>[`${v}`,n]}/>
                <Scatter data={model.historyPairs} fill="#2196F3" opacity={0.5}/>
              </ScatterChart>
            </ResponsiveContainer></div>
          </div>

          <div className="card">
            <h3>Learned Factor Per Hour <span style={{fontSize:11,color:'var(--text-dim)',fontWeight:400}}>— ×{fmt(avgFactor,4)} avg</span></h3>
            <div style={{width:'100%',height:300}}><ResponsiveContainer>
              <LineChart animationDuration={0} data={model.historyPairs}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="hour" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={s=>new Date(s).toLocaleDateString().slice(0,5)}/>
                <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}} domain={['auto','auto']}/>
                <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} labelFormatter={s=>new Date(s).toLocaleString()} formatter={v=>[v,'factor']}/>
                <Line isAnimationActive={false} connectNulls={true} type="monotone" dataKey="factor" stroke="#4CAF50" dot={false} strokeWidth={1.5} name="Factor"/>
                <Brush dataKey="ts" height={20} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}}/>
              </LineChart>
            </ResponsiveContainer></div>
          </div>
        </div>}

        {/* Prediction Accuracy */}
        {model.accuracyHistory?.length>0&&<div className="card" style={{marginBottom:16}}>
          <h3>Prediction Accuracy — Predicted vs Actual (kWh)</h3>
          <p style={{fontSize:11,color:'var(--text-dim)',marginBottom:8}}>Average error: ±{fmt(model.avgAbsErrorPct,1)}% over {model.accuracyDays} days</p>
          <div style={{width:'100%',height:280}}><ResponsiveContainer>
            <BarChart animationDuration={0} data={model.accuracyHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/><Legend/>
              <Bar isAnimationActive={false} dataKey="predicted" fill="#2196F3" name="Predicted" radius={[2,2,0,0]}/>
              <Bar isAnimationActive={false} dataKey="actual" fill="#4CAF50" name="Actual" radius={[2,2,0,0]}/>
              <Brush dataKey="ts" height={20} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}/>
            </BarChart>
          </ResponsiveContainer></div>
        </div>}

        {/* Recent training pairs */}
        {model.recentPairs?.length>0&&<div className="card">
          <h3>Recent Training Pairs <span style={{fontSize:11,color:'var(--text-dim)',fontWeight:400}}>— last 24 hours of data</span></h3>
          <div className="table-wrap">
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead><tr style={{color:'var(--text-dim)',textAlign:'left'}}>
                <th style={{padding:'6px 10px'}}>Hour</th><th style={{padding:'6px 10px',textAlign:'right'}}>Radiation</th>
                <th style={{padding:'6px 10px',textAlign:'right'}}>Production</th><th style={{padding:'6px 10px',textAlign:'right'}}>Factor</th>
              </tr></thead>
              <tbody>{model.recentPairs.map((r,i)=>(
                <tr key={i} style={{background:i%2===0?'var(--bg-card2)':'transparent'}}>
                  <td style={{padding:'6px 10px',color:'var(--text-dim)',fontSize:11}}>{new Date(r.hour).toLocaleString()}</td>
                  <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace'}}>{fmt(r.radiation,0)} W/m²</td>
                  <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace'}}>{fmt(r.production,1)} W</td>
                  <td style={{padding:'6px 10px',textAlign:'right',fontFamily:'monospace',color:'var(--accent2)'}}>×{fmt(r.factor,4)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>}
      </>}
    </div>
  );
}
