import type { EquipmentId, MetricKey, Scenario } from '../types';

export const INSTALLATION_ID = 'MX-001';
export const TANK_CAPACITY_LITRES = 10000;
export const EQUIPMENT: Record<EquipmentId, string> = { tank: 'Rainwater tank', pump: 'Treatment pump', membrane: 'Membrane filter', uv: 'UV chamber', solar: 'Solar array', mains: 'Mains backup', homes: 'Residential supply' };
export const CLEAN_BASELINE = { turbidityOut: 0.22, pressureDelta: 0.45, flow: 18 };
export const SCENARIOS: Scenario[] = ['normal', 'heavy-rain', 'filter-degradation', 'low-tank', 'sensor-offline', 'recovery'];
export const SCENARIO_LABELS: Record<Scenario, string> = { normal: 'Normal', 'heavy-rain': 'Heavy Rain', 'filter-degradation': 'Filter Degradation', 'low-tank': 'Low Tank', 'sensor-offline': 'Sensor Offline', recovery: 'Recovery' };
export const SCENARIO_DESCRIPTIONS: Record<Scenario, string> = {
  normal: 'Stable treatment with healthy membrane performance.',
  'heavy-rain': 'Rainwater storage rises while inlet turbidity increases.',
  'filter-degradation': 'Pressure loss rises, treated flow drops and outlet turbidity increases.',
  'low-tank': 'Rainwater is below the operating reserve; mains backup remains available.',
  'sensor-offline': 'The telemetry connection is lost. Readings become stale and commands time out.',
  recovery: 'Restored filter performance and connected sensors after maintenance.',
};
export const METRICS: Record<MetricKey, { label: string; unit: string; equipment: EquipmentId }> = {
  tankLevel: { label: 'Rainwater capacity', unit: '%', equipment: 'tank' },
  tankVolume: { label: 'Stored rainwater', unit: 'L', equipment: 'tank' },
  turbidityIn: { label: 'Before-filter turbidity', unit: 'NTU', equipment: 'membrane' },
  turbidityOut: { label: 'After-filter turbidity', unit: 'NTU', equipment: 'membrane' },
  pressureIn: { label: 'Before-filter pressure', unit: 'bar', equipment: 'membrane' },
  pressureOut: { label: 'After-filter pressure', unit: 'bar', equipment: 'membrane' },
  pressureDelta: { label: 'Filter pressure difference', unit: 'bar', equipment: 'membrane' },
  flow: { label: 'Supply flow', unit: 'L/min', equipment: 'homes' },
  rainUsage: { label: 'Rainwater bulk meter', unit: 'm³', equipment: 'tank' },
  mainsUsage: { label: 'Mains bulk meter', unit: 'm³', equipment: 'mains' },
  solarPower: { label: 'Solar generation', unit: 'W', equipment: 'solar' },
  pumpPower: { label: 'Pump power', unit: 'W', equipment: 'pump' },
  uvPower: { label: 'UV power', unit: 'W', equipment: 'uv' },
  miscPower: { label: 'Miscellaneous power', unit: 'W', equipment: 'homes' },
  totalPower: { label: 'Total load', unit: 'W', equipment: 'homes' },
  solarEnergy: { label: 'Solar energy generated', unit: 'kWh', equipment: 'solar' },
  pumpEnergy: { label: 'Pump energy', unit: 'kWh', equipment: 'pump' },
  uvEnergy: { label: 'UV energy', unit: 'kWh', equipment: 'uv' },
  miscEnergy: { label: 'Miscellaneous energy', unit: 'kWh', equipment: 'homes' },
  totalEnergy: { label: 'Total consumed energy', unit: 'kWh', equipment: 'homes' },
  mainsTurbidity: { label: 'Mains turbidity', unit: 'NTU', equipment: 'mains' },
  mainsPressure: { label: 'Mains pressure', unit: 'bar', equipment: 'mains' },
  mainsCapacity: { label: 'Mains backup capacity', unit: '%', equipment: 'mains' },
  heartbeat: { label: 'Backend heartbeat latency', unit: 'ms', equipment: 'homes' },
};
