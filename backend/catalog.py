"""Static site description. Ported from frontend/src/data/catalog.ts.

Constants, not tables: a single installation whose shape changes at deploy time, not at
runtime. See DESIGN.md section 5.
"""
from __future__ import annotations

from typing import Callable, Literal, NamedTuple, get_args

InstallationId = str
EquipmentId = Literal["tank", "pump", "membrane", "uv", "solar", "mains", "homes"]
MetricKey = Literal[
    "tankLevel", "tankVolume", "turbidityIn", "turbidityOut", "pressureIn", "pressureOut",
    "pressureDelta", "flow", "rainUsage", "mainsUsage", "solarPower", "pumpPower", "uvPower",
    "miscPower", "totalPower", "solarEnergy", "pumpEnergy", "uvEnergy", "miscEnergy",
    "totalEnergy", "mainsTurbidity", "mainsPressure", "mainsCapacity", "heartbeat",
]
Scenario = Literal["normal", "heavy-rain", "filter-degradation", "low-tank", "sensor-offline", "recovery"]
Source = Literal["rainwater", "mains"]
Quality = Literal["valid", "stale", "unavailable"]
EquipmentStatus = Literal["normal", "warning", "critical", "offline", "stopped"]
CommandType = Literal["source", "stop", "reset"]

INSTALLATION_ID = "MX-001"
TANK_CAPACITY_L = 10_000.0
TICK_SECONDS = 2.0

EQUIPMENT: dict[EquipmentId, str] = {
    "tank": "Rainwater tank", "pump": "Treatment pump", "membrane": "Membrane filter",
    "uv": "UV chamber", "solar": "Solar array", "mains": "Mains backup",
    "homes": "Residential supply",
}


class Metric(NamedTuple):
    label: str
    unit: str
    equipment: EquipmentId


METRICS: dict[MetricKey, Metric] = {
    "tankLevel": Metric("Rainwater capacity", "%", "tank"),
    "tankVolume": Metric("Stored rainwater", "L", "tank"),
    "turbidityIn": Metric("Before-filter turbidity", "NTU", "membrane"),
    "turbidityOut": Metric("After-filter turbidity", "NTU", "membrane"),
    "pressureIn": Metric("Before-filter pressure", "bar", "membrane"),
    "pressureOut": Metric("After-filter pressure", "bar", "membrane"),
    "pressureDelta": Metric("Filter pressure difference", "bar", "membrane"),
    "flow": Metric("Supply flow", "L/min", "homes"),
    "rainUsage": Metric("Rainwater bulk meter", "m³", "tank"),
    "mainsUsage": Metric("Mains bulk meter", "m³", "mains"),
    "solarPower": Metric("Solar generation", "W", "solar"),
    "pumpPower": Metric("Pump power", "W", "pump"),
    "uvPower": Metric("UV power", "W", "uv"),
    "miscPower": Metric("Miscellaneous power", "W", "homes"),
    "totalPower": Metric("Total load", "W", "homes"),
    "solarEnergy": Metric("Solar energy generated", "kWh", "solar"),
    "pumpEnergy": Metric("Pump energy", "kWh", "pump"),
    "uvEnergy": Metric("UV energy", "kWh", "uv"),
    "miscEnergy": Metric("Miscellaneous energy", "kWh", "homes"),
    "totalEnergy": Metric("Total consumed energy", "kWh", "homes"),
    "mainsTurbidity": Metric("Mains turbidity", "NTU", "mains"),
    "mainsPressure": Metric("Mains pressure", "bar", "mains"),
    "mainsCapacity": Metric("Mains backup capacity", "%", "mains"),
    "heartbeat": Metric("Backend heartbeat latency", "ms", "homes"),
}

ALL_METRICS: frozenset[MetricKey] = frozenset(get_args(MetricKey))
assert ALL_METRICS == frozenset(METRICS), "METRICS must cover every MetricKey"

# Metrics the engine computes from other metrics. No driver may claim these: a real rig has
# two pressure sensors, not a differential one, and the sum of three loads is arithmetic
# rather than an instrument. Keeping them here is what lets a driver provide only what it
# physically measures. See DESIGN.md section 4.
DERIVED: dict[MetricKey, tuple[tuple[MetricKey, ...], Callable[..., float]]] = {
    "tankVolume": (("tankLevel",), lambda level: level / 100.0 * TANK_CAPACITY_L),
    "pressureDelta": (("pressureIn", "pressureOut"), lambda a, b: max(0.0, a - b)),
    "totalPower": (("pumpPower", "uvPower", "miscPower"), lambda *v: sum(v)),
    "totalEnergy": (("pumpEnergy", "uvEnergy", "miscEnergy"), lambda *v: sum(v)),
}

# Monotonic totalisers. A real bulk meter reports these directly; the simulator integrates
# them. Either way the engine stores the value as given rather than integrating itself.
COUNTERS: frozenset[MetricKey] = frozenset(
    {"rainUsage", "mainsUsage", "solarEnergy", "pumpEnergy", "uvEnergy", "miscEnergy"}
)

CLEAN_BASELINE = {"turbidityOut": 0.22, "pressureDelta": 0.45, "flow": 18.0}
DEFAULT_THRESHOLDS = {"turbidityOut": 1.0, "pressureDelta": 0.9, "lowTank": 15.0}

SCENARIO_LABELS: dict[Scenario, str] = {
    "normal": "Normal", "heavy-rain": "Heavy Rain", "filter-degradation": "Filter Degradation",
    "low-tank": "Low Tank", "sensor-offline": "Sensor Offline", "recovery": "Recovery",
}


def rounded(value: float, metric: MetricKey) -> float:
    return round(value, 6 if metric in COUNTERS else 3)
