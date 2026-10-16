export type EquipmentId = 'tank' | 'pump' | 'membrane' | 'uv' | 'solar' | 'mains' | 'homes';
export type Scenario = 'normal' | 'heavy-rain' | 'filter-degradation' | 'low-tank' | 'sensor-offline' | 'recovery';
export type Source = 'rainwater' | 'mains';
export type MetricKey = 'tankLevel' | 'tankVolume' | 'turbidityIn' | 'turbidityOut' | 'pressureIn' | 'pressureOut' | 'pressureDelta' | 'flow' | 'rainUsage' | 'mainsUsage' | 'solarPower' | 'pumpPower' | 'uvPower' | 'miscPower' | 'totalPower' | 'solarEnergy' | 'pumpEnergy' | 'uvEnergy' | 'miscEnergy' | 'totalEnergy' | 'mainsTurbidity' | 'mainsPressure' | 'mainsCapacity' | 'heartbeat';
export type AppMode = 'live' | 'test';
export type Quality = 'valid' | 'stale' | 'unavailable';
export interface MetricReading {
  installationId: string;
  equipmentId: EquipmentId;
  metric: MetricKey;
  value: number | null;
  unit: string;
  quality: Quality;
  timestamp: string;
}
export type EquipmentStatus = 'normal' | 'warning' | 'critical' | 'offline' | 'stopped';
export interface Snapshot {
  installationId: string;
  timestamp: string;
  scenario: Scenario;
  source: Source;
  stopped: boolean;
  connected: boolean;
  sourceAvailability: { rainwater: boolean; mains: boolean };
  metrics: Record<MetricKey, MetricReading>;
  equipment: Record<EquipmentId, { status: EquipmentStatus; label: string }>;
  events: EventRecord[];
}
export type HistoryRange = '1h' | '6h' | '24h';
export interface HistoryPoint extends MetricReading {}
export type Command = { type: 'source'; source: Source } | { type: 'stop' } | { type: 'reset' };
export interface CommandResult {
  id: string;
  type: Command['type'];
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout';
  message: string;
  timestamp: string;
}
export interface Alert {
  id: string;
  equipment: EquipmentId;
  title: string;
  message: string;
  severity: 'warning' | 'critical';
  status: 'active' | 'resolved';
  createdAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
}
export interface EventRecord {
  id: string;
  timestamp: string;
  type: 'telemetry' | 'scenario' | 'command' | 'alert' | 'maintenance' | 'inventory' | 'incident' | 'connection';
  level: 'info' | 'warning' | 'error';
  equipment?: EquipmentId;
  message: string;
}
export interface InventoryItem { id: string; name: string; category: string; quantity: number; unit: string; minimum: number; }
export interface SupplyOrder { id: string; itemId: string; quantity: number; status: 'draft' | 'ordered' | 'received'; createdAt: string; updatedAt: string; }
export interface MaintenanceTask { id: string; equipment: EquipmentId; description: string; status: 'open' | 'completed'; createdAt: string; completedAt?: string; suppliesUsed?: { itemId: string; quantity: number }[]; }
export interface Incident { id: string; description: string; source: 'resident' | 'operator'; status: 'open' | 'resolved'; createdAt: string; }
export interface Thresholds { turbidityOut: number; pressureDelta: number; lowTank: number; }
/** A forced reading, for demonstrating a failure without waiting for one. Ephemeral by
 *  design -- see DESIGN.md section 6.1; the backend keeps the same shape. */
export interface Override { metric: MetricKey; value: number | null; quality: Quality; expiresAt: string; }
export interface StoreState {
  snapshot: Snapshot;
  history: Snapshot[];
  alerts: Alert[];
  events: EventRecord[];
  inventory: InventoryItem[];
  orders: SupplyOrder[];
  tasks: MaintenanceTask[];
  incidents: Incident[];
  thresholds: Thresholds;
  overrides: Override[];
  command: CommandResult | null;
}
export interface DataSource {
  subscribe(callback: (snapshot: Snapshot) => void): () => void;
  getHistory(metric: MetricKey, range: HistoryRange): HistoryPoint[];
  sendCommand(command: Command): Promise<CommandResult>;
}
