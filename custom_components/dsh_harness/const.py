"""Constants for the DeepSeek Harness integration."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "dsh_harness"

CONF_HOST = "host"
CONF_PORT = "port"
CONF_TOKEN = "token"
CONF_SCAN_INTERVAL = "scan_interval"
CONF_WEB_MODE = "web_mode"
CONF_WEB_PORT = "web_port"

# One config entry is one Harness host. The sidebar entry it registers keeps the
# path it was first given (`panel_path`, stored in entry data so a rename cannot
# move it) and takes its label from the entry title.
CONF_PANEL_PATH = "panel_path"
CONF_PANEL_TITLE = "panel_title"

DEFAULT_PORT = 43131
DEFAULT_SCAN_INTERVAL = 20
MIN_SCAN_INTERVAL = 5

# The workbench plugin (dsh_ha_workbench) serves the Harness Web GUI behind the
# bridge token as a path prefix; see dsh_ha_workbench/README.md.
DEFAULT_WEB_PORT = 43132
WEB_MODE_PROXY = "proxy"
WEB_MODE_DIRECT = "direct"
DEFAULT_WEB_MODE = WEB_MODE_PROXY

MANUFACTURER = "DeepSeek"
MODEL = "Harness"
DEVICE_NAME = "DeepSeek Harness"

# Sidebar panel. The JS is served by the integration itself, so a panel update is
# a file copy plus a version bump, no Home Assistant release involved.
URL_BASE = f"/{DOMAIN}/frontend"
PANEL_JS = f"{URL_BASE}/{DOMAIN}-panel.js?v=14"
PANEL_TITLE = "DeepSeek Harness"
PANEL_ICON = "mdi:robot-happy-outline"
PANEL_ELEMENT = f"{DOMAIN}-panel"
# The path a single-host setup has always used. The first entry keeps it so
# existing bookmarks and the sidebar order survive the multi-host upgrade.
PANEL_PATH_LEGACY = DOMAIN
WORKBENCH_BASE = f"/api/{DOMAIN}/workbench"

# Fired after a waited prompt settles, so automations can notify on the answer.
EVENT_PROMPT_SETTLED = f"{DOMAIN}_prompt_settled"

SERVICE_SEND_PROMPT = "send_prompt"
SERVICE_CANCEL = "cancel"
SERVICE_WAIT = "wait"

ATTR_SESSION_ID = "session_id"
ATTR_TEXT = "text"
ATTR_MODE = "mode"
ATTR_WAIT = "wait"
ATTR_TIMEOUT = "timeout"
ATTR_MAX_MESSAGES = "max_messages"
ATTR_ENTRY_ID = "entry_id"

MODE_QUEUE = "queue"
MODE_STEER = "steer"

DEFAULT_TIMEOUT_SECONDS = 120

UPDATE_INTERVAL = timedelta(seconds=DEFAULT_SCAN_INTERVAL)
REQUEST_TIMEOUT = 30
