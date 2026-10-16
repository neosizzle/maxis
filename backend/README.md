# MAXIS backend

Telemetry, alerting and controls for the township water installation. Design and rationale:
[DESIGN.md](DESIGN.md).

```bash
uv sync
uv run uvicorn main:app --reload --port 8000
uv run python test_engine.py        # 21 self-checks, no server needed
```

Docs at `/docs`, liveness and driver ownership at `/api/health`.

## Adding a real sensor

Write a driver in `drivers/`, then append it to `DRIVERS` in `main.py`:

```python
DRIVERS = [ModbusTurbidity(port="/dev/ttyUSB0", unit=1), sim]
```

It claims `turbidityIn`/`turbidityOut`; the simulator backfills everything else
automatically. Nothing in `engine.py`, `main.py` or the frontend changes. Two drivers
claiming one metric is a startup error, and a metric no driver claims reads `unavailable`.

A driver that cannot read should **emit nothing** — `max_age` turns silence into staleness.
Never fabricate a value.

## Demonstrating alerting

```bash
# force a reading past its threshold (default thresholds: 1.0 NTU, 0.9 bar, 15%)
curl -X PUT localhost:8000/api/sim/override/turbidityOut \
     -H 'content-type: application/json' -d '{"value":1.45,"ttl_s":120}'

curl -s 'localhost:8000/api/alerts?status=active'
curl -X DELETE localhost:8000/api/sim/override/turbidityOut
```

Overrides apply above the driver layer, so they work with real sensors attached. Setting
`{"quality":"stale"}` exercises the offline paths without touching the network. Every
override is logged to the event feed and expires on its own (`ttl_s`, default 300s).

Whole-plant presets instead of single metrics:

```bash
curl -X POST 'localhost:8000/api/sim/scenario?scenario=filter-degradation'
```

`/api/sim/*` is demo-only and never part of a device-facing API.

## Running with the dashboard

```bash
uv run uvicorn main:app --port 8000      # this directory
cd ../frontend && npm run dev            # proxies /api to 127.0.0.1:8000
```

Open http://127.0.0.1:5173 and press **Live API** in the top bar. Demo mode keeps working
offline with the in-browser simulator.

## Not built yet

SQLite persistence: history and operator records are in memory, so a restart reseeds from the
simulator. See DESIGN.md §5, §8.
