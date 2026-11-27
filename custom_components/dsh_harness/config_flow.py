"""Config flow for the DeepSeek Harness integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv

from .api import DshAuthError, DshClient, DshError
from .const import (
    CONF_HOST,
    CONF_PANEL_TITLE,
    CONF_PORT,
    CONF_SCAN_INTERVAL,
    CONF_TOKEN,
    CONF_WEB_MODE,
    CONF_WEB_PORT,
    DEFAULT_PORT,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_WEB_MODE,
    DEFAULT_WEB_PORT,
    DOMAIN,
    MIN_SCAN_INTERVAL,
    WEB_MODE_DIRECT,
    WEB_MODE_PROXY,
)

_LOGGER = logging.getLogger(__name__)

USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): cv.port,
        vol.Required(CONF_TOKEN): str,
    }
)

REAUTH_SCHEMA = vol.Schema({vol.Required(CONF_TOKEN): str})


async def _valid(hass, host: str, port: int, token: str) -> str | None:
    """Probe the bridge; return an error key, or None when it answers."""
    client = DshClient(hass, host, port, token)
    try:
        await client.async_health()
    except DshAuthError:
        return "invalid_auth"
    except DshError as err:
        _LOGGER.debug("bridge probe failed for %s:%s: %s", host, port, err)
        return "cannot_connect"
    except Exception:  # noqa: BLE001 - a config flow must never crash
        _LOGGER.exception("unexpected error probing the bridge at %s:%s", host, port)
        return "unknown"
    return None


class DshHarnessConfigFlow(ConfigFlow, domain=DOMAIN):
    """Ask for the bridge address and its bearer token."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the first setup step."""
        errors: dict[str, str] = {}
        if user_input is not None:
            error = await _valid(
                self.hass,
                user_input[CONF_HOST],
                user_input[CONF_PORT],
                user_input[CONF_TOKEN],
            )
            if error is None:
                await self.async_set_unique_id(
                    f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
                )
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"DeepSeek Harness ({user_input[CONF_HOST]})",
                    data=user_input,
                )
            errors["base"] = error
        return self.async_show_form(
            step_id="user", data_schema=USER_SCHEMA, errors=errors
        )

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> ConfigFlowResult:
        """Start a token refresh after the bridge rejected the old one."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for a fresh token and reload the entry."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            error = await _valid(
                self.hass,
                entry.data[CONF_HOST],
                entry.data[CONF_PORT],
                user_input[CONF_TOKEN],
            )
            if error is None:
                return self.async_update_reload_and_abort(
                    entry,
                    data={**entry.data, CONF_TOKEN: user_input[CONF_TOKEN]},
                )
            errors["base"] = error
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=REAUTH_SCHEMA,
            errors=errors,
            description_placeholders={"host": entry.data[CONF_HOST]},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry) -> DshOptionsFlow:
        """Return the options flow."""
        return DshOptionsFlow()


class DshOptionsFlow(OptionsFlow):
    """Rename the sidebar panel and tune how its workbench is reached."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the options form."""
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        entry = self.config_entry
        options = entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    # The sidebar label. Empty means "use the entry title".
                    vol.Optional(
                        CONF_PANEL_TITLE,
                        default=options.get(CONF_PANEL_TITLE) or entry.title,
                    ): str,
                    vol.Required(
                        CONF_SCAN_INTERVAL,
                        default=options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
                    ): vol.All(
                        vol.Coerce(int), vol.Range(min=MIN_SCAN_INTERVAL, max=600)
                    ),
                    vol.Required(
                        CONF_WEB_PORT,
                        default=options.get(CONF_WEB_PORT, DEFAULT_WEB_PORT),
                    ): vol.All(vol.Coerce(int), vol.Range(min=1, max=65535)),
                    vol.Required(
                        CONF_WEB_MODE,
                        default=options.get(CONF_WEB_MODE, DEFAULT_WEB_MODE),
                    ): vol.In([WEB_MODE_PROXY, WEB_MODE_DIRECT]),
                }
            ),
        )
