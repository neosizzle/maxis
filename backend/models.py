"""Wire models. These mirror frontend/src/types.ts exactly.

Fields are snake_case in Python and camelCase on the wire via `to_camel`; every response is
dumped with `by_alias=True`. If you add a field here, add it to types.ts in the same commit.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from catalog import (
    CommandType, EquipmentId, EquipmentStatus, MetricKey, Quality, Scenario, Source,
)


def now() -> datetime:
    return datetime.now(timezone.utc)


class Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class MetricReading(Wire):
    installation_id: str
    equipment_id: EquipmentId
    metric: MetricKey
    value: float | None
    unit: str
    quality: Quality
    timestamp: datetime


class EquipmentState(Wire):
    status: EquipmentStatus
    label: str


class SourceAvailability(Wire):
    rainwater: bool
    mains: bool


class EventRecord(Wire):
    id: str
    timestamp: datetime
    type: Literal["telemetry", "scenario", "command", "alert", "maintenance",
                  "inventory", "incident", "connection"]
    level: Literal["info", "warning", "error"] = "info"
    equipment: EquipmentId | None = None
    message: str


class Snapshot(Wire):
    installation_id: str
    timestamp: datetime
    scenario: Scenario
    source: Source
    stopped: bool
    connected: bool
    source_availability: SourceAvailability
    metrics: dict[MetricKey, MetricReading]
    equipment: dict[EquipmentId, EquipmentState]
    events: list[EventRecord] = Field(default_factory=list)


class Alert(Wire):
    id: str
    equipment: EquipmentId
    title: str
    message: str
    severity: Literal["warning", "critical"]
    status: Literal["active", "resolved"]
    created_at: datetime
    acknowledged_at: datetime | None = None
    resolved_at: datetime | None = None


class Thresholds(Wire):
    turbidity_out: float = Field(gt=0)
    pressure_delta: float = Field(gt=0)
    low_tank: float = Field(gt=0, lt=100)


class ThresholdPatch(Wire):
    turbidity_out: float | None = Field(default=None, gt=0)
    pressure_delta: float | None = Field(default=None, gt=0)
    low_tank: float | None = Field(default=None, gt=0, lt=100)


class Command(Wire):
    type: CommandType
    source: Source | None = None


class CommandResult(Wire):
    id: str
    type: CommandType
    status: Literal["pending", "confirmed", "rejected", "timeout"]
    message: str
    timestamp: datetime


class OverrideRequest(Wire):
    """Force one metric to a value, for demonstrating alerting. See DESIGN.md section 6.1."""
    value: float | None = None
    quality: Quality = "valid"
    ttl_s: float = Field(default=300.0, gt=0, le=3600)


class Override(Wire):
    metric: MetricKey
    value: float | None
    quality: Quality
    expires_at: datetime

    @property
    def expired(self) -> bool:
        return now() >= self.expires_at


class InventoryItem(Wire):
    id: str
    name: str
    category: str
    quantity: int
    unit: str
    minimum: int


class SupplyUse(Wire):
    item_id: str
    quantity: int


class SupplyOrder(Wire):
    id: str
    item_id: str
    quantity: int
    status: Literal["draft", "ordered", "received"]
    created_at: datetime
    updated_at: datetime


class MaintenanceTask(Wire):
    id: str
    equipment: EquipmentId
    description: str
    status: Literal["open", "completed"]
    created_at: datetime
    completed_at: datetime | None = None
    supplies_used: list[SupplyUse] = Field(default_factory=list)


class Incident(Wire):
    id: str
    description: str
    source: Literal["resident", "operator"]
    status: Literal["open", "resolved"]
    created_at: datetime


class TaskRequest(Wire):
    equipment: EquipmentId
    description: str = Field(min_length=1)


class CompleteTaskRequest(Wire):
    item_id: str | None = None
    quantity: int = Field(default=1, ge=1)


class AdjustRequest(Wire):
    delta: int


class OrderRequest(Wire):
    item_id: str
    quantity: int = Field(ge=1)


class IncidentRequest(Wire):
    description: str = Field(min_length=1)
    source: Literal["resident", "operator"] = "resident"


class Series(Wire):
    range: str
    step: int
    t: list[datetime]
    series: dict[MetricKey, list[float | None]]
