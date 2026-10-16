"""The port between core and hardware. See DESIGN.md section 3.

Core depends on these protocols and never on a concrete driver. Adding a real sensor means
writing a module in this package and appending it to the list in registry.py — nothing in
engine.py, main.py or the frontend changes.
"""
from __future__ import annotations

from datetime import datetime
from typing import Callable, NamedTuple, Protocol, runtime_checkable

from catalog import CommandType, MetricKey, Quality
from models import Command, CommandResult


class Frame(NamedTuple):
    """One measurement. The only thing a driver ever hands to core."""
    metric: MetricKey
    value: float | None
    ts: datetime
    quality: Quality = "valid"


Emit = Callable[[Frame], None]


@runtime_checkable
class SensorDriver(Protocol):
    name: str
    #: Claimed up front so the registry can detect overlap at boot, let the simulator backfill
    #: whatever is left, and mark genuinely unclaimed metrics `unavailable`.
    provides: frozenset[MetricKey]
    #: Seconds without a frame before this driver's metrics go stale.
    max_age: float

    async def run(self, emit: Emit) -> None:
        """Long-lived. Push drivers await their transport; poll drivers read then sleep.

        On a read failure, emit nothing and keep going: `max_age` turns silence into
        staleness. Never fabricate a value, never report staleness explicitly.
        """
        ...


@runtime_checkable
class ActuatorDriver(Protocol):
    name: str
    accepts: frozenset[CommandType]

    async def apply(self, command: Command) -> CommandResult: ...
