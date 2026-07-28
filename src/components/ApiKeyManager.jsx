import React, { useState, useEffect } from 'react';

export default function ApiKeyManager({ apiFetch }) {
  const [keys, setKeys] = useState([]);
  const [newName, setNewName] = useState('');
  const [createdKey, setCreatedKey] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { loadKeys(); }, [apiFetch]);

  async function loadKeys() {
    try { setKeys(await apiFetch('/auth/apikeys')); } catch {}
  }

  async function createKey(e) {
    e.preventDefault(); setError('');
    try {
      const result = await apiFetch('/auth/apikeys', { method:'POST', body:JSON.stringify({name:newName}) });
      setCreatedKey(result.key);
      setNewName(''); loadKeys();
    } catch(err) { setError(err.message); }
  }

  async function deleteKey(id) {
    try { await apiFetch(`/auth/apikeys/${id}`, { method:'DELETE' }); loadKeys(); }
    catch(err) { setError(err.message); }
  }

  return (
    <div className="card">
      <h2>API Keys</h2>
      <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>
        Create read-only API keys for external access. Pass via <code style={{background:'var(--bg-card2)',padding:'2px 6px',borderRadius:3}}>X-API-Key</code> header.
        See <a href="/apidocs" target="_blank" style={{color:'var(--accent2)'}}>API Docs</a> for endpoints.
      </p>
      {error && <div className="error">{error}</div>}

      {createdKey && (
        <div style={{background:'rgba(76,175,80,.15)',padding:'12px 16px',borderRadius:8,marginBottom:14,fontSize:13}}>
          <strong>New key created — copy it now, you won't see it again:</strong><br/>
          <code style={{fontSize:12,wordBreak:'break-all',userSelect:'all'}}>{createdKey}</code>
          <br/><button className="btn btn-sm" style={{marginTop:8,background:'var(--bg-card2)',color:'var(--text)'}} onClick={()=>setCreatedKey(null)}>Dismiss</button>
        </div>
      )}

      <form onSubmit={createKey} style={{display:'flex',gap:8,marginBottom:12}}>
        <input placeholder="Key name (e.g. Home Assistant)" value={newName} onChange={e=>setNewName(e.target.value)}
          style={{flex:1,padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13}} required/>
        <button className="btn btn-primary btn-sm">Create Key</button>
      </form>

      {keys.map(k=>(
        <div key={k.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 12px',background:'var(--bg-card2)',borderRadius:8,marginBottom:4}}>
          <div>
            <span style={{fontWeight:600}}>{k.name}</span>
            <span style={{fontSize:11,color:'var(--text-dim)',marginLeft:8}}>
              {new Date(k.created_at*1000).toLocaleDateString()}
            </span>
          </div>
          <button className="btn btn-danger btn-sm" onClick={()=>deleteKey(k.id)}>Revoke</button>
        </div>
      ))}
    </div>
  );
}
