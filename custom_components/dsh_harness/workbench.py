"""Serve the DeepSeek Harness Web GUI inside the Home Assistant frontend.

The Harness browser surface authenticates with a per-process launch token that
becomes an ``HttpOnly; SameSite=Strict`` cookie, and its WebSocket admission
rejects a foreign ``Origin``. A page framed by Home Assistant is therefore never
authenticated — which is why the workbench plugin serves the GUI behind a path
prefix instead, and why this module forwards to it:

    browser ──/api/dsh_harness/workbench/<token>/…──► HA (token = credential)
            ──http://host:43132/<token>/…──────────► workbench plugin
            ──http://127.0.0.1:43129/…─────────────► Harness web listener (cookie)

The Harness frontend is relocatable by design: ``index.html`` is served with
``<base href="./">`` and every application route is document-relative, so the
whole single-page app — assets, RPC and the WebSocket mux — works under the
prefix.

The route is registered straight on the aiohttp router rather than as a
:class:`~homeassistant.helpers.http.HomeAssistantView`, for two reasons:

* it is deliberately not Home Assistant authenticated — a framed document and
  everything it loads are plain browser requests, and an ``Authorization``
  header cannot be attached to an iframe navigation. The token path segment is
  the credential, and it is the same secret the bridge already requires.
* a ``{path:.*}`` resource cannot go through ``register_view``: Home Assistant
  hands every registered view to ``aiohttp_cors``, and that library fails to
  install a preflight handler on a wildcard resource.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
from typing import Any

import aiohttp
from aiohttp import web
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_HOST,
    CONF_TOKEN,
    CONF_WEB_MODE,
    CONF_WEB_PORT,
    DEFAULT_WEB_MODE,
    DEFAULT_WEB_PORT,
    DOMAIN,
    WEB_MODE_DIRECT,
    WEB_MODE_PROXY,
    WORKBENCH_BASE,
)

_LOGGER = logging.getLogger(__name__)

try:  # Home Assistant serves under a base path when one is configured.
    from homeassistant.components.http.const import BASE_PATH
except ImportError:  # pragma: no cover - older cores have no base path support
    BASE_PATH = ""

# Request headers the Harness listener acts on: content negotiation, conditional
# revalidation and range seeks. Everything else is irrelevant or misleading —
# in particular Host/Origin/Cookie, which describe the wrong hop.
_FORWARDED_REQUEST = frozenset(
    {"accept", "content-type", "if-match", "if-modified-since", "if-none-match", "range"}
)

# Response headers a browser needs to cache, seek and render Harness assets.
_FORWARDED_RESPONSE = frozenset(
    {
        "accept-ranges",
        "cache-control",
        "content-disposition",
        "content-encoding",
        "content-language",
        "content-length",
        "content-range",
        "content-type",
        "etag",
        "expires",
        "last-modified",
        "vary",
    }
)

_CHUNK = 64 * 1024


def upstream_base(hass: HomeAssistant, entry) -> str:
    """Return the workbench plugin origin for one config entry."""
    port = entry.options.get(CONF_WEB_PORT, DEFAULT_WEB_PORT)
    return f"http://{entry.data[CONF_HOST]}:{port}"


def workbench_url(hass: HomeAssistant, entry) -> str:
    """Return the browser URL of the workbench for one entry.

    Root-absolute and base-path aware, because it is used as an iframe ``src``
    and the frame keeps to that path for every asset it loads.
    """
    return f"{BASE_PATH}{WORKBENCH_BASE}/{entry.data[CONF_TOKEN]}/"


class WorkbenchProxy:
    """Translates one browser request into one workbench plugin request."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Remember the Home Assistant instance the proxy serves."""
        self.hass = hass

    # ---------------------------------------------------------------- routing

    async def handle(self, request: web.Request) -> web.StreamResponse:
        """Serve one GUI request, or upgrade to the WebSocket mux."""
        path = request.match_info.get("path", "")
        token, separator, rest = path.partition("/")
        if separator == "" and not request.path.endswith("/"):
            # `<base href="./">` resolves against a directory URL; without the
            # trailing slash every relative asset would be looked up one level up.
            raise web.HTTPPermanentRedirect(f"{request.path}/")
        host, port, upstream_path = self._resolve(token, rest)
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await self._relay_websocket(request, host, port, upstream_path)
        return await self._relay_http(request, host, port, upstream_path)

    def _resolve(self, token: str, rest: str) -> tuple[str, int, str]:
        """Match the leading token segment to a config entry.

        @returns `(host, port, upstream path)`; the upstream path keeps the token
        because the workbench plugin authenticates on that same segment.
        """
        for entry_id in list(self.hass.data.get(DOMAIN, {})):
            entry = self.hass.config_entries.async_get_entry(entry_id)
            if entry is None:
                continue
            expected = str(entry.data[CONF_TOKEN])
            if hmac.compare_digest(token, expected):
                port = int(entry.options.get(CONF_WEB_PORT, DEFAULT_WEB_PORT))
                return entry.data[CONF_HOST], port, f"/{token}/{rest}"
        raise web.HTTPNotFound(text="unknown workbench")

    @staticmethod
    def _upstream_url(host: str, port: int, upstream_path: str, query: str) -> str:
        """Build the plugin URL for one GUI request."""
        url = f"http://{host}:{port}{upstream_path}"
        return f"{url}?{query}" if query else url

    @staticmethod
    def _request_headers(request: web.Request) -> dict[str, str]:
        """Forward only the request headers the GUI actually needs upstream."""
        return {
            name: value
            for name, value in request.headers.items()
            if name.lower() in _FORWARDED_REQUEST
        }

    # ---------------------------------------------------------------- http

    async def _relay_http(
        self, request: web.Request, host: str, port: int, upstream_path: str
    ) -> web.StreamResponse:
        """Stream one HTTP exchange through to the workbench plugin."""
        session = async_get_clientsession(self.hass)
        url = self._upstream_url(host, port, upstream_path, request.query_string)
        # The request body is streamed, never buffered: uploads from the panel can
        # be much larger than what `request.read()` would accept.
        data = request.content if request.body_exists else None
        try:
            upstream = await session.request(
                request.method,
                url,
                headers=self._request_headers(request),
                data=data,
                allow_redirects=False,
            )
        except aiohttp.ClientError as err:
            _LOGGER.debug("workbench upstream failed for %s: %s", upstream_path, err)
            raise web.HTTPBadGateway(text=f"workbench unreachable: {err}") from err

        async with upstream:
            headers = {
                name: value
                for name, value in upstream.headers.items()
                if name.lower() in _FORWARDED_RESPONSE or name.lower().startswith("x-")
            }
            # Harness cookies belong to the upstream hop; leaking one would scope
            # a Harness session to the Home Assistant origin.
            headers.pop("Set-Cookie", None)
            if upstream.status in (301, 302, 303, 307, 308) and "Location" in upstream.headers:
                headers["Location"] = upstream.headers["Location"]

            response = web.StreamResponse(status=upstream.status, headers=headers)
            if upstream.content_length is None:
                response.enable_chunked_encoding()
            await response.prepare(request)
            async for chunk in upstream.content.iter_chunked(_CHUNK):
                await response.write(chunk)
            await response.write_eof()
            return response

    # ---------------------------------------------------------------- websocket

    async def _relay_websocket(
        self, request: web.Request, host: str, port: int, upstream_path: str
    ) -> web.StreamResponse:
        """Relay the GUI's WebSocket mux, which carries every live session stream."""
        requested = request.headers.get("Sec-WebSocket-Protocol", "")
        protocols = [item.strip() for item in requested.split(",") if item.strip()]
        client = web.WebSocketResponse(
            protocols=protocols or (), compress=False, max_msg_size=0
        )
        await client.prepare(request)

        session = async_get_clientsession(self.hass)
        url = self._upstream_url(host, port, upstream_path, request.query_string)
        try:
            upstream = await session.ws_connect(
                url,
                protocols=protocols or (),
                # The mux is meant to stay open; a total timeout would kill it.
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=15),
                max_msg_size=0,
                compress=False,
            )
        except (aiohttp.ClientError, TimeoutError) as err:
            _LOGGER.debug("workbench websocket failed for %s: %s", upstream_path, err)
            await client.close(code=aiohttp.WSCloseCode.TRY_AGAIN_LATER)
            return client

        async with upstream:
            await asyncio.gather(
                self._pump_downstream(upstream, client),
                self._pump_upstream(client, upstream),
                return_exceptions=True,
            )
        return client

    @staticmethod
    async def _pump_downstream(
        upstream: aiohttp.ClientWebSocketResponse, client: web.WebSocketResponse
    ) -> None:
        """Forward Harness frames to the browser."""
        async for message in upstream:
            if message.type == aiohttp.WSMsgType.TEXT:
                await client.send_str(message.data)
            elif message.type == aiohttp.WSMsgType.BINARY:
                await client.send_bytes(message.data)
            else:
                # CLOSE, CLOSED and ERROR all end the relay.
                break
        await client.close()

    @staticmethod
    async def _pump_upstream(
        client: web.WebSocketResponse, upstream: aiohttp.ClientWebSocketResponse
    ) -> None:
        """Forward browser frames to Harness."""
        async for message in client:
            if message.type == aiohttp.WSMsgType.TEXT:
                await upstream.send_str(message.data)
            elif message.type == aiohttp.WSMsgType.BINARY:
                await upstream.send_bytes(message.data)
            else:
                break
        if not upstream.closed:
            await upstream.close()


def async_register_workbench(hass: HomeAssistant) -> None:
    """Mount the workbench route on the HTTP application."""
    proxy = WorkbenchProxy(hass)
    router = hass.http.app.router
    router.add_route("*", f"{WORKBENCH_BASE}/{{path:.*}}", proxy.handle)
    # The bare route exists only to move a careless client onto the directory URL
    # that `<base href="./">` needs to resolve every relative asset correctly.
    router.add_route("*", WORKBENCH_BASE, proxy.handle)
    _LOGGER.debug("mounted the workbench proxy at %s", WORKBENCH_BASE)


async def async_probe_workbench(hass: HomeAssistant, entry) -> bool:
    """Report whether the workbench plugin answers for this entry."""
    url = f"{upstream_base(hass, entry)}/__health"
    session = async_get_clientsession(hass)
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as response:
            payload = await response.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("ok") is True


def panel_payload(hass: HomeAssistant, entry) -> dict[str, Any]:
    """Describe where the panel should frame the workbench from."""
    mode = entry.options.get(CONF_WEB_MODE, DEFAULT_WEB_MODE)
    if mode == WEB_MODE_DIRECT:
        port = entry.options.get(CONF_WEB_PORT, DEFAULT_WEB_PORT)
        token = str(entry.data[CONF_TOKEN])
        return {
            "mode": WEB_MODE_DIRECT,
            "url": f"http://{entry.data[CONF_HOST]}:{port}/{token}/",
        }
    # Home Assistant relative: same origin, so the workbench is reachable through
    # whatever tunnel or reverse proxy the user already reaches Home Assistant
    # with, without exposing a second port to the internet.
    return {"mode": WEB_MODE_PROXY, "url": workbench_url(hass, entry)}
