"""Binary sensor telling whether the harness is working right now."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DEVICE_NAME, DOMAIN, MANUFACTURER, MODEL
from .coordinator import DshCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the busy binary sensor for one bridge."""
    coordinator: DshCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([DshBusySensor(coordinator, entry)])


class DshBusySensor(CoordinatorEntity[DshCoordinator], BinarySensorEntity):
    """On while any session is executing a turn."""

    _attr_has_entity_name = True
    _attr_translation_key = "busy"
    _attr_icon = "mdi:progress-wrench"

    def __init__(self, coordinator: DshCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_busy"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=DEVICE_NAME,
            manufacturer=MANUFACTURER,
            model=MODEL,
            configuration_url=coordinator.client.base_url,
        )

    @property
    def is_on(self) -> bool:
        """Return True while the harness is running a turn."""
        return self.coordinator.running_count > 0
