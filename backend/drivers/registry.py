"""Driver registration and supervision. See DESIGN.md section 3."""
from __future__ import annotations

import asyncio
import logging

from catalog import ALL_METRICS, DERIVED, MetricKey
from drivers.base import Emit, SensorDriver

log = logging.getLogger("maxis.drivers")


class DriverConflict(RuntimeError):
    pass


class Registry:
    """Resolves metric ownership at boot and keeps each driver running."""

    def __init__(self, drivers: list[SensorDriver]) -> None:
        self.drivers = drivers
        self.owner: dict[MetricKey, SensorDriver] = {}
        for driver in drivers:
            if bad := driver.provides & frozenset(DERIVED):
                raise DriverConflict(
                    f"{driver.name} claims derived metric(s) {sorted(bad)}; "
                    "the engine computes these from their inputs."
                )
            if unknown := driver.provides - ALL_METRICS:
                raise DriverConflict(f"{driver.name} claims unknown metric(s) {sorted(unknown)}")
            for metric in driver.provides:
                if (held := self.owner.get(metric)) is not None:
                    raise DriverConflict(
                        f"{metric} is claimed by both {held.name} and {driver.name}"
                    )
                self.owner[metric] = driver
        unclaimed = ALL_METRICS - frozenset(self.owner) - frozenset(DERIVED)
        if unclaimed:
            log.info("unclaimed metrics will read as unavailable: %s", sorted(unclaimed))
        self._tasks: list[asyncio.Task[None]] = []

    def start(self, emit: Emit) -> None:
        self._tasks = [
            asyncio.create_task(self._supervise(d, emit), name=f"driver:{d.name}")
            for d in self.drivers
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _supervise(self, driver: SensorDriver, emit: Emit) -> None:
        """A crashing driver restarts with backoff. Its metrics go stale meanwhile; the
        server stays up and every other driver keeps reporting."""
        backoff = 1.0
        while True:
            try:
                await driver.run(emit)
                log.warning("driver %s returned; restarting", driver.name)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("driver %s crashed; restarting in %.0fs", driver.name, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
