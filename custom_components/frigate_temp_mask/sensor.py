"""Sensors for the Frigate Temporary Mask integration."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the active temporary masks sensor."""
    entity = FrigateActiveMasksSensor(entry)
    pending_state = hass.data[DOMAIN].pop("pending_sensor_state", None)
    if pending_state:
        entity._attr_native_value, entity._attr_extra_state_attributes = pending_state
    hass.data[DOMAIN]["mask_sensor"] = entity
    async_add_entities([entity])


class FrigateActiveMasksSensor(SensorEntity):
    """Expose active temporary masks as a manageable config-entry entity."""

    # Keep the historical sensor.frigate_active_masks entity ID used by the card.
    _attr_name = "Frigate Active Masks"
    _attr_icon = "mdi:vector-square-remove"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, entry: ConfigEntry) -> None:
        """Initialize the sensor with a stable per-entry identity."""
        self._attr_unique_id = f"{entry.entry_id}_active_masks"
        self._attr_native_value = "0"
        self._attr_extra_state_attributes = {
            "masks": [],
            "pending_restart_masks": [],
            "restart_pending": False,
            "pending_count": 0,
            "frigate_version": "unknown",
            "supports_dynamic_toggle": False,
        }

    @property
    def device_info(self) -> dict:
        """Group the entity under the integration's config-entry device."""
        return {
            "identifiers": {(DOMAIN, self._attr_unique_id.removesuffix("_active_masks"))},
            "name": "Frigate Temporary Mask",
            "manufacturer": "Frigate Events Card",
        }

    def update_state(self, state: str, attributes: dict) -> None:
        """Publish the latest mask count and attributes."""
        self._attr_native_value = state
        self._attr_extra_state_attributes = attributes
        if self.hass is not None:
            self.async_write_ha_state()
