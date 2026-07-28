import React from 'react';
export default function StatCard({ label, value, unit, color, sub, fontSize, className, ...props }) {
  return (
    <div className={`stat-card ${className || ''}`} style={{ textAlign: 'center', ...props.style }}>
      <div className="label">{label}</div>
      <div className="value" style={{ color, fontSize }}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
