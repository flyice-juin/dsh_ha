"""Sensors exposing DeepSeek Harness session state."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DEVICE_NAME, DOMAIN, MANUFACTURER, MODEL
from .coordinator import DshCoordinator

SENSOR_KEYS = ("sessions", "running", "waiting")

# How many session rows ride along as attributes; enough for a card, small
# enough to keep the recorder happy.
MAX_ATTRIBUTE_SESSIONS = 12


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the summary sensors for one bridge."""
    coordinator: DshCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(DshSensor(coordinator, entry, key) for key in SENSOR_KEYS)


class DshSensor(CoordinatorEntity[DshCoordinator], SensorEntity):
    """One summary number for the harness."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: DshCoordinator,
        entry: ConfigEntry,
        key: str,
    ) -> None:
        super().__init__(coordinator)
        self._key = key
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_translation_key = key
        self._attr_icon = {
            "sessions": "mdi:message-text-outline",
            "running": "mdi:robot-outline",
            "waiting": "mdi:hand-back-right-outline",
        }[key]
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            # The entry title carries the host, which is what tells two Harness
            # devices apart in the registry.
            name=entry.title or DEVICE_NAME,
            manufacturer=MANUFACTURER,
            model=MODEL,
            configuration_url=coordinator.client.base_url,
        )

    @property
    def native_value(self) -> int:
        """Return the current count for this sensor."""
        if self._key == "running":
            return self.coordinator.running_count
        if self._key == "waiting":
            return self.coordinator.waiting_count
        return len(self.coordinator.sessions)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return the session table on the main sensor only."""
        if self._key != "sessions":
            return None
        rows = sorted(
            self.coordinator.sessions,
            key=lambda row: row.get("updatedAt") or 0,
            reverse=True,
        )[:MAX_ATTRIBUTE_SESSIONS]
        return {
            "sessions": [
                {
                    "id": row.get("id"),
                    "title": row.get("title"),
                    "running": bool(row.get("running")),
                    "queued": row.get("queued", 0),
                    "pending_input": row.get("pendingInput") or [],
                    "cwd": row.get("cwd"),
                }
                for row in rows
            ],
            "latest_session_id": self.coordinator.latest_session_id(),
            "host": self.coordinator.client.base_url,
        }
