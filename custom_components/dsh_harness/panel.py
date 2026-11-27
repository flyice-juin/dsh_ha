"""One sidebar panel per configured Harness host, and the assets behind it.

Home Assistant can talk to several Harness hosts at once — a desktop, a laptop,
a build server — so the sidebar entry is not a singleton: every config entry
owns one panel. The path a panel is given is decided once, when its entry is
first set up, so renaming never moves a bookmark; the label comes from the
entry's panel title, which the options flow edits.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import (
    async_register_built_in_panel,
    async_remove_panel,
)
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import (
    CONF_PANEL_PATH,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_JS,
    PANEL_PATH_LEGACY,
    URL_BASE,
)
from .naming import panel_title

_LOGGER = logging.getLogger(__name__)

# Static paths and panels outlive a single config entry reload; the flag is
# process-wide so a reload cannot register the same route twice.
_REGISTERED: set[str] = set()


def _claimed_paths(hass: HomeAssistant, entry_id: str) -> set[str]:
    """Return the sidebar paths every *other* entry already owns."""
    return {
        str(other.data.get(CONF_PANEL_PATH))
        for other in hass.config_entries.async_entries(DOMAIN)
        if other.entry_id != entry_id and other.data.get(CONF_PANEL_PATH)
    }


async def async_ensure_panel_path(hass: HomeAssistant, entry) -> str:
    """Give an entry a stable sidebar path, writing it into the entry once.

    Called before the entry registers its update listener: persisting the path
    is bookkeeping, not a configuration change, and must not bounce the entry
    into a reload while it is being set up.
    """
    existing = entry.data.get(CONF_PANEL_PATH)
    if existing:
        return str(existing)

    taken = _claimed_paths(hass, entry.entry_id)
    if PANEL_PATH_LEGACY not in taken:
        # The first host keeps the path the single-host version always used, so
        # an upgrade leaves the sidebar entry — and any bookmark — where it was.
        path = PANEL_PATH_LEGACY
    else:
        suffix = entry.entry_id.replace("-", "")[:8]
        path = f"{DOMAIN}_{suffix}"
        while path in taken:
            suffix += "0"
            path = f"{DOMAIN}_{suffix}"

    hass.config_entries.async_update_entry(
        entry, data={**entry.data, CONF_PANEL_PATH: path}
    )
    _LOGGER.debug("panel path for %s: %s", entry.title, path)
    return path


async def async_setup_panel(hass: HomeAssistant, entry) -> None:
    """Serve the panel bundle and put this entry's panel in the sidebar."""
    frontend_dir = Path(__file__).parent / "frontend"

    if "static" not in _REGISTERED:
        try:
            await hass.http.async_register_static_paths(
                [StaticPathConfig(URL_BASE, str(frontend_dir), False)]
            )
        except (ImportError, AttributeError):
            hass.http.register_static_path(URL_BASE, str(frontend_dir), False)
        _REGISTERED.add("static")

    path = await async_ensure_panel_path(hass, entry)
    async_register_built_in_panel(
        hass,
        component_name="custom",
        frontend_url_path=path,
        sidebar_title=panel_title(entry),
        sidebar_icon=PANEL_ICON,
        config={
            "_panel_custom": {
                "name": PANEL_ELEMENT,
                "module_url": PANEL_JS,
                "embed_iframe": False,
                "trust_external": False,
            }
        },
        require_admin=False,
        # A rename (or a module version bump) re-registers the same path.
        update=True,
    )
    _LOGGER.debug("registered the sidebar panel %s for %s", path, entry.title)


def async_remove_panel_for(hass: HomeAssistant, entry) -> None:
    """Drop one entry's sidebar panel; it may be reloading, not leaving."""
    path = entry.data.get(CONF_PANEL_PATH)
    if not path or str(path) not in hass.data.get("frontend_panels", {}):
        return
    try:
        async_remove_panel(hass, str(path), warn_if_unknown=False)
    except Exception:  # noqa: BLE001 - removing a panel must never fail an unload
        _LOGGER.debug("could not remove the panel %s", path, exc_info=True)
