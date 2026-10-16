"""Self-checks for the parts of the design that are easy to break. Run: python test_engine.py"""
from __future__ import annotations

import asyncio
from datetime import timedelta

from catalog import DERIVED, MetricKey
from drivers.base import Frame
from drivers.registry import DriverConflict, Registry
from drivers.sim import PlantState, SimActuator, SimDriver
from engine import Engine
from models import Command, now

checks: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    checks.append(name)
    assert condition, f"{name}: {detail}"
    print(f"  ok  {name}")


class FakeProbe:
    """Stands in for a real turbidity sensor."""
    name = "probe"
    provides = frozenset({"turbidityIn", "turbidityOut"})
    max_age = 30.0

    async def run(self, emit):           # pragma: no cover - not started in these checks
        await asyncio.sleep(3600)


def build(drivers) -> Engine:
    plant = PlantState()
    return Engine(Registry(drivers), SimActuator(plant), plant,
                  sim=next((d for d in drivers if isinstance(d, SimDriver)), None))


# --- the driver-swap story ----------------------------------------------------
plant = PlantState()
probe = FakeProbe()
sim_alone = SimDriver(PlantState())
sim_with_probe = SimDriver(plant, claimed=probe.provides)

check("simulator backfills only unclaimed metrics",
      sim_alone.provides - sim_with_probe.provides == probe.provides,
      f"{sorted(sim_alone.provides - sim_with_probe.provides)}")
check("a real driver owns its metrics",
      build([probe, sim_with_probe]).registry.owner["turbidityOut"] is probe)

try:
    build([probe, sim_alone])
except DriverConflict:
    check("overlapping claims fail at boot", True)
else:
    check("overlapping claims fail at boot", False, "no DriverConflict raised")

# --- freshness and derivation -------------------------------------------------
e = build([sim_alone])
at = now()
for metric in sim_alone.provides:
    e.ingest(Frame(metric, 1.0 if metric != "pressureIn" else 3.0, at))
e.ingest(Frame("pressureOut", 1.0, at))
s = e.compose(at)
check("derived metric computes", s.metrics["pressureDelta"].value == 2.0,
      str(s.metrics["pressureDelta"].value))
check("unclaimed metric is unavailable", s.metrics["mainsCapacity"].quality == "unavailable")

stale = e.compose(at + timedelta(seconds=sim_alone.max_age + 1))
check("silence becomes staleness", stale.metrics["flow"].quality == "stale")
check("stale reading keeps its last-seen timestamp", stale.metrics["flow"].timestamp == at)
check("stale propagates into derived", stale.metrics["pressureDelta"].quality == "stale")
check("no driver reporting means disconnected", stale.connected is False)

# --- overrides ----------------------------------------------------------------
CLEAN: dict[MetricKey, float] = {"tankLevel": 70.0, "turbidityOut": 0.22,
                                 "pressureIn": 2.85, "pressureOut": 2.40}


def seed(engine, at, **extra: float) -> None:
    values = CLEAN | extra
    for metric in sim_alone.provides:
        engine.ingest(Frame(metric, values.get(metric, 1.0), at))


e = build([sim_alone])
at = now()
seed(e, at)
e.snapshot = e.compose(at)
check("no alert at clean readings", not [a for a in e.alerts if a.status == "active"],
      str([a.title for a in e.alerts]))

e.set_override("turbidityOut", 1.45, "valid", ttl_s=60)
e.snapshot = e.compose(at)
active = [a for a in e.alerts if a.status == "active"]
check("override raises exactly one alert", len(active) == 1, str([a.title for a in active]))
check("override drives the equipment badge",
      e.snapshot.equipment["membrane"].status == "warning")

e.compose(at)
check("repeated ticks do not duplicate the alert",
      len([a for a in e.alerts if a.status == "active"]) == 1)

e.clear_override("turbidityOut")
e.compose(at)
check("clearing the override resolves the alert",
      not [a for a in e.alerts if a.status == "active"])

e.set_override("tankLevel", None, "stale", ttl_s=60)
s = e.compose(at)
check("quality-only override works", s.metrics["tankLevel"].quality == "stale")
check("derived metric follows an overridden input",
      s.metrics["tankVolume"].quality == "stale", s.metrics["tankVolume"].quality)

e.overrides["tankLevel"].expires_at = now() - timedelta(seconds=1)
e._expire_overrides()
check("overrides expire on their own", "tankLevel" not in e.overrides)

check("no driver may claim a derived metric", frozenset(DERIVED).isdisjoint(sim_alone.provides))

# --- commands -----------------------------------------------------------------
async def commands() -> None:
    e = build([sim_alone])
    at = now()
    seed(e, at)
    e.snapshot = e.compose(at)
    # Both start in the same event-loop pass; send_command checks the lock synchronously
    # before awaiting, so exactly one wins regardless of ordering.
    a, b = await asyncio.gather(e.send_command(Command(type="stop")),
                                e.send_command(Command(type="stop")))
    check("one command at a time",
          {a.status, b.status} == {"confirmed", "rejected"}, f"{a.status}/{b.status}")
    check("stop latches the plant", e.plant.stopped is True)

    e.latest.clear(); e.driver_seen.clear()
    e.snapshot = e.compose(now())
    result = await e.send_command(Command(type="reset"))
    check("commands time out while disconnected", result.status == "timeout", result.message)

asyncio.run(commands())
print(f"\n{len(checks)} checks passed")
