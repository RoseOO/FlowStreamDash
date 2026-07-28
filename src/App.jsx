import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import DeviceDetail from './pages/DeviceDetail';
import History from './pages/History';
import Savings from './pages/Savings';
import Export from './pages/Export';
import Stats from './pages/Stats';
import ApiDocs from './pages/ApiDocs';
import Model from './pages/Model';
import GridDetail from './pages/GridDetail';
import LiveDisplay from './pages/LiveDisplay';
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
  const [gridPower, setGridPower] = useState(null);
  const routerLoc = useLocation();
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
    let ws = null;
    let reconnectTimer = null;
    let reconnectDelay = 1000;

    function connect() {
      if (!token) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay = 1000; // reset on successful connect
      };

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
          if (msg.type === 'devapi' && msg.sn && msg.fields) {
            setLiveData(prev => {
              const prevDev = prev[msg.sn] || {};
              const devFields = {};
              for (const [key, val] of Object.entries(msg.fields)) {
                devFields['_dev_' + key] = val;
              }
              return { ...prev, [msg.sn]: { ...prevDev, ...devFields, _ts: msg.ts } };
            });
          }
          if (msg.type === 'alert' && msg.message) {
            if (Notification.permission === 'granted') {
              new Notification('EcoFlow Alert', { body: msg.message, icon: '/icon.svg' });
            }
            setAlerts(prev => [...prev.slice(-4), { ...msg, ts: Date.now() }]);
          }
          if (msg.type === 'grid' && msg.power_w != null) {
            setGridPower({ w: msg.power_w, kwh: msg.energy_kwh, ts: msg.ts, v: msg.voltage_v, a: msg.current_a });
          }
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        // Auto-reconnect with backoff (1s → 2s → 4s → ... → max 30s)
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
          connect();
        }, reconnectDelay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      setConnected(false);
    };
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
      <LiveContext.Provider value={{ connected, liveData, gridPower }}>
        <div className="app-layout">
          {routerLoc.pathname !== '/live' && <nav className="navbar">
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
            <NavLink to="/grid">Grid Meter</NavLink>
            <NavLink to="/export">Export</NavLink>
              <NavLink to="/setup">Setup</NavLink>
            </div>
            <button className="btn btn-sm btn-danger hide-mobile" onClick={logout}>Logout</button>
            <button className="hamburger" onClick={() => setMenuOpen(!menuOpen)}>
              {menuOpen ? '✕' : '☰'}
            </button>
          </nav>}

          {routerLoc.pathname !== '/live' && menuOpen && (
            <div className={`mobile-menu ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
              <div className="menu-section">Navigation</div>
              <NavLink to="/">Dashboard</NavLink>
              <NavLink to="/history">History</NavLink>
              <NavLink to="/savings">Savings</NavLink>
              <NavLink to="/stats">Stats</NavLink>
              <NavLink to="/model">AI Model</NavLink>
              <NavLink to="/grid">Grid Meter</NavLink>
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
              <Route path="/grid" element={<GridDetail />} />
              <Route path="/live" element={<LiveDisplay />} />
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
