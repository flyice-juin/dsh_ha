"""HTTP client for the DeepSeek Harness bridge plugin.

The bridge (``@local/ha-bridge`` inside Harness) answers a small JSON contract
on a bearer-token-protected LAN port; this module is the only place that knows
that contract.
"""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import REQUEST_TIMEOUT


class DshError(Exception):
    """Base error for the bridge."""


class DshAuthError(DshError):
    """The bearer token was rejected; the entry needs re-authentication."""


class DshConnectionError(DshError):
    """The bridge is unreachable or answered garbage."""


class DshClient:
    """Thin async client over the bridge HTTP API."""

    def __init__(
        self,
        hass: HomeAssistant,
        host: str,
        port: int,
        token: str,
    ) -> None:
        self._hass = hass
        self._base = f"http://{host}:{port}"
        self._token = token

    @property
    def base_url(self) -> str:
        """Return the bridge origin, useful for diagnostics."""
        return self._base

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float = REQUEST_TIMEOUT,
    ) -> Any:
        session = async_get_clientsession(self._hass)
        url = f"{self._base}{path}"
        try:
            async with session.request(
                method,
                url,
                json=payload,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as response:
                body = await response.text()
                if response.status == 401:
                    raise DshAuthError("the bridge rejected the token")
                if response.status >= 400:
                    raise DshError(f"HTTP {response.status}: {body[:200]}")
                try:
                    return await response.json(content_type=None)
                except ValueError as err:
                    raise DshError(f"invalid JSON from the bridge: {body[:200]}") from err
        except TimeoutError as err:
            raise DshConnectionError(f"timeout talking to {url}") from err
        except aiohttp.ClientError as err:
            raise DshConnectionError(f"cannot reach {url}: {err}") from err

    async def async_health(self) -> dict[str, Any]:
        """Return the bridge health document."""
        result = await self._request("GET", "/api/health")
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise DshError("the bridge did not report a healthy state")
        return result

    async def async_sessions(self) -> list[dict[str, Any]]:
        """Return every session row."""
        result = await self._request("GET", "/api/sessions", timeout=45)
        sessions = result.get("sessions") if isinstance(result, dict) else None
        if not isinstance(sessions, list):
            raise DshError("the bridge returned no session list")
        return [row for row in sessions if isinstance(row, dict)]

    async def async_messages(self, session_id: str, max_messages: int = 20) -> list[dict[str, Any]]:
        """Return the most recent message rows of one session."""
        result = await self._request(
            "GET", f"/api/sessions/{session_id}/messages?maxMessages={max_messages}", timeout=45
        )
        messages = result.get("messages") if isinstance(result, dict) else None
        return messages if isinstance(messages, list) else []

    async def async_prompt(self, session_id: str, text: str, mode: str = "queue") -> dict[str, Any]:
        """Queue or steer one prompt into a session."""
        return await self._request(
            "POST",
            f"/api/sessions/{session_id}/prompt",
            {"text": text, "mode": mode},
        )

    async def async_cancel(self, session_id: str) -> dict[str, Any]:
        """Cancel the active turn of one session."""
        return await self._request("POST", f"/api/sessions/{session_id}/cancel", {})

    async def async_wait(
        self,
        session_id: str,
        timeout_seconds: float,
        max_messages: int = 20,
    ) -> dict[str, Any]:
        """Wait for quiescence and return the trailing messages.

        The bridge caps the wait at five minutes; the client timeout leaves room
        for the bridge's own response overhead.
        """
        timeout_ms = max(1, int(timeout_seconds * 1000))
        return await self._request(
            "POST",
            f"/api/sessions/{session_id}/wait",
            {"timeoutMs": timeout_ms, "maxMessages": max_messages},
            timeout=timeout_seconds + 20,
        )
