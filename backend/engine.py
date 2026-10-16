"""Core. Merges driver frames, derives, evaluates thresholds, broadcasts snapshots.

Knows nothing about Modbus, MQTT or the simulator — only `Frame` in, `Snapshot` out.
See DESIGN.md section 4.
"""
from __future__ import annotations

import asyncio
import itertools
from collections import deque
from datetime import datetime, timedelta
from typing import Iterable

from catalog import (
    ALL_METRICS, CLEAN_BASELINE, DEFAULT_THRESHOLDS, DERIVED, EQUIPMENT, EquipmentId,
    INSTALLATION_ID, METRICS, MetricKey, Quality, Scenario, TICK_SECONDS, rounded,
)
from drivers.base import ActuatorDriver, Frame
from drivers.registry import Registry
from drivers.sim import PlantState, SimDriver, Totals, integrate, sample
from models import (
    Alert, Command, CommandResult, EquipmentState, EventRecord, MetricReading, Override,
    Snapshot, SourceAvailability, Thresholds, now,
)

HISTORY_MINUTES = 24 * 60
EVENT_LIMIT = 300
ALERT_LIMIT = 100
HEARTBEAT_LOG_SECONDS = 30.0


class Engine:
    def __init__(self, registry: Registry, actuator: ActuatorDriver, plant: PlantState,
                 sim: SimDriver | None = None) -> None:
        self.registry = registry
        self.actuator = actuator
        self.plant = plant
        self.sim = sim

        self.latest: dict[MetricKey, Frame] = {}
        self.overrides: dict[MetricKey, Override] = {}
        self.driver_seen: dict[str, datetime] = {}
        self.thresholds = Thresholds(**DEFAULT_THRESHOLDS)
        self.alerts: list[Alert] = []
        self.events: deque[EventRecord] = deque(maxlen=EVENT_LIMIT)
        self.history: list[tuple[datetime, dict[MetricKey, float | None]]] = []
        self.snapshot: Snapshot | None = None

        self._subscribers: set[asyncio.Queue[Snapshot]] = set()
        self._command_lock = asyncio.Lock()
        self._ids = itertools.count(1)
        self._last_heartbeat_log = now()

    # ---------------------------------------------------------------- ingest

    def ingest(self, frame: Frame) -> None:
        """Partial merge, never replace: drivers report subsets at different rates."""
        self.latest[frame.metric] = frame
        if (owner := self.registry.owner.get(frame.metric)) is not None:
            self.driver_seen[owner.name] = frame.ts

    # ------------------------------------------------------------- composing

    def _fresh(self, metric: MetricKey, at: datetime) -> Frame | None:
        frame = self.latest.get(metric)
        owner = self.registry.owner.get(metric)
        if frame is None or owner is None:
            return None
        return frame if (at - frame.ts).total_seconds() < owner.max_age else None

    def _reading(self, metric: MetricKey, at: datetime) -> MetricReading:
        info = METRICS[metric]
        frame = self.latest.get(metric)
        live = self._fresh(metric, at)
        if live is not None:
            value, quality, ts = live.value, live.quality, live.ts
        elif frame is not None:
            value, quality, ts = None, "stale", frame.ts  # pin to the last good reading
        else:
            value, quality, ts = None, "unavailable", at
        if (override := self.overrides.get(metric)) is not None and not override.expired:
            value, quality, ts = override.value, override.quality, at
        return MetricReading(
            installation_id=INSTALLATION_ID, equipment_id=info.equipment, metric=metric,
            value=None if value is None else rounded(value, metric),
            unit=info.unit, quality=quality, timestamp=ts,
        )

    def _derive(self, readings: dict[MetricKey, MetricReading], at: datetime) -> None:
        """Compute metrics no instrument measures. A derived value is only as good as its
        worst input, so quality propagates rather than being asserted."""
        rank: dict[Quality, int] = {"valid": 0, "stale": 1, "unavailable": 2}
        for metric, (inputs, fn) in DERIVED.items():
            if (override := self.overrides.get(metric)) is not None and not override.expired:
                readings[metric] = MetricReading(
                    installation_id=INSTALLATION_ID, equipment_id=METRICS[metric].equipment,
                    metric=metric, value=override.value, unit=METRICS[metric].unit,
                    quality=override.quality, timestamp=at)
                continue
            parts = [readings[i] for i in inputs]
            # A derived value is only as good as its weakest input. `rank` orders
            # valid < stale < unavailable, so the worst input's quality carries over: inputs
            # that went stale make the result stale, not structurally absent.
            worst = max(parts, key=lambda r: rank[r.quality]).quality
            usable = all(p.value is not None for p in parts)
            if usable:
                value, quality = rounded(fn(*[p.value for p in parts]), metric), worst
            else:
                # No value while every input claims to be valid is a contradiction, not
                # staleness — report it as unavailable.
                value, quality = None, "unavailable" if worst == "valid" else worst
            readings[metric] = MetricReading(
                installation_id=INSTALLATION_ID, equipment_id=METRICS[metric].equipment,
                metric=metric, value=value, unit=METRICS[metric].unit, quality=quality,
                timestamp=min(p.timestamp for p in parts),
            )

    def compose(self, at: datetime | None = None) -> Snapshot:
        at = at or now()
        readings = {m: self._reading(m, at) for m in ALL_METRICS if m not in DERIVED}
        self._derive(readings, at)
        return self._evaluate(readings, at)

    # ------------------------------------------------------------ evaluating

    def _evaluate(self, readings: dict[MetricKey, MetricReading], at: datetime) -> Snapshot:
        connected = any(
            (at - seen).total_seconds() < driver.max_age
            for driver in self.registry.drivers
            if (seen := self.driver_seen.get(driver.name)) is not None
        )
        level = readings["tankLevel"].value
        out = readings["turbidityOut"].value
        delta = readings["pressureDelta"].value
        t = self.thresholds

        rain_available = connected and level is not None and level > t.low_tank
        running = not self.plant.stopped and (self.plant.source == "mains" or rain_available)

        equipment = {
            eid: EquipmentState(status="normal" if connected else "offline", label=label)
            for eid, label in EQUIPMENT.items()
        }
        if connected:
            if (out is not None and out > t.turbidity_out) or (delta is not None and delta > t.pressure_delta):
                equipment["membrane"].status = "warning"
            if level is not None and level < t.low_tank:
                equipment["tank"].status = "warning"
            if self.plant.stopped:
                for eid in ("pump", "membrane", "uv", "homes"):
                    equipment[eid].status = "stopped"
            elif not running:
                equipment["pump"].status = "stopped"
                equipment["uv"].status = "stopped"
                equipment["homes"].status = "warning"

        snapshot = Snapshot(
            installation_id=INSTALLATION_ID, timestamp=at,
            scenario=self.sim.scenario if self.sim else "normal",
            source=self.plant.source, stopped=self.plant.stopped, connected=connected,
            source_availability=SourceAvailability(rainwater=rain_available, mains=connected),
            metrics=readings, equipment=equipment, events=list(self.events),
        )
        self._reconcile_alerts(snapshot)
        snapshot.events = list(self.events)
        return snapshot

    def _reconcile_alerts(self, s: Snapshot) -> None:
        """Conditions are derived every tick; only identity and lifecycle persist.
        Ported from `reconcileAlerts` in store.ts."""
        t = self.thresholds
        out = s.metrics["turbidityOut"].value
        delta = s.metrics["pressureDelta"].value
        level = s.metrics["tankLevel"].value
        triggered: list[tuple[str, EquipmentId, str, str, str]] = []

        # Not at boot: "offline" means telemetry was there and stopped, not that no driver has
        # reported yet. Without this the UI opens on a spurious resolved alert.
        if not s.connected and self.driver_seen:
            triggered.append(("offline", "homes", "Telemetry offline",
                              "Live readings are stale. Restore the device connection before "
                              "submitting controls.", "critical"))
        if out is not None and out > t.turbidity_out:
            triggered.append(("turbidity", "membrane", "Outlet turbidity elevated",
                              f"{out:.2f} NTU exceeds the {t.turbidity_out:.2f} NTU threshold. "
                              f"Clean baseline: {CLEAN_BASELINE['turbidityOut']} NTU.", "warning"))
        if delta is not None and delta > t.pressure_delta:
            triggered.append(("pressure", "membrane", "Membrane pressure loss rising",
                              f"{delta:.2f} bar exceeds the {t.pressure_delta:.2f} bar threshold. "
                              f"Clean baseline: {CLEAN_BASELINE['pressureDelta']} bar. "
                              "Inspect flow and filter condition.", "warning"))
        if level is not None and level < t.low_tank:
            triggered.append(("lowtank", "tank", "Rainwater reserve low",
                              f"{level:.1f}% remaining; minimum operating reserve is "
                              f"{t.low_tank:.0f}%. Mains backup is available.", "warning"))
        if s.stopped:
            triggered.append(("stop", "pump", "Emergency stop latched",
                              "Treatment has stopped. An explicit operator reset is required.",
                              "critical"))

        active_keys = {key for key, *_ in triggered}
        # A quality alert is *held*, not resolved, while telemetry is offline: silence is not
        # evidence the condition cleared.
        held = {"pressure", "turbidity", "lowtank"}
        for alert in self.alerts:
            key = alert.id.split(":")[0]
            if alert.status == "active" and key not in active_keys and not (
                not s.connected and key in held
            ):
                alert.status = "resolved"
                alert.resolved_at = s.timestamp
                self.add_event("alert", f"Resolved: {alert.title}", "info", alert.equipment)

        for key, eid, title, message, severity in triggered:
            if any(a.id.startswith(f"{key}:") and a.status == "active" for a in self.alerts):
                continue
            self.alerts.insert(0, Alert(
                id=f"{key}:{self._id('alert')}", equipment=eid, title=title, message=message,
                severity=severity, status="active", created_at=s.timestamp))
            self.add_event("alert", f"Raised: {title}",
                           "error" if severity == "critical" else "warning", eid)
        del self.alerts[ALERT_LIMIT:]

    # ---------------------------------------------------------------- events

    def _id(self, prefix: str) -> str:
        return f"{prefix}-{int(now().timestamp()*1000):x}-{next(self._ids)}"

    def add_event(self, type_: str, message: str, level: str = "info",
                  equipment: EquipmentId | None = None) -> None:
        self.events.appendleft(EventRecord(id=self._id("event"), timestamp=now(), type=type_,
                                           level=level, equipment=equipment, message=message))

    # -------------------------------------------------------------- overrides

    def set_override(self, metric: MetricKey, value: float | None, quality: Quality,
                     ttl_s: float) -> Override:
        override = Override(metric=metric, value=value, quality=quality,
                            expires_at=now() + timedelta(seconds=ttl_s))
        self.overrides[metric] = override
        self.add_event("scenario",
                       f"Demo override set: {METRICS[metric].label} forced to "
                       f"{'—' if value is None else value} {METRICS[metric].unit} "
                       f"({quality}) for {ttl_s:.0f}s.",
                       "warning", METRICS[metric].equipment)
        return override

    def clear_override(self, metric: MetricKey, reason: str = "cleared") -> bool:
        if self.overrides.pop(metric, None) is None:
            return False
        self.add_event("scenario", f"Demo override {reason}: {METRICS[metric].label}.",
                       "info", METRICS[metric].equipment)
        return True

    def _expire_overrides(self) -> None:
        for metric in [m for m, o in self.overrides.items() if o.expired]:
            self.clear_override(metric, "expired")

    # --------------------------------------------------------------- history

    def backfill(self) -> None:
        """Seed 24h of per-minute history by running the simulator backwards, as store.ts does.

        Only possible while the sim owns the metrics; with real hardware this comes from the
        database instead (next slice).
        """
        if self.sim is None:
            return
        # Truncated to the minute so backfill and live rows share one bucket grid; without
        # this the last backfill row sorts after the first live row and ranges mis-slice.
        totals, at = Totals(), now().replace(second=0, microsecond=0)
        for minute in range(HISTORY_MINUTES, -1, -1):
            ts = at - timedelta(minutes=minute)
            gauges = sample(ts, "normal", self.plant)
            integrate(totals, gauges, self.plant.source, 60.0)
            values: dict[MetricKey, float | None] = {
                m: rounded(v, m) for m, v in (gauges | totals.as_dict()).items()
            }
            for metric, (inputs, fn) in DERIVED.items():
                values[metric] = rounded(fn(*[values[i] for i in inputs]), metric)  # type: ignore[arg-type]
            values.setdefault("mainsCapacity", None)
            self.history.append((ts, values))
        self.sim.totals = totals

    def record_history(self, s: Snapshot) -> None:
        """One row per minute, last write wins — same bucketing as store.ts updateHistory."""
        values = {m: r.value if r.quality == "valid" else None for m, r in s.metrics.items()}
        minute = s.timestamp.replace(second=0, microsecond=0)
        if self.history and self.history[-1][0] == minute:
            self.history[-1] = (minute, values)
        else:
            self.history.append((minute, values))
        cutoff = s.timestamp - timedelta(minutes=HISTORY_MINUTES)
        while self.history and self.history[0][0] < cutoff:
            self.history.pop(0)

    def series(self, hours: int) -> tuple[list[datetime], dict[MetricKey, list[float | None]]]:
        cutoff = now() - timedelta(hours=hours)
        rows = [(ts, v) for ts, v in self.history if ts >= cutoff]
        return [ts for ts, _ in rows], {
            m: [v.get(m) for _, v in rows] for m in sorted(ALL_METRICS)
        }

    # ------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        self.backfill()
        self.add_event("connection", "Telemetry engine started.")
        self.registry.start(self.ingest)
        self.snapshot = self.compose()
        self._tick_task = asyncio.create_task(self._tick_loop(), name="engine:tick")

    async def stop(self) -> None:
        self._tick_task.cancel()
        await asyncio.gather(self._tick_task, return_exceptions=True)
        await self.registry.stop()

    async def _tick_loop(self) -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            self._expire_overrides()
            previous, current = self.snapshot, self.compose()
            if previous is not None:
                self._record_transitions(previous, current)
            self._heartbeat(current)
            self.snapshot = current
            self.record_history(current)
            self.broadcast(current)

    def _heartbeat(self, s: Snapshot) -> None:
        if s.connected and (s.timestamp - self._last_heartbeat_log).total_seconds() >= HEARTBEAT_LOG_SECONDS:
            flow = s.metrics["flow"].value
            self.add_event("telemetry", f"Heartbeat received; {flow:.1f} L/min supplied from "
                                        f"{s.source}." if flow is not None else "Heartbeat received.")
            self._last_heartbeat_log = s.timestamp

    def _record_transitions(self, a: Snapshot, b: Snapshot) -> None:
        if a.connected != b.connected:
            self.add_event("connection",
                           "Telemetry connection restored." if b.connected
                           else "Telemetry connection lost; readings marked stale.",
                           "info" if b.connected else "error")
        for eid in EQUIPMENT:
            if a.equipment[eid].status != b.equipment[eid].status:
                status = b.equipment[eid].status
                self.add_event("telemetry",
                               f"{EQUIPMENT[eid]} status changed: {a.equipment[eid].status} "
                               f"→ {status}.",
                               "error" if status in ("critical", "offline")
                               else "warning" if status == "warning" else "info", eid)

    # --------------------------------------------------------------- commands

    async def send_command(self, command: Command) -> CommandResult:
        if self._command_lock.locked():
            self.add_event("command",
                           "Concurrent command rejected: another command is awaiting "
                           "confirmation.", "warning")
            return CommandResult(id=self._id("command"), type=command.type, status="rejected",
                                 message="Another command is awaiting confirmation.",
                                 timestamp=now())
        async with self._command_lock:
            cid = self._id("command")
            s = self.snapshot or self.compose()
            self.add_event("command", f"Requested {'source switch to ' + command.source if command.type == 'source' and command.source else command.type}.")

            if not s.connected:
                result = CommandResult(id=cid, type=command.type, status="timeout",
                                       message="No device acknowledgment received. Restore "
                                               "telemetry and try again.", timestamp=now())
            elif command.type == "source" and command.source and not getattr(
                s.source_availability, command.source
            ):
                label = "Rainwater" if command.source == "rainwater" else "Mains"
                result = CommandResult(id=cid, type=command.type, status="rejected",
                                       message=f"{label} supply is unavailable.", timestamp=now())
            elif command.type == "reset" and not getattr(s.source_availability, s.source):
                result = CommandResult(id=cid, type=command.type, status="rejected",
                                       message="The selected source is unavailable. Select an "
                                               "available source before resetting.",
                                       timestamp=now())
            else:
                applied = await self.actuator.apply(command)
                result = applied.model_copy(update={"id": cid})

            equipment: EquipmentId = (
                ("tank" if command.source == "rainwater" else "mains")
                if command.type == "source" and command.source else "pump"
            )
            self.add_event("command", result.message,
                           "info" if result.status == "confirmed"
                           else "error" if result.status == "timeout" else "warning", equipment)
            self.snapshot = self.compose()
            self.broadcast(self.snapshot)
            return result

    # -------------------------------------------------------------- streaming

    def subscribe(self) -> asyncio.Queue[Snapshot]:
        queue: asyncio.Queue[Snapshot] = asyncio.Queue(maxsize=4)
        self._subscribers.add(queue)
        if self.snapshot is not None:
            queue.put_nowait(self.snapshot)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Snapshot]) -> None:
        self._subscribers.discard(queue)

    def broadcast(self, s: Snapshot) -> None:
        for queue in list(self._subscribers):
            if queue.full():          # a slow client drops frames rather than stalling the tick
                queue.get_nowait()
            queue.put_nowait(s)
