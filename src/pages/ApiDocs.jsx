import React from 'react';

const ENDPOINTS = [
  { method:'GET', path:'/api/public/devices',
    desc:'List all devices with latest labeled values, computed efficiency, and panel config.' },
  { method:'GET', path:'/api/public/device/:sn/latest',
    desc:'Latest values for a single device with labeled field names (e.g. PV1_Power_W, Grid_Voltage_V).' },
  { method:'GET', path:'/api/public/device/:sn/history?from=&to=&fields=',
    desc:'Historical time-series data. Timestamps ISO 8601, values labeled. Optional from/to (unix seconds) and fields (comma-separated field numbers).' },
  { method:'GET', path:'/api/public/device/:sn/stats?from=&to=',
    desc:'Statistics: daily production, hourly generation profile, peak hours, daylight efficiency, panel efficiency.' },
  { method:'GET', path:'/api/public/savings/:sn?from=&to=',
    desc:'Savings calculation: total kWh produced x electricity rate = £ saved. Includes rate info and period.' },
  { method:'GET', path:'/api/public/savings/aggregate?from=&to=',
    desc:'Aggregate savings across all devices. Same format as per-device savings.' },
  { method:'GET', path:'/api/public/export/:sn?from=&to=',
    desc:'CSV export with labeled column headers. Same format as the web UI export.' },
];

const FIELD_REFERENCE = [
  ['PV1_Power_W','PV1 Voltage','V'],
  ['PV1_Voltage_V','PV1 Voltage','V'],
  ['PV1_Current_A','PV1 Current','A'],
  ['PV2_Power_W','PV2 Power','W'],
  ['PV2_Voltage_V','PV2 Voltage','V'],
  ['PV2_Current_A','PV2 Current','A'],
  ['Grid_Power_W','Grid Power (positive=import negative=export)','W'],
  ['Grid_Voltage_V','Grid Voltage','V'],
  ['Grid_Current_A','Grid Current','A'],
  ['Grid_Frequency_Hz','Grid Frequency','Hz'],
  ['Inverter_Temp_C','Inverter Temperature','C'],
  ['WiFi_RSSI_dBm','WiFi Signal Strength','dBm'],
  ['PV1_Efficiency_Pct','PV1 Efficiency (computed)','%'],
  ['PV2_Efficiency_Pct','PV2 Efficiency (computed)','%'],
];

export default function ApiDocs() {
  return (
    <div>
      <h2 style={{marginBottom:8}}>API Documentation</h2>
      <p style={{color:'var(--text-dim)',fontSize:13,marginBottom:20}}>
        All endpoints require an <code style={{background:'var(--bg-card2)',padding:'2px 6px',borderRadius:3}}>X-API-Key</code> header.
        Create keys in <a href="/setup" style={{color:'var(--accent2)'}}>Setup → API Keys</a> (admin only).
        Base URL: <code>http://your-server:3000</code>
      </p>

      <div className="card" style={{marginBottom:16}}>
        <h3>Endpoints</h3>
        {ENDPOINTS.map((e,i)=>(
          <div key={i} style={{padding:'12px 14px',marginBottom:4,background:i%2===0?'var(--bg-card2)':'transparent',borderRadius:8}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
              <span style={{fontWeight:700,color:'var(--accent2)',fontSize:12,minWidth:36}}>{e.method}</span>
              <code style={{fontSize:12,color:'var(--text)'}}>{e.path}</code>
            </div>
            <p style={{fontSize:12,color:'var(--text-dim)',margin:0,paddingLeft:46}}>{e.desc}</p>
          </div>
        ))}
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3>Example Usage</h3>
        <pre style={{background:'var(--bg-card2)',padding:16,borderRadius:8,fontSize:12,overflow:'auto',color:'var(--text)'}}>{`# Get all devices with live data
curl -H "X-API-Key: ef_yourkeyhere" \\
  http://localhost:3000/api/public/devices

# Get historical data (last 24 hours)
curl -H "X-API-Key: ef_yourkeyhere" \\
  "http://localhost:3000/api/public/device/BK01.../history?from=$(date -d '24 hours ago' +%s)"

# Get savings for last 30 days
curl -H "X-API-Key: ef_yourkeyhere" \\
  "http://localhost:3000/api/public/savings/BK01...?from=$(date -d '30 days ago' +%s)"`}</pre>
      </div>

      <div className="card">
        <h3>Response Fields</h3>
        <p style={{fontSize:12,color:'var(--text-dim)',marginBottom:12}}>
          All API responses use snake_case labeled field names with unit suffixes.
          Field numbers from the raw MQTT protocol are never exposed through the public API.
        </p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))',gap:'4px 20px',fontSize:12}}>
          {FIELD_REFERENCE.map(([key,desc,unit])=>(
            <div key={key} style={{display:'flex',justifyContent:'space-between',padding:'4px 8px',borderRadius:4}}>
              <code style={{color:'var(--accent2)'}}>{key}</code>
              <span style={{color:'var(--text-dim)'}}>{desc} ({unit})</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
