import React, { useState, useEffect } from 'react';
import { useAuth, useIsAdmin } from '../App';
import PanelConfig from '../components/PanelConfig';
import ApiKeyManager from '../components/ApiKeyManager';
import WeatherConfig from '../components/WeatherConfig';
import HaMqttConfig from '../components/HaMqttConfig';
import GridMeterConfig from '../components/GridMeterConfig';
import DevApiConfig from '../components/DevApiConfig';

export default function Setup({ onLogin, apiFetch }) {
  const auth = useAuth();
  const isAdmin = useIsAdmin();
  const isLoggedIn = !!auth;
  const [accountsExist, setAccountsExist] = useState(false);

  // ── Auth form (not logged in) ─────────────────────────────
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // ── EcoFlow login (logged in) ─────────────────────────────
  const [email, setEmail] = useState('');
  const [efPassword, setEfPassword] = useState('');
  const [efStatus, setEfStatus] = useState(null);
  const [efError, setEfError] = useState('');
  const [efLoading, setEfLoading] = useState(false);

  // ── Device management ─────────────────────────────────────
  const [devices, setDevices] = useState([]);
  const [newSn, setNewSn] = useState('');
  const [newName, setNewName] = useState('');
  const [devError, setDevError] = useState('');

  // ── User management ───────────────────────────────────────
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState('');
  const [newUserPw, setNewUserPw] = useState('');
  const [userMsg, setUserMsg] = useState('');
  const [userErr, setUserErr] = useState('');
  const [pwUser, setPwUser] = useState('');
  const [pwNew, setPwNew] = useState('');

  const fetch = auth?.apiFetch || apiFetch;

  useEffect(() => {
    if (isLoggedIn) { loadDevices(); loadEfStatus(); loadUsers(); }
  }, [isLoggedIn]);

  // Check if accounts exist (for hiding register link)
  useEffect(() => {
    if (!isLoggedIn) {
      fetch('/api/auth/check').then(() => setAccountsExist(true)).catch(() => {});
    }
  }, []);

  async function loadDevices() {
    try { setDevices(await auth.apiFetch('/devices')); } catch {}
  }
  async function loadEfStatus() {
    try { setEfStatus(await auth.apiFetch('/ecoflow/status')); } catch {}
  }
  async function loadUsers() {
    try { setUsers(await auth.apiFetch('/auth/users')); } catch {}
  }

  // ── Auth handlers ─────────────────────────────────────────
  async function handleAuth(e) {
    e.preventDefault(); setAuthError(''); setAuthLoading(true);
    try {
      const endpoint = mode === 'register' ? '/auth/register' : '/auth/login';
      const data = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (onLogin) onLogin(data.token);
    } catch (err) { setAuthError(err.message); }
    finally { setAuthLoading(false); }
  }

  // ── EcoFlow ───────────────────────────────────────────────
  async function handleEfLogin(e) {
    e.preventDefault(); setEfError(''); setEfLoading(true);
    try {
      await auth.apiFetch('/ecoflow/login', { method:'POST', body:JSON.stringify({ email, password:efPassword }) });
      setEfPassword(''); loadEfStatus();
    } catch (err) { setEfError(err.message); }
    finally { setEfLoading(false); }
  }

  // ── Devices ───────────────────────────────────────────────
  async function addDevice(e) {
    e.preventDefault(); setDevError('');
    try {
      await auth.apiFetch('/devices', { method:'POST', body:JSON.stringify({ sn:newSn, name:newName }) });
      setNewSn(''); setNewName(''); loadDevices();
    } catch (err) { setDevError(err.message); }
  }
  async function removeDevice(sn) {
    try { await auth.apiFetch(`/devices/${sn}`, { method:'DELETE' }); loadDevices(); }
    catch (err) { setDevError(err.message); }
  }

  // ── Users ─────────────────────────────────────────────────
  async function handleCreateUser(e) {
    e.preventDefault(); setUserErr(''); setUserMsg('');
    try {
      await auth.apiFetch('/auth/register', {
        method:'POST', body:JSON.stringify({ username:newUser, password:newUserPw }),
      });
      setUserMsg(`User "${newUser}" created.`);
      setNewUser(''); setNewUserPw(''); loadUsers();
    } catch (err) { setUserErr(err.message); }
  }
  async function handleDeleteUser(username) {
    if (!confirm(`Delete user "${username}"?`)) return;
    setUserErr('');
    try {
      await auth.apiFetch(`/auth/users/${username}`, { method:'DELETE' });
      setUserMsg(`User "${username}" deleted.`);
      loadUsers();
    } catch (err) { setUserErr(err.message); }
  }
  async function handleChangePw(e) {
    e.preventDefault(); setUserErr(''); setUserMsg('');
    try {
      await auth.apiFetch('/auth/change-password', {
        method:'POST', body:JSON.stringify({ username:pwUser, newPassword:pwNew }),
      });
      setUserMsg(`Password changed for "${pwUser}".`);
      setPwUser(''); setPwNew('');
    } catch (err) { setUserErr(err.message); }
  }

  // ── NOT LOGGED IN view ────────────────────────────────────
  if (!isLoggedIn && onLogin) {
    return (
      <div style={{ maxWidth:400, margin:'60px auto' }}>
        <div className="card">
          <h2>{mode==='register'?'Create Account':'Login'}</h2>
          {authError && <div className="error">{authError}</div>}
          <form onSubmit={handleAuth}>
            <div className="form-group"><label>Username</label><input value={username} onChange={e=>setUsername(e.target.value)} required /></div>
            <div className="form-group"><label>Password</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} required /></div>
            <button className="btn btn-primary" disabled={authLoading} style={{width:'100%'}}>
              {authLoading?'Please wait...':(mode==='register'?'Create Account':'Login')}
            </button>
          </form>
          {!accountsExist && mode === 'login' && (
            <p style={{marginTop:14,fontSize:13,color:'var(--text-dim)',textAlign:'center'}}>
              Don't have an account?{' '}<a href="#" onClick={e=>{e.preventDefault();setMode('register');setAuthError('');}}>Register</a>
            </p>
          )}
          {mode === 'register' && (
            <p style={{marginTop:14,fontSize:13,color:'var(--text-dim)',textAlign:'center'}}>
              Already have an account?{' '}<a href="#" onClick={e=>{e.preventDefault();setMode('login');setAuthError('');}}>Login</a>
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── LOGGED IN view ────────────────────────────────────────
  return (
    <div className="grid-2">
      {/* EcoFlow */}
      <div className="card">
        <h2>EcoFlow Account</h2>
        <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:16}}>Login with your EcoFlow app credentials to auto-fetch MQTT broker details.</p>
        {efStatus?.configured && (
          <div style={{background:'rgba(76,175,80,.1)',padding:'10px 14px',borderRadius:8,marginBottom:14,fontSize:13}}>
            ✅ Connected as <strong>{efStatus.email}</strong><br/>
            {efStatus.connected?'🟢 Online':'🔴 Offline'}
            {efStatus.stats&&<> — {efStatus.stats.msgCount} msgs</>}
            {efStatus.hasStoredPassword&&<><br/>🔐 Credentials stored for auto-refresh</>}
          </div>
        )}
        {efStatus?.configured && !efStatus?.hasStoredPassword && (
          <div style={{background:'rgba(255,152,0,.1)',padding:'10px 14px',borderRadius:8,marginBottom:14,fontSize:13}}>
            ⚠️ Credentials not stored. Re-enter password to enable auto-refresh.
          </div>
        )}
        {efError&&<div className="error">{efError}</div>}
        <form onSubmit={handleEfLogin}>
          <div className="form-group"><label>EcoFlow Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></div>
          <div className="form-group"><label>EcoFlow Password</label><input type="password" value={efPassword} onChange={e=>setEfPassword(e.target.value)} required/></div>
          <button className="btn btn-primary" disabled={efLoading}>{efLoading?'Connecting...':'Fetch MQTT Credentials'}</button>
        </form>
      </div>

      {/* Developer API */}
      <div className="card">
        <h2>Developer API</h2>
        <DevApiConfig apiFetch={auth.apiFetch} />
      </div>

      {/* Devices */}
      <div className="card">
        <h2>Devices ({devices.length})</h2>
        {devError&&<div className="error">{devError}</div>}
        <form onSubmit={addDevice} style={{display:'flex',gap:8,marginBottom:16}}>
          <input placeholder="Serial Number" value={newSn} onChange={e=>setNewSn(e.target.value)}
            style={{flex:1,padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13}} required/>
          <input placeholder="Name" value={newName} onChange={e=>setNewName(e.target.value)}
            style={{width:120,padding:'8px 12px',background:'var(--bg-card2)',border:'1px solid var(--border)',borderRadius:8,color:'var(--text)',fontSize:13}}/>
          <button className="btn btn-primary btn-sm">Add</button>
        </form>
        {devices.length===0&&<p style={{color:'var(--text-dim)',fontSize:13}}>No devices yet.</p>}
        {devices.map(d=>(
          <div key={d.sn} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',background:'var(--bg-card2)',borderRadius:8,marginBottom:6}}>
            <div><div style={{fontWeight:600}}>{d.name||d.sn}</div><div style={{fontSize:12,color:'var(--text-dim)',fontFamily:'monospace'}}>{d.sn}</div></div>
            <button className="btn btn-danger btn-sm" onClick={()=>removeDevice(d.sn)}>Remove</button>
          </div>
        ))}
      </div>

      {/* Weather Location */}
      <div className="card">
        <h2>Weather Location</h2>
        <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>Set your latitude/longitude for cloud cover data and generation forecasts.</p>
        <WeatherConfig apiFetch={auth.apiFetch} />
      </div>

      {/* Panel Wattage Config */}
      <div className="card">
        <h2>Panel Configuration</h2>
        <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>Set rated panel wattage per device for efficiency calculations.</p>
        {devices.length === 0 && <p style={{color:'var(--text-dim)',fontSize:13}}>Add a device first.</p>}
        {devices.map(d => (
          <div key={d.sn} style={{marginBottom:16,padding:'10px 14px',background:'var(--bg-card2)',borderRadius:8}}>
            <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>{d.name || d.sn}</div>
            <PanelConfig apiFetch={auth.apiFetch} sn={d.sn} />
          </div>
        ))}
      </div>

      {/* Home Assistant MQTT Bridge */}
      <div className="card">
        <h2>Home Assistant MQTT</h2>
        <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>Publish live sensor data to your local MQTT broker. Sensors auto-discover in Home Assistant.</p>
        <HaMqttConfig apiFetch={auth.apiFetch} />
      </div>

      {/* Grid Meter (ESPHome) */}
      <div className="card">
        <h2>Grid Meter</h2>
        <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>Connect an ESPHome Sonoff POW Ring to get real grid import/export data for accurate savings.</p>
        <GridMeterConfig apiFetch={auth.apiFetch} />
      </div>

      {/* User Management (admin only) */}
      {isAdmin && (
        <>
          <div className="card">
            <h2>Create User</h2>
            {userErr&&<div className="error">{userErr}</div>}
            {userMsg&&<div style={{background:'rgba(76,175,80,.1)',padding:'10px 14px',borderRadius:8,marginBottom:14,fontSize:13}}>✅ {userMsg}</div>}
            <form onSubmit={handleCreateUser}>
              <div className="form-group"><label>Username</label><input value={newUser} onChange={e=>setNewUser(e.target.value)} required/></div>
              <div className="form-group"><label>Password</label><input type="password" value={newUserPw} onChange={e=>setNewUserPw(e.target.value)} required/></div>
              <button className="btn btn-primary">Create User</button>
            </form>
          </div>

          <div className="card">
            <h2>Manage Users</h2>
            <h3>Change Password</h3>
            <form onSubmit={handleChangePw} style={{marginBottom:16,display:'flex',gap:8,alignItems:'flex-end'}}>
              <div className="form-group" style={{flex:1,marginBottom:0}}><label>Username</label><input value={pwUser} onChange={e=>setPwUser(e.target.value)} required/></div>
              <div className="form-group" style={{flex:1,marginBottom:0}}><label>New Password</label><input type="password" value={pwNew} onChange={e=>setPwNew(e.target.value)} required/></div>
              <button className="btn btn-primary btn-sm">Change</button>
            </form>
            <h3>Users ({users.length})</h3>
            {users.map(u=>(
              <div key={u.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 12px',background:'var(--bg-card2)',borderRadius:8,marginBottom:4}}>
                <div>
                  <span style={{fontWeight:600}}>{u.username}</span>
                  {u.is_admin?<span style={{fontSize:11,color:'var(--accent2)',marginLeft:6}}>admin</span>:null}
                </div>
                {!u.is_admin&&<button className="btn btn-danger btn-sm" onClick={()=>handleDeleteUser(u.username)}>Delete</button>}
              </div>
            ))}
          </div>

          <ApiKeyManager apiFetch={auth.apiFetch} />

          <div className="card">
            <h2>Backup & Restore</h2>
            <p style={{fontSize:13,color:'var(--text-dim)',marginBottom:12}}>Download the full database or restore from a backup file. Restoring will replace all data and restart the MQTT connection.</p>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              <button className="btn btn-primary btn-sm" onClick={async () => {
                try {
                  const token = localStorage.getItem('ecoflow_token');
                  const res = await window.fetch('/api/db/export', { headers: { Authorization: `Bearer ${token}` } });
                  if (!res.ok) { const e = await res.json().catch(()=>({})); alert('Download failed: ' + (e.error || res.statusText)); return; }
                  const b = await res.blob();
                  const url = URL.createObjectURL(b);
                  const a = document.createElement('a'); a.href = url;
                  a.download = `ecoflow_backup_${new Date().toISOString().slice(0,10)}.db`;
                  document.body.appendChild(a); a.click(); document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                } catch (err) { alert('Download failed: ' + err.message); }
              }}>Download Backup</button>
              <label className="btn btn-sm" style={{background:'var(--bg-card2)',color:'var(--text)',cursor:'pointer',padding:'6px 12px',borderRadius:8,fontSize:12}}>
                Restore Backup
                <input type="file" accept=".db" style={{display:'none'}} onChange={async e => {
                  const file = e.target.files[0];
                  if (!file || !confirm(`Replace ALL data with "${file.name}"? This cannot be undone.`)) return;
                  try {
                    const token = localStorage.getItem('ecoflow_token');
                    const buf = await file.arrayBuffer();
                    const res = await window.fetch('/api/db/import', {
                      method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/octet-stream'},
                      body: new Uint8Array(buf),
                    });
                    if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
                    alert('Database restored. You may need to reload the page.');
                    window.location.reload();
                  } catch (err) { alert('Restore failed: ' + err.message); }
                }}/>
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
