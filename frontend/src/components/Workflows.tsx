import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Activity, AlertTriangle, Check, CheckCheck, ClipboardList, Clock3, Droplets, Gauge, Package, Plus, Power, Search, Settings2, ShieldCheck, ShoppingCart, Wifi, WifiOff, Wrench, X } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CLEAN_BASELINE, METRICS, useMaxis } from '../data/store';
import type { Command, EquipmentId, HistoryRange, MetricKey, MetricReading, Snapshot } from '../types';

const equipment: { id: EquipmentId; label: string }[] = [
  { id: 'tank', label: 'Rainwater tank' }, { id: 'pump', label: 'Pump' }, { id: 'membrane', label: 'Membrane filter' },
  { id: 'uv', label: 'UV chamber' }, { id: 'solar', label: 'Solar array' }, { id: 'mains', label: 'Mains supply' }, { id: 'homes', label: 'Residential supply' },
];
const formatTime = (date: string) => new Date(date).toLocaleTimeString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const formatDate = (date: string) => new Date(date).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const equipmentName = (id: EquipmentId) => equipment.find(item => item.id === id)?.label ?? id;
const readingText = (reading: MetricReading, digits = 2) => reading.value === null ? '—' : reading.value.toFixed(digits);
type Feedback = { ok: boolean; message: string; field?: string };
const chartColors = { water: '#3478f6', filtered: '#21b8d5', baseline: '#7d8996', warning: '#985e00', text: '#52606d', grid: '#e5e9ee' };
const maintenanceTabs = [{ id: 'tasks', label: 'Service tasks', icon: ClipboardList }, { id: 'inventory', label: 'Inventory', icon: Package }, { id: 'orders', label: 'Supply orders', icon: ShoppingCart }, { id: 'records', label: 'Activity & incidents', icon: Clock3 }] as const;
const required = <span className="required-marker" aria-hidden="true"> *</span>;
const positiveQuantityError = (value: string) => !Number.isInteger(Number(value)) || Number(value) <= 0 ? 'Enter a positive whole-number quantity, such as 1 or 2.' : '';
function sampleTimeSeries<T>(points: T[], isValid: (point: T) => boolean) {
  if (points.length <= 288) return points;
  const stride = Math.ceil(points.length / 288);
  return points.filter((point, index) => index === 0 || index === points.length - 1 || index % stride === 0 || (index > 0 && isValid(point) !== isValid(points[index - 1])) || (index < points.length - 1 && isValid(point) !== isValid(points[index + 1])));
}

function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  return error || hint ? <span id={id} className={error ? 'field-error' : 'field-hint'} aria-hidden="true">{error || hint}</span> : null;
}

function FeedbackMessage({ feedback }: { feedback: Feedback | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (feedback && !feedback.ok) ref.current?.focus(); }, [feedback]);
  return feedback ? <div ref={ref} className={`inline-feedback ${feedback.ok ? 'success' : 'error'}`} role={feedback.ok ? 'status' : 'alert'} aria-atomic="true" tabIndex={feedback.ok ? undefined : -1}>{feedback.ok ? <Check aria-hidden="true" size={15} /> : <AlertTriangle aria-hidden="true" size={15} />}<span>{feedback.message}{feedback.field && <a href={`#${feedback.field}`} onClick={() => document.getElementById(feedback.field!)?.focus()}> Review this field</a>}</span></div> : null;
}

function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`badge ${status}`}>{children ?? status.replace('-', ' ')}</span>;
}

function HistoryRangeButtons({ range, setRange }: { range: HistoryRange; setRange: (range: HistoryRange) => void }) {
  return <div className="tab-strip compact" role="group" aria-label="History range">{(['1h', '6h', '24h'] as HistoryRange[]).map(value => <button type="button" key={value} aria-pressed={range === value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{value}</button>)}</div>;
}

function HistoricalDataTable({ history, metrics, range, timestamp, title }: { history: Snapshot[]; metrics: MetricKey[]; range: HistoryRange; timestamp: string; title: string }) {
  const rows = useMemo(() => {
    const since = new Date(timestamp).getTime() - Number.parseInt(range) * 3_600_000;
    return history.filter(point => new Date(point.timestamp).getTime() >= since).slice(-10).reverse();
  }, [history, range, timestamp]);
  return <details className="chart-data-details"><summary>View {title.toLowerCase()} as a table</summary><p className="field-hint">Latest {rows.length} minute samples in the selected {range} range. Export data provides the complete history.</p>{rows.length ? <div className="table-wrap" role="region" aria-label={`${title} data`} tabIndex={0}><table className="data-table"><caption>{title} · {range} range · Malaysia time</caption><thead><tr><th scope="col">Time (MYT)</th>{metrics.map(metric => <th scope="col" key={metric}>{METRICS[metric].label} ({METRICS[metric].unit})</th>)}</tr></thead><tbody>{rows.map(point => <tr key={point.timestamp}><th scope="row"><time dateTime={point.timestamp}>{formatTime(point.timestamp)}</time></th>{metrics.map(metric => { const reading = point.metrics[metric]; return <td key={metric}>{reading.quality === 'valid' && reading.value !== null ? reading.value.toFixed(metric === 'heartbeat' ? 0 : 2) : `Unavailable (${reading.quality})`}</td>; })}</tr>)}</tbody></table></div> : <p>No historical readings in this range.</p>}</details>;
}

export function MaintenancePage() {
  const { snapshot, history, tasks, inventory, orders, incidents, events, thresholds, actions } = useMaxis();
  const [range, setRange] = useState<HistoryRange>('6h');
  const [tab, setTab] = useState<'tasks' | 'inventory' | 'orders' | 'records'>('tasks');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [thresholdFeedback, setThresholdFeedback] = useState<Feedback | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [taskEquipment, setTaskEquipment] = useState<EquipmentId>('membrane');
  const [taskDescription, setTaskDescription] = useState('');
  const [completionId, setCompletionId] = useState<string | null>(null);
  const [supplyId, setSupplyId] = useState('');
  const [supplyQuantity, setSupplyQuantity] = useState('1');
  const [inventoryId, setInventoryId] = useState('');
  const [stockDelta, setStockDelta] = useState('1');
  const [orderItemId, setOrderItemId] = useState('');
  const [orderQuantity, setOrderQuantity] = useState('1');
  const [thresholdDraft, setThresholdDraft] = useState(thresholds);
  useEffect(() => setThresholdDraft(thresholds), [thresholds]);

  const turbidity = snapshot.metrics.turbidityOut;
  const pressureDelta = snapshot.metrics.pressureDelta;
  const flow = snapshot.metrics.flow;
  const readingsAvailable = [turbidity, pressureDelta, flow].every(value => value.quality === 'valid' && value.value !== null);
  const highTurbidity = readingsAvailable && turbidity.value! > thresholds.turbidityOut;
  const highPressure = readingsAvailable && pressureDelta.value! > thresholds.pressureDelta;
  const lowFlow = readingsAvailable && !snapshot.stopped && snapshot.source === 'rainwater' && flow.value! < CLEAN_BASELINE.flow * 0.7;
  const condition = !readingsAvailable ? 'unavailable' : highTurbidity || highPressure || lowFlow ? 'warning' : snapshot.stopped ? 'stopped' : 'normal';
  const recommendation = !readingsAvailable ? 'A sensor reading is unavailable or stale. Inspect the sensor connection before assessing filter condition.'
    : snapshot.stopped ? 'Treatment is stopped. Live flow cannot be used to assess the filter until treatment resumes.'
    : highTurbidity || highPressure || lowFlow ? [highTurbidity ? `Outlet turbidity exceeds ${thresholds.turbidityOut.toFixed(2)} NTU.` : '', highPressure ? `Pressure difference exceeds ${thresholds.pressureDelta.toFixed(2)} bar.` : '', lowFlow ? 'Flow is below 70% of the clean-filter baseline.' : '', 'Inspect the membrane and record any cleaning or replacement.'].filter(Boolean).join(' ')
    : 'Readings are within the configured illustrative limits. Continue monitoring outlet turbidity, pressure difference and treated-water flow.';
  const plot = useMemo(() => {
    const hours = range === '1h' ? 1 : range === '6h' ? 6 : 24;
    const since = new Date(snapshot.timestamp).getTime() - hours * 3_600_000;
    const points = history.filter(point => new Date(point.timestamp).getTime() >= since).map(point => ({ timestamp: new Date(point.timestamp).getTime(), outlet: point.metrics.turbidityOut.quality === 'valid' ? point.metrics.turbidityOut.value : null, inlet: point.metrics.turbidityIn.quality === 'valid' ? point.metrics.turbidityIn.value : null }));
    return sampleTimeSeries(points, point => point.outlet !== null && point.inlet !== null);
  }, [history, range, snapshot.timestamp]);
  const turbidityTrend = useMemo(() => {
    const hours = range === '1h' ? 1 : range === '6h' ? 6 : 24;
    const cutoff = new Date(snapshot.timestamp).getTime() - hours * 3_600_000;
    const samples = history.filter(point => new Date(point.timestamp).getTime() >= cutoff && point.metrics.turbidityOut.quality === 'valid' && point.metrics.turbidityOut.value !== null)
      .map(point => ({ time: new Date(point.timestamp).getTime(), value: point.metrics.turbidityOut.value! }));
    if (samples.length < 5 || samples.at(-1)!.time - samples[0].time < 5 * 60_000) return { rate: null as number | null, samples: samples.length };
    const origin = samples[0].time;
    const points = samples.map(sample => ({ x: (sample.time - origin) / 3_600_000, y: sample.value }));
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const variance = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    if (variance === 0) return { rate: null as number | null, samples: samples.length };
    const covariance = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
    return { rate: covariance / variance, samples: samples.length };
  }, [history, range, snapshot.timestamp]);
  const openTasks = tasks.filter(task => task.status === 'open').length;
  const lowStock = inventory.filter(item => item.quantity <= item.minimum).length;
  const pendingOrders = orders.filter(order => order.status !== 'received').length;
  const itemName = (id: string) => inventory.find(item => item.id === id)?.name ?? id;
  const reportResult = (result: Feedback) => { setFeedback(result); return result.ok; };
  const setFieldError = (field: string, error: string) => setFieldErrors(previous => ({ ...previous, [field]: error }));
  const fail = (field: string, inputId: string, message: string) => { setFieldError(field, message); setFeedback({ ok: false, message, field: inputId }); };
  const activateTab = (next: typeof tab) => { setTab(next); setFeedback(null); setFieldErrors({}); };
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: typeof tab) => {
    const index = maintenanceTabs.findIndex(item => item.id === current);
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % maintenanceTabs.length : event.key === 'ArrowLeft' ? (index + maintenanceTabs.length - 1) % maintenanceTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? maintenanceTabs.length - 1 : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = maintenanceTabs[nextIndex].id;
    activateTab(next);
    document.getElementById(`maintenance-tab-${next}`)?.focus();
  };
  const saveThresholds = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors = {
      thresholdTurbidity: !Number.isFinite(thresholdDraft.turbidityOut) || thresholdDraft.turbidityOut <= 0 ? 'Enter a turbidity limit greater than zero.' : '',
      thresholdPressure: !Number.isFinite(thresholdDraft.pressureDelta) || thresholdDraft.pressureDelta <= 0 ? 'Enter a pressure difference greater than zero.' : '',
      thresholdTank: !Number.isFinite(thresholdDraft.lowTank) || thresholdDraft.lowTank <= 0 || thresholdDraft.lowTank >= 100 ? 'Enter a tank level greater than 0% and below 100%.' : '',
    };
    setFieldErrors(previous => ({ ...previous, ...errors }));
    const firstError = Object.entries(errors).find(([, message]) => message);
    if (firstError) { setThresholdFeedback({ ok: false, message: 'Thresholds were not saved. Correct the highlighted values and try again.', field: firstError[0] }); return; }
    actions.setThresholds(thresholdDraft);
    setThresholdFeedback({ ok: true, message: 'Illustrative thresholds saved. Active alerts now use these limits.' });
  };
  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!taskDescription.trim()) { fail('taskDescription', 'taskDescription', 'Describe the inspection, cleaning or replacement before creating a task.'); return; }
    setFieldError('taskDescription', '');
    if (reportResult(actions.addTask(taskEquipment, taskDescription.trim()))) setTaskDescription('');
  };
  const completeTask = (event: FormEvent<HTMLFormElement>, taskId: string) => {
    event.preventDefault();
    const quantity = Number(supplyQuantity);
    if (supplyId) {
      const error = positiveQuantityError(supplyQuantity);
      const stock = inventory.find(item => item.id === supplyId)?.quantity ?? 0;
      if (error || quantity > stock) { fail('supplyQuantity', 'supplyQuantity', error || `Only ${stock} are available. Reduce the quantity or receive more supplies first.`); return; }
    }
    setFieldError('supplyQuantity', '');
    const result = actions.completeTask(taskId, supplyId || undefined, supplyId ? quantity : undefined);
    if (reportResult(result)) setCompletionId(null);
    else setFieldError('supplyQuantity', result.message);
  };
  const adjustStock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const delta = Number(stockDelta);
    const item = inventory.find(entry => entry.id === (inventoryId || inventory[0]?.id));
    if (!Number.isInteger(delta) || delta === 0) { fail('stockDelta', 'stockDelta', 'Enter a nonzero whole-number adjustment, such as +2 or −1.'); return; }
    if (!item || item.quantity + delta < 0) { fail('stockDelta', 'stockDelta', `This adjustment exceeds available stock (${item?.quantity ?? 0}). Enter a smaller deduction.`); return; }
    setFieldError('stockDelta', '');
    reportResult(actions.adjustInventory(item.id, delta));
  };
  const createSupplyOrder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const error = positiveQuantityError(orderQuantity);
    if (error) { fail('orderQuantity', 'orderQuantity', error); return; }
    setFieldError('orderQuantity', '');
    reportResult(actions.createOrder(orderItemId || inventory[0]?.id || '', Number(orderQuantity)));
  };

  return <div className="page-content">
    <div className="metric-grid workflow-metrics">
      {[{ label: 'Outlet turbidity', reading: turbidity, baseline: `${CLEAN_BASELINE.turbidityOut.toFixed(2)} NTU`, icon: Droplets, warning: highTurbidity }, { label: 'Filter pressure difference', reading: pressureDelta, baseline: `${CLEAN_BASELINE.pressureDelta.toFixed(2)} bar`, icon: Gauge, warning: highPressure }, { label: 'Treated-water flow', reading: flow, baseline: `${CLEAN_BASELINE.flow} L/min`, icon: Activity, warning: lowFlow }].map(({ label, reading, baseline, icon: Icon, warning }) => <div className={`metric-card ${warning ? 'metric-warning' : ''}`} key={label}><div className="metric-top"><span className="metric-label">{label}</span><span className="metric-icon"><Icon aria-hidden="true" size={19} /></span></div><div className="metric-value">{readingText(reading)} <span>{reading.unit}</span></div><div className="metric-detail">Clean-filter baseline <strong>{baseline}</strong></div><div className="metric-detail"><StatusBadge status={reading.quality}>{reading.quality}</StatusBadge><span>{formatTime(reading.timestamp)}</span></div></div>)}
      <div className="metric-card trend-rate-card"><div className="metric-top"><span className="metric-label">Outlet turbidity trend</span><Droplets aria-hidden="true" size={18}/></div><div className="metric-value">{turbidityTrend.rate === null ? '—' : `${turbidityTrend.rate > 0 ? '+' : ''}${turbidityTrend.rate.toFixed(3)}`} <span>NTU/h</span></div><div className="metric-detail">Linear slope · selected {range} range · {turbidityTrend.samples} valid samples</div><div className="metric-detail">Screening indicator only; not a membrane-life prediction.</div></div>
    </div>

    <div className={`notice ${condition === 'warning' ? 'warning' : condition === 'unavailable' ? 'warning' : ''}`}><Wrench aria-hidden="true" size={19} /><div><strong>{condition === 'warning' ? 'Maintenance recommendation' : 'Filter condition assessment'}</strong><p>{recommendation}</p><span className="text-muted">Illustrative thresholds for the prototype demo. These signals do not predict remaining membrane life.</span></div></div>

    <section className="panel"><div className="panel-header"><div><h2>Turbidity signal & baseline</h2><p>Compare incoming and treated water against the clean-filter reference.</p></div><HistoryRangeButtons range={range} setRange={setRange} /></div><div className="chart-legend"><span><i style={{ background: chartColors.water }} /> Before membrane</span><span><i style={{ background: chartColors.filtered }} /> After membrane</span><span><i style={{ background: chartColors.baseline }} /> Clean baseline</span></div><div className="chart-container" role="figure" aria-label={`Turbidity before and after the membrane over ${range}; clean outlet baseline ${CLEAN_BASELINE.turbidityOut} NTU`} style={{ height: 250 }}><ResponsiveContainer width="100%" height="100%"><LineChart data={plot} margin={{ left: 0, right: 24, top: 20, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartColors.grid} /><XAxis dataKey="timestamp" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => new Date(value).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })} minTickGap={65} tick={{ fontSize: 12, fill: chartColors.text }} axisLine={false} tickLine={false} /><YAxis unit=" NTU" tick={{ fontSize: 12, fill: chartColors.text }} axisLine={false} tickLine={false} width={65} /><Tooltip labelFormatter={value => formatDate(new Date(Number(value)).toISOString())} formatter={(value, name) => [value === null || value === undefined ? 'Unavailable' : `${Number(value).toFixed(2)} NTU`, name]} /><ReferenceLine y={CLEAN_BASELINE.turbidityOut} stroke={chartColors.baseline} strokeDasharray="5 5" /><ReferenceLine y={thresholds.turbidityOut} stroke={chartColors.warning} strokeDasharray="3 3" /><Line dataKey="inlet" name="Before membrane" stroke={chartColors.water} strokeDasharray="6 3" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} /><Line dataKey="outlet" name="After membrane" stroke={chartColors.filtered} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} /></LineChart></ResponsiveContainer></div><HistoricalDataTable history={history} metrics={['turbidityIn', 'turbidityOut']} range={range} timestamp={snapshot.timestamp} title="Turbidity history" /><details className="threshold-settings"><summary><Settings2 aria-hidden="true" size={15} /> Configure illustrative alert thresholds</summary><form className="form-grid threshold-grid" noValidate onSubmit={saveThresholds}><label className="field"><span>Outlet turbidity limit (NTU){required}</span><input id="thresholdTurbidity" aria-invalid={Boolean(fieldErrors.thresholdTurbidity)} aria-describedby="thresholdTurbidity-message" type="number" min="0.01" step="0.01" value={thresholdDraft.turbidityOut} onChange={event => setThresholdDraft({ ...thresholdDraft, turbidityOut: Number(event.target.value) })} onBlur={() => setFieldError('thresholdTurbidity', !Number.isFinite(thresholdDraft.turbidityOut) || thresholdDraft.turbidityOut <= 0 ? 'Enter a turbidity limit greater than zero.' : '')} required /><FieldMessage id="thresholdTurbidity-message" error={fieldErrors.thresholdTurbidity} /></label><label className="field"><span>Pressure difference limit (bar){required}</span><input id="thresholdPressure" aria-invalid={Boolean(fieldErrors.thresholdPressure)} aria-describedby="thresholdPressure-message" type="number" min="0.01" step="0.01" value={thresholdDraft.pressureDelta} onChange={event => setThresholdDraft({ ...thresholdDraft, pressureDelta: Number(event.target.value) })} onBlur={() => setFieldError('thresholdPressure', !Number.isFinite(thresholdDraft.pressureDelta) || thresholdDraft.pressureDelta <= 0 ? 'Enter a pressure difference greater than zero.' : '')} required /><FieldMessage id="thresholdPressure-message" error={fieldErrors.thresholdPressure} /></label><label className="field"><span>Low tank level (%){required}</span><input id="thresholdTank" aria-invalid={Boolean(fieldErrors.thresholdTank)} aria-describedby="thresholdTank-message" type="number" min="1" max="99" step="1" value={thresholdDraft.lowTank} onChange={event => setThresholdDraft({ ...thresholdDraft, lowTank: Number(event.target.value) })} onBlur={() => setFieldError('thresholdTank', !Number.isFinite(thresholdDraft.lowTank) || thresholdDraft.lowTank <= 0 || thresholdDraft.lowTank >= 100 ? 'Enter a value greater than 0% and below 100%.' : '')} required /><FieldMessage id="thresholdTank-message" error={fieldErrors.thresholdTank} /></label><button className="button button-secondary" type="submit">Save thresholds</button></form><FeedbackMessage feedback={thresholdFeedback} /></details></section>

    <section className="panel"><div className="panel-header"><div><h2>Maintenance workspace</h2><p>{openTasks} open tasks · {lowStock} supplies at reorder level · {pendingOrders} pending orders</p></div></div><div className="tab-strip workflow-tabs" role="tablist" aria-label="Maintenance workspace">{maintenanceTabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`maintenance-tab-${id}`} aria-controls={`maintenance-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onKeyDown={event => tabKeyDown(event, id)} className={tab === id ? 'active' : ''} onClick={() => activateTab(id)}><Icon aria-hidden="true" size={16} />{label}</button>)}</div><FeedbackMessage feedback={feedback} />

      {tab === 'tasks' && <div id="maintenance-panel-tasks" role="tabpanel" aria-labelledby="maintenance-tab-tasks" className="workflow-body"><form className="form-grid" noValidate onSubmit={createTask}><label className="field"><span>Equipment{required}</span><select required value={taskEquipment} onChange={event => setTaskEquipment(event.target.value as EquipmentId)}>{equipment.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label><label className="field field-grow"><span>Service task{required}</span><input id="taskDescription" aria-invalid={Boolean(fieldErrors.taskDescription)} aria-describedby="taskDescription-message" value={taskDescription} maxLength={250} onChange={event => setTaskDescription(event.target.value)} onBlur={() => setFieldError('taskDescription', taskDescription.trim() ? '' : 'Describe the work to be performed.')} placeholder="e.g. Inspect and clean the membrane" required /><FieldMessage id="taskDescription-message" error={fieldErrors.taskDescription} hint="Describe the inspection, cleaning or replacement." /></label><button type="submit" className="button button-primary"><Plus aria-hidden="true" size={16} />Create task</button></form>{tasks.length === 0 ? <div className="empty-state"><ClipboardList aria-hidden="true" size={26} /><p>No service tasks yet. Create one when an inspection is needed.</p></div> : <div className="task-list">{[...tasks].sort((a, b) => a.status.localeCompare(b.status) * -1).map(task => <div className="task-row" key={task.id}><div className="task-main"><div className={`task-check ${task.status === 'completed' ? 'completed' : ''}`}>{task.status === 'completed' ? <CheckCheck aria-hidden="true" size={18} /> : <Wrench aria-hidden="true" size={18} />}</div><div><strong>{task.description}</strong><p>{equipmentName(task.equipment)} · Created {formatDate(task.createdAt)}</p>{task.completedAt && <p>Completed {formatDate(task.completedAt)}{task.suppliesUsed?.length ? ` · Supplies: ${task.suppliesUsed.map(supply => `${itemName(supply.itemId)} × ${supply.quantity}`).join(', ')}` : ' · No supplies used'}</p>}</div></div><div className="action-cell"><StatusBadge status={task.status} />{task.status === 'open' && <button type="button" className="button button-secondary button-small" onClick={() => { setCompletionId(completionId === task.id ? null : task.id); setSupplyId(''); setSupplyQuantity('1'); }}>Complete</button>}</div>{completionId === task.id && <form className="completion-form form-grid" noValidate onSubmit={event => completeTask(event, task.id)}><label className="field field-grow">Supplies used<select value={supplyId} onChange={event => setSupplyId(event.target.value)}><option value="">None — inspection or cleaning only</option>{inventory.map(item => <option value={item.id} key={item.id}>{item.name} ({item.quantity} {item.unit} available)</option>)}</select></label>{supplyId && <label className="field"><span>Quantity{required}</span><input id="supplyQuantity" aria-invalid={Boolean(fieldErrors.supplyQuantity)} aria-describedby="supplyQuantity-message" type="number" min="1" step="1" value={supplyQuantity} onChange={event => setSupplyQuantity(event.target.value)} onBlur={() => setFieldError('supplyQuantity', positiveQuantityError(supplyQuantity))} required /><FieldMessage id="supplyQuantity-message" error={fieldErrors.supplyQuantity} hint={`${inventory.find(item => item.id === supplyId)?.quantity ?? 0} available in stock`} /></label>}<button className="button button-primary" type="submit"><Check aria-hidden="true" size={15} />Record completion</button><button className="button button-ghost" type="button" onClick={() => setCompletionId(null)} aria-label="Cancel completion"><X aria-hidden="true" size={16} /></button></form>}</div>)}</div>}</div>}

      {tab === 'inventory' && <div id="maintenance-panel-inventory" role="tabpanel" aria-labelledby="maintenance-tab-inventory" className="workflow-body"><form className="form-grid" noValidate onSubmit={adjustStock}><label className="field field-grow"><span>Supply{required}</span><select required value={inventoryId || inventory[0]?.id || ''} onChange={event => setInventoryId(event.target.value)}>{inventory.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="field"><span>Adjustment (+ / −){required}</span><input id="stockDelta" aria-invalid={Boolean(fieldErrors.stockDelta)} aria-describedby="stockDelta-message" type="number" step="1" value={stockDelta} onChange={event => setStockDelta(event.target.value)} onBlur={() => setFieldError('stockDelta', !Number.isInteger(Number(stockDelta)) || Number(stockDelta) === 0 ? 'Enter a nonzero whole-number adjustment.' : '')} required /><FieldMessage id="stockDelta-message" error={fieldErrors.stockDelta} hint="Positive adds stock; negative deducts stock." /></label><button className="button button-primary" type="submit" disabled={!inventory.length}>Adjust stock</button></form><div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Supply</th><th scope="col">Category</th><th scope="col">In stock</th><th scope="col">Reorder at</th><th scope="col">Status</th></tr></thead><tbody>{inventory.map(item => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.category}</td><td>{item.quantity} {item.unit}</td><td>{item.minimum} {item.unit}</td><td><StatusBadge status={item.quantity <= item.minimum ? 'warning' : 'normal'}>{item.quantity <= item.minimum ? 'Reorder needed' : 'In stock'}</StatusBadge></td></tr>)}</tbody></table></div><p className="text-muted helper-text">Completing a task deducts its supplies. Receiving an order adds stock once.</p></div>}

      {tab === 'orders' && <div id="maintenance-panel-orders" role="tabpanel" aria-labelledby="maintenance-tab-orders" className="workflow-body"><form className="form-grid" noValidate onSubmit={createSupplyOrder}><label className="field field-grow"><span>Supply{required}</span><select required value={orderItemId || inventory[0]?.id || ''} onChange={event => setOrderItemId(event.target.value)}>{inventory.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="field"><span>Quantity{required}</span><input id="orderQuantity" aria-invalid={Boolean(fieldErrors.orderQuantity)} aria-describedby="orderQuantity-message" type="number" min="1" step="1" value={orderQuantity} onChange={event => setOrderQuantity(event.target.value)} onBlur={() => setFieldError('orderQuantity', positiveQuantityError(orderQuantity))} required /><FieldMessage id="orderQuantity-message" error={fieldErrors.orderQuantity} hint="Whole units only. Stock changes when received." /></label><button className="button button-primary" type="submit" disabled={!inventory.length}><Plus aria-hidden="true" size={16} />Create draft</button></form><p className="text-muted helper-text">Internal demo orders: Draft → Ordered → Received. No external purchase is submitted.</p>{!orders.length ? <div className="empty-state"><ShoppingCart aria-hidden="true" size={26} /><p>No supply orders yet.</p></div> : <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Order</th><th scope="col">Supply</th><th scope="col">Quantity</th><th scope="col">Updated</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}><td className="mono">{order.id.slice(-8).toUpperCase()}</td><td>{itemName(order.itemId)}</td><td>{order.quantity}</td><td>{formatDate(order.updatedAt)}</td><td><StatusBadge status={order.status} /></td><td>{order.status !== 'received' ? <button type="button" className="button button-secondary button-small" onClick={() => reportResult(actions.advanceOrder(order.id))}>{order.status === 'draft' ? 'Mark ordered' : 'Receive supplies'}</button> : <span className="text-muted"><Check aria-hidden="true" size={14} /> Stock updated</span>}</td></tr>)}</tbody></table></div>}</div>}

      {tab === 'records' && <div id="maintenance-panel-records" role="tabpanel" aria-labelledby="maintenance-tab-records" className="workflow-body workflow-grid"><div><h3 className="section-heading">Maintenance & stock activity</h3><div className="timeline-list">{events.filter(event => event.type === 'maintenance' || event.type === 'inventory').map(event => <div className="timeline-item" key={event.id}><span className={`timeline-dot ${event.level}`} /><div><p>{event.message}</p><span className="text-muted">{formatDate(event.timestamp)}{event.equipment ? ` · ${equipmentName(event.equipment)}` : ''}</span></div></div>)}</div>{!events.some(event => event.type === 'maintenance' || event.type === 'inventory') && <div className="empty-state"><Clock3 aria-hidden="true" size={24} /><p>Recorded maintenance and stock changes appear here.</p></div>}</div><div><h3 className="section-heading">Incident reports <span className="badge">{incidents.length}</span></h3>{incidents.length ? incidents.map(incident => <div className="incident-card" key={incident.id}><div className="panel-header"><StatusBadge status={incident.status} /><span className="text-muted">{incident.source}</span></div><p>{incident.description}</p><span className="text-muted">{formatDate(incident.createdAt)}</span></div>) : <div className="empty-state"><ShieldCheck aria-hidden="true" size={24} /><p>No incidents reported.</p></div>}</div></div>}
    </section>
  </div>;
}

export function AlertsPage() {
  const { snapshot, history, alerts, events, command, actions } = useMaxis();
  const [heartbeatRange, setHeartbeatRange] = useState<HistoryRange>('6h');
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning' | 'acknowledged' | 'resolved'>('all');
  const [search, setSearch] = useState('');
  const [logLevel, setLogLevel] = useState('all');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const pending = command?.status === 'pending';
  const [lastCommand, setLastCommand] = useState<Command | null>(null);
  const criticalDataValid = snapshot.connected && snapshot.metrics.pressureIn.quality === 'valid' && snapshot.metrics.pressureOut.quality === 'valid';
  const controlsDisabled = pending || !criticalDataValid;
  const active = alerts.filter(alert => alert.status === 'active');
  const unacknowledged = active.filter(alert => !alert.acknowledgedAt);
  const critical = active.filter(alert => alert.severity === 'critical');
  const warnings = active.filter(alert => alert.severity === 'warning');
  const acknowledged = active.filter(alert => Boolean(alert.acknowledgedAt));
  const resolved = alerts.filter(alert => alert.status === 'resolved');
  const shownAlerts = alerts.filter(alert => {
    if (filter === 'critical' || filter === 'warning') return alert.status === 'active' && alert.severity === filter;
    if (filter === 'acknowledged') return alert.status === 'active' && Boolean(alert.acknowledgedAt);
    if (filter === 'resolved') return alert.status === 'resolved';
    return true;
  });
  const shownEvents = events.filter(event => (logLevel === 'all' || event.level === logLevel) && `${event.message} ${event.type} ${event.equipment ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const devicesOnline = Object.values(snapshot.equipment).filter(value => value.status !== 'offline').length;
  const heartbeatPlot = useMemo(() => {
    const hours = heartbeatRange === '1h' ? 1 : heartbeatRange === '6h' ? 6 : 24;
    const since = new Date(snapshot.timestamp).getTime() - hours * 3_600_000;
    const points = history.filter(point => new Date(point.timestamp).getTime() >= since).map(point => ({ timestamp: new Date(point.timestamp).getTime(), latency: point.metrics.heartbeat.quality === 'valid' ? point.metrics.heartbeat.value : null }));
    return sampleTimeSeries(points, point => point.latency !== null);
  }, [history, heartbeatRange, snapshot.timestamp]);
  const issueCommand = async (next: Command) => {
    setFeedback(null);
    setLastCommand(next);
    try { await actions.sendCommand(next); }
    catch { setFeedback({ ok: false, message: 'The command could not be sent. Check connection status and try again.' }); }
  };

  return <div className="page-content">
    <div className="metric-grid workflow-metrics"><div className="metric-card"><div className="metric-top"><span className="metric-label">Active alerts</span><AlertTriangle aria-hidden="true" size={19} /></div><div className="metric-value">{active.length}</div><span className="metric-detail">{critical.length} critical · {unacknowledged.length} need acknowledgment</span></div><div className="metric-card"><div className="metric-top"><span className="metric-label">Device connectivity</span><Wifi aria-hidden="true" size={19} /></div><div className="metric-value">{devicesOnline}<span> / {equipment.length}</span></div><span className="metric-detail">Equipment reporting test data</span></div><div className="metric-card"><div className="metric-top"><span className="metric-label">Service heartbeat</span><Activity aria-hidden="true" size={19} /></div><div className="metric-value">{readingText(snapshot.metrics.heartbeat, 0)} <span>{snapshot.metrics.heartbeat.unit}</span></div><div className="metric-detail"><StatusBadge status={snapshot.metrics.heartbeat.quality} />Last signal {formatTime(snapshot.metrics.heartbeat.timestamp)}</div></div></div>

    <section className="panel"><div className="panel-header"><div><h2>Operational controls</h2><p>Commands are simulated and recorded in the event log.</p></div><StatusBadge status={snapshot.stopped ? 'stopped' : 'normal'}>{snapshot.stopped ? 'Stop latched' : 'Treatment running'}</StatusBadge></div><div className="workflow-body"><div className="control-grid" aria-busy={pending}><div className="control-card"><div><Droplets aria-hidden="true" size={20} /><h3>Supply source</h3></div><p>Confirmed source: <strong>{snapshot.source === 'rainwater' ? 'Rainwater' : 'Mains backup'}</strong></p><div className="source-buttons">{(['rainwater', 'mains'] as const).map(source => <button className={`button ${snapshot.source === source ? 'button-primary' : 'button-secondary'}`} type="button" key={source} disabled={controlsDisabled || snapshot.source === source || !snapshot.sourceAvailability[source]} onClick={() => void issueCommand({ type: 'source', source })}>{source === 'rainwater' ? 'Rainwater' : 'Mains backup'}{snapshot.source === source && <Check aria-hidden="true" size={14} />}</button>)}</div><span className="text-muted">Rainwater {snapshot.sourceAvailability.rainwater ? 'available' : 'unavailable'} · Mains {snapshot.sourceAvailability.mains ? 'available' : 'unavailable'}</span></div><div className="control-card"><div><Power aria-hidden="true" size={20} /><h3>Emergency stop</h3></div><p>{snapshot.stopped ? 'Treatment remains stopped until an explicit reset.' : 'Halt the pump and UV treatment immediately.'}</p><div className="source-buttons"><button type="button" className="button button-danger" disabled={controlsDisabled || snapshot.stopped} onClick={() => void issueCommand({ type: 'stop' })}><Power aria-hidden="true" size={16} />Stop treatment</button><button type="button" className="button button-secondary" disabled={controlsDisabled || !snapshot.stopped} onClick={() => void issueCommand({ type: 'reset' })}>Reset & restart</button></div></div></div>{!criticalDataValid && <div className="notice warning"><WifiOff aria-hidden="true" size={18} /><p>Controls are unavailable while the connection or required pressure readings are stale or offline.</p></div>}{command && <div className={`command-result ${command.status}`} role={command.status === 'rejected' || command.status === 'timeout' ? 'alert' : 'status'} aria-atomic="true">{pending && <Clock3 aria-hidden="true" className="pending-indicator" size={17} />}<StatusBadge status={command.status} /><span>{command.message}</span><span className="text-muted">{formatTime(command.timestamp)}</span>{pending && <p className="field-hint">Controls are locked while the device confirms this request.</p>}{(command.status === 'rejected' || command.status === 'timeout') && lastCommand && <div><p className="field-hint">Restore telemetry or choose an available source, then retry.</p><button type="button" className="button button-secondary" disabled={controlsDisabled} onClick={() => void issueCommand(lastCommand)}>Retry command</button></div>}</div>}<FeedbackMessage feedback={feedback} /></div></section>

    <section className="panel alert-center"><div className="panel-header"><div><h2>Alerts</h2><p>Updated {formatTime(snapshot.timestamp)} · Acknowledgment records receipt; the fault remains until its condition clears.</p></div><button type="button" className="button button-secondary button-small" disabled={!unacknowledged.length} onClick={() => unacknowledged.forEach(alert => actions.acknowledgeAlert(alert.id))}><CheckCheck aria-hidden="true" size={14} />Acknowledge all</button></div>
      <div className="alert-priority-grid" role="group" aria-label="Filter alerts"><button type="button" aria-pressed={filter === 'all'} className={`alert-priority-card all ${filter === 'all' ? 'selected' : ''}`} onClick={() => setFilter('all')}><strong>{alerts.length}</strong><span>All</span></button><button type="button" aria-pressed={filter === 'critical'} className={`alert-priority-card critical ${filter === 'critical' ? 'selected' : ''}`} onClick={() => setFilter('critical')}><strong>{critical.length}</strong><span>Critical</span></button><button type="button" aria-pressed={filter === 'warning'} className={`alert-priority-card warning ${filter === 'warning' ? 'selected' : ''}`} onClick={() => setFilter('warning')}><strong>{warnings.length}</strong><span>Warning</span></button><button type="button" aria-pressed={filter === 'acknowledged'} className={`alert-priority-card acknowledged ${filter === 'acknowledged' ? 'selected' : ''}`} onClick={() => setFilter('acknowledged')}><strong>{acknowledged.length}</strong><span>Acknowledged</span></button><button type="button" aria-pressed={filter === 'resolved'} className={`alert-priority-card resolved ${filter === 'resolved' ? 'selected' : ''}`} onClick={() => setFilter('resolved')}><strong>{resolved.length}</strong><span>Resolved</span></button></div>
      <div className="alert-list">{shownAlerts.length ? [...shownAlerts].sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical')).map(alert => <div className={`alert-row ${alert.severity} ${alert.status}`} key={alert.id}><span className={`alert-icon ${alert.severity}`}>{alert.status === 'resolved' ? <CheckCheck aria-hidden="true" size={20} /> : <AlertTriangle aria-hidden="true" size={20} />}</span><div className="alert-copy"><div className="alert-title"><strong>{alert.title}</strong><StatusBadge status={alert.status === 'resolved' ? 'resolved' : alert.severity}>{alert.status === 'resolved' ? 'Resolved' : alert.severity}</StatusBadge></div><p>{alert.message}</p><span className="text-muted">{equipmentName(alert.equipment)} · Opened {formatDate(alert.createdAt)}{alert.acknowledgedAt ? ` · Acknowledged ${formatDate(alert.acknowledgedAt)}` : ''}{alert.resolvedAt ? ` · Resolved ${formatDate(alert.resolvedAt)}` : ''}</span></div>{alert.status === 'active' && (!alert.acknowledgedAt ? <button className="button button-secondary button-small" type="button" onClick={() => actions.acknowledgeAlert(alert.id)}><Check aria-hidden="true" size={14} />Acknowledge</button> : <span className="badge acknowledged"><CheckCheck aria-hidden="true" size={14} />Acknowledged</span>)}</div>) : <div className="empty-state"><ShieldCheck aria-hidden="true" size={30} /><strong>{filter === 'all' && !alerts.length ? 'All clear' : 'No alerts in this view'}</strong><p>{filter === 'all' && !alerts.length ? 'No active alerts. New signals will appear here.' : 'Alert history will appear as conditions change.'}</p></div>}</div></section>

    <section className="panel">
      <div className="panel-header"><div><h2>Service heartbeat history</h2><p>Simulated response latency. Missing and stale signals appear as gaps.</p></div><HistoryRangeButtons range={heartbeatRange} setRange={setHeartbeatRange} /></div>
      <div className="chart-legend"><span><i style={{ background: chartColors.filtered }} />Backend latency (ms)</span></div><div className="chart-container" role="figure" aria-label={`Service heartbeat latency over ${heartbeatRange}; stale signals appear as gaps`} style={{ height: 200 }}><ResponsiveContainer width="100%" height="100%"><LineChart data={heartbeatPlot} margin={{ left: 0, right: 24, top: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartColors.grid} />
        <XAxis dataKey="timestamp" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => new Date(value).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })} minTickGap={65} tick={{ fontSize: 12, fill: chartColors.text }} axisLine={false} tickLine={false} />
        <YAxis unit=" ms" tick={{ fontSize: 12, fill: chartColors.text }} axisLine={false} tickLine={false} width={65} />
        <Tooltip labelFormatter={value => formatDate(new Date(Number(value)).toISOString())} formatter={value => [value === null || value === undefined ? 'Unavailable' : `${Number(value).toFixed(0)} ms`, 'Backend latency']} />
        <Line dataKey="latency" name="Backend latency" stroke={chartColors.filtered} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
      </LineChart></ResponsiveContainer></div>
      <HistoricalDataTable history={history} metrics={['heartbeat']} range={heartbeatRange} timestamp={snapshot.timestamp} title="Service heartbeat history" />
    </section>

    <section className="panel"><div className="panel-header"><div><h2>Device status</h2><p>Current equipment state from the shared simulated data source.</p></div></div><div className="device-grid">{equipment.map(item => <div className="device-status" key={item.id}><span className={`status-dot ${snapshot.equipment[item.id].status}`} /><strong>{item.label}</strong><StatusBadge status={snapshot.equipment[item.id].status} /></div>)}</div></section>

    <section className="panel"><div className="panel-header"><div><h2>System event log</h2><p>Timestamped connection, alert, command and workflow history · simulated backend.</p></div><div className="log-filters"><label className="search-field"><Search aria-hidden="true" size={16} /><input aria-label="Search event log" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search activity..." /></label><select aria-label="Log severity" value={logLevel} onChange={event => setLogLevel(event.target.value)}><option value="all">All levels</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select></div></div><div className="table-wrap log-table"><table className="data-table"><thead><tr><th scope="col">Time (MYT)</th><th scope="col">Level</th><th scope="col">Event</th><th scope="col">Equipment</th><th scope="col">Message</th></tr></thead><tbody>{shownEvents.map(event => <tr key={event.id}><td className="mono">{formatDate(event.timestamp)}</td><td><StatusBadge status={event.level} /></td><td>{event.type}</td><td>{event.equipment ? equipmentName(event.equipment) : 'System'}</td><td>{event.message}</td></tr>)}</tbody></table>{!shownEvents.length && <div className="empty-state"><Search aria-hidden="true" size={24} /><p>No matching activity. Try a different search or severity.</p></div>}</div><p className="text-muted helper-text">Showing {shownEvents.length} matching entries. All times use Malaysia time.</p></section>
  </div>;
}


