import type { EquipmentId, MetricKey } from '../types';

export interface EquipmentMetadata {
  name: string;
  tag: string;
  type: string;
  totalAreaCapacity: string;
  tenantsServing: string;
  operationalSince: string;
  primaryMetric: MetricKey;
  secondaryMetric?: MetricKey;
  nominalNote: string;
  warningNote: string;
}

export const ASSET_METADATA: Record<EquipmentId, EquipmentMetadata> = {
  tank: {
    name: 'Rainwater Storage Tank',
    tag: '#TK-101',
    type: 'Atmospheric Corrugated Cistern',
    totalAreaCapacity: '10,000 L (10.0 m³)',
    tenantsServing: '6 Residential Units (MX-001)',
    operationalSince: '2021',
    primaryMetric: 'tankLevel',
    secondaryMetric: 'tankVolume',
    nominalNote: 'Storage capacity operating within certified nominal reserve.',
    warningNote: 'Storage level below operating threshold; consider source switch.',
  },
  membrane: {
    name: 'Ultrafiltration Membrane Skid',
    tag: '#MF-204',
    type: 'High-Flux Hollow-Fiber Module',
    totalAreaCapacity: '45.0 m² · 35 L/min Design Flux',
    tenantsServing: 'Township Central Treatment Line',
    operationalSince: '2022',
    primaryMetric: 'turbidityOut',
    secondaryMetric: 'pressureDelta',
    nominalNote: 'Turbidity and transmembrane pressure within clean baseline limits.',
    warningNote: 'Elevated differential pressure detected; chemical backwash advised.',
  },
  pump: {
    name: 'Raw Water Booster Pump',
    tag: '#PM-301',
    type: 'Variable Frequency Centrifugal Skid',
    totalAreaCapacity: '4.5 kW · 45 L/min Max Flow',
    tenantsServing: 'Membrane Feed Manifold',
    operationalSince: '2021',
    primaryMetric: 'pumpPower',
    secondaryMetric: 'flow',
    nominalNote: 'VFD operating in auto-modulation curve with normal vibration profile.',
    warningNote: 'Pump energy consumption deviating +15% from hydraulic curve.',
  },
  uv: {
    name: 'UV-C Disinfection Chamber',
    tag: '#UV-402',
    type: 'Medium-Pressure Reactor (254 nm)',
    totalAreaCapacity: '40 mJ/cm² UV Fluence Dose',
    tenantsServing: 'Potable Disinfection Line',
    operationalSince: '2022',
    primaryMetric: 'uvPower',
    secondaryMetric: 'flow',
    nominalNote: 'Photometric lamp output at 98.4% rated intensity with zero quartz scaling.',
    warningNote: 'UV sleeve transmissivity reduced; wipe cycle scheduled.',
  },
  solar: {
    name: 'Photovoltaic Solar Canopy',
    tag: '#PV-501',
    type: 'Monocrystalline Bifacial Array (16-panel)',
    totalAreaCapacity: '6.8 kWp Peak Generation Capacity',
    tenantsServing: 'On-site Microgrid & Pumps',
    operationalSince: '2021',
    primaryMetric: 'solarPower',
    secondaryMetric: 'solarEnergy',
    nominalNote: 'Bifacial generation active with maximum power point tracking.',
    warningNote: 'Generation reduced due to cloud cover / overcast weather.',
  },
  mains: {
    name: 'Mains Interconnection & Backflow',
    tag: '#MS-601',
    type: 'Municipal Pressurized Dual-Check Station',
    totalAreaCapacity: '50 mm Flanged · 4.8 Bar Regulated',
    tenantsServing: 'Automated Redundant Town Supply',
    operationalSince: '2020',
    primaryMetric: 'mainsPressure',
    secondaryMetric: 'mainsTurbidity',
    nominalNote: 'Municipal standby connection pressurized and ready for auto-switch.',
    warningNote: 'Mains backup currently serving network during maintenance.',
  },
  homes: {
    name: 'Skyline Community & Commercial',
    tag: '#CM-701',
    type: 'Mixed-use Township Precinct',
    totalAreaCapacity: '45,000 m² · 1,224 Active Units',
    tenantsServing: '6 Residential Blocks + Retail',
    operationalSince: '2018',
    primaryMetric: 'flow',
    secondaryMetric: 'rainUsage',
    nominalNote: 'Municipal reticulation supply pressure nominal at all riser feeds.',
    warningNote: 'Elevated daytime demand peak detected on south township riser.',
  },
};
