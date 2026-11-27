# dsh-ha-bridge

A DeepSeek Harness plugin that exposes your Harness sessions over a
token-protected HTTP API on the LAN, so a Home Assistant custom integration can
read them and drive them — list sessions, send a prompt, cancel a run, wait for
the answer.

It also serves a **loopback-only setup page** that shows the token, rotates it,
and prints the exact values Home Assistant asks for:

```
http://127.0.0.1:43131/          setup page (this machine only)
http://127.0.0.1:43131/setup/token   the token as text/plain (curl friendly)
```

The package ships **no token**. On first start the plugin mints a 128-bit token,
persists it under `$DSH_HOME/ha-bridge/state.json`, and reuses it on every later
start — so each machine gets its own secret, and installing from npm is safe.

## Install

In DSH Desktop: **Plugins** → search `dsh-ha-bridge` → install, then restart
Harness if the host asks for it.

From a terminal:

```sh
dsh plugin --profile web add dsh-ha-bridge
```

Then open <http://127.0.0.1:43131/> **on the machine running Harness**.

## Connect Home Assistant

The companion custom integration lives in the same repository under
`custom_components/dsh_harness` (copy it to `config/custom_components/`,
restart Home Assistant).

1. Settings → Devices & services → Add integration → **DeepSeek Harness**.
2. Fill in the three values from the setup page: host, port (default `43131`),
   token.
3. Done — the integration polls sessions and offers `dsh_harness.send_prompt`,
   `dsh_harness.cancel` and `dsh_harness.wait`.

Home Assistant can talk to several machines: add one integration entry per
machine (the entry is keyed by host and port).

## Configuration

Everything has a working default; the row below is what the package ships.

```yaml
- id: ha-bridge
  name: dsh-ha-bridge
  config:
    host: 0.0.0.0        # 127.0.0.1 keeps the API off the LAN
    port: 43131
    timeZone: Asia/Shanghai
    # token: ''          # leave empty to use the generated one
    # setupPage: true    # false closes the loopback setup surface
```

Edit it in the profile's `cordis.patch.yml` (Plugins → the plugin's row), then
restart Harness — Host plugin modules are held in the ESM cache, so a code
change only takes effect on restart.

`token` wins over the stored one when set, which is how pre-0.3 installations
that pinned a value keep working; in that case the setup page only displays it
and refuses to rotate. Delete the line to let the plugin manage its own token.

The state file can be relocated with `DSH_HA_BRIDGE_STATE=/path/to/state.json`.

## API

All endpoints require `Authorization: Bearer <token>`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ok, name, version, timeZone}` |
| GET | `/api/sessions` | rows: `id, title, running, active, queued, pendingInput, cwd, updatedAt, agentAvailable` |
| GET | `/api/sessions/{id}` | one row |
| GET | `/api/sessions/{id}/messages?maxMessages=20` | `{messages:[{role,type,seq,time,text}], cursor}` |
| POST | `/api/sessions/{id}/prompt` | `{text, mode?: "queue"\|"steer"}` |
| POST | `/api/sessions/{id}/cancel` | |
| POST | `/api/sessions/{id}/wait` | `{timeoutMs?, maxMessages?, afterSeq?}` → `{reason, state, messages, truncated}` |

Self-test:

```sh
curl -H "Authorization: Bearer <token>" http://127.0.0.1:43131/api/health
```

## Security

* The setup page answers **loopback requests only** (and refuses forwarded
  requests), because it displays the secret.
* The token is the whole credential: anyone holding it can list sessions, send
  prompts and cancel runs on this computer. Treat it like an SSH key.
* The listener binds `0.0.0.0` by default so Home Assistant can reach it. Set
  `host: 127.0.0.1` if you only ever drive Harness from this machine, and never
  port-forward `43131` to the internet.
* Rotating the token invalidates the old one immediately; re-authenticate the
  Home Assistant entry afterwards.

## Development

No build step, no runtime dependencies.

```sh
node dsh_ha_bridge/tests/bridge.test.mjs
```

The harness mounts `apply` against a stub `sessionController`, so the token
lifecycle, the loopback gate and the bearer check run outside Harness.

## Distribution: your own server, not npm

Most people who run DSH Desktop have no npm account, no Git, and no terminal —
so this plugin is published as a plain tarball on any static host, and shipped
with a **skill** their AI can follow.

Build the uploadable directory:

```sh
pwsh -File scripts/build-release.ps1      # or: powershell -ExecutionPolicy Bypass -File ...
```

`dist/release/` then holds exactly what the server should serve:

```
latest.json                  {"name","version","url","sha256","size","builtAt"}
dsh-ha-bridge-<version>.tgz  the plugin
SKILL.md                     install skill the user's AI follows
fetch.ps1 / fetch.sh         download + SHA-256 verification helpers
README.txt                   what a non-technical user should do
```

Upload those, set `BASE_URL` at the top of `SKILL.md` to the directory URL, and
give the user that file (or have them drop it into
`~/.agents/skills/dsh-ha-bridge-install/SKILL.md`). Their AI then downloads,
verifies the hash, installs through the plugin manager, checks
`/api/health`, and hands back host, port and token.

The install must go through the plugin manager — `plugin_manager` tool, or
**Settings → Plugins → Install** with the tarball URL. `dsh plugin add <spec>`
only forwards to pnpm inside the profile, and DSH Desktop loads nothing that is
not listed in `dsh.profile.bundles`; a bare pnpm dependency never activates.

Installing from a plain `http(s)://…tgz` URL is verified to work with this
plugin manager (pnpm records the URL as the dependency spec), and so is the
`latest.json` → download → verify → install-local-file flow used by the skill.

npm is optional: `npm publish` still works if you want the package name
reserved, and the in-app market would additionally need a PR to the curated
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
registry.

## License

MIT