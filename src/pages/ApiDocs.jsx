import React, { useState } from 'react';

const ENDPOINTS = [
  { method:'GET', path:'/api/public/devices', desc:'All devices with latest labeled values + efficiency.' },
  { method:'GET', path:'/api/public/device/:sn/latest', desc:'Latest labeled values for one device.' },
  { method:'GET', path:'/api/public/device/:sn/history', params:'from=&to=&fields=', desc:'Historical time-series (unix ts, labeled fields).' },
  { method:'GET', path:'/api/public/device/:sn/stats', params:'from=&to=', desc:'Stats: daily kWh, hourly profile, daylight, efficiency.' },
  { method:'GET', path:'/api/public/device/:sn/pr', params:'from=&to=', desc:'Performance Ratio (PR) — actual vs expected kWh.' },
  { method:'GET', path:'/api/public/device/:sn/quality', desc:'Data quality: uptime %, gen hours, coverage.' },
  { method:'GET', path:'/api/public/device/:sn/degradation', desc:'Monthly avg/peak efficiency over time.' },
  { method:'GET', path:'/api/public/device/:sn/daylight', params:'from=&to=', desc:'Gen window (to the minute), daylight eff, avg power.' },
  { method:'GET', path:'/api/public/weather', desc:'Hourly cloud cover %, radiation W/m² for today.' },
  { method:'GET', path:'/api/public/device/:sn/model', desc:'AI model: learned factor, training pairs, accuracy.' },
  { method:'GET', path:'/api/public/savings/:sn', params:'from=&to=', desc:'Savings: kWh produced × rate = £ saved.' },
  { method:'GET', path:'/api/public/savings/aggregate', params:'from=&to=', desc:'Aggregate savings across all devices.' },
  { method:'GET', path:'/api/public/export/:sn', params:'from=&to=', desc:'CSV export with labeled columns.' },
];

export default function ApiDocs() {
  const [apiKey, setApiKey] = useState('');
  const [selectedEp, setSelectedEp] = useState(0);
  const [customSn, setCustomSn] = useState('BK01Z1S3CH1B0662');
  const [customParams, setCustomParams] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function testEndpoint() {
    setLoading(true); setError(''); setResult(null);
    try {
      let url = ENDPOINTS[selectedEp].path.replace(':sn', customSn);
      const params = customParams || ENDPOINTS[selectedEp].params || '';
      if (params) {
        // Replace template params with actual values
        let p = params;
        const now = Math.floor(Date.now()/1000);
        p = p.replace('from=', `from=${now-86400*7}`);
        p = p.replace('to=', `to=${now}`);
        if (!p.includes('from=')) p = `from=${now-86400}&to=${now}`;
        url += (url.includes('?') ? '&' : '?') + p;
      }
      const headers = apiKey ? { 'X-API-Key': apiKey } : {};
      const res = await fetch(url, { headers });
      const ct = res.headers.get('content-type')||'';
      const data = ct.includes('json') ? await res.json() : await res.text();
      setResult({ status: res.status, data });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  return (
    <div>
      <h2 style={{marginBottom:8}}>API Documentation & Tester</h2>
      <p style={{color:'var(--text-dim)',fontSize:13,marginBottom:20}}>
        All endpoints accept <code>X-API-Key</code> header. Create keys in <a href="/setup">Setup → API Keys</a>.
        Base: <code>http://your-server:3000</code>
      </p>

      {/* API Tester */}
      <div className="card" style={{marginBottom:16}}>
        <h3>🧪 API Tester</h3>
        <div className="flex-row gap-sm" style={{marginBottom:10,flexWrap:'wrap'}}>
          <select value={selectedEp} onChange={e=>setSelectedEp(parseInt(e.target.value))}
            style={{padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13,flex:1,minWidth:200}}>
            {ENDPOINTS.map((e,i)=><option key={i} value={i}>{e.method} {e.path}</option>)}
          </select>
          <input placeholder="API Key (optional)" value={apiKey} onChange={e=>setApiKey(e.target.value)}
            style={{padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13,width:200}}/>
          <button className="btn btn-primary btn-sm" onClick={testEndpoint} disabled={loading}>
            {loading?'Testing...':'Send'}
          </button>
        </div>
        <div className="flex-row gap-sm" style={{flexWrap:'wrap'}}>
          <input placeholder="Device SN" value={customSn} onChange={e=>setCustomSn(e.target.value)}
            style={{padding:'6px 10px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontSize:12,width:180}}/>
          <input placeholder="Custom params (e.g. from=123&to=456)" value={customParams} onChange={e=>setCustomParams(e.target.value)}
            style={{padding:'6px 10px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text)',fontSize:12,flex:1,minWidth:200}}/>
        </div>
        {error && <div className="error" style={{marginTop:10}}>{error}</div>}
        {result && (
          <div style={{marginTop:10}}>
            <div style={{fontSize:12,marginBottom:6}}>
              Status: <span style={{color:result.status===200?'var(--accent)':'var(--danger)',fontWeight:600}}>{result.status}</span>
            </div>
            <pre style={{background:'var(--bg-card2)',padding:12,borderRadius:8,fontSize:11,overflow:'auto',maxHeight:400,color:'var(--text)',whiteSpace:'pre-wrap'}}>
              {typeof result.data === 'string' ? result.data.substring(0, 2000) : JSON.stringify(result.data, null, 2).substring(0, 5000)}
            </pre>
          </div>
        )}
      </div>

      {/* Endpoints Reference */}
      <div className="card">
        <h3>All Endpoints</h3>
        {ENDPOINTS.map((e,i)=>(
          <div key={i} style={{padding:'12px 14px',marginBottom:4,background:i%2===0?'var(--bg-card2)':'transparent',borderRadius:8}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
              <span style={{fontWeight:700,color:'var(--accent2)',fontSize:12,minWidth:36}}>{e.method}</span>
              <code style={{fontSize:12,color:'var(--text)'}}>{e.path}</code>
            </div>
            <p style={{fontSize:12,color:'var(--text-dim)',margin:0,paddingLeft:46}}>{e.desc}</p>
            {e.params && <p style={{fontSize:11,color:'var(--text-dim)',margin:'4px 0 0',paddingLeft:46}}>Query: <code>{e.params}</code></p>}
          </div>
        ))}
      </div>
    </div>
  );
}
