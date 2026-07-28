import mqtt from 'mqtt';
import { FIELD_META, getGridStatusLabel, getErrorLabel } from './fields.js';

let client = null;
let config = null;

function guessDeviceClass(label, unit) {
  if (unit === 'W' || unit === 'var') return 'power';
  if (unit === 'V') return 'voltage';
  if (unit === 'A') return 'current';
  if (unit === 'Hz') return 'frequency';
  if (unit === 'C' || label.includes('Temp')) return 'temperature';
  if (unit === 'dBm') return 'signal_strength';
  if (label.includes('Factor')) return 'power_factor';
  if (unit === 'kWh' || label.includes('kWh')) return 'energy';
  if (unit === '£') return 'monetary';
  if (label.includes('CO₂') || label.includes('CO2')) return 'carbon_dioxide';
  if (unit === '%') return undefined;
  return undefined;
}

function guessIcon(label) {
  if (label.includes('PV') || label.includes('Solar') || label.includes('Target')) return 'mdi:solar-power';
  if (label.includes('Grid')) return 'mdi:transmission-tower';
  if (label.includes('Voltage')) return 'mdi:flash';
  if (label.includes('Current')) return 'mdi:current-dc';
  if (label.includes('Frequency')) return 'mdi:sine-wave';
  if (label.includes('Temp')) return 'mdi:thermometer';
  if (label.includes('WiFi') || label.includes('RSSI') || label.includes('Signal')) return 'mdi:wifi';
  if (label.includes('Reactive') || label.includes('Factor')) return 'mdi:chart-line';
  if (label.includes('Limit') || label.includes('Max') || label.includes('Peak')) return 'mdi:speedometer';
  if (label.includes('Status') || label.includes('Error')) return 'mdi:alert-circle';
  if (label.includes('Factory') || label.includes('Debug') || label.includes('Mode')) return 'mdi:cog';
  if (label.includes('Country') || label.includes('Town') || label.includes('Code')) return 'mdi:flag';
  if (label.includes('Timezone') || label.includes('UTC')) return 'mdi:clock';
  if (label.includes('Curtailment')) return 'mdi:hand-back-left-off';
  if (label.includes('Display') || label.includes('Upload') || label.includes('Period')) return 'mdi:timer';
  if (label.includes('PF Setting')) return 'mdi:tune';
  if (label.includes('kWh') || label.includes('Energy') || label.includes('Import') || label.includes('Export')) return 'mdi:flash';
  if (label.includes('Saving') || label.includes('Cost')) return 'mdi:cash';
  if (label.includes('CO₂') || label.includes('CO2')) return 'mdi:molecule-co2';
  if (label.includes('Efficiency') || label.includes('Accuracy')) return 'mdi:percent';
  if (label.includes('Predicted') || label.includes('Forecast') || label.includes('Model') || label.includes('Samples') || label.includes('Next Hour')) return 'mdi:brain';
  return 'mdi:chip';
}

const DEVICE = {
  identifiers: ['ecoflow_monitor'],
  name: 'EcoFlow Monitor',
  model: 'Stream Microinverter',
  manufacturer: 'EcoFlow',
};

function pubConfig(uid, name, stateTopic, opts = {}) {
  const payload = {
    name,
    unique_id: uid,
    state_topic: stateTopic,
    value_template: opts.value_template || `{{ value_json.${opts.json_key || name.replace(/\s+/g,'_').toLowerCase()} }}`,
    availability_topic: 'ecoflow/status',
    device: DEVICE,
    icon: opts.icon || guessIcon(name),
  };
  if (opts.device_class) payload.device_class = opts.device_class;
  if (opts.unit) payload.unit_of_measurement = opts.unit;
  if (opts.device_class || opts.unit) payload.state_class = 'measurement';
  client.publish(`${config.discovery_prefix || 'homeassistant'}/sensor/${uid}/config`,
    JSON.stringify(payload), { retain: true });
}

export async function startHaMqtt(cfg) {
  stopHaMqtt();
  if (!cfg?.host) return false;
  config = cfg;

  return new Promise((resolve) => {
    client = mqtt.connect({
      host: cfg.host,
      port: cfg.port || 1883,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clientId: `ecoflow_monitor_${Date.now()}`,
      keepalive: 60,
      reconnectPeriod: 30000,
      connectTimeout: 10000,
    });

    client.on('connect', () => {
      console.log('[HA-MQTT] Connected to local broker');
      publishDiscovery();
      resolve(true);
    });

    client.on('error', (err) => {
      console.error('[HA-MQTT] Error:', err.message);
      resolve(false);
    });
  });
}

export function stopHaMqtt() {
  if (client) {
    try { client.end(true); } catch {}
    client = null;
  }
}

function publishDiscovery() {
  if (!client || !config) return;
  let count = 0;

  // ── Live protobuf fields ────────────────────────────────
  for (const [fnum, meta] of Object.entries(FIELD_META)) {
    const num = Number(fnum);
    const dc = guessDeviceClass(meta.label, meta.unit);
    const isNumeric = meta.unit && meta.unit !== '' &&
      !['Grid State','Error Code List','Factory Mode','Debug Mode','UTC Mode','Status Flag'].includes(meta.label);
    const isFactor = meta.label === 'Power Factor' || meta.label === 'PF Setting';

    pubConfig(`ecoflow_${num}`, meta.label, 'ecoflow/state', {
      json_key: `f${num}`,
      icon: guessIcon(meta.label),
      device_class: isFactor ? 'power_factor' : dc,
      unit: isNumeric || isFactor ? (isFactor ? undefined : meta.unit) : undefined,
    });
    count++;
  }

  // ── Stats sensors (ecoflow/stats) ────────────────────────
  const statsSensors = [
    { key:'today_kwh', name:'Today kWh', dc:'energy', unit:'kWh' },
    { key:'peak_w', name:'Peak W', dc:'power', unit:'W' },
    { key:'pv_efficiency_pct', name:'PV Efficiency', unit:'%' },
    { key:'saving_gbp', name:'Saving', dc:'monetary', unit:'£' },
    { key:'co2_kg', name:'CO₂ Saved', dc:'carbon_dioxide', unit:'kg' },
    { key:'yesterday_kwh', name:'Yesterday kWh', dc:'energy', unit:'kWh' },
    { key:'model_factor', name:'Model Factor' },
    { key:'model_samples', name:'Model Samples' },
    { key:'model_r2', name:'Model R²' },
  ];
  for (const s of statsSensors) {
    pubConfig(`ecoflow_stat_${s.key}`, s.name, 'ecoflow/stats', {
      json_key: s.key, device_class: s.dc, unit: s.unit, icon: guessIcon(s.name),
    });
    count++;
  }

  // ── Grid meter sensors (ecoflow/grid) ────────────────────
  const gridSensors = [
    { key:'power_w', name:'Grid Meter Power', dc:'power', unit:'W' },
    { key:'voltage_v', name:'Grid Meter Voltage', dc:'voltage', unit:'V' },
    { key:'current_a', name:'Grid Meter Current', dc:'current', unit:'A' },
    { key:'daily_kwh', name:'Grid Meter Daily Import', dc:'energy', unit:'kWh' },
    { key:'total_kwh', name:'Grid Meter Total Import', dc:'energy', unit:'kWh' },
    { key:'import_cost_gbp', name:'Grid Import Cost', dc:'monetary', unit:'£' },
  ];
  for (const s of gridSensors) {
    pubConfig(`ecoflow_grid_${s.key}`, s.name, 'ecoflow/grid', {
      json_key: s.key, device_class: s.dc, unit: s.unit, icon: guessIcon(s.name),
    });
    count++;
  }

  // ── Prediction sensors (ecoflow/prediction) ──────────────
  const predSensors = [
    { key:'predicted_total_kwh', name:'Predicted Total kWh', dc:'energy', unit:'kWh' },
    { key:'predicted_remaining_kwh', name:'Predicted Remaining kWh', dc:'energy', unit:'kWh' },
    { key:'already_produced_kwh', name:'Already Produced kWh', dc:'energy', unit:'kWh' },
    { key:'model_factor', name:'Prediction Model Factor' },
    { key:'model_samples', name:'Prediction Model Samples' },
    { key:'using_learned_model', name:'Using Learned Model' },
    { key:'next_hour_w', name:'Next Hour Predicted W', dc:'power', unit:'W' },
    { key:'yesterday_error_pct', name:'Yesterday Accuracy', unit:'%' },
  ];
  for (const s of predSensors) {
    pubConfig(`ecoflow_pred_${s.key}`, s.name, 'ecoflow/prediction', {
      json_key: s.key, device_class: s.dc, unit: s.unit, icon: guessIcon(s.name),
    });
    count++;
  }

  console.log(`[HA-MQTT] Published ${count} sensor discovery configs`);
}

// ── Publish live protobuf fields ─────────────────────────────

export function publishState(sn, fields, connected) {
  if (!client || !config) return;

  client.publish('ecoflow/status', connected ? 'online' : 'offline', { retain: true });

  if (!fields || !sn) return;

  const state = {};
  for (const [fnum, value] of Object.entries(fields)) {
    const num = Number(fnum);
    if (value === null || value === undefined) { state[`f${num}`] = ''; continue; }

    const meta = FIELD_META[num];

    if (num === 619) {
      state[`f${num}`] = getGridStatusLabel(value) || String(value);
    } else if (num === 627) {
      if (Array.isArray(value)) {
        state[`f${num}`] = value.map(v => getErrorLabel(Number(v))).join(', ') || 'None';
      } else if (typeof value === 'string' && value && value !== '0') {
        try {
          const codes = [];
          for (let i = 0; i < value.length; i += 8) {
            const hex = value.substring(i, Math.min(i + 8, value.length));
            const code = parseInt(hex, 16);
            if (code > 0) codes.push(getErrorLabel(code));
          }
          state[`f${num}`] = codes.length > 0 ? codes.join(', ') : 'None';
        } catch { state[`f${num}`] = value; }
      } else {
        state[`f${num}`] = String(value) === '0' ? 'None' : 'Unknown';
      }
    } else if (num === 1677) {
      if (value === 0 || value === '0') state[`f${num}`] = 'OK';
      else if (value === 1 || value === '1') state[`f${num}`] = 'Active';
      else state[`f${num}`] = String(value);
    } else if (typeof value === 'number') {
      state[`f${num}`] = meta ? value.toFixed(meta.decimals) : value;
    } else {
      state[`f${num}`] = String(value);
    }
  }

  client.publish('ecoflow/state', JSON.stringify(state), { retain: false });
}

// ── Publish computed stats ───────────────────────────────────

export function publishHaStats(sn, stats) {
  if (!client || !config) return;
  const payload = {
    today_kwh: round3(stats?.totalKwh),
    peak_w: round1(stats?.bestDay?.peakW),
    pv_efficiency_pct: round1(stats?.pvEfficiency),
    saving_gbp: round3(stats?.totalSaving),
    co2_kg: round3(stats?.co2SavingKgToday),
    yesterday_kwh: round3(stats?.yesterday?.totalKwh),
    model_factor: round3(stats?.modelFactor),
    model_samples: stats?.modelSamples ?? '',
    model_r2: round3(stats?.modelR2),
  };
  client.publish('ecoflow/stats', JSON.stringify(payload), { retain: true });
}

// ── Publish grid meter (Sonoff ESPHome) ──────────────────────

export function publishHaGridMeter(data) {
  if (!client || !config) return;
  const payload = {
    power_w: data.power_w != null ? round1(data.power_w) : '',
    voltage_v: data.voltage_v != null ? round1(data.voltage_v) : '',
    current_a: data.current_a != null ? round2(data.current_a) : '',
    daily_kwh: data.energy_kwh != null ? round3(data.energy_kwh) : '',
    total_kwh: data.total_kwh != null ? round3(data.total_kwh) : '',
    import_cost_gbp: data.import_cost != null ? round3(data.import_cost) : '',
  };
  client.publish('ecoflow/grid', JSON.stringify(payload), { retain: true });
}

// ── Publish prediction/forecast ──────────────────────────────

export function publishHaPrediction(sn, pred) {
  if (!client || !config) return;
  const payload = {
    predicted_total_kwh: round3(pred?.predictedTotalKwh),
    predicted_remaining_kwh: round3(pred?.predictedRemainingKwh),
    already_produced_kwh: round3(pred?.alreadyProducedKwh),
    model_factor: round3(pred?.modelFactor),
    model_samples: pred?.modelSamples ?? '',
    using_learned_model: pred?.usingLearnedModel ? 'Yes' : 'No',
    next_hour_w: pred?.predictedWattsByHour ? round1(pred.predictedWattsByHour[pred.currentHour + 1]) : '',
    yesterday_error_pct: pred?.yesterdayErrorPct != null ? round1(pred.yesterdayErrorPct) : '',
  };
  client.publish('ecoflow/prediction', JSON.stringify(payload), { retain: true });
}

export function isHaMqttConnected() {
  return client?.connected || false;
}

function round1(v) { return v != null && !isNaN(v) ? Math.round(v * 10) / 10 : ''; }
function round2(v) { return v != null && !isNaN(v) ? Math.round(v * 100) / 100 : ''; }
function round3(v) { return v != null && !isNaN(v) ? Math.round(v * 1000) / 1000 : ''; }
