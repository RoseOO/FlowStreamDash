import React, { useState, useEffect, useMemo } from 'react';
import { useAuth, useLiveData } from '../App';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush, AreaChart, Area } from 'recharts';

const DAY = 86400;

export default function GridDetail() {
  const { apiFetch } = useAuth();
  const { gridPower } = useLiveData();
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState('1h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [stats, setStats] = useState(null);

  const gridW = gridPower?.w ?? null;
  const gridV = gridPower?.v ?? null;
  const gridA = gridPower?.a ?? null;
  const gridKwh = gridPower?.kwh ?? null;

  const RANGES = { '1h':3600, '6h':21600, '24h':DAY, '7d':7*DAY, '30d':30*DAY, '90d':90*DAY };

  function getFromTo() {
    const now = Math.floor(Date.now()/1000);
    if (range === 'custom' && customFrom) {
      return {
        from: Math.floor(new Date(customFrom).getTime()/1000),
        to: customTo ? Math.floor(new Date(customTo).getTime()/1000) : now,
      };
    }
    return { from: now - (RANGES[range] || 3600), to: now };
  }

  // Fetch historical data
  useEffect(() => {
    const { from, to } = getFromTo();
    Promise.all([
      apiFetch(`/grid-meter/history?from=${from}&to=${to}`).catch(() => []),
      apiFetch(`/grid-meter/stats?from=${from}&to=${to}`).catch(() => null),
    ]).then(([rows, s]) => {
      setHistory(rows.map(r => ({
        ts: r.ts * 1000,
        watts: r.power_w,
        voltage: r.voltage_v,
        current: r.current_a,
        energy: r.energy_kwh,
      })));
      setStats(s);
    });
  }, [range, customFrom, customTo, apiFetch]);

  // Append live data for short ranges
  useEffect(() => {
    if (gridPower?.ts == null) return;
    const { from } = getFromTo();
    const lookback = (Date.now() / 1000) - from;
    setHistory(prev => {
      const pt = {
        ts: gridPower.ts * 1000,
        watts: gridPower.w,
        voltage: gridPower.v,
        current: gridPower.a,
        energy: gridPower.kwh,
      };
      const next = [...prev, pt];
      const cutoff = Date.now() - (lookback * 1000);
      return next.filter(p => p.ts >= cutoff).slice(-5000);
    });
  }, [gridPower?.ts, range, customFrom, customTo]);

  // Downsample for large datasets
  const displayData = useMemo(() => {
    if (history.length <= 400) return history;
    const BUCKETS = 400;
    const tsRange = history[history.length-1].ts - history[0].ts || 1;
    const bucketSize = Math.max(1, Math.ceil(tsRange / BUCKETS));
    const buckets = {};
    for (const pt of history) {
      const bk = Math.floor(pt.ts / bucketSize) * bucketSize;
      if (!buckets[bk]) buckets[bk] = { ts: bk, watts:0, voltage:0, current:0, energy:0, _n:0 };
      buckets[bk].watts += pt.watts || 0;
      buckets[bk].voltage += pt.voltage || 0;
      buckets[bk].current += pt.current || 0;
      buckets[bk].energy = pt.energy;
      buckets[bk]._n++;
    }
    return Object.values(buckets).sort((a,b)=>a.ts-b.ts).map(b => ({
      ts: b.ts,
      watts: Math.round(b.watts / b._n),
      voltage: Math.round(b.voltage / b._n * 10) / 10,
      current: Math.round(b.current / b._n * 100) / 100,
      energy: b.energy,
    }));
  }, [history]);

  function fmt(v, d=1) { return v != null ? v.toFixed(d) : '--'; }
  function tsToShort(ts) {
    const d = new Date(ts);
    if (range === '1h' || range === '6h') return d.toLocaleTimeString().slice(0,5);
    if (range === '24h') return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    return d.toLocaleDateString([],{month:'short',day:'numeric'});
  }

  const importCost = stats?.importCost;
  const dailyArr = stats?.daily || [];

  return (
    <div>
      <h2 style={{marginBottom:12}}>⚡ Grid Meter</h2>

      {/* Live stats */}
      <div className="grid-4" style={{marginBottom:12}}>
        <div className="stat-card" style={{textAlign:'center'}}>
          <div className="label">Import Power</div>
          <div className="value" style={{color:gridW>5?'var(--warn)':'var(--accent)'}}>{fmt(gridW,0)}<span className="unit">W</span></div>
        </div>
        <div className="stat-card" style={{textAlign:'center'}}>
          <div className="label">Voltage</div>
          <div className="value">{fmt(gridV,0)}<span className="unit">V</span></div>
        </div>
        <div className="stat-card" style={{textAlign:'center'}}>
          <div className="label">Current</div>
          <div className="value">{fmt(gridA,1)}<span className="unit">A</span></div>
        </div>
        <div className="stat-card" style={{textAlign:'center'}}>
          <div className="label">Today Import</div>
          <div className="value">{fmt(gridKwh,2)}<span className="unit">kWh</span></div>
          {importCost != null && <div className="sub">£{importCost} cost</div>}
        </div>
      </div>

      {/* Range selector */}
      <div className="flex-row gap-sm" style={{marginBottom:12}}>
        {['1h','6h','24h','7d','30d','90d'].map(r => (
          <button key={r} className={`btn btn-sm ${range===r?'btn-primary':''}`}
            style={range!==r?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}}
            onClick={()=>setRange(r)}>{r}</button>
        ))}
        <button className={`btn btn-sm ${range==='custom'?'btn-primary':''}`}
          style={range!=='custom'?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}}
          onClick={()=>setRange('custom')}>Custom</button>
      </div>

      {range === 'custom' && (
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:12}}>
          <input type="datetime-local" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}
            style={{padding:'6px 10px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontSize:12}}/>
          <span style={{color:'var(--text-dim)',fontSize:12}}>to</span>
          <input type="datetime-local" value={customTo} onChange={e=>setCustomTo(e.target.value)}
            style={{padding:'6px 10px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontSize:12}}/>
        </div>
      )}

      {/* Charts */}
      <div className="grid-2" style={{marginBottom:16}}>
        {/* Power chart */}
        <div className="card"><h3>Grid Power (W)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <LineChart animationDuration={0} data={displayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={tsToShort}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleString()}
                contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="watts" stroke="#FF9800" dot={false} strokeWidth={1.5} connectNulls={true} name="Grid Power"/>
              <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}
                tickFormatter={ts=>tsToShort(ts)}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>

        {/* Voltage chart */}
        <div className="card"><h3>Grid Voltage (V)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <LineChart animationDuration={0} data={displayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={tsToShort}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}} domain={['auto','auto']}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleString()}
                contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="voltage" stroke="#4CAF50" dot={false} strokeWidth={1.5} connectNulls={true} name="Voltage"/>
              <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}
                tickFormatter={ts=>tsToShort(ts)}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>

        {/* Current chart */}
        <div className="card"><h3>Grid Current (A)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <LineChart animationDuration={0} data={displayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={tsToShort}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleString()}
                contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="current" stroke="#2196F3" dot={false} strokeWidth={1.5} connectNulls={true} name="Current"/>
              <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}
                tickFormatter={ts=>tsToShort(ts)}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>

        {/* Energy stacked area */}
        <div className="card"><h3>Cumulative Energy (kWh)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <AreaChart animationDuration={0} data={displayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={tsToShort}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleString()}
                contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Area isAnimationActive={false} type="stepAfter" dataKey="energy" stroke="#9C27B0" fill="#9C27B0" fillOpacity={0.15} strokeWidth={1.5} connectNulls={true} name="kWh"/>
              <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}
                tickFormatter={ts=>tsToShort(ts)}/>
            </AreaChart>
          </ResponsiveContainer></div>
        </div>
      </div>

      {/* Daily import chart */}
      {dailyArr.length > 0 && (
        <div className="card" style={{marginBottom:16}}>
          <h3>Daily Import (kWh)</h3>
          <div style={{width:'100%',height:300}}><ResponsiveContainer>
            <LineChart animationDuration={0} data={dailyArr.slice(-30)}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip labelFormatter={ts=>new Date(ts).toLocaleDateString()}
                contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="importKwh" stroke="#FF9800" dot={false} strokeWidth={2} connectNulls={true} name="Import kWh"/>
              <Brush dataKey="date" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>
      )}

      {/* Summary stats */}
      {stats && !stats.error && (
        <div className="grid-2" style={{marginBottom:16}}>
          <div className="card">
            <h3>Period Summary</h3>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              {stats.totalImportKwh != null && <div className="stat-card"><div className="label">Total Import</div><div className="value">{fmt(stats.totalImportKwh,2)}kWh</div></div>}
              {stats.totalExportKwh != null && <div className="stat-card"><div className="label">Total Export</div><div className="value">{fmt(stats.totalExportKwh,2)}kWh</div></div>}
              {stats.peakImportW != null && <div className="stat-card"><div className="label">Peak Import</div><div className="value">{stats.peakImportW}W</div></div>}
              {stats.sampleCount != null && <div className="stat-card"><div className="label">Sample Count</div><div className="value">{stats.sampleCount}</div></div>}
              {importCost != null && <div className="stat-card"><div className="label">Import Cost</div><div className="value" style={{color:'var(--warn)'}}>£{importCost}</div></div>}
              {stats.exportValue != null && <div className="stat-card"><div className="label">Export Value</div><div className="value" style={{color:'var(--accent)'}}>£{stats.exportValue}</div></div>}
              {stats.rate != null && <div className="stat-card"><div className="label">Rate</div><div className="value">£{stats.rate}/kWh</div></div>}
              {stats.netCost != null && <div className="stat-card"><div className="label">Net Cost</div><div className="value" style={{color:stats.netCost>0?'var(--warn)':'var(--accent)'}}>£{stats.netCost}</div></div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
