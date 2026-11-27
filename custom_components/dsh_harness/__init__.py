"""Set up the DeepSeek Harness integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers import config_validation as cv

from .api import DshAuthError, DshClient, DshError
from .const import (
    ATTR_ENTRY_ID,
    ATTR_MAX_MESSAGES,
    ATTR_MODE,
    ATTR_SESSION_ID,
    ATTR_TEXT,
    ATTR_TIMEOUT,
    ATTR_WAIT,
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DEFAULT_TIMEOUT_SECONDS,
    DOMAIN,
    EVENT_PROMPT_SETTLED,
    MODE_QUEUE,
    MODE_STEER,
    SERVICE_CANCEL,
    SERVICE_SEND_PROMPT,
    SERVICE_WAIT,
)
from .coordinator import DshCoordinator
from .panel import async_remove_panel_for, async_setup_panel
from .websocket import async_register_websocket_commands
from .workbench import async_register_workbench

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.BINARY_SENSOR]

# The workbench proxy view is installed on the HTTP application, which outlives
# every config entry; registering it twice would raise on the duplicate route.
_FRONTEND_REGISTERED: set[str] = set()

SEND_PROMPT_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_ENTRY_ID): cv.string,
        vol.Optional(ATTR_SESSION_ID): cv.string,
        vol.Required(ATTR_TEXT): cv.string,
        vol.Optional(ATTR_MODE, default=MODE_QUEUE): vol.In([MODE_QUEUE, MODE_STEER]),
        vol.Optional(ATTR_WAIT, default=False): cv.boolean,
        vol.Optional(ATTR_TIMEOUT, default=DEFAULT_TIMEOUT_SECONDS): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=300)
        ),
        vol.Optional(ATTR_MAX_MESSAGES, default=20): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=100)
        ),
    }
)

CANCEL_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_ENTRY_ID): cv.string,
        vol.Optional(ATTR_SESSION_ID): cv.string,
    }
)

WAIT_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_ENTRY_ID): cv.string,
        vol.Optional(ATTR_SESSION_ID): cv.string,
        vol.Optional(ATTR_TIMEOUT, default=DEFAULT_TIMEOUT_SECONDS): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=300)
        ),
        vol.Optional(ATTR_MAX_MESSAGES, default=20): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=100)
        ),
    }
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one Harness bridge connection."""
    client = DshClient(
        hass,
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_TOKEN],
    )
    try:
        await client.async_health()
    except DshAuthError as err:
        raise ConfigEntryNotReady(f"the bridge rejected the token: {err}") from err
    except DshError as err:
        raise ConfigEntryNotReady(f"cannot reach the bridge: {err}") from err

    coordinator = DshCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _async_register_services(hass)
    await _async_setup_frontend(hass, entry)
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry))
    return True


async def _async_setup_frontend(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Install the shared routes, then this entry's own sidebar panel.

    The workbench proxy routes on the bridge token, so one mount serves every
    host; the panel is per entry because each one frames a different host.
    """
    if "workbench" not in _FRONTEND_REGISTERED:
        async_register_workbench(hass)
        _FRONTEND_REGISTERED.add("workbench")
    async_register_websocket_commands(hass)
    await async_setup_panel(hass, entry)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload one bridge connection and drop the services with the last one."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    # Each entry owns its panel; a reload puts it straight back.
    async_remove_panel_for(hass, entry)
    if not hass.data.get(DOMAIN):
        hass.data.pop(DOMAIN, None)
        for service in (SERVICE_SEND_PROMPT, SERVICE_CANCEL, SERVICE_WAIT):
            if hass.services.has_service(DOMAIN, service):
                hass.services.async_remove(DOMAIN, service)
    return unload_ok


async def _async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry after its options change."""
    await hass.config_entries.async_reload(entry.entry_id)


# --------------------------------------------------------------------- services


def _coordinator(hass: HomeAssistant, data: dict[str, Any] | None = None) -> DshCoordinator:
    """Return the coordinator the call is aimed at.

    One host is implied; with several, the caller says which by ``entry_id``,
    because picking one silently would send prompts to the wrong machine.
    """
    entries: dict[str, DshCoordinator] = hass.data.get(DOMAIN, {})
    if not entries:
        raise HomeAssistantError("the DeepSeek Harness integration is not loaded")
    wanted = str((data or {}).get(ATTR_ENTRY_ID) or "")
    if wanted:
        coordinator = entries.get(wanted)
        if coordinator is None:
            raise HomeAssistantError(f"no DeepSeek Harness host has entry_id {wanted}")
        return coordinator
    if len(entries) > 1:
        raise HomeAssistantError(
            "several DeepSeek Harness hosts are configured; pass entry_id to say which one"
        )
    return next(iter(entries.values()))


def _pick_session(hass: HomeAssistant, data: dict[str, Any]) -> str:
    """Resolve the target session, defaulting to the most recently active one."""
    explicit = data.get(ATTR_SESSION_ID)
    if explicit:
        return str(explicit)
    session_id = _coordinator(hass, data).latest_session_id()
    if session_id is None:
        raise HomeAssistantError("the bridge reported no session to act on")
    return session_id


def _last_assistant(messages: Any) -> str | None:
    """Return the last assistant text of a wait result."""
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant":
            text = message.get("text")
            if isinstance(text, str) and text.strip():
                return text
    return None


def _async_register_services(hass: HomeAssistant) -> None:
    """Register the domain services once per Home Assistant instance."""
    if hass.services.has_service(DOMAIN, SERVICE_SEND_PROMPT):
        return

    async def async_send_prompt(call: ServiceCall) -> dict[str, Any] | None:
        coordinator = _coordinator(hass, call.data)
        session_id = _pick_session(hass, call.data)
        text = str(call.data[ATTR_TEXT])
        try:
            await coordinator.client.async_prompt(
                session_id, text, str(call.data[ATTR_MODE])
            )
        except DshError as err:
            raise HomeAssistantError(f"the bridge refused the prompt: {err}") from err

        await _refresh(coordinator)
        if not call.data[ATTR_WAIT]:
            return None

        try:
            result = await coordinator.client.async_wait(
                session_id,
                float(call.data[ATTR_TIMEOUT]),
                int(call.data[ATTR_MAX_MESSAGES]),
            )
        except DshError as err:
            raise HomeAssistantError(f"waiting for the answer failed: {err}") from err

        answer = _last_assistant(result.get("messages"))
        hass.bus.async_fire(
            EVENT_PROMPT_SETTLED,
            {
                "session_id": session_id,
                "reason": result.get("reason"),
                "answer": answer,
            },
        )
        await _refresh(coordinator)
        return {
            "session_id": session_id,
            "reason": result.get("reason"),
            "answer": answer,
            "messages": result.get("messages", []),
        }

    async def async_cancel(call: ServiceCall) -> None:
        coordinator = _coordinator(hass, call.data)
        session_id = _pick_session(hass, call.data)
        try:
            await coordinator.client.async_cancel(session_id)
        except DshError as err:
            raise HomeAssistantError(f"the bridge refused the cancel: {err}") from err
        await _refresh(coordinator)

    async def async_wait(call: ServiceCall) -> dict[str, Any]:
        coordinator = _coordinator(hass, call.data)
        session_id = _pick_session(hass, call.data)
        try:
            result = await coordinator.client.async_wait(
                session_id,
                float(call.data[ATTR_TIMEOUT]),
                int(call.data[ATTR_MAX_MESSAGES]),
            )
        except DshError as err:
            raise HomeAssistantError(f"waiting for the answer failed: {err}") from err
        return {
            "session_id": session_id,
            "reason": result.get("reason"),
            "answer": _last_assistant(result.get("messages")),
            "messages": result.get("messages", []),
        }

    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_PROMPT,
        async_send_prompt,
        schema=SEND_PROMPT_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_CANCEL, async_cancel, schema=CANCEL_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_WAIT,
        async_wait,
        schema=WAIT_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )


async def _refresh(coordinator: DshCoordinator) -> None:
    """Ask for a refresh after an action; a failure is logged, never raised."""
    try:
        await coordinator.async_request_refresh()
    except Exception:  # noqa: BLE001 - a refresh must not fail the service
        _LOGGER.debug("session refresh after action failed")
