export function fmt(v, d = 1) {
  return (v != null && !isNaN(v)) ? v.toFixed(d) : '--';
}
export function tsToDate(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString() : '';
}
export function minuteToStr(m) {
  if (m == null) return '--';
  const h = Math.floor(m / 60), min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
