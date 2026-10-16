"""MAXIS backend. See DESIGN.md."""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from catalog import ALL_METRICS, DERIVED, MetricKey, SCENARIO_LABELS, Scenario
from drivers.registry import Registry
from drivers.sim import PlantState, SimActuator, SimDriver
from engine import Engine
from models import (
    AdjustRequest, Alert, Command, CommandResult, CompleteTaskRequest, EventRecord, Incident,
    IncidentRequest, InventoryItem, MaintenanceTask, OrderRequest, Override, OverrideRequest,
    Series, Snapshot, SupplyOrder, TaskRequest, ThresholdPatch, Thresholds, now,
)
from workflows import Rejected, Workflows

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

# ---------------------------------------------------------------- composition
# Real hardware goes here. Append a driver and it claims its metrics; the simulator backfills
# whatever is left. Nothing below this block needs to change. See DESIGN.md section 3.
plant = PlantState()
sim = SimDriver(plant)
DRIVERS = [sim]
ACTUATOR = SimActuator(plant)

engine = Engine(Registry(DRIVERS), ACTUATOR, plant, sim=sim)
workflows = Workflows(log=engine.add_event)


def rejected(exc: Rejected) -> HTTPException:
    """An invariant violation is the client's fault, not a server fault."""
    return HTTPException(409, str(exc))


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await engine.start()
    try:
        yield
    finally:
        await engine.stop()


app = FastAPI(title="MAXIS backend", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"], allow_headers=["*"],
)


def _metric(metric: str) -> MetricKey:
    if metric not in ALL_METRICS:
        raise HTTPException(404, f"Unknown metric '{metric}'")
    return metric  # type: ignore[return-value]


# ----------------------------------------------------------------- telemetry

@app.get("/api/snapshot", response_model=Snapshot, response_model_by_alias=True)
async def get_snapshot() -> Snapshot:
    return engine.snapshot or engine.compose()


@app.get("/api/stream")
async def stream() -> StreamingResponse:
    """SSE. One `snapshot` event per tick, plus one immediately on connect."""
    async def events() -> AsyncIterator[bytes]:
        queue = engine.subscribe()
        try:
            while True:
                try:
                    snapshot = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield b": keepalive\n\n"      # keeps proxies from closing an idle stream
                    continue
                payload = snapshot.model_dump_json(by_alias=True)
                yield f"event: snapshot\ndata: {payload}\n\n".encode()
        finally:
            engine.unsubscribe(queue)

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no",
    })


@app.get("/api/series", response_model=Series, response_model_by_alias=True)
async def get_series(range: Literal["1h", "6h", "24h"] = "24h") -> Series:
    """Columnar: bare numbers, not repeated MetricReading objects. See DESIGN.md section 7."""
    t, series = engine.series(int(range.rstrip("h")))
    return Series(range=range, step=60, t=t, series=series)


# --------------------------------------------------------------------- state

@app.get("/api/alerts", response_model=list[Alert], response_model_by_alias=True)
async def get_alerts(status: Literal["active", "resolved"] | None = None) -> list[Alert]:
    return [a for a in engine.alerts if status is None or a.status == status]


@app.post("/api/alerts/{alert_id}/acknowledge", response_model=Alert,
          response_model_by_alias=True)
async def acknowledge(alert_id: str) -> Alert:
    for alert in engine.alerts:
        if alert.id == alert_id:
            if alert.acknowledged_at is None:
                alert.acknowledged_at = now()
                engine.add_event("alert", f"Acknowledged: {alert.title}. The condition remains "
                                          f"{alert.status}.", "info", alert.equipment)
            return alert
    raise HTTPException(404, "Unknown alert")


@app.get("/api/events", response_model=list[EventRecord], response_model_by_alias=True)
async def get_events(limit: int = 100) -> list[EventRecord]:
    return list(engine.events)[:limit]


@app.get("/api/thresholds", response_model=Thresholds, response_model_by_alias=True)
async def get_thresholds() -> Thresholds:
    return engine.thresholds


@app.patch("/api/thresholds", response_model=Thresholds, response_model_by_alias=True)
async def patch_thresholds(patch: ThresholdPatch) -> Thresholds:
    engine.thresholds = engine.thresholds.model_copy(
        update=patch.model_dump(exclude_none=True))
    engine.add_event("maintenance", "Alert thresholds updated. Clean-filter baseline unchanged.")
    engine.snapshot = engine.compose()
    engine.broadcast(engine.snapshot)
    return engine.thresholds


@app.post("/api/commands", response_model=CommandResult, response_model_by_alias=True)
async def post_command(command: Command) -> CommandResult:
    if command.type == "source" and command.source is None:
        raise HTTPException(422, "A source command requires a source")
    return await engine.send_command(command)


# ------------------------------------------------------------------ demo only
# Simulator controls. Never part of a device-facing API. See DESIGN.md section 6.1.

@app.post("/api/sim/scenario", response_model=Snapshot, response_model_by_alias=True)
async def set_scenario(scenario: Scenario) -> Snapshot:
    if sim is None:
        raise HTTPException(409, "No simulator is running")
    sim.scenario = scenario
    engine.add_event("scenario", f"Demo scenario selected: {SCENARIO_LABELS[scenario]}.")
    engine.snapshot = engine.compose()
    engine.broadcast(engine.snapshot)
    return engine.snapshot


@app.get("/api/sim/override", response_model=list[Override], response_model_by_alias=True)
async def list_overrides() -> list[Override]:
    return list(engine.overrides.values())


@app.put("/api/sim/override/{metric}", response_model=Override, response_model_by_alias=True)
async def set_override(metric: str, body: OverrideRequest) -> Override:
    """Force one metric, to demonstrate alerting at a precise threshold edge.

    Applies above the driver layer, so it works on a rig with real sensors attached. Setting
    `quality` to `stale` or `unavailable` exercises the offline paths without touching the
    network.
    """
    key = _metric(metric)
    if body.quality == "valid" and body.value is None:
        raise HTTPException(422, "A valid reading needs a value")
    override = engine.set_override(key, body.value, body.quality, body.ttl_s)
    engine.snapshot = engine.compose()
    engine.broadcast(engine.snapshot)
    return override


@app.delete("/api/sim/override/{metric}", response_model=Override | None,
            response_model_by_alias=True)
async def clear_override(metric: str) -> None:
    if not engine.clear_override(_metric(metric)):
        raise HTTPException(404, "No override set for that metric")
    engine.snapshot = engine.compose()
    engine.broadcast(engine.snapshot)
    return None


# ------------------------------------------------------------------ workflows

@app.get("/api/tasks", response_model=list[MaintenanceTask], response_model_by_alias=True)
async def get_tasks() -> list[MaintenanceTask]:
    return workflows.tasks


@app.post("/api/tasks", response_model=MaintenanceTask, response_model_by_alias=True)
async def post_task(body: TaskRequest) -> MaintenanceTask:
    try:
        return workflows.add_task(body.equipment, body.description)
    except Rejected as exc:
        raise rejected(exc) from exc


@app.post("/api/tasks/{task_id}/complete", response_model=MaintenanceTask,
          response_model_by_alias=True)
async def complete_task(task_id: str, body: CompleteTaskRequest) -> MaintenanceTask:
    try:
        return workflows.complete_task(task_id, body.item_id, body.quantity)
    except Rejected as exc:
        raise rejected(exc) from exc


@app.get("/api/inventory", response_model=list[InventoryItem], response_model_by_alias=True)
async def get_inventory() -> list[InventoryItem]:
    return workflows.inventory


@app.post("/api/inventory/{item_id}/adjust", response_model=InventoryItem,
          response_model_by_alias=True)
async def adjust_inventory(item_id: str, body: AdjustRequest) -> InventoryItem:
    try:
        return workflows.adjust(item_id, body.delta)
    except Rejected as exc:
        raise rejected(exc) from exc


@app.get("/api/orders", response_model=list[SupplyOrder], response_model_by_alias=True)
async def get_orders() -> list[SupplyOrder]:
    return workflows.orders


@app.post("/api/orders", response_model=SupplyOrder, response_model_by_alias=True)
async def post_order(body: OrderRequest) -> SupplyOrder:
    try:
        return workflows.create_order(body.item_id, body.quantity)
    except Rejected as exc:
        raise rejected(exc) from exc


@app.post("/api/orders/{order_id}/advance", response_model=SupplyOrder,
          response_model_by_alias=True)
async def advance_order(order_id: str) -> SupplyOrder:
    try:
        return workflows.advance_order(order_id)
    except Rejected as exc:
        raise rejected(exc) from exc


@app.get("/api/incidents", response_model=list[Incident], response_model_by_alias=True)
async def get_incidents() -> list[Incident]:
    return workflows.incidents


@app.post("/api/incidents", response_model=Incident, response_model_by_alias=True)
async def post_incident(body: IncidentRequest) -> Incident:
    try:
        return workflows.report_incident(body.description, body.source)
    except Rejected as exc:
        raise rejected(exc) from exc


@app.get("/api/bootstrap")
async def bootstrap(range: Literal["1h", "6h", "24h"] = "24h") -> dict[str, object]:
    """Everything the client needs on connect, in one round trip."""
    t, series = engine.series(int(range.rstrip("h")))
    dump = lambda items: [i.model_dump(by_alias=True, mode="json") for i in items]
    return {
        "snapshot": (engine.snapshot or engine.compose()).model_dump(by_alias=True, mode="json"),
        "series": Series(range=range, step=60, t=t, series=series).model_dump(by_alias=True, mode="json"),
        "alerts": dump(engine.alerts),
        "events": dump(engine.events),
        "thresholds": engine.thresholds.model_dump(by_alias=True, mode="json"),
        "tasks": dump(workflows.tasks),
        "inventory": dump(workflows.inventory),
        "orders": dump(workflows.orders),
        "incidents": dump(workflows.incidents),
    }


@app.post("/api/sim/reset", response_model=Snapshot, response_model_by_alias=True)
async def reset_demo() -> Snapshot:
    """Restore the seeded demo state. Simulator-only, like the rest of /api/sim."""
    if sim is None:
        raise HTTPException(409, "No simulator is running")
    sim.reset()
    plant.source, plant.stopped = "rainwater", False
    engine.alerts.clear()
    engine.overrides.clear()
    engine.events.clear()
    workflows.reset()
    engine.add_event("scenario", "Demo reset to normal operation. Workflow records cleared.")
    engine.snapshot = engine.compose()
    engine.broadcast(engine.snapshot)
    return engine.snapshot


@app.get("/api/health")
async def health() -> dict[str, object]:
    s = engine.snapshot
    return {
        "status": "ok",
        "connected": bool(s and s.connected),
        "drivers": {d.name: sorted(d.provides) for d in engine.registry.drivers},
        "unclaimed": sorted(ALL_METRICS - frozenset(engine.registry.owner) - frozenset(DERIVED)),
        "overrides": sorted(engine.overrides),
        "history_minutes": len(engine.history),
    }
