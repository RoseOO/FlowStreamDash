import React from 'react';
import { ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, Brush } from 'recharts';
export default function ChartContainer({ data, height = 300, xFormatter, brushFormatter, children, ...props }) {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        {React.cloneElement(children, {
          animationDuration: 0,
          data,
          ...props,
          children: [
            <CartesianGrid key="grid" strokeDasharray="3 3" stroke="var(--border)" />,
            <XAxis key="x" dataKey="ts" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickFormatter={xFormatter} />,
            <YAxis key="y" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} />,
            <Tooltip key="tip" labelFormatter={ts => new Date(ts).toLocaleString()}
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }} />,
            ...(Array.isArray(children.props.children) ? children.props.children : [children.props.children]),
            <Brush key="brush" dataKey="ts" height={24} stroke="var(--accent2)" fill="var(--bg-card2)" travellerWidth={8}
              tickFormatter={brushFormatter || xFormatter} />,
          ],
        })}
      </ResponsiveContainer>
    </div>
  );
}
