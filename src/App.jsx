import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import DeviceDetail from './pages/DeviceDetail';
import History from './pages/History';
import Savings from './pages/Savings';
import Export from './pages/Export';
import Stats from './pages/Stats';
import ApiDocs from './pages/ApiDocs';
import Model from './pages/Model';
import Setup from './pages/Setup';

// ── Auth Context ────────────────────────────────────────────
const AuthContext = createContext(null);
export function useAuth() { return useContext(AuthContext); }

// ── Live Data Context ───────────────────────────────────────
const LiveContext = createContext(null);
export function useLiveData() { return useContext(LiveContext); }

// ── Admin Context ───────────────────────────────────────────
const AdminContext = createContext(false);
export function useIsAdmin() { return useContext(AdminContext); }

const API = '/api';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('ecoflow_token'));
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [liveData, setLiveData] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('ecoflow_theme') || 'dark');
  const [alerts, setAlerts] = useState([]);
  const wsRef = useRef(null);

  // Theme toggle
  const toggleTheme = useCallback(() => {
    setTheme(prev => { const t = prev === 'dark' ? 'light' : 'dark'; localStorage.setItem('ecoflow_theme', t); return t; });
  }, []);
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  // Request notification permission (non-blocking)
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Auth helpers
  const login = useCallback((t) => { localStorage.setItem('ecoflow_token', t); setToken(t); }, []);
  const logout = useCallback(() => { localStorage.removeItem('ecoflow_token'); setToken(null); }, []);

  const apiFetch = useCallback(async (path, opts = {}) => {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || res.statusText); }
    // Handle CSV (text) vs JSON
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }, [token, logout]);

  // Verify token on startup
  useEffect(() => {
    if (!token) { setLoading(false); return; }
    fetch('/api/auth/check', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.valid) setIsAdmin(d.is_admin); setLoading(false); })
      .catch(() => { logout(); setLoading(false); });
  }, []);

  // WebSocket for live data
  useEffect(() => {
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') setConnected(msg.connected);
        if (msg.type === 'data' && msg.sn && msg.fields) {
          setLiveData(prev => {
            const prevDev = prev[msg.sn] || {};
            return { ...prev, [msg.sn]: { ...prevDev, ...msg.fields, _ts: msg.ts, _idle: msg.idle || false } };
          });
        }
        if (msg.type === 'alert' && msg.message) {
          // Browser notification
          if (Notification.permission === 'granted') {
            new Notification('EcoFlow Alert', { body: msg.message, icon: '/icon.svg' });
          }
          setAlerts(prev => [...prev.slice(-4), { ...msg, ts: Date.now() }]);
        }
      } catch {}
    };
    ws.onclose = () => setConnected(false);
    return () => ws.close();
  }, [token]);

  if (loading) return <div className="loading"><div className="spinner"></div><p>Loading...</p></div>;

  if (!token) {
    return (
      <div className="app-layout">
        <div className="content">
          <Setup onLogin={login} apiFetch={apiFetch} />
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ token, login, logout, apiFetch }}>
      <AdminContext.Provider value={isAdmin}>
      <LiveContext.Provider value={{ connected, liveData }}>
        <div className="app-layout">
          <nav className="navbar">
            <span className="logo">⚡ EcoFlow</span>
            <span className={`status-dot ${connected ? 'on' : 'off'}`} title={connected ? 'Connected' : 'Disconnected'}></span>
            {alerts.length > 0 && <button className="theme-btn" title={`${alerts.length} alerts`} onClick={() => setAlerts([])}
              style={{color:'var(--warn)',fontWeight:700}}>⚠{alerts.length}</button>}
            <button className="theme-btn" onClick={toggleTheme} title="Toggle theme">{theme==='dark'?'☀':'🌙'}</button>
            <div className="nav-links">
              <NavLink to="/">Dashboard</NavLink>
              <NavLink to="/history">History</NavLink>
              <NavLink to="/savings">Savings</NavLink>
              <NavLink to="/stats">Stats</NavLink>
            <NavLink to="/apidocs">API</NavLink>
            <NavLink to="/model">Model</NavLink>
            <NavLink to="/export">Export</NavLink>
              <NavLink to="/setup">Setup</NavLink>
            </div>
            <button className="btn btn-sm btn-danger hide-mobile" onClick={logout}>Logout</button>
            <button className="hamburger" onClick={() => setMenuOpen(!menuOpen)}>
              {menuOpen ? '✕' : '☰'}
            </button>
          </nav>

          {menuOpen && (
            <div className={`mobile-menu ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
              <div className="menu-section">Navigation</div>
              <NavLink to="/">Dashboard</NavLink>
              <NavLink to="/history">History</NavLink>
              <NavLink to="/savings">Savings</NavLink>
              <NavLink to="/stats">Stats</NavLink>
              <NavLink to="/model">AI Model</NavLink>
              <NavLink to="/export">Export</NavLink>
              <NavLink to="/apidocs">API Docs</NavLink>
              <div className="menu-section">Settings</div>
              <NavLink to="/setup">Setup</NavLink>
              <button onClick={logout} style={{color:'var(--danger)',marginTop:8}}>Logout</button>
            </div>
          )}

          <div className="content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/device/:sn" element={<DeviceDetail />} />
              <Route path="/history" element={<History />} />
              <Route path="/savings" element={<Savings />} />
              <Route path="/export" element={<Export />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/apidocs" element={<ApiDocs />} />
              <Route path="/model" element={<Model />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </LiveContext.Provider>
      </AdminContext.Provider>
    </AuthContext.Provider>
  );
}
