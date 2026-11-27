"""Names derived from a config entry, with no Home Assistant imports.

Kept apart from :mod:`panel` so the websocket layer can label a panel without
pulling in the frontend component (and so the offline test can import it).
"""

from __future__ import annotations

from .const import CONF_PANEL_TITLE, PANEL_TITLE


def panel_title(entry) -> str:
    """Return the sidebar label for one entry.

    The options value wins, so a host can be renamed without touching the entry
    title Home Assistant made up; an empty value falls back to that title.
    """
    options = getattr(entry, "options", None) or {}
    custom = str(options.get(CONF_PANEL_TITLE) or "").strip()
    return custom or str(getattr(entry, "title", "") or PANEL_TITLE)
