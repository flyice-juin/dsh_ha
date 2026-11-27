"""WebSocket commands for the DeepSeek Harness panel.

The command shell is deliberately thin: everything worth testing lives in
:func:`async_panel_payload`, which takes only the Home Assistant instance and
can therefore be exercised offline (see `tests/test_workbench_proxy.py`).

Several Harness hosts can be configured at once, so the panel says which sidebar
entry it is (`panel_path`, which the frontend exposes as ``hass.panelUrl``) and
the payload describes that host.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import CONF_HOST, CONF_PANEL_PATH, DOMAIN
from .naming import panel_title
from .workbench import async_probe_workbench, panel_payload

_LOGGER = logging.getLogger(__name__)

# Command registration is process-wide; a config entry reload must not repeat it.
_REGISTERED: set[str] = set()


class NotConfigured(Exception):
    """No bridge config entry exists, so there is no workbench to frame."""


def configured_entry(hass: HomeAssistant, panel_path: str | None = None):
    """Return the entry a panel belongs to, or None when nothing is configured.

    An unknown path falls back to the only entry so a stale bookmark (or a
    frontend that reports no `panelUrl`) still frames something instead of
    erroring out.
    """
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        return None
    if panel_path:
        for entry in entries:
            if str(entry.data.get(CONF_PANEL_PATH)) == panel_path:
                return entry
    return entries[0]


async def async_panel_payload(
    hass: HomeAssistant, panel_path: str | None = None
) -> dict[str, Any]:
    """Describe one workbench to the frontend, probing that it answers."""
    entry = configured_entry(hass, panel_path)
    if entry is None:
        raise NotConfigured
    payload = panel_payload(hass, entry)
    payload["available"] = await async_probe_workbench(hass, entry)
    payload["host"] = entry.data[CONF_HOST]
    payload["title"] = panel_title(entry)
    payload["entry_id"] = entry.entry_id
    payload["panel_path"] = entry.data.get(CONF_PANEL_PATH)
    return payload


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/panel",
        vol.Optional("panel_path"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_panel(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Tell the panel where to frame the workbench, and whether it answers."""
    try:
        payload = await async_panel_payload(hass, msg.get("panel_path"))
    except NotConfigured:
        connection.send_error(
            msg["id"], "not_configured", "the integration is not configured"
        )
        return
    connection.send_result(msg["id"], payload)


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register the panel commands once per Home Assistant instance."""
    if "panel" in _REGISTERED:
        return
    websocket_api.async_register_command(hass, ws_panel)
    _REGISTERED.add("panel")
