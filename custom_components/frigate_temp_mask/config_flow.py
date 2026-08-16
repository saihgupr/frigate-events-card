"""Config flow for Frigate Temporary Mask integration."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

DOMAIN = "frigate_temp_mask"
_LOGGER = logging.getLogger(__name__)

class FrigateTempMaskConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Frigate Temporary Mask."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title="Frigate Temporary Mask", data={})

        return self.async_show_form(step_id="user")

    async def async_step_import(self, import_config: dict[str, Any]) -> FlowResult:
        """Handle import from YAML configuration."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        return self.async_create_entry(title="Frigate Temporary Mask", data=import_config)
