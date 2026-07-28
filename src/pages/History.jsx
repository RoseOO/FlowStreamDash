import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../App';
import { FIELD_META, DISPLAY_ORDER, getFieldLabel } from '../../server/fields';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Brush } from 'recharts';
import { DAY, RANGE_OPTIONS, CHART_COLORS } from '../utils/constants';
import { fmt } from '../utils/format';
import useDevices from '../hooks/useDevices';
import DeviceSelector from '../components/DeviceSelector';
import RangeSelector from '../components/RangeSelector';

export default function History() {
  const { apiFetch } = useAuth();
  const { devices, selectedSn, setSelectedSn } = useDevices(apiFetch);
  const [range, setRange] = useState('24h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [rawData, setRawData] = useState([]);
  const [panelConfig, setPanelConfig] = useState({});
  const [loading, setLoading] = useState(false);
  const [selectedFields, setSelectedFields] = useState([361, 70, 616]);
  const [gridData, setGridData] = useState([]);
  useEffect(() => { if (selectedSn) apiFetch(`/settings/panels/${selectedSn}`).then(setPanelConfig); }, [selectedSn, apiFetch]);

  // Fetch grid meter data separately
  useEffect(() => {
    if (!selectedSn) return;
    const now = Math.floor(Date.now()/1000);
    let from, to;
    if (range === 'custom' && customFrom) {
      from = Math.floor(new Date(customFrom).getTime()/1000);
      to = customTo ? Math.floor(new Date(customTo).getTime()/1000) : now;
    } else {
      from = now - (RANGE_OPTIONS[range] || 86400); to = now;
    }
    apiFetch(`/grid-meter/history?from=${from}&to=${to}`)
      .then(rows => setGridData(rows || []))
      .catch(() => setGridData([]));
  }, [selectedSn, range, customFrom, customTo, apiFetch]);

  useEffect(() => {
    if (!selectedSn) return;
    setLoading(true);
    const now = Math.floor(Date.now()/1000);
    let from, to;
    if (range === 'custom' && customFrom) {
      from = Math.floor(new Date(customFrom).getTime()/1000);
      to = customTo ? Math.floor(new Date(customTo).getTime()/1000) : now;
    } else {
      from = now - (RANGE_OPTIONS[range] || DAY);
      to = now;
    }
    apiFetch(`/data/${selectedSn}/history?from=${from}&to=${to}&fields=${selectedFields.join(',')}`)
      .then(rows => setRawData(rows || []))
      .finally(() => setLoading(false));
  }, [selectedSn, range, selectedFields.join(','), customFrom, customTo, apiFetch]);

  // Client-side downsample: group into ~200 buckets
  const chartData = useMemo(() => {
    if (!rawData.length) return [];
    const BUCKETS = 200;
    const tsRange = rawData[rawData.length-1].ts - rawData[0].ts || 1;
    const bucketSize = Math.max(1, Math.ceil(tsRange / BUCKETS));

    const buckets = {};
    for (const row of rawData) {
      const bk = Math.floor(row.ts / bucketSize) * bucketSize;
      if (!buckets[bk]) buckets[bk] = { ts: bk * 1000, _sum: {}, _cnt: {} };
      const val = row.value_num;
      if (val == null) continue;
      const fk = `f${row.field_num}`;
      buckets[bk]._sum[fk] = (buckets[bk]._sum[fk] || 0) + val;
      buckets[bk]._cnt[fk] = (buckets[bk]._cnt[fk] || 0) + 1;
    }
    return Object.values(buckets).sort((a,b)=>a.ts-b.ts).map(b => {
      const pt = { ts: b.ts };
      for (const fk of Object.keys(b._sum)) pt[fk] = Math.round(b._sum[fk] / b._cnt[fk] * 10) / 10;
      return pt;
    });
  }, [rawData]);

  // Efficiency fields (computed): 901=Pv1Eff, 902=Pv2Eff
  const chartDataWithEff = useMemo(() => {
    const pv1Rated = parseInt(panelConfig.pv1_rated_watts) || 0;
    const pv2Rated = parseInt(panelConfig.pv2_rated_watts) || 0;
    const needsEff = selectedFields.includes(901) || selectedFields.includes(902);
    if (!needsEff) return chartData;
    return chartData.map(pt => {
      const np = { ...pt };
      if (pv1Rated && pt.f361) np.f901 = Math.round(pt.f361 / pv1Rated * 1000) / 10;
      if (pv2Rated && pt.f70) np.f902 = Math.round(pt.f70 / pv2Rated * 1000) / 10;
      return np;
    });
  }, [chartData, panelConfig, selectedFields]);

  // Merge grid data into chart data when grid field selected
  const displayData = useMemo(() => {
    let base = chartDataWithEff;
    if (selectedFields.includes(801) && gridData.length) {
      const byTs = {};
      for (const pt of base) byTs[Math.round(pt.ts/1000)] = { ...pt };
      for (const r of gridData) {
        if (!byTs[r.ts]) byTs[r.ts] = { ts: r.ts * 1000 };
        byTs[r.ts].f801 = r.power_w;
        if (r.voltage_v != null) byTs[r.ts].f802 = r.voltage_v;
        if (r.current_a != null) byTs[r.ts].f803 = r.current_a;
      }
      base = Object.values(byTs).sort((a,b) => a.ts - b.ts);
    }
    return base;
  }, [chartDataWithEff, gridData, selectedFields]);

  function toggleField(f) {
    setSelectedFields(prev => prev.includes(f)?prev.filter(x=>x!==f):[...prev,f]);
  }

  const fieldOptions = DISPLAY_ORDER.filter(f=>FIELD_META[f]&&['W','V','A','Hz','C','var'].includes(FIELD_META[f].unit));
  const pv1Rated = parseInt(panelConfig.pv1_rated_watts) || 0;
  const pv2Rated = parseInt(panelConfig.pv2_rated_watts) || 0;
  const effFields = [];
  if (pv1Rated) effFields.push({ f:901, label:'PV1 Efficiency %' });
  if (pv2Rated) effFields.push({ f:902, label:'PV2 Efficiency %' });
  // Grid meter fields
  const gridFields = [
    { f:801, label:'Grid Import (W)' },
    { f:802, label:'Grid Voltage (V)' },
    { f:803, label:'Grid Current (A)' },
  ];
  const colors = CHART_COLORS;

  return (
    <div>
      <h2 style={{marginBottom:16}}>Historical Data</h2>
      <div className="card">
        <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap',marginBottom:16}}>
          <DeviceSelector devices={devices} selectedSn={selectedSn} setSelectedSn={setSelectedSn} />
        </div>
        <RangeSelector range={range} setRange={setRange} customFrom={customFrom} setCustomFrom={setCustomFrom} customTo={customTo} setCustomTo={setCustomTo} options={['1h','6h','24h','7d','30d','90d','365d']} />
        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:16}}>
          {fieldOptions.map((f,i)=>(
            <button key={f} onClick={()=>toggleField(f)} className="btn btn-sm"
              style={{background:selectedFields.includes(f)?colors[i%colors.length]:'var(--bg-card2)',
                color:selectedFields.includes(f)?'#fff':'var(--text-dim)',opacity:selectedFields.includes(f)?1:.6}}>
              {getFieldLabel(f)}
            </button>
          ))}
          {effFields.map((e,i)=>(
            <button key={e.f} onClick={()=>toggleField(e.f)} className="btn btn-sm"
              style={{background:selectedFields.includes(e.f)?colors[(fieldOptions.length+i)%colors.length]:'var(--bg-card2)',
                color:selectedFields.includes(e.f)?'#fff':'var(--text-dim)',opacity:selectedFields.includes(e.f)?1:.6}}>
              {e.label}
            </button>
          ))}
          {gridFields.map((e,i)=>(
            <button key={e.f} onClick={()=>toggleField(e.f)} className="btn btn-sm"
              style={{background:selectedFields.includes(e.f)?colors[(fieldOptions.length+effFields.length+i)%colors.length]:'var(--bg-card2)',
                color:selectedFields.includes(e.f)?'#fff':'var(--text-dim)',opacity:selectedFields.includes(e.f)?1:.6}}>
              {e.label}
            </button>
          ))}
        </div>

        {loading?<div className="loading"><div className="spinner"></div></div>:
          displayData.length===0?<p style={{color:'var(--text-dim)',textAlign:'center',padding:40}}>No data for this period yet. Keep monitoring for a while and data will accumulate.</p>:
          <div style={{width:'100%',height:400}}>
            <ResponsiveContainer>
              <LineChart animationDuration={0} data={displayData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="ts" tick={{fontSize:11,fill:'var(--text-dim)'}}
                  tickFormatter={ts=>new Date(ts).toLocaleString().slice(0, range==='1h'?5:16)}/>
                <YAxis tick={{fontSize:11,fill:'var(--text-dim)'}}/>
                <Tooltip labelFormatter={ts=>new Date(ts).toLocaleString()}
                  contentStyle={{background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8}}/>
                <Legend/>
                {selectedFields.map((f,i)=>{
                  let label = f===901?'PV1 Efficiency %':f===902?'PV2 Efficiency %':f===801?'Grid Import (W)':f===802?'Grid Voltage (V)':f===803?'Grid Current (A)':getFieldLabel(f);
                  return <Line isAnimationActive={false} key={f} type="monotone" dataKey={`f${f}`}
                    stroke={colors[i%colors.length]} name={label} dot={false}
                    strokeWidth={1.5} connectNulls={true}/>
                })}
              <Brush dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8} tickFormatter={ts=>{const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}} />
            </LineChart>
            </ResponsiveContainer>
          </div>
        }
      </div>
    </div>
  );
}
