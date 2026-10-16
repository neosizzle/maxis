import { useId, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Clock,
  Layers,
  MoreVertical,
  Radio,
  ShieldCheck,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { METRICS } from '../data/store';
import { ASSET_METADATA } from '../data/metadata';
import type { EquipmentId, HistoryRange, MetricKey, Snapshot } from '../types';

interface DigitalTwinCardsProps {
  id: EquipmentId;
  snapshot: Snapshot;
  history: Snapshot[];
  range: HistoryRange;
  setRange: (r: HistoryRange) => void;
  alerts: string[];
  onClose?: () => void;
  onManageAsset?: () => void;
}

const formatTime = (ts: string) =>
  new Date(ts).toLocaleTimeString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export default function DigitalTwinCards({
  id,
  snapshot,
  history,
  range,
  setRange,
  alerts,
  onClose,
  onManageAsset,
}: DigitalTwinCardsProps) {
  const chartId = useId();
  const meta = ASSET_METADATA[id] || ASSET_METADATA.homes;
  const status = snapshot.equipment[id]?.status || 'normal';
  const hasAlert = alerts.length > 0 || status === 'warning' || status === 'critical';

  const [activeTab, setActiveTab] = useState<'bar' | 'area'>('bar');
  const [showRangeDropdown, setShowRangeDropdown] = useState(false);

  // Filter history for selected range
  const lastTime = history.at(-1)?.timestamp ? new Date(history.at(-1)!.timestamp).getTime() : Date.now();
  const hours = range === '1h' ? 1 : range === '6h' ? 6 : 24;
  const cutoff = lastTime - hours * 3600000;
  const filteredHistory = history.filter(p => new Date(p.timestamp).getTime() >= cutoff);

  // Sample history points for crisp bar chart
  const sampleCount = range === '1h' ? 16 : range === '6h' ? 24 : 32;
  const stride = Math.max(1, Math.floor(filteredHistory.length / sampleCount));
  const chartData = filteredHistory
    .filter((_, idx) => idx % stride === 0)
    .map((p, idx) => {
      const primaryVal = p.metrics[meta.primaryMetric]?.value ?? 0;
      return {
        time: formatTime(p.timestamp),
        timestamp: p.timestamp,
        value: Number(primaryVal.toFixed(1)),
        isPeak: idx === Math.floor(sampleCount * 0.75), // visual peak indicator
      };
    });

  // Calculate peak value
  const peakVal = chartData.reduce((max, item) => Math.max(max, item.value), 0);
  const currentVal = snapshot.metrics[meta.primaryMetric]?.value ?? 0;
  const unit = METRICS[meta.primaryMetric]?.unit ?? '';

  // Health bars calculations based on current status and metrics
  const fluxHealth =
    status === 'critical'
      ? 28
      : status === 'warning'
        ? 45
        : 92;
  const waterSupplyHealth =
    snapshot.sourceAvailability[snapshot.source]
      ? status === 'normal'
        ? 88
        : 64
      : 30;
  const pressureHealth =
    status === 'critical'
      ? 32
      : status === 'warning'
        ? 58
        : 95;

  // Donut distribution data
  const distributionData = [
    { name: 'Water Treatment', value: 45, color: '#3b82f6' },
    { name: 'Pumping & Feed', value: 25, color: '#06b6d4' },
    { name: 'UV Disinfection', value: 20, color: '#8b5cf6' },
    { name: 'Auxiliary & IT', value: 10, color: '#64748b' },
  ];

  return (
    <div className="digital-twin-panel" role="region" aria-label={`${meta.name} telemetry cards`}>
      {/* CARD 1: Equipment / Building Specifications */}
      <section className="dt-card asset-specs-card">
        <div className="dt-card-header">
          <div className="dt-card-title-group">
            <span className="dt-card-eyebrow">ASSET DETAILS</span>
            <h3 className="dt-card-title">{meta.name}</h3>
          </div>
          <div className="dt-card-actions">
            {onClose && (
              <button
                type="button"
                className="dt-icon-btn"
                onClick={onClose}
                aria-label="Close equipment details"
                title="Close equipment details"
              >
                <X size={16} />
              </button>
            )}
            <button type="button" className="dt-icon-btn" aria-label="More options">
              <MoreVertical size={16} />
            </button>
          </div>
        </div>

        <div className="dt-specs-grid">
          <div className="dt-spec-row">
            <span className="dt-spec-label">Type:</span>
            <span className="dt-spec-value">{meta.type}</span>
          </div>
          <div className="dt-spec-row">
            <span className="dt-spec-label">Total Area / Capacity:</span>
            <span className="dt-spec-value">{meta.totalAreaCapacity}</span>
          </div>
          <div className="dt-spec-row">
            <span className="dt-spec-label">Tenants / Serving:</span>
            <span className="dt-spec-value">{meta.tenantsServing}</span>
          </div>
          <div className="dt-spec-row">
            <span className="dt-spec-label">Operational Since:</span>
            <span className="dt-spec-value">{meta.operationalSince}</span>
          </div>
          <div className="dt-spec-row">
            <span className="dt-spec-label">Asset Tag:</span>
            <span className="dt-spec-value highlight-tag">{meta.tag}</span>
          </div>
        </div>
      </section>

      {/* CARD 2: Real-time Telemetry & Power Draw / Flow Chart */}
      <section className="dt-card telemetry-chart-card">
        <div className="dt-card-header">
          <div className="dt-card-title-group">
            <h3 className="dt-card-title">Real-time {METRICS[meta.primaryMetric]?.label || 'Power Draw'}</h3>
          </div>
          <div className="dt-range-picker-wrapper">
            <button
              type="button"
              className="dt-range-pill"
              onClick={() => setShowRangeDropdown(!showRangeDropdown)}
              aria-label="Change time interval"
            >
              <span>{range === '1h' ? 'Real time (1h)' : range === '6h' ? '6 hours' : '24 hours'}</span>
              <ChevronDown size={14} />
            </button>
            {showRangeDropdown && (
              <div className="dt-range-dropdown">
                {(['1h', '6h', '24h'] as const).map(r => (
                  <button
                    key={r}
                    type="button"
                    className={`dt-range-opt ${r === range ? 'active' : ''}`}
                    onClick={() => {
                      setRange(r);
                      setShowRangeDropdown(false);
                    }}
                  >
                    {r === '1h' ? 'Real time (1h)' : r === '6h' ? 'Past 6 hours' : 'Past 24 hours'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 3 Prominent Stat Callouts (like Picture 2: 580 kW Peak today, 412 kW Load, 15 Alerts) */}
        <div className="dt-metrics-summary-row">
          <div className="dt-metric-stat">
            <div className="dt-stat-value">
              {peakVal > 0 ? peakVal.toFixed(1) : currentVal.toFixed(1)} <small>{unit}</small>
            </div>
            <div className="dt-stat-label">Peak today</div>
          </div>
          <div className="dt-metric-stat">
            <div className="dt-stat-value">
              {currentVal.toFixed(1)} <small>{unit}</small>
            </div>
            <div className="dt-stat-label">Current Reading</div>
          </div>
          <div className="dt-metric-stat">
            <div className={`dt-stat-value ${hasAlert ? 'alert-tint' : ''}`}>
              {alerts.length}
            </div>
            <div className="dt-stat-label">Active Alerts</div>
          </div>
        </div>

        {/* High-resolution Chart matching Picture 2 (bars with peak indicator) */}
        <div className="dt-chart-container" style={{ height: 140 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 10, right: 8, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id={`barGradient-${chartId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#0284c7" stopOpacity={0.45} />
                </linearGradient>
                <linearGradient id={`peakGradient-${chartId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0ea5e9" stopOpacity={1} />
                  <stop offset="100%" stopColor="#0369a1" stopOpacity={0.8} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="#e2e8f0" />
              <XAxis
                dataKey="time"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 10 }}
                minTickGap={28}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 10 }}
                domain={[0, 'auto']}
              />
              <Tooltip
                formatter={(val: unknown) => [`${val} ${unit}`, METRICS[meta.primaryMetric]?.label]}
                contentStyle={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: 8,
                  fontSize: 12,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                }}
              />
              <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={entry.isPeak ? `url(#peakGradient-${chartId})` : `url(#barGradient-${chartId})`}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Notice callout banner matching Picture 2 */}
        <div className={`dt-notice-banner ${hasAlert ? 'warning' : 'nominal'}`}>
          {hasAlert ? (
            <>
              <AlertTriangle size={15} className="dt-notice-icon" />
              <span>
                <strong>Warning:</strong> {alerts[0] || meta.warningNote}
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 size={15} className="dt-notice-icon" />
              <span>{meta.nominalNote}</span>
            </>
          )}
        </div>
      </section>

      {/* CARD 3: Infrastructure Health (with progress bars matching Picture 2) */}
      <section className="dt-card infrastructure-health-card">
        <div className="dt-card-header">
          <h3 className="dt-card-title">Infrastructure health</h3>
          <button type="button" className="dt-icon-btn" aria-label="Health settings">
            <MoreVertical size={16} />
          </button>
        </div>

        <div className="dt-health-bars-list">
          {/* Progress Bar 1 */}
          <div className="dt-health-item">
            <div className="dt-health-label-row">
              <span className="dt-health-title">Membrane flux / HVAC efficiency</span>
              <span className="dt-health-percent">{fluxHealth}%</span>
            </div>
            <div className="dt-progress-track">
              <div
                className={`dt-progress-fill ${fluxHealth < 50 ? 'accent-warn' : 'accent-blue'}`}
                style={{ width: `${fluxHealth}%` }}
              />
            </div>
          </div>

          {/* Progress Bar 2 */}
          <div className="dt-health-item">
            <div className="dt-health-label-row">
              <span className="dt-health-title">Water supply reliability</span>
              <span className="dt-health-percent">{waterSupplyHealth}%</span>
            </div>
            <div className="dt-progress-track">
              <div
                className="dt-progress-fill accent-blue"
                style={{ width: `${waterSupplyHealth}%` }}
              />
            </div>
          </div>

          {/* Progress Bar 3 */}
          <div className="dt-health-item">
            <div className="dt-health-label-row">
              <span className="dt-health-title">Pressure integrity & fire safety</span>
              <span className="dt-health-percent">{pressureHealth}%</span>
            </div>
            <div className="dt-progress-track">
              <div
                className={`dt-progress-fill ${pressureHealth < 40 ? 'accent-warn' : 'accent-blue'}`}
                style={{ width: `${pressureHealth}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* CARD 4: Load Distribution Donut Chart (matching Picture 2) */}
      <section className="dt-card load-distribution-card">
        <div className="dt-card-header">
          <h3 className="dt-card-title">Load distribution</h3>
          <button type="button" className="dt-icon-btn" aria-label="Distribution settings">
            <MoreVertical size={16} />
          </button>
        </div>

        <div className="dt-donut-layout">
          <div className="dt-donut-chart" style={{ width: 110, height: 110 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={distributionData}
                  dataKey="value"
                  innerRadius={36}
                  outerRadius={50}
                  paddingAngle={3}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {distributionData.map(entry => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="dt-donut-center-label">
              <strong>100%</strong>
              <span>LOAD</span>
            </div>
          </div>

          <div className="dt-donut-legend">
            {distributionData.map(entry => (
              <div className="dt-legend-row" key={entry.name}>
                <span className="dt-legend-dot" style={{ backgroundColor: entry.color }} />
                <span className="dt-legend-name">{entry.name}</span>
                <span className="dt-legend-value">{entry.value}%</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <details className="history-table-details" style={{ margin: '12px 4px 4px', borderTop: '1px solid #e2e8f0' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#0284c7', padding: '8px 0' }}>
          View recent readings as a table
        </summary>
        <div className="table-wrap" style={{ maxHeight: 180, overflowY: 'auto' }}>
          <table className="data-table" style={{ width: '100%', fontSize: 11 }}>
            <caption style={{ textAlign: 'left', padding: '4px 0', color: '#64748b' }}>
              Latest telemetry readings for {meta.name}
            </caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: 'left' }}>Time (MYT)</th>
                <th scope="col" style={{ textAlign: 'right' }}>{METRICS[meta.primaryMetric].label} ({unit})</th>
              </tr>
            </thead>
            <tbody>
              {chartData.slice(-6).reverse().map((p, i) => (
                <tr key={i}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 'normal' }}>{p.time}</th>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{p.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
