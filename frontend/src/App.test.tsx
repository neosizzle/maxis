// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { dataSource, STORAGE_KEY } from './data/store';

vi.mock('./components/InstallationScene', () => ({
  default: ({ onSelect }: { onSelect: (equipment: string) => void }) => <section aria-label="Installation scene"><button type="button" onClick={() => onSelect('membrane')}>Membrane equipment</button></section>,
}));

// jsdom has no layout or ResizeObserver. Chart layout is covered by browser QA;
// the application, workflows and shared data source remain real in these tests.
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: () => <div aria-label="Historical chart viewport" /> };
});

beforeEach(() => {
  window.localStorage.clear();
  act(() => dataSource.resetDemo());
});
afterEach(() => cleanup());

const nav = () => within(screen.getByRole('navigation', { name: 'Main navigation' }));
const panel = (name: string) => within(screen.getByRole('heading', { name }).closest('section')!);
const stockRow = () => screen.getByRole('cell', { name: 'Membrane cartridge' }).closest('tr')!;

describe('MAXIS frontend demo workflows', () => {
  it('keeps resident controls read-only and delivers a resident report to the operator incident list', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.click(nav().getByRole('button', { name: /^Alerts & system/ }));
    expect(screen.getByRole('button', { name: 'Stop treatment' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Resident' }));
    expect(screen.queryByRole('button', { name: 'Stop treatment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset & restart' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Demo scenario' })).toBeNull();
    expect(nav().queryByRole('button', { name: 'Maintenance' })).toBeNull();
    expect(screen.getByText('Installation total · no household meter')).toBeDefined();

    const issue = 'The community supply pressure dropped this evening.';
    await user.click(screen.getByRole('textbox', { name: 'Describe your issue' }));
    await user.paste(issue);
    await user.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(screen.getByText('Report added to the operator incident list.')).toBeDefined();
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved.incidents.some((incident: { description: string }) => incident.description === issue)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Operator' }));
    await user.click(nav().getByRole('button', { name: 'Maintenance' }));
    await user.click(screen.getByRole('tab', { name: 'Activity & incidents' }));
    expect(screen.getByText(issue, { exact: true })).toBeDefined();
  });

  it('acknowledges a degradation alert without resolving its active condition', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Demo scenario' }), 'filter-degradation');
    await user.click(nav().getByRole('button', { name: /^Alerts & system/ }));
    const alerts = panel('Alerts');
    expect(alerts.getByText('Outlet turbidity elevated')).toBeDefined();
    expect(alerts.getByText('Membrane pressure loss rising')).toBeDefined();
    const count = dataSource.getState().alerts.filter(alert => alert.status === 'active').length;
    await user.click(alerts.getAllByRole('button', { name: 'Acknowledge' })[0]);
    expect(alerts.getAllByText('Acknowledged', { exact: true }).length).toBeGreaterThan(0);
    expect(dataSource.getState().alerts.filter(alert => alert.status === 'active')).toHaveLength(count);

    await user.click(alerts.getByRole('button', { name: /Resolved/ }));
    expect(alerts.getByText('No alerts in this view')).toBeDefined();
    await user.click(alerts.getByRole('button', { name: /All/ }));
    expect(alerts.getByText('Outlet turbidity elevated')).toBeDefined();
    expect(alerts.getAllByText('Acknowledged', { exact: true }).length).toBeGreaterThan(0);
  });

  it('changes the source only after device confirmation and keeps the overview consistent', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.click(nav().getByRole('button', { name: /^Alerts & system/ }));
    const controls = panel('Operational controls');
    await user.click(controls.getByRole('button', { name: 'Mains backup' }));
    expect(controls.getByText('Waiting for simulated device confirmation…')).toBeDefined();
    expect(dataSource.getState().snapshot.source).toBe('rainwater');
    expect((controls.getByRole('button', { name: 'Stop treatment' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(controls.getByText('Supply switched to mains.')).toBeDefined(), { timeout: 1800 });
    expect(dataSource.getState().snapshot.source).toBe('mains');
    expect(controls.getByText('Mains backup', { selector: 'strong' })).toBeDefined();
    await user.click(nav().getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Mains backup', { selector: '.active-source strong' })).toBeDefined();

    await user.click(nav().getByRole('button', { name: /^Alerts & system/ }));
    await user.click(panel('Operational controls').getByRole('button', { name: 'Rainwater' }));
    await waitFor(() => expect(panel('Operational controls').getByText('Supply switched to rainwater.')).toBeDefined(), { timeout: 1800 });
    expect(dataSource.getState().snapshot.source).toBe('rainwater');
  });

  it('latches treatment off until the operator explicitly resets it', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.click(nav().getByRole('button', { name: /^Alerts & system/ }));
    const controls = panel('Operational controls');
    await user.click(controls.getByRole('button', { name: 'Stop treatment' }));
    await waitFor(() => expect(controls.getByText('Stop latched')).toBeDefined(), { timeout: 1800 });
    expect(dataSource.getState().snapshot.stopped).toBe(true);
    expect(dataSource.getState().snapshot.metrics.flow.value).toBe(0);
    expect((controls.getByRole('button', { name: 'Stop treatment' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(nav().getByRole('button', { name: 'Overview' }));
    expect(screen.getByText('Treatment stopped', { exact: true })).toBeDefined();
    await user.click(nav().getByRole('button', { name: /^Alerts & system/ }));
    await user.click(panel('Operational controls').getByRole('button', { name: 'Reset & restart' }));
    await waitFor(() => expect(panel('Operational controls').getByText('Treatment running')).toBeDefined(), { timeout: 1800 });
    expect(dataSource.getState().snapshot.stopped).toBe(false);
    expect(dataSource.getState().snapshot.metrics.flow.value).toBeGreaterThan(0);
  });

  it('receives a supply order once and reflects its stock in the inventory view', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.click(nav().getByRole('button', { name: 'Maintenance' }));
    await user.click(screen.getByRole('tab', { name: 'Inventory' }));
    expect(stockRow().cells[2].textContent).toBe('4 units');
    await user.click(screen.getByRole('tab', { name: 'Supply orders' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Supply' }), 'membrane');
    await user.clear(screen.getByRole('spinbutton', { name: 'Quantity' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Quantity' }), '2');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(screen.getByText('draft', { exact: true })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Mark ordered' }));
    expect(screen.getByText('ordered', { exact: true })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Receive supplies' }));
    expect(screen.getByText('received', { exact: true })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Receive supplies' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Inventory' }));
    expect(stockRow().cells[2].textContent).toBe('6 units');
    await user.click(screen.getByRole('tab', { name: 'Supply orders' }));
    expect(screen.queryByRole('button', { name: 'Receive supplies' })).toBeNull();
    expect(dataSource.getState().inventory.find(item => item.id === 'membrane')?.quantity).toBe(6);
  });

  it('blocks operator commands while sensors are offline and restores controls after recovery', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Demo scenario' }), 'sensor-offline');
    await user.click(nav().getByRole('button', { name: /^Alerts & system/ }));
    const controls = panel('Operational controls');
    expect(screen.getByText('Sensor connection lost', { exact: true })).toBeDefined();
    expect((controls.getByRole('button', { name: 'Mains backup' }) as HTMLButtonElement).disabled).toBe(true);
    expect((controls.getByRole('button', { name: 'Stop treatment' }) as HTMLButtonElement).disabled).toBe(true);
    expect(controls.getByText(/Controls are unavailable while the connection/)).toBeDefined();
    expect(dataSource.getState().snapshot.metrics.heartbeat.quality).toBe('stale');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Demo scenario' }), 'recovery');
    expect(screen.getByText('Demo data active', { exact: true })).toBeDefined();
    expect((controls.getByRole('button', { name: 'Mains backup' }) as HTMLButtonElement).disabled).toBe(false);
    expect((controls.getByRole('button', { name: 'Stop treatment' }) as HTMLButtonElement).disabled).toBe(false);
  });
});



describe('accessible equipment details', () => {
  it('traps keyboard focus in equipment details and restores it on Escape', async () => {
    const user = userEvent.setup();
    render(<App />);
    const trigger = await screen.findByRole('button', { name: 'Membrane equipment' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Membrane filtration details' });
    const close = within(dialog).getByRole('button', { name: 'Close equipment details' });
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(dialog.querySelector('summary'));
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('accessible maintenance validation and navigation', () => {
  it('rejects a 100% low-tank threshold, focuses the error summary and supports correction', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.click(nav().getByRole('button', { name: 'Maintenance' }));
    await user.click(screen.getByText('Configure illustrative alert thresholds'));
    const input = screen.getByRole('spinbutton', { name: 'Low tank level (%)' });
    const original = dataSource.getState().thresholds.lowTank;
    await user.clear(input);
    await user.type(input, '100');
    await user.click(screen.getByRole('button', { name: 'Save thresholds' }));

    const errorSummary = screen.getByRole('alert');
    expect(errorSummary.textContent).toContain('Thresholds were not saved.');
    expect(document.activeElement).toBe(errorSummary);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(dataSource.getState().thresholds.lowTank).toBe(original);
    expect(screen.queryByText('Illustrative thresholds saved. Active alerts now use these limits.')).toBeNull();
    await user.click(within(errorSummary).getByRole('link', { name: 'Review this field' }));
    expect(document.activeElement).toBe(input);

    await user.clear(input);
    await user.type(input, '20');
    await user.click(screen.getByRole('button', { name: 'Save thresholds' }));
    expect(screen.getByText('Illustrative thresholds saved. Active alerts now use these limits.')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(dataSource.getState().thresholds.lowTank).toBe(20);
    expect(screen.queryByRole('alert')).toBeNull();
  }, 10000);

  it('moves focus and the associated panel between maintenance tabs with arrow keys', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);
    await user.click(nav().getByRole('button', { name: 'Maintenance' }));
    const tasks = screen.getByRole('tab', { name: 'Service tasks' });
    const inventory = screen.getByRole('tab', { name: 'Inventory' });
    await user.click(tasks);
    await user.keyboard('{ArrowRight}');
    const inventoryPanel = screen.getByRole('tabpanel', { name: 'Inventory' });
    expect(document.activeElement).toBe(inventory);
    expect(inventory.getAttribute('aria-selected')).toBe('true');
    expect(inventory.getAttribute('aria-controls')).toBe(inventoryPanel.id);
    expect(tasks.getAttribute('tabindex')).toBe('-1');
    expect(within(inventoryPanel).getByRole('button', { name: 'Adjust stock' })).toBeDefined();

    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tasks);
    expect(tasks.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Service tasks' })).toBeDefined();
    expect(screen.queryByRole('tabpanel', { name: 'Inventory' })).toBeNull();
  }, 10000);
});
