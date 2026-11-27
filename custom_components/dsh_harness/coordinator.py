"""Coordinator polling the DeepSeek Harness bridge."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import DshAuthError, DshClient, DshConnectionError, DshError
from .const import CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL, DOMAIN

_LOGGER = logging.getLogger(__name__)


class DshCoordinator(DataUpdateCoordinator[list[dict[str, Any]]]):
    """Poll ``GET /api/sessions`` and expose the rows to every platform."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: DshClient) -> None:
        self.client = client
        interval = entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=interval),
        )

    async def _async_update_data(self) -> list[dict[str, Any]]:
        try:
            return await self.client.async_sessions()
        except DshAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except DshConnectionError as err:
            raise UpdateFailed(str(err)) from err
        except DshError as err:
            raise UpdateFailed(str(err)) from err

    # ---------------------------------------------------------------- helpers

    @property
    def sessions(self) -> list[dict[str, Any]]:
        """Return the last polled session rows."""
        return self.data or []

    @property
    def running_count(self) -> int:
        """Return how many sessions are executing a turn right now."""
        return sum(1 for row in self.sessions if row.get("running"))

    @property
    def waiting_count(self) -> int:
        """Return how many sessions are blocked on a human answer."""
        return sum(1 for row in self.sessions if row.get("pendingInput"))

    def latest_session_id(self) -> str | None:
        """Return the most recently updated non-empty session."""
        candidates = [row for row in self.sessions if not row.get("blank")]
        if not candidates:
            candidates = self.sessions
        if not candidates:
            return None
        newest = max(candidates, key=lambda row: row.get("updatedAt") or 0)
        session_id = newest.get("id")
        return session_id if isinstance(session_id, str) else None

    def session_ids(self) -> list[str]:
        """Return every known session id."""
        return [row["id"] for row in self.sessions if isinstance(row.get("id"), str)]
