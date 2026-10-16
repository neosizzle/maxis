"""Simulated plant. Physics ported from frontend/src/data/store.ts `makeSnapshot`.

This is a driver like any other: it emits Frames through the same port a Modbus probe would
and holds no privileged position in core. Give a real sensor the same metric and the
simulator stops producing it (see Registry claim resolution) with no edit to this file.
"""
from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from catalog import (
    CLEAN_BASELINE, COUNTERS, DERIVED, MetricKey, Scenario, Source, TICK_SECONDS,
)
from drivers.base import Emit, Frame
from models import Command, CommandResult, now

#: The pump's own dry-run cutout. Deliberately *not* `thresholds.lowTank`: that is an
#: operator alerting preference, while this is plant protection wired into the starter.
#: They default to the same number so the demo matches the frontend.
SIM_LOW_TANK_CUTOUT = 15.0

#: Gauges this driver measures. Counters are added below; derived metrics are the engine's.
SIM_GAUGES: frozenset[MetricKey] = frozenset({
    "tankLevel", "turbidityIn", "turbidityOut", "pressureIn", "pressureOut", "flow",
    "solarPower", "pumpPower", "uvPower", "miscPower", "mainsTurbidity", "mainsPressure",
    "heartbeat",
})
#: `mainsCapacity` is claimed by nobody on purpose: the utility exposes no such telemetry, so
#: it reads `unavailable` — the same way an unwired sensor would.


@dataclass
class PlantState:
    """What the plant is currently doing. The actuator writes it; sensors read it.

    On real hardware the device owns this and reports it back; here the two sim drivers share
    one instance.
    """
    source: Source = "rainwater"
    stopped: bool = False


@dataclass
class Totals:
    """Bulk-meter and energy-meter registers. A real meter reports these directly; the
    simulator integrates them, which is why this driver is a `counter` source."""
    rainUsage: float = 124.82
    mainsUsage: float = 18.36
    solarEnergy: float = 48.2
    pumpEnergy: float = 39.1
    uvEnergy: float = 8.6
    miscEnergy: float = 5.3

    def as_dict(self) -> dict[MetricKey, float]:
        return {k: v for k, v in self.__dict__.items()}  # type: ignore[misc]


def sample(ts: datetime, scenario: Scenario, plant: PlantState) -> dict[MetricKey, float]:
    """Pure: the instantaneous gauge readings at `ts`. Used live and for history backfill."""
    t = ts.timestamp() * 1000.0
    wave = math.sin(t / 95_000.0)
    gentle = math.sin(t / 510_000.0)
    minute_of_day = ((t / 60_000.0 + 480.0) % 1440.0 + 1440.0) % 1440.0
    sun = max(0.0, math.sin((minute_of_day / 60.0 - 6.0) / 12.0 * math.pi))

    degraded = scenario == "filter-degradation"
    low = scenario == "low-tank"
    heavy = scenario == "heavy-rain"

    tank_level = 9.0 + gentle if low else 91.0 + gentle * 2 if heavy else 73.0 + gentle * 3
    rain_available = tank_level > SIM_LOW_TANK_CUTOUT
    running = not plant.stopped and (plant.source == "mains" or rain_available)
    treatment = running and plant.source == "rainwater"

    pressure_in = 0.0 if (plant.stopped or not treatment) else (3.25 if degraded else 2.85) + wave * 0.03
    pressure_delta = ((1.38 if degraded else CLEAN_BASELINE["pressureDelta"]) + gentle * 0.02) if pressure_in else 0.0
    flow = (
        0.0 if not running
        else 19.2 + gentle * 0.4 if plant.source == "mains"
        else 10.4 + gentle * 0.3 if degraded
        else CLEAN_BASELINE["flow"] + gentle * 0.7
    )
    pump_power = 0.0 if not treatment else (510.0 + wave * 8 if degraded else 360.0 + wave * 5)

    return {
        "tankLevel": tank_level,
        "turbidityIn": (18.0 if heavy else 9.8 if degraded else 7.2) + wave * 0.15,
        "turbidityOut": (1.72 if degraded else 0.2 if scenario == "recovery"
                         else CLEAN_BASELINE["turbidityOut"]) + gentle * 0.02,
        "pressureIn": pressure_in,
        "pressureOut": max(0.0, pressure_in - pressure_delta),
        "flow": flow,
        "solarPower": 1350.0 * sun * (0.42 if heavy else 1.0),
        "pumpPower": pump_power,
        "uvPower": 48.0 if treatment else 0.0,
        "miscPower": 34.0 + gentle * 2,
        "mainsTurbidity": 0.12 + gentle * 0.01,
        "mainsPressure": 3.1 + wave * 0.03,
        "heartbeat": 38.0 + abs(wave) * 8,
    }


def integrate(totals: Totals, gauges: dict[MetricKey, float], source: Source, seconds: float) -> None:
    """Advance the meter registers. Mirrors `integrate` in store.ts."""
    key = "rainUsage" if source == "rainwater" else "mainsUsage"
    setattr(totals, key, getattr(totals, key) + gauges["flow"] * seconds / 60.0 / 1000.0)
    for power, energy in (("solarPower", "solarEnergy"), ("pumpPower", "pumpEnergy"),
                          ("uvPower", "uvEnergy"), ("miscPower", "miscEnergy")):
        setattr(totals, energy, getattr(totals, energy) + gauges[power] * seconds / 3_600_000.0)


class SimDriver:
    """Emits the simulated plant at the tick rate."""

    name = "sim"
    kind = "counter"  # for the metrics in COUNTERS; gauges otherwise
    max_age = TICK_SECONDS * 3

    def __init__(self, plant: PlantState, claimed: frozenset[MetricKey] = frozenset()) -> None:
        self.plant = plant
        self.totals = Totals()
        self.scenario: Scenario = "normal"
        # Backfill whatever real hardware has not claimed.
        self.provides = (SIM_GAUGES | COUNTERS) - claimed - frozenset(DERIVED)

    async def run(self, emit: Emit) -> None:
        last = now()
        while True:
            await asyncio.sleep(TICK_SECONDS)
            ts = now()
            # `sensor-offline` is modelled honestly: the driver simply stops emitting, and
            # max_age turns that silence into staleness. No special case in core.
            if self.scenario == "sensor-offline":
                last = ts
                continue
            gauges = sample(ts, self.scenario, self.plant)
            integrate(self.totals, gauges, self.plant.source, (ts - last).total_seconds())
            last = ts
            for metric, value in (gauges | self.totals.as_dict()).items():
                if metric in self.provides:
                    emit(Frame(metric, value, ts))

    def reset(self) -> None:
        self.totals = Totals()
        self.scenario = "normal"


class SimActuator:
    """Stands in for a relay/VFD. Validation lives in the engine; this only moves the plant."""

    name = "sim"
    accepts = frozenset({"source", "stop", "reset"})
    ack_delay = 0.65

    def __init__(self, plant: PlantState) -> None:
        self.plant = plant

    async def apply(self, command: Command) -> CommandResult:
        await asyncio.sleep(self.ack_delay)
        if command.type == "source" and command.source:
            self.plant.source = command.source
            message = f"Supply switched to {command.source}."
        elif command.type == "stop":
            self.plant.stopped = True
            message = "Emergency stop confirmed. Treatment is latched off."
        else:
            self.plant.stopped = False
            message = "Stop latch reset. Treatment can resume."
        return CommandResult(id="", type=command.type, status="confirmed",
                             message=message, timestamp=now())
