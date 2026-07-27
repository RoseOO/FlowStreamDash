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
  // Grid connection status (field 619)
  if (fnum === 619) return getGridStatusLabel(Number(value)) || String(value);
  // Error code list (field 627) — could be array or hex string
  if (fnum === 627) {
    if (Array.isArray(value)) {
      const codes = value.map(v => getErrorLabel(Number(v)));
      return codes.length > 0 ? codes.join(', ') : 'None';
    }
    if (typeof value === 'string' && value) {
      // Hex string — try to parse as list of varints
      try {
        const codes = [];
        for (let i = 0; i < value.length; i += 8) {
          const hex = value.substring(i, Math.min(i+8, value.length));
          const code = parseInt(hex, 16);
          if (code > 0) codes.push(getErrorLabel(code));
        }
        return codes.length > 0 ? codes.join(', ') : 'None';
      } catch { return value; }
    }
    return String(value) === '0' ? 'None' : String(value);
  }
  // Status flag (field 1677)
  if (fnum === 1677) {
    if (value === 0 || value === '0') return 'OK';
    if (value === 1 || value === '1') return 'Active';
    return String(value);
  }
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

// ── Grid Connection Status (field 619) ──────────────────────
export const GRID_STATUS = {
  0: 'No Valid',
  1: 'Grid In (importing)',
  2: 'Not Online',
  3: 'Feed Grid (exporting)',
};

// ── Error Codes (from EcoFlow app error_code.json) ──────────
export const ERROR_CODES = {
  // Inverter/DC errors
  1:"Battery overvoltage", 2:"Battery undervoltage", 3:"Battery overcurrent",
  4:"Bus overvoltage", 5:"Bus undervoltage", 6:"Inverter short circuit",
  7:"Output overload", 8:"PFC overcurrent", 9:"Battery communication exception",
  11:"Overtemperature", 12:"Undertemperature", 13:"Fan is stalled",
  15:"Input relay is stuck", 16:"PFC soft-start exception",
  20:"LLC bus overvoltage", 21:"AC output voltage is undervoltage",
  22:"Ambient temperature is too high", 23:"Internal MCU communication exception",
  25:"Hardware bus is overvoltage", 26:"Transient inverter short-circuit",
  27:"Internal MCU communication exception 2", 28:"Europe-standard output port is overcurrent",
  29:"Number of transient failures exceeds the limit", 30:"Fan is stalled",
  31:"During battery discharge prohibition, AC discharge is unavailable",
  32:"Current sensor self-test failed", 33:"Input relay is stuck",
  34:"Detection exception of the output current value", 35:"Output relay is stuck",
  66:"Discharge is prohibited",
  70:"AC overcurrent/undervoltage or overfrequency/underfrequency",
  71:"The AC input voltage exists, but no battery is connected",
  // PV errors (PV IN2, PV IN3)
  20001:"PV IN2 is short-circuited", 20002:"PV IN2 bus is short-circuited",
  20003:"PV IN2 is overcurrent", 20004:"PV IN2 output is overcurrent",
  20005:"PV IN2 input is overcurrent", 20006:"PV IN2 output is overvoltage",
  20007:"PV IN2 output is undervoltage", 20008:"PV IN2 input is overvoltage",
  20009:"PV IN2 input is undervoltage", 20010:"PV IN2 is overtemperature",
  20011:"PV IN2 is undertemperature", 20012:"PV IN2 is overloaded",
  20013:"Battery is disconnected", 20014:"Communication with the battery is abnormal",
  20015:"Fan is faulty", 20016:"Communication with the BBC is abnormal",
  20017:"Input soft-start failed",
  20201:"PV IN3 is short-circuited", 20202:"PV IN3 bus is short-circuited",
  20203:"PV IN3 is overcurrent", 20204:"PV IN3 output is overcurrent",
  20205:"PV IN3 input is overcurrent", 20206:"PV IN3 output is overvoltage",
  20207:"PV IN3 output is undervoltage", 20208:"PV IN3 input is overvoltage",
  20209:"PV IN3 input is undervoltage", 20210:"PV IN3 is overtemperature",
  20211:"PV IN3 is undertemperature", 20212:"PV IN3 is overloaded",
  20213:"Battery is disconnected", 20214:"Communication with the battery is abnormal",
  20215:"Fan is faulty", 20216:"Communication with the BBC is abnormal",
  20217:"Input soft-start failed",
  // Grid/Smart Home Panel
  3038:"The time for the device is incorrect",
  3073:"Grid Power Off", 3076:"Battery overload error",
  3080:"Battery pause", 3088:"Frequency error", 3104:"Voltage error",
  3136:"Grid: Neutral wire not connected", 3200:"Battery: Neutral wire not connected",
  3329:"Single-phase mode error", 3330:"Split-phase mode error",
  3841:"Smart Home Panel: high temperature", 3842:"Smart Home Panel: high temperature",
  4097:"Battery 1: charge error", 4098:"Battery 1: discharge error",
  4353:"Battery 2: charge error", 4354:"Battery 2: discharge error",
  4609:"Maintenance door open",
  10003:"Battery overcurrent", 10004:"Battery short circuit",
  10005:"DC input is overvoltage", 10006:"DC input is overcurrent",
  10012:"Input relay is stuck", 10013:"Inductor L1 is overcurrent",
  10014:"Inductor L2 is overcurrent", 10015:"Radiator is undertemperature",
  10016:"Heat sink is overtemperature", 10020:"EMS prohibits charging",
  10021:"Battery is disconnected", 10022:"Fan is faulty",
  10023:"Battery communication is lost", 10024:"IC communication is lost",
  15001:"Battery overvoltage", 15002:"Battery undervoltage",
  15007:"DC output is overvoltage", 15008:"DC output is undervoltage",
  15009:"DC output is overcurrent", 15010:"DC output is overloaded",
  15011:"DC output is short-circuited", 15013:"Inductor L1 is overcurrent",
  15014:"Inductor L2 is overcurrent", 15015:"Radiator is undertemperature",
  15016:"Heat sink is overtemperature", 15017:"PCB board is undertemperature",
  15018:"PCB board is overtemperature", 15019:"EMS prohibits discharging",
  15022:"Fan is faulty", 15023:"Battery communication is lost",
  15024:"IC communication is lost",
  // General hardware
  50001:"Hardware undervoltage", 50002:"Hardware overvoltage",
  50003:"Hardware overcurrent", 50004:"Hardware short circuit",
  50005:"Undervoltage", 50006:"Overvoltage", 50007:"Discharge overcurrent",
  50008:"Charge overcurrent", 50009:"Discharge overtemperature",
  50010:"Discharge undertemperature", 50011:"Charge overtemperature",
  50012:"Charge undertemperature", 50013:"MOS overtemperature",
  50014:"Power-on exception", 50015:"Charge overcurrent", 50016:"Short circuit",
  50017:"Parallel charge exception", 50018:"Parallel discharge exception",
  50019:"BMS is faulty", 50020:"MOS undertemperature",
  50021:"Charge overcurrent", 50022:"Predischarge failed",
  50071:"Cell overvoltage level 2", 50072:"Cell undervoltage level 2",
  50073:"Cell over-temperature level 2", 50074:"Cell under-temperature level 2",
  50075:"Battery MOS over-temperature", 50076:"Battery MOS under-temperature",
  50077:"Cell voltage difference large", 50078:"Battery charge/discharge MOS damaged",
  50079:"Battery charge MOS damaged", 50080:"Battery discharge MOS damaged",
  50081:"Battery heating film MOS damaged",
};

export function getErrorLabel(code) {
  return ERROR_CODES[code] || `Error ${code}`;
}

export function getGridStatusLabel(code) {
  return GRID_STATUS[code] || `Unknown (${code})`;
}
