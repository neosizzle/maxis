import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../types';
import { CLEAN_BASELINE, MaxisStore, STORAGE_KEY, TANK_CAPACITY_LITRES } from './store';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const makeStore = (storage: MemoryStorage | null = null) => new MaxisStore({ autoTick: false, storage });
const advance = (store: MaxisStore, milliseconds: number) => { vi.setSystemTime(Date.now() + milliseconds); store.step(); };
async function command(store: MaxisStore, value: Command, delay = 650) {
  const promise = store.sendCommand(value);
  await vi.advanceTimersByTimeAsync(delay);
  return promise;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T04:00:00.000Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('shared telemetry and history', () => {
  it('seeds all metrics for 24h and offers the agreed history windows', () => {
    const store = makeStore();
    expect(store.getState().history).toHaveLength(1441);
    expect(store.getHistory('flow', '1h')).toHaveLength(61);
    expect(store.getHistory('flow', '6h')).toHaveLength(361);
    expect(store.getHistory('flow', '24h')).toHaveLength(1441);
    expect(store.getState().alerts).toHaveLength(0);
    expect(TANK_CAPACITY_LITRES).toBe(10000);
    expect(store.getState().snapshot.metrics.tankVolume.value!).toBeCloseTo(store.getState().snapshot.metrics.tankLevel.value! / 100 * TANK_CAPACITY_LITRES, 1);
    expect(store.getState().snapshot.metrics.totalPower.value).toBeCloseTo(
      store.getState().snapshot.metrics.pumpPower.value! + store.getState().snapshot.metrics.uvPower.value! + store.getState().snapshot.metrics.miscPower.value!, 2,
    );
  });

  it('runs exactly one shared two-second timer, with subscriber cleanup', async () => {
    const store = new MaxisStore({ storage: null });
    const first = vi.fn();
    const second = vi.fn();
    const unFirst = store.subscribe(first);
    const unSecond = store.subscribe(second);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second.mock.calls[1][0]).toBe(first.mock.calls[1][0]);
    expect(first.mock.calls[1][0].events.some((event: { type: string }) => event.type === 'connection')).toBe(true);
    unFirst();
    expect(vi.getTimerCount()).toBe(1);
    unSecond();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('integrates flow into the selected source meter and power into kWh', async () => {
    const store = makeStore();
    const before = store.getState().snapshot;
    advance(store, 2000);
    const after = store.getState().snapshot;
    expect(after.metrics.rainUsage.value! - before.metrics.rainUsage.value!).toBeCloseTo(after.metrics.flow.value! * 2 / 60 / 1000, 5);
    expect(after.metrics.mainsUsage.value).toBe(before.metrics.mainsUsage.value);
    expect(after.metrics.pumpEnergy.value! - before.metrics.pumpEnergy.value!).toBeCloseTo(after.metrics.pumpPower.value! * 2 / 3600000, 6);
    await command(store, { type: 'source', source: 'mains' });
    const switched = store.getState().snapshot;
    advance(store, 2000);
    const mains = store.getState().snapshot;
    expect(mains.metrics.rainUsage.value).toBe(switched.metrics.rainUsage.value);
    expect(mains.metrics.mainsUsage.value!).toBeGreaterThan(switched.metrics.mainsUsage.value!);
    expect(mains.metrics.pumpPower.value).toBe(0);
    expect(mains.metrics.pumpPower.quality).toBe('valid');
  });

  it('correlates filter degradation and keeps a fixed clean baseline', () => {
    const store = makeStore();
    const normal = store.getState().snapshot;
    store.setScenario('filter-degradation');
    const degraded = store.getState().snapshot;
    expect(degraded.metrics.pressureDelta.value!).toBeGreaterThan(normal.metrics.pressureDelta.value!);
    expect(degraded.metrics.flow.value!).toBeLessThan(normal.metrics.flow.value!);
    expect(degraded.metrics.turbidityOut.value!).toBeGreaterThan(normal.metrics.turbidityOut.value!);
    expect(CLEAN_BASELINE).toEqual({ turbidityOut: 0.22, pressureDelta: 0.45, flow: 18 });
    expect(store.getState().alerts.filter(alert => alert.status === 'active')).toHaveLength(2);
  });

  it('marks missing telemetry null/stale and retains its last signal timestamp', () => {
    const store = makeStore();
    const stamp = store.getState().snapshot.timestamp;
    advance(store, 2000);
    const lastValid = store.getState().snapshot.timestamp;
    store.setScenario('sensor-offline');
    advance(store, 60000);
    const offline = store.getState().snapshot;
    expect(offline.connected).toBe(false);
    expect(offline.metrics.flow.value).toBeNull();
    expect(offline.metrics.flow.quality).toBe('stale');
    expect(offline.metrics.flow.timestamp).toBe(lastValid);
    expect(offline.metrics.flow.timestamp).not.toBe(stamp);
    expect(store.getHistory('flow', '1h').at(-1)?.value).toBeNull();
    store.setScenario('recovery');
    expect(store.getState().snapshot.metrics.flow.quality).toBe('valid');
    expect(store.getState().snapshot.metrics.flow.value!).toBeGreaterThan(0);
  });
});

describe('commands and alert lifecycle', () => {
  it('does not update state before confirmation, rejects unavailable rainwater, and times out offline', async () => {
    const store = makeStore();
    store.setScenario('low-tank');
    const pending = store.sendCommand({ type: 'source', source: 'mains' });
    expect(store.getState().command?.status).toBe('pending');
    expect(store.getState().snapshot.source).toBe('rainwater');
    await vi.advanceTimersByTimeAsync(650);
    expect((await pending).status).toBe('confirmed');
    expect(store.getState().snapshot.source).toBe('mains');
    expect((await command(store, { type: 'source', source: 'rainwater' })).status).toBe('rejected');
    expect(store.getState().snapshot.source).toBe('mains');
    store.setScenario('sensor-offline');
    expect((await command(store, { type: 'stop' }, 1500)).status).toBe('timeout');
    expect(store.getState().snapshot.stopped).toBe(false);
  });

  it('latches an emergency stop across source changes and scenario recovery until reset', async () => {
    const store = makeStore();
    await command(store, { type: 'stop' });
    expect(store.getState().snapshot.stopped).toBe(true);
    expect(store.getState().snapshot.metrics.flow.value).toBe(0);
    expect(store.getState().snapshot.metrics.uvPower.value).toBe(0);
    await command(store, { type: 'source', source: 'mains' });
    store.setScenario('recovery');
    expect(store.getState().snapshot.stopped).toBe(true);
    expect(store.getState().snapshot.metrics.flow.value).toBe(0);
    await command(store, { type: 'reset' });
    expect(store.getState().snapshot.stopped).toBe(false);
    expect(store.getState().snapshot.metrics.flow.value!).toBeGreaterThan(0);
  });

  it('rejects overlapping controls and prevents a pending command from changing a reset demo', async () => {
    const store = makeStore();
    const pending = store.sendCommand({ type: 'stop' });
    const overlapping = await store.sendCommand({ type: 'source', source: 'mains' });
    expect(overlapping.status).toBe('rejected');
    expect(store.getState().command?.status).toBe('pending');
    expect(store.getState().events.some(event => event.message.includes('Concurrent command rejected'))).toBe(true);
    store.resetDemo();
    await vi.advanceTimersByTimeAsync(650);
    expect((await pending).status).toBe('rejected');
    expect(store.getState().snapshot.stopped).toBe(false);
    expect(store.getState().command).toBeNull();
  });

  it('acknowledges receipt separately from recovery and never creates duplicate active faults', () => {
    const store = makeStore();
    store.setScenario('filter-degradation');
    const id = store.getState().alerts[0].id;
    store.acknowledgeAlert(id);
    expect(store.getState().alerts.find(alert => alert.id === id)?.status).toBe('active');
    expect(store.getState().alerts.find(alert => alert.id === id)?.acknowledgedAt).toBeDefined();
    advance(store, 2000);
    expect(store.getState().alerts.filter(alert => alert.status === 'active')).toHaveLength(2);
    store.setScenario('recovery');
    expect(store.getState().alerts.filter(alert => alert.status === 'active')).toHaveLength(0);
    expect(store.getState().alerts.find(alert => alert.id === id)?.resolvedAt).toBeDefined();
    expect(store.getState().alerts.find(alert => alert.id === id)?.acknowledgedAt).toBeDefined();
  });

  it('does not treat loss of readings as proof a pre-existing sensor fault recovered', () => {
    const store = makeStore();
    store.setScenario('filter-degradation');
    store.setScenario('sensor-offline');
    expect(store.getState().alerts.filter(alert => alert.status === 'active')).toHaveLength(3);
  });

  it('records equipment, connection and source availability transitions in the event timeline', async () => {
    const store = makeStore();
    store.setScenario('filter-degradation');
    expect(store.getState().events.some(event => event.equipment === 'membrane' && event.message.includes('normal → warning'))).toBe(true);
    store.setScenario('low-tank');
    expect(store.getState().events.some(event => event.equipment === 'tank' && event.message === 'Rainwater supply unavailable.')).toBe(true);
    await command(store, { type: 'source', source: 'mains' });
    expect(store.getState().events.some(event => event.type === 'command' && event.equipment === 'mains' && event.message === 'Supply switched to mains.')).toBe(true);
    store.setScenario('sensor-offline');
    expect(store.getState().events.some(event => event.equipment === 'uv' && event.message.includes('offline'))).toBe(true);
    expect(store.getState().events.some(event => event.type === 'connection' && event.message.includes('lost'))).toBe(true);
    store.setScenario('recovery');
    expect(store.getState().events.some(event => event.equipment === 'tank' && event.message === 'Rainwater supply available.')).toBe(true);
    expect(store.getState().events.some(event => event.type === 'connection' && event.message.includes('restored'))).toBe(true);
  });
});

describe('operator workflows and persistence', () => {
  it('receives an order exactly once and consumes only available maintenance stock', () => {
    const store = makeStore();
    const original = store.getState().inventory.find(item => item.id === 'membrane')!.quantity;
    expect(store.createOrder('membrane', 3).ok).toBe(true);
    const order = store.getState().orders[0];
    store.advanceOrder(order.id);
    expect(store.getState().inventory.find(item => item.id === 'membrane')!.quantity).toBe(original);
    store.advanceOrder(order.id);
    expect(store.getState().inventory.find(item => item.id === 'membrane')!.quantity).toBe(original + 3);
    expect(store.advanceOrder(order.id).ok).toBe(false);
    expect(store.getState().inventory.find(item => item.id === 'membrane')!.quantity).toBe(original + 3);
    store.setScenario('filter-degradation');
    store.addTask('membrane', 'Replace membrane cartridge');
    const task = store.getState().tasks[0];
    expect(store.completeTask(task.id, 'membrane', 100).ok).toBe(false);
    expect(store.completeTask(task.id, 'membrane', 1).ok).toBe(true);
    expect(store.getState().inventory.find(item => item.id === 'membrane')!.quantity).toBe(original + 2);
    expect(store.completeTask(task.id, 'membrane', 1).ok).toBe(false);
    expect(store.getState().alerts.some(alert => alert.status === 'active')).toBe(true);
  });

  it('persists records, acknowledgment and stop latch across a fresh store', async () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    store.setScenario('filter-degradation');
    store.acknowledgeAlert(store.getState().alerts[0].id);
    store.reportIncident('Supply pressure seems lower this morning');
    store.createOrder('uv-lamp', 2);
    store.addTask('pump', 'Inspect pump coupling');
    await command(store, { type: 'stop' });
    const restored = makeStore(storage);
    expect(restored.getState().incidents[0].description).toContain('Supply pressure');
    expect(restored.getState().orders).toHaveLength(1);
    expect(restored.getState().tasks.some(task => task.description === 'Inspect pump coupling')).toBe(true);
    expect(restored.getState().alerts.some(alert => alert.acknowledgedAt)).toBe(true);
    expect(restored.getState().snapshot.stopped).toBe(true);
    expect(restored.getState().snapshot.metrics.flow.value).toBe(0);
    expect(storage.getItem(STORAGE_KEY)).toBeTruthy();
  });

  it('validates adjustments/thresholds and resets a repeatable demo', () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    expect(store.adjustInventory('membrane', -999).ok).toBe(false);
    expect(store.createOrder('membrane', 1.5).ok).toBe(false);
    expect(store.reportIncident('  ').ok).toBe(false);
    store.setThresholds({ turbidityOut: -1 });
    expect(store.getState().thresholds.turbidityOut).toBe(1);
    store.reportIncident('Test incident');
    store.setScenario('low-tank');
    store.resetDemo();
    expect(store.getState().snapshot.scenario).toBe('normal');
    expect(store.getState().snapshot.stopped).toBe(false);
    expect(store.getState().alerts).toHaveLength(0);
    expect(store.getState().incidents).toHaveLength(0);
    expect(store.getState().history).toHaveLength(1441);
    expect(makeStore(storage).getState().snapshot.scenario).toBe('normal');
  });

  it('raises an alert from a forced reading and releases it when the override expires', () => {
    const store = makeStore();
    expect(store.setOverride('turbidityOut', 2.4, 'valid', 120).ok).toBe(true);
    expect(store.getState().snapshot.metrics.turbidityOut.value).toBe(2.4);
    expect(store.getState().snapshot.equipment.membrane.status).toBe('warning');
    expect(store.getState().alerts.filter(alert => alert.status === 'active' && alert.title.includes('turbidity'))).toHaveLength(1);
    expect(store.getState().events.some(event => event.message.includes('Demo override set'))).toBe(true);
    advance(store, 121_000);
    expect(store.getState().overrides).toHaveLength(0);
    expect(store.getState().snapshot.metrics.turbidityOut.value).toBeCloseTo(CLEAN_BASELINE.turbidityOut, 1);
    expect(store.getState().alerts.filter(alert => alert.status === 'active')).toHaveLength(0);
    expect(store.getState().events.some(event => event.message.includes('Demo override expired'))).toBe(true);
  });

  it('forces quality without a value, and never persists an override', () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    expect(store.setOverride('turbidityOut', null, 'valid', 120).ok).toBe(false);
    expect(store.setOverride('pressureIn', 2.5, 'valid', 7200).ok).toBe(false);
    expect(store.getState().overrides).toHaveLength(0);
    store.setOverride('pressureIn', null, 'stale', 120);
    expect(store.getState().snapshot.metrics.pressureIn.quality).toBe('stale');
    expect(store.getState().snapshot.metrics.pressureIn.value).toBeNull();
    expect(makeStore(storage).getState().overrides).toHaveLength(0);
    expect(store.clearOverride('pressureIn').ok).toBe(true);
    expect(store.clearOverride('pressureIn').ok).toBe(false);
    expect(store.getState().snapshot.metrics.pressureIn.quality).toBe('valid');
  });

  it('completes the presentation sequence from fault to acknowledged maintenance and recovery', async () => {
    const store = makeStore();
    store.setScenario('filter-degradation');
    store.getState().alerts.forEach(alert => store.acknowledgeAlert(alert.id));
    await command(store, { type: 'source', source: 'mains' });
    store.addTask('membrane', 'Inspect and replace membrane');
    store.completeTask(store.getState().tasks[0].id, 'membrane', 1);
    expect(store.getState().snapshot.scenario).toBe('filter-degradation');
    store.setScenario('recovery');
    await command(store, { type: 'source', source: 'rainwater' });
    expect(store.getState().snapshot.source).toBe('rainwater');
    expect(store.getState().alerts.filter(alert => alert.status === 'active')).toHaveLength(0);
    expect(store.getState().tasks[0].status).toBe('completed');
    expect(store.getState().events.some(event => event.message.includes('Supply switched to rainwater'))).toBe(true);
  });
});
