import type { Alert, AppMode, Command, CommandResult, EquipmentId, EventRecord, HistoryPoint, HistoryRange, Incident, InventoryItem, MaintenanceTask, MetricKey, Override, Quality, Scenario, Snapshot, StoreState, SupplyOrder, Thresholds } from '../types';
import { METRICS } from './catalog';

const BASE = '/api';
const STALE_AFTER_MS = 6000;
const RETRY_MS = 4000;
type Result = { ok: boolean; message: string };
type Columnar = { range: HistoryRange; step: number; t: string[]; series: Record<MetricKey, (number | null)[]> };

/** Rebuild the Snapshot[] the charts expect from the columnar payload. Only the fields the
 *  chart and CSV export read are reconstructed; status and alerts are live-only. */
function rehydrate(data: Columnar, template: Snapshot): Snapshot[] {
  return data.t.map((timestamp, index) => {
    const metrics = {} as Snapshot['metrics'];
    for (const key of Object.keys(METRICS) as MetricKey[]) {
      const value = data.series[key]?.[index] ?? null;
      metrics[key] = { installationId: template.installationId, equipmentId: METRICS[key].equipment, metric: key, value, unit: METRICS[key].unit, quality: value === null ? 'unavailable' : 'valid', timestamp };
    }
    return { ...template, timestamp, metrics, events: [] };
  });
}

/**
 * Live data source. Mirrors MaxisStore's public surface exactly so `useMaxis` can swap
 * between them; see DESIGN.md section 7.
 */
export class ApiSource {
  private state: StoreState | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Set<(snapshot: Snapshot) => void>();
  private source: EventSource | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setInterval> | null = null;
  private loading = false;
  lastError: string | null = null;

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...init });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.detail ?? `${response.status} ${response.statusText}`);
    }
    return response.status === 204 ? (null as T) : response.json();
  }

  private emit() { this.listeners.forEach(fn => fn()); if (this.state) this.streams.forEach(fn => fn(this.state!.snapshot)); }

  private async bootstrap() {
    if (this.loading) return;
    this.loading = true;
    try {
      const [data, overrides] = await Promise.all([
        this.request<any>('/bootstrap?range=24h'),
        // Demo-only route; a backend built without the simulator simply has no overrides.
        this.request<Override[]>('/sim/override').catch(() => [] as Override[]),
      ]);
      this.state = {
        snapshot: data.snapshot, history: rehydrate(data.series, data.snapshot),
        alerts: data.alerts, events: data.events, inventory: data.inventory,
        orders: data.orders, tasks: data.tasks, incidents: data.incidents,
        thresholds: data.thresholds, overrides, command: null,
      };
      this.lastError = null;
      this.stopRetry();
      this.connect();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Backend unreachable.';
      this.scheduleRetry();
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  private connect() {
    this.source?.close();
    this.source = new EventSource(`${BASE}/stream`);
    this.source.addEventListener('snapshot', event => {
      const snapshot: Snapshot = JSON.parse((event as MessageEvent).data);
      if (!this.state) return;
      this.state = { ...this.state, snapshot, events: snapshot.events, history: this.appendMinute(snapshot) };
      this.lastError = null;
      this.stopRetry();
      this.armWatchdog();
      this.emit();
      void this.refreshAlerts();
    });
    // EventSource only retries by itself after a clean socket drop. A proxy or load balancer
    // answering 5xx fails the connection permanently, so recovery needs an explicit retry --
    // which must re-bootstrap rather than just reopen the stream, to refill the history gap
    // and resync alerts and workflow records.
    this.source.onerror = () => { this.markStale(); this.scheduleRetry(); };
    this.armWatchdog();
  }

  /** Same minute-bucket last-write-wins as the demo store, so the chart edge advances
   *  without refetching the range. */
  private appendMinute(snapshot: Snapshot): Snapshot[] {
    const history = this.state!.history;
    const minute = Math.floor(new Date(snapshot.timestamp).getTime() / 60000);
    const last = history.at(-1);
    const sameMinute = last && Math.floor(new Date(last.timestamp).getTime() / 60000) === minute;
    const next = sameMinute ? [...history.slice(0, -1), snapshot] : [...history, snapshot];
    const cutoff = new Date(snapshot.timestamp).getTime() - 86400000;
    return next.filter(point => new Date(point.timestamp).getTime() >= cutoff);
  }

  private scheduleRetry() {
    if (this.retry) return;
    this.retry = setInterval(() => { if (!this.loading) void this.bootstrap(); }, RETRY_MS);
  }

  private stopRetry() {
    if (this.retry) { clearInterval(this.retry); this.retry = null; }
  }

  private armWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.markStale(), STALE_AFTER_MS);
  }

  /** The server cannot tell us it died. Degrade the last known snapshot in place, keeping
   *  each reading's timestamp so cards read "stale · last seen 14:32". */
  private markStale() {
    this.scheduleRetry();
    if (!this.state || !this.state.snapshot.connected) return;
    const previous = this.state.snapshot;
    const metrics = {} as Snapshot['metrics'];
    for (const key of Object.keys(previous.metrics) as MetricKey[]) metrics[key] = { ...previous.metrics[key], quality: 'stale' };
    const equipment = {} as Snapshot['equipment'];
    for (const key of Object.keys(previous.equipment) as EquipmentId[]) equipment[key] = { ...previous.equipment[key], status: 'offline' };
    this.state = { ...this.state, snapshot: { ...previous, connected: false, metrics, equipment, sourceAvailability: { rainwater: false, mains: false } } };
    this.lastError = 'Lost contact with the backend.';
    this.emit();
  }

  private async refreshAlerts() {
    try {
      const [alerts, events, overrides] = await Promise.all([
        this.request<Alert[]>('/alerts'), this.request<EventRecord[]>('/events?limit=300'),
        this.request<Override[]>('/sim/override').catch(() => this.state?.overrides ?? []),
      ]);
      if (this.state) { this.state = { ...this.state, alerts, events, overrides }; this.emit(); }
    } catch { /* The stream keeps the dashboard live even when a side fetch fails. */ }
  }

  private async reload(keys: ('tasks' | 'inventory' | 'orders' | 'incidents')[]) {
    const entries = await Promise.all(keys.map(async key => [key, await this.request<unknown>(`/${key}`)] as const));
    if (this.state) { this.state = { ...this.state, ...Object.fromEntries(entries) }; this.emit(); }
  }

  /** Workflow actions are synchronous in the UI, so these report the locally validated
   *  outcome and reconcile from the server's reply. The server is authoritative: a rejection
   *  is logged and the affected collections are refetched. */
  private submit(path: string, body: unknown, keys: ('tasks' | 'inventory' | 'orders' | 'incidents')[], ok: string): Result {
    void (async () => {
      try { await this.request(path, { method: 'POST', body: JSON.stringify(body) }); }
      catch (error) { this.lastError = error instanceof Error ? error.message : 'Request failed.'; }
      finally { await this.reload(keys).catch(() => undefined); }
    })();
    return { ok: true, message: ok };
  }

  private async refreshOverrides() {
    const overrides = await this.request<Override[]>('/sim/override');
    if (this.state) { this.state = { ...this.state, overrides }; this.emit(); }
  }

  private mutateOverride(path: string, init: RequestInit) {
    void (async () => {
      try { await this.request(path, init); }
      catch (error) { this.lastError = error instanceof Error ? error.message : 'The override could not be applied.'; }
      finally { await Promise.all([this.refreshOverrides(), this.refreshAlerts()]).catch(() => undefined); }
    })();
  }

  subscribeState = (callback: () => void) => {
    this.listeners.add(callback);
    if (!this.state) void this.bootstrap();
    return () => { this.listeners.delete(callback); };
  };
  subscribe = (callback: (snapshot: Snapshot) => void) => {
    this.streams.add(callback);
    if (this.state) callback(this.state.snapshot); else void this.bootstrap();
    return () => { this.streams.delete(callback); };
  };
  getState = () => this.state;

  getHistory = (metric: MetricKey, range: HistoryRange): HistoryPoint[] => {
    if (!this.state) return [];
    const hours = { '1h': 1, '6h': 6, '24h': 24 }[range];
    const cutoff = new Date(this.state.snapshot.timestamp).getTime() - hours * 3600000;
    return this.state.history.filter(p => new Date(p.timestamp).getTime() >= cutoff).map(p => ({ ...p.metrics[metric], timestamp: p.timestamp }));
  };

  sendCommand = async (command: Command): Promise<CommandResult> => {
    const pending: CommandResult = { id: 'pending', type: command.type, status: 'pending', message: 'Waiting for device confirmation…', timestamp: new Date().toISOString() };
    if (this.state) { this.state = { ...this.state, command: pending }; this.emit(); }
    try {
      const result = await this.request<CommandResult>('/commands', { method: 'POST', body: JSON.stringify(command) });
      if (this.state) { this.state = { ...this.state, command: result }; this.emit(); }
      void this.refreshAlerts();
      return result;
    } catch (error) {
      const failed: CommandResult = { ...pending, status: 'timeout', message: error instanceof Error ? error.message : 'Command failed.' };
      if (this.state) { this.state = { ...this.state, command: failed }; this.emit(); }
      return failed;
    }
  };

  readonly actions = {
    setScenario: (scenario: Scenario) => { void this.request(`/sim/scenario?scenario=${scenario}`, { method: 'POST' }).then(() => this.refreshAlerts()); },
    acknowledgeAlert: (id: string) => { void this.request(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: 'POST' }).then(() => this.refreshAlerts()); },
    sendCommand: this.sendCommand,
    addTask: (equipment: EquipmentId, description: string): Result =>
      !description.trim() ? { ok: false, message: 'Select equipment and describe the maintenance work.' }
        : this.submit('/tasks', { equipment, description }, ['tasks'], 'Maintenance task created.'),
    completeTask: (id: string, itemId?: string, quantity = 1): Result => {
      const item = itemId ? this.state?.inventory.find(entry => entry.id === itemId) : null;
      if (itemId && (!item || !Number.isInteger(quantity) || quantity < 1 || item.quantity < quantity)) return { ok: false, message: 'The selected supply quantity is invalid or exceeds available stock.' };
      return this.submit(`/tasks/${encodeURIComponent(id)}/complete`, { itemId: itemId ?? null, quantity }, ['tasks', 'inventory'], 'Maintenance recorded. Review the sensor trend to confirm recovery.');
    },
    adjustInventory: (id: string, delta: number): Result => {
      const item = this.state?.inventory.find(entry => entry.id === id);
      if (!item || !Number.isInteger(delta) || item.quantity + delta < 0) return { ok: false, message: 'Stock cannot be negative; use a whole-number adjustment.' };
      return this.submit(`/inventory/${encodeURIComponent(id)}/adjust`, { delta }, ['inventory'], 'Inventory updated.');
    },
    createOrder: (itemId: string, quantity: number): Result =>
      !this.state?.inventory.some(item => item.id === itemId) || !Number.isInteger(quantity) || quantity < 1
        ? { ok: false, message: 'Choose a supply and a positive whole-number quantity.' }
        : this.submit('/orders', { itemId, quantity }, ['orders'], 'Draft supply order created.'),
    advanceOrder: (id: string): Result => {
      const order = this.state?.orders.find(item => item.id === id);
      if (!order || order.status === 'received') return { ok: false, message: 'This order is already received or unavailable.' };
      return this.submit(`/orders/${encodeURIComponent(id)}/advance`, {}, ['orders', 'inventory'], order.status === 'draft' ? 'Supply order marked ordered.' : 'Supplies received and added to inventory.');
    },
    reportIncident: (description: string): Result =>
      !description.trim() ? { ok: false, message: 'Describe the issue before submitting.' }
        : this.submit('/incidents', { description }, ['incidents'], 'Issue reported to the operator.'),
    /** Force one reading, to stage a failure on demand. The server owns the TTL and the
     *  audit event; this reports the locally validated outcome and reconciles from its reply. */
    setOverride: (metric: MetricKey, value: number | null, quality: Quality = 'valid', ttlSeconds = 300): Result => {
      if (!METRICS[metric]) return { ok: false, message: 'Choose a reading to override.' };
      if (quality === 'valid' && (value === null || !Number.isFinite(value))) return { ok: false, message: 'A forced reading needs a number. Enter a value, or force the signal stale or unavailable instead.' };
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) return { ok: false, message: 'Choose a duration between 1 second and 1 hour.' };
      const info = METRICS[metric];
      const forced = quality === 'valid' ? `${value} ${info.unit}` : quality === 'stale' ? 'a stale signal' : 'no signal';
      this.mutateOverride(`/sim/override/${encodeURIComponent(metric)}`, { method: 'PUT', body: JSON.stringify({ value: quality === 'valid' ? value : null, quality, ttlS: ttlSeconds }) });
      return { ok: true, message: `${info.label} is forced to ${forced} for the next ${Math.round(ttlSeconds / 60)} minute${ttlSeconds >= 120 ? 's' : ''}.` };
    },
    clearOverride: (metric: MetricKey): Result => {
      if (!this.state?.overrides.some(override => override.metric === metric)) return { ok: false, message: 'No override is active on that reading.' };
      this.mutateOverride(`/sim/override/${encodeURIComponent(metric)}`, { method: 'DELETE' });
      return { ok: true, message: `${METRICS[metric].label} is back on measured readings.` };
    },
    clearOverrides: (): Result => {
      const active = this.state?.overrides ?? [];
      if (!active.length) return { ok: false, message: 'No overrides are active.' };
      for (const override of active) this.mutateOverride(`/sim/override/${encodeURIComponent(override.metric)}`, { method: 'DELETE' });
      return { ok: true, message: 'All readings are back on measured values.' };
    },
    setThresholds: (partial: Partial<Thresholds>) => {
      void this.request<Thresholds>('/thresholds', { method: 'PATCH', body: JSON.stringify(partial) })
        .then(thresholds => { if (this.state) { this.state = { ...this.state, thresholds }; this.emit(); } return this.refreshAlerts(); });
    },
    resetDemo: () => { void this.request('/sim/reset', { method: 'POST' }).then(() => this.reload(['tasks', 'inventory', 'orders', 'incidents'])).then(() => this.refreshAlerts()).then(() => this.refreshOverrides()); },
  };

  disconnect() {
    this.source?.close();
    this.source = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.stopRetry();
  }
}

export const apiSource = new ApiSource();
export type { AppMode, InventoryItem, MaintenanceTask, SupplyOrder, Incident };
