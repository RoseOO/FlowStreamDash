import React, { useState, useEffect, useRef } from 'react';
import { useAuth, useLiveData } from '../App';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const HISTORY_WINDOW = 3600; // 1 hour of live data

export default function GridDetail() {
  const { apiFetch } = useAuth();
  const { gridPower } = useLiveData();
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState('1h');
  const [stats, setStats] = useState(null);

  const gridW = gridPower?.w ?? null;
  const gridV = gridPower?.v ?? null;
  const gridA = gridPower?.a ?? null;
  const gridKwh = gridPower?.kwh ?? null;

  // Fetch historical grid data
  useEffect(() => {
    const now = Math.floor(Date.now()/1000);
    const ranges = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
    const from = now - (ranges[range] || 3600);
    Promise.all([
      apiFetch(`/grid-meter/history?from=${from}&to=${now}`),
      apiFetch(`/grid-meter/stats?from=${now - 86400}&to=${now}`),
    ]).then(([rows, s]) => {
      setHistory(rows.map(r => ({
        ts: r.ts * 1000,
        watts: r.power_w,
        voltage: r.voltage_v,
        current: r.current_a,
      })));
      setStats(s);
    });
  }, [range]);

  // Append live data
  useEffect(() => {
    if (gridPower?.ts == null) return;
    setHistory(prev => {
      const pt = { ts: gridPower.ts * 1000, watts: gridPower.w, voltage: gridPower.v, current: gridPower.a };
      const next = [...prev, pt];
      const cutoff = Date.now() - (HISTORY_WINDOW * 1000);
      return next.filter(p => p.ts >= cutoff).slice(-2000);
    });
  }, [gridPower?.ts]);

  function fmt(v, d=1) { return v != null ? v.toFixed(d) : '--'; }

  return (
    <div>
      <h2 style={{marginBottom:12}}>⚡ Grid Meter — Live</h2>

      {/* Stats */}
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
          {stats?.importCost != null && <div className="sub">£{stats.importCost} cost</div>}
        </div>
      </div>

      {/* Range selector */}
      <div className="flex-row gap-sm" style={{marginBottom:12}}>
        {['1h','6h','24h','7d'].map(r => (
          <button key={r} className={`btn btn-sm ${range===r?'btn-primary':''}`}
            style={range!==r?{background:'var(--bg-card2)',color:'var(--text-dim)'}:{}}
            onClick={()=>setRange(r)}>{r}</button>
        ))}
      </div>

      {/* Charts */}
      <div className="grid-2" style={{marginBottom:16}}>
        <div className="card"><h3>Grid Power (W)</h3>
          <div className="chart-container"><ResponsiveContainer>
            <LineChart animationDuration={0} data={history}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={ts=>new Date(ts).toLocaleTimeString().slice(0,5)}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="watts" stroke="#FF9800" dot={false} strokeWidth={1.5} connectNulls={true}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>
        <div className="card"><h3>Grid Voltage (V)</h3>
          <div className="chart-container"><ResponsiveContainer>
            <LineChart animationDuration={0} data={history}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={ts=>new Date(ts).toLocaleTimeString().slice(0,5)}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}} domain={['auto','auto']}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="voltage" stroke="#4CAF50" dot={false} strokeWidth={1.5} connectNulls={true}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>
        <div className="card"><h3>Grid Current (A)</h3>
          <div className="chart-container"><ResponsiveContainer>
            <LineChart animationDuration={0} data={history}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="ts" tick={{fontSize:10,fill:'var(--text-dim)'}} tickFormatter={ts=>new Date(ts).toLocaleTimeString().slice(0,5)}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="current" stroke="#2196F3" dot={false} strokeWidth={1.5} connectNulls={true}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>
        {/* Daily import bar chart */}
        {stats?.daily && <div className="card"><h3>Daily Import (kWh)</h3>
          <div className="chart-container"><ResponsiveContainer>
            <LineChart animationDuration={0} data={stats.daily.slice(-14).map(d=>({...d,ts:d.ts*1000}))}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <YAxis tick={{fontSize:10,fill:'var(--text-dim)'}}/>
              <Tooltip contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}} />
              <Line isAnimationActive={false} type="monotone" dataKey="importKwh" stroke="#FF9800" dot={false} strokeWidth={2} connectNulls={true}/>
            </LineChart>
          </ResponsiveContainer></div>
        </div>}
      </div>
    </div>
  );
}
