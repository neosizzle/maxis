# MAXIS backend — MVP design

Status: proposal. Nothing here is built yet; `main.py` is still the Flask + FastAPI scaffold.

## 1. The problem shape

The frontend is a complete, self-contained simulator. `frontend/src/types.ts:71` already
defines the seam the backend has to fill:

```ts
interface DataSource {
  subscribe(cb: (s: Snapshot) => void): () => void
  getHistory(metric: MetricKey, range: HistoryRange): HistoryPoint[]
  sendCommand(cmd: Command): Promise<CommandResult>
}
```

`MaxisStore` (`frontend/src/data/store.ts`) implements it plus 11 workflow actions. The
backend's job is to become that class on the server side — but it must separate three kinds
of state the store conflates:

| Kind | Source | Storage rule |
|---|---|---|
| **Telemetry** — the 24 `MetricKey`s | drivers | Ingested, append-only |
| **Reconciled** — equipment status, source availability, alert triggers | pure fn of telemetry + thresholds | **Recompute every tick, never store as truth** |
| **Operator records** — tasks, inventory, orders, incidents, thresholds | human writes | Transactional tables with invariants |

That split drives the whole architecture.

## 2. Architecture

Single process, one SQLite file. No Postgres, Redis, broker, worker, or second deployable.
`uvicorn main:app` and a `maxis.db`.

Drop Flask from `main.py` — nothing uses the `/flask` mount, and it doubles the surface for
no benefit.

```
backend/
  main.py          routes
  models.py        Pydantic mirrors of types.ts
  catalog.py       metric -> unit, equipment, owner   (ported from catalog.ts)
  engine.py        merge · evaluate · broadcast       <- core, stops changing
  db.py            SQLite + DDL
  drivers/
    base.py        Protocol + Frame
    registry.py    claim resolution, task supervision
    sim.py         SimDriver (physics ported from store.ts makeSnapshot)
    modbus.py      <- real sensors land here
    mqtt.py
    replay.py      CSV playback for demos and regression tests
```

## 3. The driver layer

The point of this layer: **integrating a real sensor is appending to a list.** Core depends
on two protocols and never on a concrete driver.

```python
# drivers/base.py
class Frame(NamedTuple):
    metric: MetricKey
    value: float | None
    ts: datetime
    quality: Quality = "valid"

class SensorDriver(Protocol):
    name: str
    provides: frozenset[MetricKey]   # declared up front
    max_age: float                   # seconds before its metrics go stale
    async def run(self, emit: Callable[[Frame], None]) -> None: ...

class ActuatorDriver(Protocol):
    name: str
    accepts: frozenset[CommandType]
    async def apply(self, cmd: Command) -> CommandResult: ...
```

`run(emit)` as a long-lived coroutine is the load-bearing choice: one shape covers both push
and poll. MQTT drivers `await` messages in a loop; Modbus/ADC drivers read-then-sleep.
Core never knows which.

Sensor and actuator are separate protocols because most real probes are read-only — a
turbidity sensor shouldn't have to stub out `apply()`.

### Registration

```python
DRIVERS = [
    ModbusTurbidity(port="/dev/ttyUSB0", unit=1),   # provides {turbidityIn, turbidityOut}
    SimDriver(),                                    # provides everything still unclaimed
]
```

Declaring `provides` statically buys three things at startup:

- **Overlapping claims are a boot error**, not a race between two drivers writing one metric.
- **The sim backfills automatically** (`SimDriver.provides = ALL_METRICS - claimed`). Plug in
  a real turbidity probe and the sim silently stops generating those two metrics — no edits
  to the sim, the engine, or the UI. Hardware integration goes sensor-by-sensor instead of
  all-at-once.
- **An unclaimed metric is `unavailable`**, a `Quality` the frontend already renders
  (`mainsCapacity` is permanently this).

### Failure convention

A driver that can't read **stops emitting**. It never fabricates a value and never signals
staleness explicitly — `max_age` does that. One less thing for every future driver to get
right.

`registry.py` supervises: each driver runs as its own task, and a crashing driver restarts
with backoff while its metrics go stale. It does not take the server down.

### An example driver

Scaling, calibration and protocol quirks live here, never in core:

```python
class ModbusTurbidity:
    name, provides, max_age = "turbidity", frozenset({"turbidityIn", "turbidityOut"}), 30.0

    async def run(self, emit):
        while True:
            try:
                raw = await self.client.read_input_registers(0x00, 2)
                for metric, reg in zip(("turbidityIn", "turbidityOut"), raw):
                    emit(Frame(metric, (reg / 4095 * 16 - 4) / 16 * 100, now()))  # 4-20mA -> NTU
            except ModbusError:
                pass          # emit nothing; max_age makes it stale on its own
            await asyncio.sleep(5)
```

Two conventions fixed now: drivers declare `kind: gauge | counter`, so a real totalizing flow
meter writes `rainUsage` directly instead of core integrating it; and `emit` is sync and
non-blocking so a slow driver can't stall the tick.

## 4. Engine

```python
def ingest(self, frame):
    self.latest[frame.metric] = frame            # partial merge, never replace

def compose(self):                               # every 2s
    metrics = {m: self._reading(m) for m in ALL_METRICS}
    return self._evaluate(metrics)               # thresholds -> status, alerts
```

Composing snapshots rather than receiving them is the one core change the driver layer costs,
and it is necessary: real devices report **subsets** at **different rates**. A flow meter at
1 Hz and an energy counter every 5 minutes cannot both hand over a complete snapshot.

### Per-metric freshness

`max_age` per driver replaces the store's all-or-nothing connected flag:

```python
def _reading(self, m: MetricKey) -> MetricReading:
    f = self.latest.get(m)
    fresh = f and (now() - f.ts).total_seconds() < self.owner[m].max_age
    return MetricReading(metric=m, unit=CATALOG[m].unit,
                         equipment_id=CATALOG[m].equipment,
                         value=f.value if fresh else None,
                         quality=f.quality if fresh else "stale",
                         ts=f.ts if f else now())        # pin to last good
```

Strictly more correct than today: one dead turbidity probe no longer marks tank level stale.
`snapshot.connected` survives for the frontend, defined as *any driver live*, so
`MetricCard`'s amber-dot path (`App.tsx:37`) keeps working unchanged.

### Alerts: condition derived, lifecycle persisted

`reconcileAlerts()` (`store.ts:265`) ports as-is, with its dedupe key (`turbidity:`,
`pressure:`, `lowtank:`, `offline:`, `stop:`) as a real column. That includes the subtlety at
`store.ts:277` that quality alerts are *held*, not resolved, while telemetry is offline.

Acknowledgement is a separate timestamp that never affects status. Storing a status you could
recompute is how the alert list and the equipment badges drift apart.

## 5. Storage

Live 2-second ticks stay in memory. One row per minute per metric goes to SQLite — the only
resolution the charts use. 24h x 24 metrics is ~35k rows/day; SQLite yawns.

On startup, backfill 24h by running the sim backwards, exactly as `store.ts:56` does.

```sql
reading(ts, metric, value, quality, PRIMARY KEY(ts, metric))
totals(key PK, value)                               -- rainUsage, solarEnergy, ...
alert(id PK, dedupe_key, equipment_id, title, message, severity,
      status, created_at, acknowledged_at, resolved_at)
event(id PK, ts, type, level, equipment_id, message)
command(id PK, type, payload, status, message, ts)  -- audit only
threshold(id PK CHECK(id=1), turbidity_out, pressure_delta, low_tank)
inventory_item(id PK, name, category, quantity, unit, minimum)
supply_order(id PK, item_id, quantity, status, created_at, updated_at)
task(id PK, equipment_id, description, status, created_at, completed_at, supplies_used JSON)
incident(id PK, description, source, status, created_at)
```

No `installation_id` anywhere — single site. `catalog.ts` becomes Python constants, not tables.

Cumulative totals must live in the database, not process memory. `integrate()`
(`store.ts:36`) accumulates `rainUsage`/`solarEnergy` in the store; a restart would zero the
energy donut.

Two invariants stay, because they are correctness rather than infrastructure. Check
`rowcount`; reject on zero:

```sql
UPDATE inventory_item SET quantity = quantity - :n WHERE id = :id AND quantity >= :n;
UPDATE supply_order   SET status = 'received'      WHERE id = :id AND status = 'ordered';
```

The first stops a task completion overselling stock (`store.ts:367`); the second stops a
double-click crediting an order twice.

## 6. API

```
GET  /api/snapshot
GET  /api/stream                   SSE, full Snapshot every 2s
GET  /api/series?range=            columnar
POST /api/commands                 blocks ~650ms, returns CommandResult
GET/PATCH /api/thresholds
GET  /api/alerts   POST /api/alerts/{id}/acknowledge
GET  /api/events
GET/POST /api/tasks        POST /api/tasks/{id}/complete
GET  /api/inventory        POST /api/inventory/{id}/adjust
GET/POST /api/orders       POST /api/orders/{id}/advance
GET/POST /api/incidents
POST /api/sim/scenario     POST /api/sim/reset
```

Commands block in the handler, mirroring `store.ts:318`:

```python
async def send_command(cmd: Command) -> CommandResult:
    if lock.locked():
        return CommandResult(status="rejected",
                             message="Another command is awaiting confirmation.")
    async with lock:
        return await actuator.apply(cmd)
```

One `asyncio.Lock` replaces a partial unique index, and `sendCommand` stays a plain
`await fetch()` on the client — no adapter logic. The ack-based flow a slow real actuator
needs becomes an implementation detail of that `ActuatorDriver`, not a change to routes.

Scenario endpoints belong to the simulator and are never part of a device-facing API.

### 6.1 Demo overrides

Scenarios are whole-plant presets. To demonstrate alerting at a precise threshold edge, add
per-metric overrides — in the **engine**, not in a driver:

```python
# engine.py
overrides: dict[MetricKey, Override] = {}

def _reading(self, m):
    r = ...                                   # normal driver path, as in section 4
    if (o := self.overrides.get(m)) and not o.expired:
        r = r.model_copy(update={"value": o.value, "quality": o.quality})
    return r
```

```
PUT    /api/sim/override/{metric}   {value, quality?, ttl_s?}
DELETE /api/sim/override/{metric}
GET    /api/sim/override
```

Roughly 30 lines: an `overrides` dict plus three lines in `_reading()`, three routes, one
model. No schema change — overrides are deliberately ephemeral, because one surviving a
restart is a trap. No frontend change.

It is this cheap because reconciled state is recomputed every tick rather than stored
(section 1). Injecting at the single point every consumer derives from means the alert raise,
the equipment badge, the event log, the SSE push and the stale card all follow with no extra
code.

Two properties worth keeping:

- **The override sits above `_reading`, not inside `SimDriver`**, so it works on a rig with a
  real probe attached — no unplugging to demo. Implementing it as a high-priority driver
  instead would mean replacing the registry's boot-time overlap check with ordered
  precedence, losing a real safety property to buy nothing.
- **`quality` is overridable too.** Forcing `stale` or `unavailable` demos the offline alert
  and the amber last-seen card path without touching the network — the one demo you otherwise
  cannot stage.

Alert dedupe means repeated calls will not spam: the alert raises once and resolves when the
override clears or expires.

**Safety.** Overrides carry a TTL and emit an `event` row when set and when cleared. On a rig
with real sensors, a forced reading indistinguishable from a measured one is dangerous, and
the event log is an audit trail the frontend already renders. A visible on-screen banner is
stronger but needs a new `Snapshot` field plus UI work — the first thing in this design that
costs frontend changes. Demo-only: event log. Real hardware: pay for the banner.

No auth. Role stays frontend-only state, as it is today. Add a shared bearer token when the
demo goes on a public URL — a 5-line dependency, not a design.

## 7. Frontend integration

**Nothing in the view layer changes.** `MetricCard`, `TrendChart`, the equipment badges and
the connection pill all read from `Snapshot`. Add an `ApiSource` sibling to `MaxisStore` and
let the existing Demo/Live toggle (`App.tsx:74`) choose:

```ts
export function useMaxis() {
  const src = mode === 'live' ? apiSource : demoStore
  const state = useSyncExternalStore(src.subscribeState, src.getState, src.getState)
  return { ...state, actions: src.actions }
}
```

```ts
this.es = new EventSource('/api/stream')
this.es.addEventListener('snapshot', e => {
  this.snapshot = JSON.parse(e.data)
  this.appendMinute(this.snapshot)   // same minute-bucket LWW as store.ts:232
  this.armWatchdog()
  this.emit()
})
this.es.onerror = () => { this.markStale(); this.scheduleRetry(); }
```

`appendMinute` is what makes the chart's right edge advance without refetching.

**EventSource does not always reconnect by itself.** It retries after a clean socket drop, but
a proxy or load balancer answering 5xx fails the connection permanently — which is exactly what
happens when the backend is down, since the dev proxy returns 500. Recovery needs an explicit
retry, and that retry must re-run `/bootstrap` rather than just reopening the stream: while
disconnected the client missed history minutes, alert transitions and any workflow writes made
elsewhere. Verified by hard-killing the backend and restarting it; the dashboard goes stale
within ~6s and recovers within ~4s of the backend returning.

A graceful shutdown is a different case worth knowing: uvicorn stops accepting connections
while continuing to serve the open stream, so the dashboard keeps ticking from a server that
is already refusing new requests. Only a hard failure trips the watchdog.

### Staleness: two sources, one render path

| What broke | Detected by | Arrives as |
|---|---|---|
| Sensor stopped reporting | driver `max_age` | snapshot with `quality:'stale'`, ts pinned to last valid |
| Server or network down | **client** watchdog | nothing — synthesize it |

The second case does not exist today. After ~3 missed ticks, degrade the last known snapshot
in place:

```ts
private markStale() {
  if (!this.snapshot?.connected) return
  this.snapshot = { ...this.snapshot, connected: false,
    metrics: map(this.snapshot.metrics, m => ({ ...m, quality: 'stale' })),   // keep m.timestamp
    equipment: map(this.snapshot.equipment, e => ({ ...e, status: 'offline' })),
    sourceAvailability: { rainwater: false, mains: false } }
  this.emit()
}
```

Keeping `m.timestamp` at the last good reading is the whole trick — it makes the card read
*"stale · last seen 14:32"* instead of freezing on a stale number that looks live.
`staleSince` (`store.ts:195`) already does this, so the UI renders it correctly today.

### History goes columnar

As `Snapshot[]`, 24h of history is ~5 MB, because every point repeats `installationId`,
`equipmentId`, `unit` and `quality` as strings. Bare numbers in columns measure 267 KB raw
and 64 KB gzipped for all 24 metrics over 1440 points (`GET /api/series?range=24h`):

```json
{ "range":"24h", "step":60, "t":[...], "series":{ "flow":[18.1, ...], "turbidityOut":[0.22, ...] } }
```

Fetch all metrics on range change and rehydrate to `Snapshot[]` in the adapter, so
`TrendChart` and the CSV export stay untouched.

### Commands

Do not optimistically mutate the snapshot on success. The toast comes from `CommandResult`;
the next tick carries the truth. That is what keeps the UI honest when a device rejects.

## 8. Migration

1. ~~`ApiSource` alongside `MaxisStore`; the toggle picks.~~ Done — `frontend/src/data/api.ts`,
   selected by `setDataMode` in `store.ts`.
2. ~~Read-only first: snapshot + stream + series.~~ Done, via `/api/bootstrap` in one round trip.
3. ~~Commands, then workflow writes.~~ Done.
4. Keep `MaxisStore` permanently. It is the offline demo mode and the integration fixture,
   not scaffolding.

Still open: SQLite persistence (section 5). History and operator records live in memory, so a
restart reseeds from the simulator.

### Workflow writes are optimistically synchronous

The UI calls workflow actions synchronously (`if (reportResult(actions.addTask(...)))`), so
`ApiSource` validates locally against the state it already holds, returns that result, POSTs in
the background and refetches the affected collections from the response. The server stays
authoritative — it enforces the stock and order invariants itself and a rejection corrects the
client on the refetch — but the local check duplicates those rules well enough to mislead a
second operator working concurrently. Making those call sites await their result is the clean
fix when single-operator stops being a safe assumption.

## 9. Known ceilings

Single process means one server and no horizontal scale. Restarts drop SSE connections, which
clients reconnect through invisibly. Operator records and cumulative totals survive restarts;
the live 2-second tick does not, which does not matter.

Revisit SQLite at roughly a dozen sites or the first multi-instance deploy. Revisit blocking
commands the first time a real actuator acks slower than a request timeout.

## 10. Build order

`drivers/base.py` + `SimDriver` + `engine.compose()` first. It is the piece everything plugs
into, and it makes the sim-vs-real split testable before any routes exist.
