import { useSyncExternalStore } from 'react';
import type { Alert, AppMode, Command, CommandResult, DataSource, EquipmentId, EventRecord, HistoryPoint, HistoryRange, MetricKey, Override, Quality, Scenario, Snapshot, Source, StoreState, Thresholds } from '../types';
import { apiSource } from './api';
import { CLEAN_BASELINE, EQUIPMENT, INSTALLATION_ID, METRICS, SCENARIOS, SCENARIO_LABELS, TANK_CAPACITY_LITRES } from './catalog';
export { CLEAN_BASELINE, EQUIPMENT, INSTALLATION_ID, METRICS, SCENARIOS, SCENARIO_LABELS, SCENARIO_DESCRIPTIONS, TANK_CAPACITY_LITRES } from './catalog';

export const STORAGE_KEY = 'maxis-demo-state-v1';
const TICK_MS = 2000;
const MINUTE_MS = 60000;
const DAY_MS = 86400000;
export const DEFAULT_THRESHOLDS: Thresholds = { turbidityOut: 1, pressureDelta: 0.9, lowTank: 15 };
type Result = { ok: boolean; message: string };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Totals = { rainUsage: number; mainsUsage: number; solarEnergy: number; pumpEnergy: number; uvEnergy: number; miscEnergy: number };
type StoreOptions = { now?: () => number; storage?: StorageLike | null; autoTick?: boolean; commandDelayMs?: number; timeoutMs?: number };
const rounding = (value: number, places = 3) => Number(value.toFixed(places));

function browserStorage(): StorageLike | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

export class MaxisStore implements DataSource {
  private state!: StoreState;
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Set<(snapshot: Snapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private storage: StorageLike | null;
  private autoTick: boolean;
  private commandDelayMs: number;
  private timeoutMs: number;
  private lastTick = 0;
  private lastLog = 0;
  private staleSince: string | null = null;
  private counter = 0;
  private generation = 0;
  private totals: Totals = { rainUsage: 124.82, mainsUsage: 18.36, solarEnergy: 48.2, pumpEnergy: 39.1, uvEnergy: 8.6, miscEnergy: 5.3 };

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.autoTick = options.autoTick ?? true;
    this.commandDelayMs = options.commandDelayMs ?? 650;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.initialize();
  }

  private id(prefix: string) { return `${prefix}-${this.now().toString(36)}-${++this.counter}`; }
  private timestamp() { return new Date(this.now()).toISOString(); }

  private initialize() {
    const time = this.now();
    this.lastTick = time;
    this.lastLog = time;
    this.staleSince = null;
    this.totals = { rainUsage: 124.82, mainsUsage: 18.36, solarEnergy: 48.2, pumpEnergy: 39.1, uvEnergy: 8.6, miscEnergy: 5.3 };
    const history: Snapshot[] = [];
    for (let minute = 1440; minute >= 0; minute--) {
      const sampleTime = time - minute * MINUTE_MS;
      const sample = this.makeSnapshot(sampleTime, 'normal', 'rainwater', false);
      if (minute < 1440) this.integrate(sample, 60);
      history.push(this.makeSnapshot(sampleTime, 'normal', 'rainwater', false));
    }
    const createdAt = new Date(time - 6 * 3600000).toISOString();
    this.state = {
      snapshot: history[history.length - 1], history,
      alerts: [],
      events: ([
        { id: this.id('event'), timestamp: new Date(time - 3600000).toISOString(), type: 'maintenance', level: 'info', equipment: 'membrane', message: 'Clean-filter reference recorded: outlet 0.22 NTU, pressure difference 0.45 bar, flow 18 L/min. Simulated baseline.' },
        { id: this.id('event'), timestamp: new Date(time - 1800000).toISOString(), type: 'connection', level: 'info', message: 'Simulated device telemetry connected. All seven equipment groups online.' },
        { id: this.id('event'), timestamp: new Date(time - 60000).toISOString(), type: 'telemetry', level: 'info', message: 'Simulated backend heartbeat received; 24 hours of history available.' },
      ] satisfies EventRecord[]).reverse(),
      inventory: [
        { id: 'membrane', name: 'Membrane cartridge', category: 'Filtration', quantity: 4, unit: 'units', minimum: 2 },
        { id: 'uv-lamp', name: 'UV replacement lamp', category: 'Disinfection', quantity: 2, unit: 'units', minimum: 1 },
        { id: 'gasket', name: 'Seal & gasket kit', category: 'Spares', quantity: 6, unit: 'kits', minimum: 2 },
        { id: 'sensor', name: 'Turbidity sensor', category: 'Instrumentation', quantity: 1, unit: 'units', minimum: 1 },
        { id: 'tools', name: 'Service tool set', category: 'Tools', quantity: 2, unit: 'sets', minimum: 1 },
      ],
      orders: [],
      tasks: [{ id: this.id('task'), equipment: 'uv', description: 'Inspect UV lamp and clean the quartz sleeve', status: 'open', createdAt }],
      incidents: [], thresholds: { ...DEFAULT_THRESHOLDS }, overrides: [], command: null,
    };
    this.restore();
    this.state.snapshot = this.makeSnapshot(time, this.state.snapshot.scenario, this.state.snapshot.source, this.state.snapshot.stopped);
    this.updateHistory(this.state.snapshot);
    this.reconcileAlerts();
    this.state.snapshot = { ...this.state.snapshot, events: this.state.events };
  }

  private restore() {
    try {
      const serialized = this.storage?.getItem(STORAGE_KEY);
      if (!serialized) return;
      const saved = JSON.parse(serialized);
      if (saved.version !== 1) return;
      for (const key of ['alerts', 'events', 'inventory', 'orders', 'tasks', 'incidents'] as const) {
        if (Array.isArray(saved[key])) this.state[key] = saved[key];
      }
      if (saved.thresholds && this.validThresholds(saved.thresholds)) this.state.thresholds = { ...DEFAULT_THRESHOLDS, ...saved.thresholds };
      if (saved.controls) {
        this.state.snapshot = { ...this.state.snapshot,
          scenario: SCENARIOS.includes(saved.controls.scenario) ? saved.controls.scenario : 'normal',
          source: saved.controls.source === 'mains' ? 'mains' : 'rainwater',
          stopped: saved.controls.stopped === true,
        };
      }
    } catch { /* Corrupted or inaccessible storage uses the safe demo defaults. */ }
  }

  private persist() {
    try {
      const { alerts, events, inventory, orders, tasks, incidents, thresholds, snapshot } = this.state;
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, alerts, events, inventory, orders, tasks, incidents, thresholds, controls: { scenario: snapshot.scenario, source: snapshot.source, stopped: snapshot.stopped } }));
    } catch { /* The live demo continues when browser storage is unavailable. */ }
  }

  private ensureTimer() {
    if (!this.autoTick || this.timer || (!this.listeners.size && !this.streams.size)) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.step(), TICK_MS);
  }
  private releaseTimer() {
    if (!this.listeners.size && !this.streams.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  subscribeState = (callback: () => void) => {
    this.listeners.add(callback);
    this.ensureTimer();
    return () => { this.listeners.delete(callback); this.releaseTimer(); };
  };
  subscribe = (callback: (snapshot: Snapshot) => void) => {
    this.streams.add(callback);
    callback(this.state.snapshot);
    this.ensureTimer();
    return () => { this.streams.delete(callback); this.releaseTimer(); };
  };
  getState = () => this.state;

  private notify(persist = false) {
    this.state = { ...this.state, snapshot: { ...this.state.snapshot, events: this.state.events } };
    if (persist) this.persist();
    this.listeners.forEach(callback => callback());
    this.streams.forEach(callback => callback(this.state.snapshot));
  }

  private addEvent(type: EventRecord['type'], message: string, level: EventRecord['level'] = 'info', equipment?: EquipmentId) {
    this.state.events = [{ id: this.id('event'), timestamp: this.timestamp(), type, level, equipment, message }, ...this.state.events].slice(0, 300);
  }

  private makeSnapshot(time: number, scenario: Scenario, source: Source, stopped: boolean): Snapshot {
    const stamp = new Date(time).toISOString();
    const wave = Math.sin(time / 95000);
    const gentle = Math.sin(time / 510000);
    const minuteOfDay = ((time / MINUTE_MS + 480) % 1440 + 1440) % 1440;
    const sun = Math.max(0, Math.sin((minuteOfDay / 60 - 6) / 12 * Math.PI));
    const connected = scenario !== 'sensor-offline';
    const degraded = scenario === 'filter-degradation';
    const low = scenario === 'low-tank';
    const heavy = scenario === 'heavy-rain';
    const tankLevel = low ? 9 + gentle : heavy ? 91 + gentle * 2 : 73 + gentle * 3;
    const rainAvailable = tankLevel > (this.state?.thresholds.lowTank ?? DEFAULT_THRESHOLDS.lowTank);
    const running = !stopped && (source === 'mains' || rainAvailable);
    const treatment = running && source === 'rainwater';
    const pressureIn = stopped || !treatment ? 0 : (degraded ? 3.25 : 2.85) + wave * 0.03;
    const pressureDelta = pressureIn ? (degraded ? 1.38 : CLEAN_BASELINE.pressureDelta) + gentle * 0.02 : 0;
    const flow = !running ? 0 : source === 'mains' ? 19.2 + gentle * 0.4 : degraded ? 10.4 + gentle * 0.3 : CLEAN_BASELINE.flow + gentle * 0.7;
    const pumpPower = !treatment ? 0 : degraded ? 510 + wave * 8 : 360 + wave * 5;
    const uvPower = treatment ? 48 : 0;
    const miscPower = 34 + gentle * 2;
    const values: Record<MetricKey, number | null> = {
      tankLevel, tankVolume: tankLevel / 100 * TANK_CAPACITY_LITRES,
      turbidityIn: (heavy ? 18 : degraded ? 9.8 : 7.2) + wave * 0.15,
      turbidityOut: (degraded ? 1.72 : scenario === 'recovery' ? 0.2 : CLEAN_BASELINE.turbidityOut) + gentle * 0.02,
      pressureIn, pressureOut: Math.max(0, pressureIn - pressureDelta), pressureDelta, flow,
      rainUsage: this.totals.rainUsage, mainsUsage: this.totals.mainsUsage,
      solarPower: 1350 * sun * (heavy ? 0.42 : 1), pumpPower, uvPower, miscPower, totalPower: pumpPower + uvPower + miscPower,
      solarEnergy: this.totals.solarEnergy, pumpEnergy: this.totals.pumpEnergy, uvEnergy: this.totals.uvEnergy, miscEnergy: this.totals.miscEnergy,
      totalEnergy: this.totals.pumpEnergy + this.totals.uvEnergy + this.totals.miscEnergy,
      mainsTurbidity: 0.12 + gentle * 0.01, mainsPressure: 3.1 + wave * 0.03,
      mainsCapacity: null,
      heartbeat: 38 + Math.abs(wave) * 8,
    };
    if (!connected && !this.staleSince) this.staleSince = this.state?.snapshot.timestamp ?? stamp;
    if (connected) this.staleSince = null;
    // A forced reading replaces the simulated one before anything derives from it, so the
    // equipment badge, the alert and the event log all follow with no extra code.
    const forced = {} as Partial<Record<MetricKey, Override>>;
    for (const override of this.activeOverrides(time)) {
      forced[override.metric] = override;
      values[override.metric] = override.quality === 'valid' ? override.value : null;
    }
    const metrics = {} as Snapshot['metrics'];
    for (const metric of Object.keys(METRICS) as MetricKey[]) {
      const override = forced[metric];
      const value = values[metric];
      const available = connected && value !== null;
      metrics[metric] = { installationId: INSTALLATION_ID, equipmentId: METRICS[metric].equipment, metric,
        value: override ? override.value : available ? rounding(value, metric.includes('Energy') || metric.includes('Usage') ? 6 : 3) : null,
        unit: METRICS[metric].unit,
        quality: override ? override.quality : !connected ? 'stale' : available ? 'valid' : 'unavailable',
        timestamp: override || connected ? stamp : this.staleSince!,
      };
    }
    const equipment = {} as Snapshot['equipment'];
    for (const id of Object.keys(EQUIPMENT) as EquipmentId[]) equipment[id] = { status: connected ? 'normal' : 'offline', label: EQUIPMENT[id] };
    if (connected) {
      const thresholds = this.state?.thresholds ?? DEFAULT_THRESHOLDS;
      if (values.turbidityOut! > thresholds.turbidityOut || values.pressureDelta! > thresholds.pressureDelta) equipment.membrane.status = 'warning';
      if (values.tankLevel! < thresholds.lowTank) equipment.tank.status = 'warning';
      if (stopped) for (const id of ['pump', 'membrane', 'uv', 'homes'] as EquipmentId[]) equipment[id].status = 'stopped';
      if (!running && !stopped) { equipment.pump.status = 'stopped'; equipment.uv.status = 'stopped'; equipment.homes.status = 'warning'; }
    }
    return { installationId: INSTALLATION_ID, timestamp: stamp, scenario, source, stopped, connected,
      sourceAvailability: { rainwater: rainAvailable && connected, mains: connected }, metrics, equipment, events: [] };
  }

  private integrate(snapshot: Snapshot, seconds: number) {
    if (!snapshot.connected) return;
    const read = (key: MetricKey) => snapshot.metrics[key].value ?? 0;
    const sourceKey = snapshot.source === 'rainwater' ? 'rainUsage' : 'mainsUsage';
    this.totals[sourceKey] += read('flow') * seconds / 60 / 1000;
    for (const [power, energy] of [['solarPower', 'solarEnergy'], ['pumpPower', 'pumpEnergy'], ['uvPower', 'uvEnergy'], ['miscPower', 'miscEnergy']] as const) {
      this.totals[energy] += read(power) * seconds / 3600000;
    }
  }

  private updateHistory(snapshot: Snapshot) {
    const minute = Math.floor(new Date(snapshot.timestamp).getTime() / MINUTE_MS);
    const history = this.state.history;
    const lastMinute = Math.floor(new Date(history[history.length - 1].timestamp).getTime() / MINUTE_MS);
    const cutoff = new Date(snapshot.timestamp).getTime() - DAY_MS;
    this.state.history = (minute === lastMinute ? [...history.slice(0, -1), snapshot] : [...history, snapshot]).filter(point => new Date(point.timestamp).getTime() >= cutoff);
  }

  private recordTransitions(previous: Snapshot, current: Snapshot) {
    if (previous.connected !== current.connected) this.addEvent('connection', current.connected ? 'Simulated telemetry connection restored.' : 'Simulated telemetry connection lost; readings marked stale.', current.connected ? 'info' : 'error');
    for (const id of Object.keys(EQUIPMENT) as EquipmentId[]) {
      if (previous.equipment[id].status !== current.equipment[id].status) {
        const status = current.equipment[id].status;
        this.addEvent('telemetry', `${EQUIPMENT[id]} status changed: ${previous.equipment[id].status} → ${status}.`, status === 'critical' || status === 'offline' ? 'error' : status === 'warning' ? 'warning' : 'info', id);
      }
    }
    for (const source of ['rainwater', 'mains'] as const) {
      if (previous.sourceAvailability[source] !== current.sourceAvailability[source]) {
        const available = current.sourceAvailability[source];
        this.addEvent('telemetry', `${source === 'rainwater' ? 'Rainwater' : 'Mains'} supply ${available ? 'available' : current.connected ? 'unavailable' : 'availability unknown while telemetry is offline'}.`, available ? 'info' : 'warning', source === 'rainwater' ? 'tank' : 'mains');
      }
    }
  }

  /** Explicit stepping makes cumulative calculations and demo scenarios deterministic in tests. */
  step = (time = this.now()) => {
    this.expireOverrides(time);
    const { scenario, source, stopped } = this.state.snapshot;
    const seconds = Math.max(0, time - this.lastTick) / 1000;
    const previous = this.state.snapshot;
    const rates = this.makeSnapshot(time, scenario, source, stopped);
    this.integrate(rates, seconds);
    this.lastTick = time;
    this.state.snapshot = this.makeSnapshot(time, scenario, source, stopped);
    this.updateHistory(this.state.snapshot);
    this.reconcileAlerts();
    if (time - this.lastLog >= 30000 && this.state.snapshot.connected) {
      this.addEvent('telemetry', `Simulated heartbeat received; ${this.state.snapshot.metrics.flow.value?.toFixed(1)} L/min supplied from ${source}.`);
      this.lastLog = time;
    }
    this.recordTransitions(previous, this.state.snapshot);
    this.notify();
  };

  getHistory = (metric: MetricKey, range: HistoryRange): HistoryPoint[] => {
    const hours = { '1h': 1, '6h': 6, '24h': 24 }[range];
    const cutoff = new Date(this.state.snapshot.timestamp).getTime() - hours * 3600000;
    return this.state.history.filter(point => new Date(point.timestamp).getTime() >= cutoff).map(point => ({ ...point.metrics[metric], timestamp: point.timestamp }));
  };

  private reconcileAlerts() {
    const { snapshot: s, thresholds: t } = this.state;
    const triggered: { key: string; equipment: EquipmentId; title: string; message: string; severity: Alert['severity'] }[] = [];
    const out = s.metrics.turbidityOut.value;
    const delta = s.metrics.pressureDelta.value;
    const level = s.metrics.tankLevel.value;
    if (!s.connected) triggered.push({ key: 'offline', equipment: 'homes', title: 'Telemetry offline', message: 'Live readings are stale. Restore the device connection before submitting controls.', severity: 'critical' });
    if (out !== null && out > t.turbidityOut) triggered.push({ key: 'turbidity', equipment: 'membrane', title: 'Outlet turbidity elevated', message: `${out.toFixed(2)} NTU exceeds the illustrative ${t.turbidityOut.toFixed(2)} NTU threshold. Clean baseline: ${CLEAN_BASELINE.turbidityOut} NTU.`, severity: 'warning' });
    if (delta !== null && delta > t.pressureDelta) triggered.push({ key: 'pressure', equipment: 'membrane', title: 'Membrane pressure loss rising', message: `${delta.toFixed(2)} bar exceeds the illustrative ${t.pressureDelta.toFixed(2)} bar threshold. Clean baseline: ${CLEAN_BASELINE.pressureDelta} bar. Inspect flow and filter condition.`, severity: 'warning' });
    if (level !== null && level < t.lowTank) triggered.push({ key: 'lowtank', equipment: 'tank', title: 'Rainwater reserve low', message: `${level.toFixed(1)}% remaining; minimum operating reserve is ${t.lowTank}%. Mains backup is available.`, severity: 'warning' });
    if (s.stopped) triggered.push({ key: 'stop', equipment: 'pump', title: 'Emergency stop latched', message: 'Treatment has stopped. An explicit operator reset is required.', severity: 'critical' });
    const activeKeys = triggered.map(alert => alert.key);
    let alerts = this.state.alerts.map(alert => {
      const key = alert.id.split(':')[0];
      if (alert.status === 'active' && !activeKeys.includes(key) && !( !s.connected && ['pressure', 'turbidity', 'lowtank'].includes(key))) {
        this.addEvent('alert', `Resolved: ${alert.title}`, 'info', alert.equipment);
        return { ...alert, status: 'resolved' as const, resolvedAt: this.timestamp() };
      }
      return alert;
    });
    for (const trigger of triggered) {
      if (!alerts.some(alert => alert.id.startsWith(`${trigger.key}:`) && alert.status === 'active')) {
        const { key, ...content } = trigger;
        const alert: Alert = { ...content, id: `${key}:${this.id('alert')}`, status: 'active', createdAt: this.timestamp() };
        alerts = [alert, ...alerts];
        this.addEvent('alert', `Raised: ${alert.title}`, trigger.severity === 'critical' ? 'error' : 'warning', trigger.equipment);
      }
    }
    this.state.alerts = alerts.slice(0, 100);
  }

  // ----------------------------------------------------------------- overrides
  // The demo-side twin of the engine's override map (DESIGN.md section 6.1). Never
  // persisted: an override surviving a reload is a trap.

  private activeOverrides(time: number) {
    return (this.state?.overrides ?? []).filter(override => new Date(override.expiresAt).getTime() > time);
  }

  private expireOverrides(time: number) {
    const live = this.activeOverrides(time);
    if (live.length === this.state.overrides.length) return;
    for (const override of this.state.overrides.filter(item => !live.includes(item))) {
      this.addEvent('scenario', `Demo override expired: ${METRICS[override.metric].label}.`, 'info', METRICS[override.metric].equipment);
    }
    this.state.overrides = live;
  }

  /** Recompute from the current overrides and log the change, mirroring `set_override`. */
  private applyOverrides(overrides: Override[], message: string, level: EventRecord['level'], equipment?: EquipmentId) {
    const previous = this.state.snapshot;
    this.state.overrides = overrides;
    this.state.snapshot = this.makeSnapshot(this.now(), previous.scenario, previous.source, previous.stopped);
    this.updateHistory(this.state.snapshot);
    this.addEvent('scenario', message, level, equipment);
    this.recordTransitions(previous, this.state.snapshot);
    this.reconcileAlerts();
    this.notify(true);
  }

  setOverride = (metric: MetricKey, value: number | null, quality: Quality = 'valid', ttlSeconds = 300): Result => {
    if (!(metric in METRICS)) return { ok: false, message: 'Choose a reading to override.' };
    if (quality === 'valid' && (value === null || !Number.isFinite(value))) return { ok: false, message: 'A forced reading needs a number. Enter a value, or force the signal stale or unavailable instead.' };
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) return { ok: false, message: 'Choose a duration between 1 second and 1 hour.' };
    const info = METRICS[metric];
    const override: Override = { metric, value: quality === 'valid' ? rounding(value!, 3) : null, quality, expiresAt: new Date(this.now() + ttlSeconds * 1000).toISOString() };
    const forced = quality === 'valid' ? `${override.value} ${info.unit}` : quality === 'stale' ? 'a stale signal' : 'no signal';
    this.applyOverrides([override, ...this.state.overrides.filter(item => item.metric !== metric)],
      `Demo override set: ${info.label} forced to ${forced} for ${Math.round(ttlSeconds)}s.`, 'warning', info.equipment);
    return { ok: true, message: `${info.label} is forced to ${forced} for the next ${Math.round(ttlSeconds / 60)} minute${ttlSeconds >= 120 ? 's' : ''}.` };
  };

  clearOverride = (metric: MetricKey): Result => {
    if (!this.state.overrides.some(override => override.metric === metric)) return { ok: false, message: 'No override is active on that reading.' };
    this.applyOverrides(this.state.overrides.filter(override => override.metric !== metric),
      `Demo override cleared: ${METRICS[metric].label}.`, 'info', METRICS[metric].equipment);
    return { ok: true, message: `${METRICS[metric].label} is back on simulated readings.` };
  };

  clearOverrides = (): Result => {
    if (!this.state.overrides.length) return { ok: false, message: 'No overrides are active.' };
    this.applyOverrides([], `Demo overrides cleared: ${this.state.overrides.map(override => METRICS[override.metric].label).join(', ')}.`, 'info');
    return { ok: true, message: 'All readings are back on simulated values.' };
  };

  setScenario = (scenario: Scenario) => {
    if (!SCENARIOS.includes(scenario)) return;
    const previous = this.state.snapshot;
    this.state.snapshot = this.makeSnapshot(this.now(), scenario, this.state.snapshot.source, this.state.snapshot.stopped);
    this.lastTick = this.now();
    this.updateHistory(this.state.snapshot);
    this.addEvent('scenario', `Demo scenario selected: ${SCENARIO_LABELS[scenario]}.`);
    this.recordTransitions(previous, this.state.snapshot);
    this.reconcileAlerts();
    this.notify(true);
  };

  acknowledgeAlert = (id: string) => {
    const alert = this.state.alerts.find(item => item.id === id);
    if (!alert || alert.acknowledgedAt) return;
    this.state.alerts = this.state.alerts.map(item => item.id === id ? { ...item, acknowledgedAt: this.timestamp() } : item);
    this.addEvent('alert', `Acknowledged: ${alert.title}. The condition remains ${alert.status}.`, 'info', alert.equipment);
    this.notify(true);
  };

  sendCommand = async (command: Command): Promise<CommandResult> => {
    const id = this.id('command');
    if (this.state.command?.status === 'pending') {
      this.addEvent('command', 'Concurrent command rejected: another command is awaiting confirmation.', 'warning');
      this.notify();
      return { id, type: command.type, status: 'rejected', message: 'Another command is awaiting confirmation.', timestamp: this.timestamp() };
    }
    const generation = this.generation;
    this.state.command = { id, type: command.type, status: 'pending', message: 'Waiting for simulated device confirmation…', timestamp: this.timestamp() };
    this.addEvent('command', `Requested ${command.type === 'source' ? `source switch to ${command.source}` : command.type}.`);
    this.notify();
    await new Promise(resolve => setTimeout(resolve, this.state.snapshot.connected ? this.commandDelayMs : this.timeoutMs));
    let status: CommandResult['status'] = 'confirmed';
    let message = 'Command confirmed by simulated device.';
    if (generation !== this.generation) return { id, type: command.type, status: 'rejected', message: 'Command cancelled by demo reset.', timestamp: this.timestamp() };
    if (!this.state.snapshot.connected) { status = 'timeout'; message = 'No device acknowledgment received. Restore telemetry and try again.'; }
    else if (command.type === 'source' && !this.state.snapshot.sourceAvailability[command.source]) { status = 'rejected'; message = `${command.source === 'rainwater' ? 'Rainwater' : 'Mains'} supply is unavailable.`; }
    else if (command.type === 'reset' && !this.state.snapshot.sourceAvailability[this.state.snapshot.source]) { status = 'rejected'; message = 'The selected source is unavailable. Select an available source before resetting.'; }
    else {
      const current = this.state.snapshot;
      const source = command.type === 'source' ? command.source : current.source;
      const stopped = command.type === 'stop' ? true : command.type === 'reset' ? false : current.stopped;
      this.state.snapshot = this.makeSnapshot(this.now(), current.scenario, source, stopped);
      this.recordTransitions(current, this.state.snapshot);
      this.lastTick = this.now();
      this.updateHistory(this.state.snapshot);
      message = command.type === 'source' ? `Supply switched to ${source}.` : command.type === 'stop' ? 'Emergency stop confirmed. Treatment is latched off.' : 'Stop latch reset. Treatment can resume.';
    }
    this.state.command = { id, type: command.type, status, message, timestamp: this.timestamp() };
    this.addEvent('command', message, status === 'confirmed' ? 'info' : status === 'timeout' ? 'error' : 'warning', command.type === 'source' ? command.source === 'rainwater' ? 'tank' : 'mains' : 'pump');
    this.reconcileAlerts();
    this.notify(true);
    return this.state.command;
  };

  addTask = (equipment: EquipmentId, description: string): Result => {
    if (!EQUIPMENT[equipment] || !description.trim()) return { ok: false, message: 'Select equipment and describe the maintenance work.' };
    this.state.tasks = [{ id: this.id('task'), equipment, description: description.trim(), status: 'open', createdAt: this.timestamp() }, ...this.state.tasks];
    this.addEvent('maintenance', `Task created: ${description.trim()}`, 'info', equipment);
    this.notify(true);
    return { ok: true, message: 'Maintenance task created.' };
  };

  completeTask = (id: string, itemId?: string, quantity = 1): Result => {
    const task = this.state.tasks.find(item => item.id === id);
    if (!task || task.status === 'completed') return { ok: false, message: 'This task is already complete or unavailable.' };
    const item = itemId ? this.state.inventory.find(entry => entry.id === itemId) : null;
    if (itemId && (!item || !Number.isInteger(quantity) || quantity < 1 || item.quantity < quantity)) return { ok: false, message: 'The selected supply quantity is invalid or exceeds available stock.' };
    if (item) this.state.inventory = this.state.inventory.map(entry => entry.id === item.id ? { ...entry, quantity: entry.quantity - quantity } : entry);
    this.state.tasks = this.state.tasks.map(entry => entry.id === id ? { ...entry, status: 'completed', completedAt: this.timestamp(), suppliesUsed: item ? [{ itemId: item.id, quantity }] : [] } : entry);
    this.addEvent('maintenance', `Completed: ${task.description}${item ? `; used ${quantity} ${item.name}` : ''}. Telemetry determines fault recovery.`, 'info', task.equipment);
    this.notify(true);
    return { ok: true, message: 'Maintenance recorded. Review the sensor trend to confirm recovery.' };
  };

  adjustInventory = (id: string, delta: number): Result => {
    const item = this.state.inventory.find(entry => entry.id === id);
    if (!item || !Number.isInteger(delta) || item.quantity + delta < 0) return { ok: false, message: 'Stock cannot be negative; use a whole-number adjustment.' };
    this.state.inventory = this.state.inventory.map(entry => entry.id === id ? { ...entry, quantity: entry.quantity + delta } : entry);
    this.addEvent('inventory', `${item.name} stock adjusted by ${delta > 0 ? '+' : ''}${delta}.`);
    this.notify(true);
    return { ok: true, message: 'Inventory updated.' };
  };

  createOrder = (itemId: string, quantity: number): Result => {
    if (!this.state.inventory.some(item => item.id === itemId) || !Number.isInteger(quantity) || quantity < 1) return { ok: false, message: 'Choose a supply and a positive whole-number quantity.' };
    const stamp = this.timestamp();
    this.state.orders = [{ id: this.id('order'), itemId, quantity, status: 'draft', createdAt: stamp, updatedAt: stamp }, ...this.state.orders];
    this.addEvent('inventory', `Supply order drafted for ${quantity} ${this.state.inventory.find(item => item.id === itemId)?.name}.`);
    this.notify(true);
    return { ok: true, message: 'Draft supply order created.' };
  };

  advanceOrder = (id: string): Result => {
    const order = this.state.orders.find(item => item.id === id);
    if (!order || order.status === 'received') return { ok: false, message: 'This order is already received or unavailable.' };
    const status = order.status === 'draft' ? 'ordered' : 'received';
    this.state.orders = this.state.orders.map(item => item.id === id ? { ...item, status, updatedAt: this.timestamp() } : item);
    if (status === 'received') this.state.inventory = this.state.inventory.map(item => item.id === order.itemId ? { ...item, quantity: item.quantity + order.quantity } : item);
    this.addEvent('inventory', `Supply order ${id} ${status}${status === 'received' ? '; stock added once' : ''}.`);
    this.notify(true);
    return { ok: true, message: status === 'received' ? 'Supplies received and added to inventory.' : 'Supply order marked ordered.' };
  };

  reportIncident = (description: string): Result => {
    if (!description.trim()) return { ok: false, message: 'Describe the issue before submitting.' };
    this.state.incidents = [{ id: this.id('incident'), description: description.trim(), source: 'resident', status: 'open', createdAt: this.timestamp() }, ...this.state.incidents];
    this.addEvent('incident', `Resident issue reported: ${description.trim()}`);
    this.notify(true);
    return { ok: true, message: 'Issue reported to the operator.' };
  };

  private validThresholds(value: Partial<Thresholds>) {
    return Object.entries(value).every(([key, amount]) => ['turbidityOut', 'pressureDelta', 'lowTank'].includes(key) && Number.isFinite(amount) && amount! > 0 && (key !== 'lowTank' || amount! < 100));
  }
  setThresholds = (partial: Partial<Thresholds>) => {
    if (!this.validThresholds(partial)) return;
    const previous = this.state.snapshot;
    this.state.thresholds = { ...this.state.thresholds, ...partial };
    this.state.snapshot = this.makeSnapshot(this.now(), this.state.snapshot.scenario, this.state.snapshot.source, this.state.snapshot.stopped);
    this.recordTransitions(previous, this.state.snapshot);
    this.reconcileAlerts();
    this.addEvent('maintenance', 'Illustrative alert thresholds updated. Clean-filter baseline is unchanged.');
    this.notify(true);
  };

  resetDemo = () => {
    this.generation++;
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* The live demo can still reset. */ }
    this.initialize();
    this.addEvent('scenario', 'Demo reset to normal operation. Workflow records cleared.');
    this.notify(true);
  };

  readonly actions = {
    setScenario: this.setScenario,
    acknowledgeAlert: this.acknowledgeAlert,
    sendCommand: this.sendCommand,
    addTask: this.addTask,
    completeTask: this.completeTask,
    adjustInventory: this.adjustInventory,
    createOrder: this.createOrder,
    advanceOrder: this.advanceOrder,
    reportIncident: this.reportIncident,
    setThresholds: this.setThresholds,
    setOverride: this.setOverride,
    clearOverride: this.clearOverride,
    clearOverrides: this.clearOverrides,
    resetDemo: this.resetDemo,
  };
}

export const dataSource = new MaxisStore();

/** Demo and live sources expose the same surface; `mode` picks which one `useMaxis` reads.
 *  Switching re-subscribes every component without remounting. See DESIGN.md section 7. */
type Switchable = Pick<MaxisStore, 'subscribeState' | 'getState' | 'actions' | 'getHistory' | 'subscribe'>;
let active: Switchable = dataSource;
const switchListeners = new Set<() => void>();

export function setDataMode(mode: AppMode) {
  const next: Switchable = mode === 'live' ? (apiSource as unknown as Switchable) : dataSource;
  if (next === active) return;
  active = next;
  switchListeners.forEach(listener => listener());
}
export const activeSource = () => active;

function subscribeActive(callback: () => void) {
  let unsubscribe = active.subscribeState(callback);
  const onSwitch = () => { unsubscribe(); unsubscribe = active.subscribeState(callback); callback(); };
  switchListeners.add(onSwitch);
  return () => { unsubscribe(); switchListeners.delete(onSwitch); };
}

/** The live source has no state until its first fetch resolves; fall back to the demo
 *  store's shape so every component renders before the backend answers. */
const snapshotState = () => active.getState() ?? dataSource.getState();

export function useMaxis() {
  const state = useSyncExternalStore(subscribeActive, snapshotState, snapshotState);
  return { ...state, actions: active.actions };
}
