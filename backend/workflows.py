"""Operator records: tasks, inventory, supply orders, incidents.

Genuine write-model state, unlike telemetry. Invariants are enforced here rather than trusted
from the client: stock cannot go negative, and an order credits stock exactly once.
In-memory for this slice; the DDL in DESIGN.md section 5 is the next step.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Callable

from catalog import EQUIPMENT, EquipmentId
from models import (
    Incident, InventoryItem, MaintenanceTask, SupplyOrder, SupplyUse, now,
)

#: Seeded to match the frontend demo store so Demo and Live modes open on the same data.
SEED_INVENTORY = [
    ("membrane", "Membrane cartridge", "Filtration", 4, "units", 2),
    ("uv-lamp", "UV replacement lamp", "Disinfection", 2, "units", 1),
    ("gasket", "Seal & gasket kit", "Spares", 6, "kits", 2),
    ("sensor", "Turbidity sensor", "Instrumentation", 1, "units", 1),
    ("tools", "Service tool set", "Tools", 2, "sets", 1),
]


class Rejected(Exception):
    """A request that violates an invariant. Surfaces as 409, not 500."""


@dataclass
class Workflows:
    """`log` lets the engine record each change in the shared event feed."""
    log: Callable[..., None]
    inventory: list[InventoryItem] = field(default_factory=list)
    orders: list[SupplyOrder] = field(default_factory=list)
    tasks: list[MaintenanceTask] = field(default_factory=list)
    incidents: list[Incident] = field(default_factory=list)
    _ids: itertools.count = field(default_factory=lambda: itertools.count(1))

    def __post_init__(self) -> None:
        if not self.inventory:
            self.reset()

    def _id(self, prefix: str) -> str:
        return f"{prefix}-{int(now().timestamp()*1000):x}-{next(self._ids)}"

    def reset(self) -> None:
        self.inventory = [
            InventoryItem(id=i, name=n, category=c, quantity=q, unit=u, minimum=m)
            for i, n, c, q, u, m in SEED_INVENTORY
        ]
        self.orders, self.incidents = [], []
        self.tasks = [MaintenanceTask(
            id=self._id("task"), equipment="uv",
            description="Inspect UV lamp and clean the quartz sleeve",
            status="open", created_at=now())]

    def _item(self, item_id: str) -> InventoryItem:
        for item in self.inventory:
            if item.id == item_id:
                return item
        raise Rejected("Unknown supply item.")

    # ------------------------------------------------------------------ tasks

    def add_task(self, equipment: EquipmentId, description: str) -> MaintenanceTask:
        if equipment not in EQUIPMENT or not description.strip():
            raise Rejected("Select equipment and describe the maintenance work.")
        task = MaintenanceTask(id=self._id("task"), equipment=equipment,
                               description=description.strip(), status="open",
                               created_at=now())
        self.tasks.insert(0, task)
        self.log("maintenance", f"Task created: {task.description}", "info", equipment)
        return task

    def complete_task(self, task_id: str, item_id: str | None, quantity: int) -> MaintenanceTask:
        task = next((t for t in self.tasks if t.id == task_id), None)
        if task is None or task.status == "completed":
            raise Rejected("This task is already complete or unavailable.")
        item = self._item(item_id) if item_id else None
        if item is not None:
            # The stock check and the deduction happen together; a client that read a stale
            # quantity cannot oversell.
            if quantity < 1 or item.quantity < quantity:
                raise Rejected("The selected supply quantity is invalid or exceeds available stock.")
            item.quantity -= quantity
        task.status, task.completed_at = "completed", now()
        task.supplies_used = [SupplyUse(item_id=item.id, quantity=quantity)] if item else []
        used = f"; used {quantity} {item.name}" if item else ""
        self.log("maintenance",
                 f"Completed: {task.description}{used}. Telemetry determines fault recovery.",
                 "info", task.equipment)
        return task

    # -------------------------------------------------------------- inventory

    def adjust(self, item_id: str, delta: int) -> InventoryItem:
        item = self._item(item_id)
        if delta == 0 or item.quantity + delta < 0:
            raise Rejected("Stock cannot be negative; use a nonzero whole-number adjustment.")
        item.quantity += delta
        self.log("inventory", f"{item.name} stock adjusted by {delta:+d}.")
        return item

    # ----------------------------------------------------------------- orders

    def create_order(self, item_id: str, quantity: int) -> SupplyOrder:
        item = self._item(item_id)
        if quantity < 1:
            raise Rejected("Choose a supply and a positive whole-number quantity.")
        order = SupplyOrder(id=self._id("order"), item_id=item_id, quantity=quantity,
                            status="draft", created_at=now(), updated_at=now())
        self.orders.insert(0, order)
        self.log("inventory", f"Supply order drafted for {quantity} {item.name}.")
        return order

    def advance_order(self, order_id: str) -> SupplyOrder:
        order = next((o for o in self.orders if o.id == order_id), None)
        if order is None or order.status == "received":
            raise Rejected("This order is already received or unavailable.")
        # The status guard is what makes receiving idempotent: a double click cannot credit
        # stock twice, because the second call finds the order already received.
        order.status = "ordered" if order.status == "draft" else "received"
        order.updated_at = now()
        if order.status == "received":
            self._item(order.item_id).quantity += order.quantity
        self.log("inventory", f"Supply order {order.id} {order.status}"
                              f"{'; stock added once' if order.status == 'received' else ''}.")
        return order

    # -------------------------------------------------------------- incidents

    def report_incident(self, description: str, source: str = "resident") -> Incident:
        if not description.strip():
            raise Rejected("Describe the issue before submitting.")
        incident = Incident(id=self._id("incident"), description=description.strip(),
                            source=source, status="open", created_at=now())
        self.incidents.insert(0, incident)
        self.log("incident", f"Resident issue reported: {incident.description}")
        return incident
