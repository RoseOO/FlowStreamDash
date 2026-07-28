import React, { useState, useEffect } from 'react';
import { useAuth } from '../App';
import { DAY } from '../utils/constants';
import useDevices from '../hooks/useDevices';
import DeviceSelector from '../components/DeviceSelector';

export default function Export() {
  const { apiFetch } = useAuth();
  const { devices, selectedSn, setSelectedSn } = useDevices(apiFetch);
  const [range, setRange] = useState('24h');
  const [info, setInfo] = useState(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!selectedSn) return;
    apiFetch(`/data/${selectedSn}/latest`).then(d => setInfo(d));
  }, [selectedSn, apiFetch]);

  async function download() {
    setDownloading(true);
    try {
      const now = Math.floor(Date.now() / 1000);
      const ranges = { '1h': 3600, '6h': 21600, '24h': DAY, '7d': 7*DAY, '30d': 30*DAY, 'all': 0 };
      const from = ranges[range] ? now - ranges[range] : 0;

      const csv = await apiFetch(`/export/${selectedSn}?from=${from}&to=${now}`);

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ecoflow_${selectedSn}_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + err.message);
    }
    setDownloading(false);
  }

  const rangeLabels = { '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', 'all': 'All data' };

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>CSV Export</h2>

      <div className="grid-2">
        <div className="card">
          <h3>Export Data</h3>
          <div className="form-group">
            <label>Device</label>
            <div style={{width:'100%'}}><DeviceSelector devices={devices} selectedSn={selectedSn} setSelectedSn={setSelectedSn} /></div>
          </div>
          <div className="form-group">
            <label>Date Range</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {Object.entries(rangeLabels).map(([k, v]) => (
                <button key={k} className={`btn btn-sm ${range === k ? 'btn-primary' : ''}`}
                        style={range !== k ? { background:'var(--bg-card2)', color:'var(--text-dim)' } : {}}
                        onClick={() => setRange(k)}>{v}</button>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" onClick={download} disabled={downloading || !selectedSn}>
            {downloading ? 'Preparing...' : 'Download CSV'}
          </button>
        </div>

        <div className="card">
          <h3>Data Summary</h3>
          {info ? (
            <div>
              <div className="stat-card" style={{ marginBottom: 8 }}>
                <div className="label">Data Range</div>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>
                  {info.range?.min_ts ? new Date(info.range.min_ts * 1000).toLocaleString() : 'N/A'}
                  {' — '}
                  {info.range?.max_ts ? new Date(info.range.max_ts * 1000).toLocaleString() : 'N/A'}
                </div>
              </div>
              <div className="stat-card" style={{ marginBottom: 8 }}>
                <div className="label">Total Records</div>
                <div className="value" style={{ fontSize: 28 }}>{info.range?.count?.toLocaleString() || 0}</div>
              </div>
              <div className="stat-card">
                <div className="label">Latest Values</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'monospace', marginTop: 4 }}>
                  {info.latest && Object.keys(info.latest).slice(0,8).map(k => (
                    <div key={k}>{k}: {info.latest[k]}</div>
                  ))}
                  {info.latest && Object.keys(info.latest).length > 8 && <div>...and {Object.keys(info.latest).length - 8} more</div>}
                </div>
              </div>
            </div>
          ) : (
            <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Select a device to see stats.</p>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>CSV Format</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Columns are labelled with human-readable names (e.g. <code>PV1_Power_W</code>, <code>Grid_Voltage_V</code>)
          in the same display order as the live data table. Timestamps are ISO 8601.
          Each row represents one sampling point with all available fields.
        </p>
      </div>
    </div>
  );
}
