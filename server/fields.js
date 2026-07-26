// Field mappings for EcoFlow Stream Microinverter (and future device types)
// Source: foxthefox/ioBroker.ecoflow-mqtt ef_stream_inverter_data.js protobuf schema
//   cf254_ci21 = DisplayPropertyUpload
//   cf254_ci22 = RuntimePropertyUpload

export const FIELD_META = {
  // PV String 1
  361: { label: 'PV1 Power',       unit: 'W',   decimals: 1, graph: 'pv' },
  380: { label: 'PV1 Voltage',     unit: 'V',   decimals: 1, graph: null },
  381: { label: 'PV1 Current',     unit: 'A',   decimals: 2, graph: null },
  // PV String 2
  70:  { label: 'PV2 Power',       unit: 'W',   decimals: 1, graph: 'pv' },
  442: { label: 'PV2 Voltage',     unit: 'V',   decimals: 1, graph: null },
  71:  { label: 'PV2 Current',     unit: 'A',   decimals: 2, graph: null },
  // Grid
  616: { label: 'Grid Power',      unit: 'W',   decimals: 1, graph: 'grid' },
  613: { label: 'Grid Voltage',    unit: 'V',   decimals: 1, graph: 'voltage' },
  614: { label: 'Grid Current',    unit: 'A',   decimals: 2, graph: null },
  615: { label: 'Grid Frequency',  unit: 'Hz',  decimals: 2, graph: null },
  617: { label: 'Reactive Power',  unit: 'var', decimals: 1, graph: null },
  618: { label: 'Power Factor',    unit: '',    decimals: 2, graph: null },
  619: { label: 'Grid State',      unit: '',    decimals: 0, graph: null },
  // Inverter
  371: { label: 'Inverter Temp',   unit: 'C',   decimals: 1, graph: 'temp' },
  638: { label: 'Target Power',    unit: 'W',   decimals: 1, graph: null },
  521: { label: 'Max Output',      unit: 'W',   decimals: 0, graph: null },
  727: { label: 'Feed-in Limit',   unit: 'W',   decimals: 0, graph: null },
  // WiFi / Settings
  602: { label: 'WiFi RSSI',       unit: 'dBm', decimals: 0, graph: null },
  133: { label: 'UTC Timezone',    unit: '',    decimals: 0, graph: null },
  134: { label: 'Timezone ID',     unit: '',    decimals: 0, graph: null },
  135: { label: 'UTC Mode',        unit: '',    decimals: 0, graph: null },
  731: { label: 'Country Code',    unit: '',    decimals: 0, graph: null },
  729: { label: 'Town Code',       unit: '',    decimals: 0, graph: null },
  730: { label: 'Grid Code',       unit: '',    decimals: 0, graph: null },
  // Diagnostics
  620: { label: 'Curtailment Sig', unit: '',    decimals: 0, graph: null },
  627: { label: 'Error Code List', unit: '',    decimals: 0, graph: null },
  732: { label: 'Factory Mode',    unit: '',    decimals: 0, graph: null },
  733: { label: 'Debug Mode',      unit: '',    decimals: 0, graph: null },
  734: { label: 'PF Setting',      unit: '',    decimals: 2, graph: null },
  // RuntimePropertyUpload
  293: { label: 'Display Full Period',  unit: 'ms', decimals: 0, graph: null },
  294: { label: 'Display Incr Period',  unit: 'ms', decimals: 0, graph: null },
  295: { label: 'Runtime Full Period',  unit: 'ms', decimals: 0, graph: null },
  296: { label: 'Runtime Incr Period',  unit: 'ms', decimals: 0, graph: null },
  1677:{ label: 'Status Flag',     unit: '',    decimals: 0, graph: null },
};

export const KNOWN_FIELDS = Object.keys(FIELD_META).map(Number);

// Display order for data tables
export const DISPLAY_ORDER = [
  361, 380, 381,   // PV1: Power, Voltage, Current
  70,  442, 71,    // PV2: Power, Voltage, Current
  616, 613, 614, 615, 617, 618, 619,  // Grid
  371, 638, 521, 727,   // Inverter
  602,              // WiFi
  133, 134, 135, 731, 729, 730,  // Settings
  620, 627, 732, 733, 734,  // Diagnostics
  293, 294, 295, 296, 1677,  // Upload periods
];

// Section grouping for display
export const DISPLAY_SECTIONS = {
  361: '── PV1 ──',
  70:  '── PV2 ──',
  616: '── Grid ──',
  371: '── Inverter ──',
  602: '── WiFi ──',
  133: '── Settings ──',
  620: '── Diagnostics ──',
  293: '── Upload Periods ──',
};

export function getFieldLabel(fnum) {
  if (FIELD_META[fnum]) return FIELD_META[fnum].label;
  return `field_${fnum}`;
}

export function getCsvLabel(fnum) {
  if (FIELD_META[fnum]) {
    const { label, unit } = FIELD_META[fnum];
    const clean = label.replace(/\s+/g, '_');
    return unit ? `${clean}_${unit}` : clean;
  }
  return `field_${fnum}`;
}

export function formatValue(fnum, value) {
  if (value === null || value === undefined) return '--';
  const meta = FIELD_META[fnum];
  if (meta && typeof value === 'number') {
    return value.toFixed(meta.decimals);
  }
  return String(value);
}

// Fields to graph
export const GRAPH_FIELDS = {
  pv:     { fields: [361, 70, 616], labels: ['PV1', 'PV2', 'Output'], colors: ['#2196F3', '#4CAF50', '#F44336'] },
  grid:   { fields: [616],          labels: ['Grid Power'],       colors: ['#9C27B0'] },
  voltage:{ fields: [613],          labels: ['Grid Voltage'],     colors: ['#FF9800'] },
  temp:   { fields: [371],          labels: ['Temperature'],      colors: ['#E91E63'] },
};
