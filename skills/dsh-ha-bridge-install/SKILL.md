---
name: dsh-ha-bridge-install
description: 从自建服务器安装/升级/卸载 DeepSeek Harness 的 Home Assistant 桥接插件（dsh-ha-bridge + dsh-ha-workbench），装完把主机、端口、令牌交给用户去 HA 里添加集成。当用户说"装 HA 桥接""装 dsh-ha-bridge""让 Home Assistant 连上我电脑的 DSH""桥接插件装不上/更新/卸载"时使用。
---

# 装 dsh-ha-bridge（HA × DSH 桥接插件）

这是一个**分发技能**：插件包放在发布方自己的服务器上，不走 npm，也不需要 GitHub。
你要做的是：下载 → 校验 → 用 DSH 自带的插件管理器装进去 → 验证 → 把三项参数交给用户。

**是两件套，两个都要装**：

| 插件 | 干什么 | 端口 | 装完怎么验 |
|---|---|---|---|
| `dsh-ha-bridge` | 给 HA 用的 HTTP 接口（会话 / 指令 / 结果） | 43131 | `GET /api/health`，**要带令牌** |
| `dsh-ha-workbench` | HA 侧边栏面板里那个工作台的反向代理 | 43132 | `GET /__health`，不用令牌 |

- 只装桥：实体和服务能用，侧边栏面板会提示「ha-workbench 没在 43132 回答」；
- 只装工作台：面板空转，因为它要读桥的令牌。

## 固定参数

```yaml
BRIDGE_URL: https://hahome.fun/downloads/dsh-ha-bridge
WORKBENCH_URL: https://hahome.fun/downloads/dsh-ha-workbench
PORT: 43131
WORKBENCH_PORT: 43132
```

- 这两个地址由发布方维护。只有用户明确说「从别处装」时才改，改完把本文件顶部一起写回。
- 两个目录结构相同：`latest.json`（版本 + 文件名 + sha256）+ `<包名>-<版本>.tgz`。

## 边界（先说清楚，避免误操作）

- **不要**用 `dsh plugin add` / `pnpm add` 装它。DSH Desktop 的加载器只认 profile `package.json` 里的
  `dsh.profile.bundles` + `pnpm.overrides`，裸 pnpm 装进去的包**不会加载**（实测）。装插件只走插件管理器。
- **不要**把插件装进全局 node_modules 或别的目录——它必须成为某个 profile 的 bundle。
- 令牌等于这台电脑上 DSH 的完整操作权限：只告诉用户本人，不要发到群聊、日志或任何外部服务。
- 装/改 Host 插件后通常要**重启 DSH Desktop**；重启会中断当前会话，所以先告知用户再动手。
- 两个插件都装时，**先桥后工作台**：工作台要从桥的 `state.json` 读令牌。

## 第 1 步：环境检查

1. 确认运行环境是 DSH Desktop（有 `plugin_manager` 工具，或存在 DSH 的 data 目录）。
   - Windows：`%APPDATA%\dsh-desktop\harness`
   - macOS：`~/Library/Application Support/dsh-desktop/harness`
2. 看有没有旧版在跑：

```
plugin_manager list_bundles   # 找 name = dsh-ha-bridge / dsh-ha-workbench
```

   装过旧版就先 `plugin_manager remove_bundle <name>`，否则新包会因端口被占而绑定失败。

3. 端口占用（Windows / macOS-Linux）：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 43131,43132 -ErrorAction SilentlyContinue
```

```bash
lsof -nP -iTCP:43131 -sTCP:LISTEN; lsof -nP -iTCP:43132 -sTCP:LISTEN
```

   被占了就先卸载旧版，或让用户改端口（见第 8 步的 `port` 配置）。

## 第 2 步：读版本清单

```powershell
$meta = Invoke-RestMethod "$BRIDGE_URL/latest.json"
$meta.version; $meta.url; $meta.sha256
```

```bash
meta="$(curl -fsSL "$BRIDGE_URL/latest.json")"
version="$(printf '%s' "$meta" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
file="$(printf '%s' "$meta" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
sha="$(printf '%s' "$meta" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
echo "$version | $file | $sha"
```

`url` 是相对文件名时拼成 `$BRIDGE_URL/<url>`。拿不到就停下，把 HTTP 状态告诉用户——
地址错、服务器没开、或证书问题（自签证书可用 `curl -k` 先确认，然后让用户换成正式证书）。

## 第 3 步：下载 + 校验（**必须**，别跳过）

```powershell
$out = Join-Path $env:TEMP "dsh-ha-bridge-$($meta.version).tgz"
Invoke-WebRequest "$BRIDGE_URL/$($meta.url)" -OutFile $out
$hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $meta.sha256.ToLower()) { throw "SHA256 不匹配：$hash" }
$out
```

```bash
tgz="/tmp/dsh-ha-bridge-$version.tgz"
curl -fsSL "$BRIDGE_URL/$file" -o "$tgz"
if command -v sha256sum >/dev/null 2>&1; then
  echo "$sha  $tgz" | sha256sum -c -
else
  echo "$sha  $tgz" | shasum -a 256 -c -
fi
```

哈希不符就**不要安装**，把两个值报给用户（要么清单过期，要么下载被改写）。

## 第 4 步：安装桥插件

首选（原子、可回滚、把包写进 profile 的 bundles/overrides）：

```
plugin_manager install_bundle  target = <第 3 步得到的本地 .tgz 路径>
```

- 返回里应有 `"bundle":"dsh-ha-bridge"` 和 `"application":"applied"`。
- 成功后 Host 插件通常**当场热加载**（端口会重新绑定）。若返回里提示需要重启，或下一步连不上，
  就告诉用户「需要重启 DSH Desktop 才能生效」，等用户确认后再重启。
- 也可以用 URL 直接装（`target = $BRIDGE_URL/<包名>.tgz`，实测可行），
  但那样绕过了本地校验，**只在下载被环境限制时**才用，并说明原因。

如果 `plugin_manager` 工具不可用，让用户自己在界面里装：
**设置/插件 → 安装 → 填 `$BRIDGE_URL/<文件>`**（或本地 tgz 路径）。

## 第 5 步：验证桥（不验证就等于没装）

令牌直接从本机设置页拿，不依赖 `$DSH_HOME` 有没有设：

```powershell
$token = Invoke-RestMethod "http://127.0.0.1:43131/setup/token"
Invoke-RestMethod "http://127.0.0.1:43131/api/health" -Headers @{ Authorization = "Bearer $token" }
```

```bash
TOKEN=$(curl -fsS http://127.0.0.1:43131/setup/token)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:43131/api/health
```

期望 `{"ok":true,"name":"dsh-ha-bridge","version":...,"timeZone":"..."}`。再确认两件事：

- 不带令牌访问 `/api/health` 必须是 **401**（说明鉴权在生效）；
- `/setup/token` 返回一串 32 位 hex，就是令牌（它在 `$DSH_HOME/ha-bridge/state.json` 里也有一份）。

## 第 6 步：装工作台插件（面板要用）

把第 2、3 步的 `BRIDGE_URL` 换成 `WORKBENCH_URL` 再跑一遍，然后装：

```powershell
$wb = Invoke-RestMethod "$WORKBENCH_URL/latest.json"
$wbOut = Join-Path $env:TEMP "dsh-ha-workbench-$($wb.version).tgz"
Invoke-WebRequest "$WORKBENCH_URL/$($wb.url)" -OutFile $wbOut
if ((Get-FileHash $wbOut -Algorithm SHA256).Hash.ToLower() -ne $wb.sha256.ToLower()) { throw "SHA256 不匹配" }
$wbOut
```

```
plugin_manager install_bundle  target = <上面 $wbOut 的路径>
```

返回里应有 `"bundle":"dsh-ha-workbench"`。然后验证（**不需要令牌**）：

```powershell
Invoke-RestMethod "http://127.0.0.1:43132/__health"
```

```bash
curl -fsS http://127.0.0.1:43132/__health
```

期望 `{"ok":true,"name":"dsh-ha-workbench","version":2}`。

它**不用配令牌**：路径前缀就是桥的令牌，它从 `$DSH_HOME/ha-bridge/state.json` 读
（两个插件同一次启动时它会最多等 20 秒）。所以第 5 步必须已经通过。

> 两个插件都是 Host 插件，热加载有时只生效一半。**最稳的做法**：两个都装完后，让用户重启一次
> DSH Desktop，再用 `/api/health` 与 `/__health` 各验一次。

## 第 7 步：交付给用户

令牌从这里取（按顺序）：

1. 第 5 步已经从 <http://127.0.0.1:43131/setup/token> 拿到；
2. 没拿到就读 `$DSH_HOME/ha-bridge/state.json` 的 `token` 字段（`$DSH_HOME` 缺省是 `~/.dsh`，
   Windows 实际是 `%APPDATA%\dsh-desktop\harness`）。

主机地址取这台机器**局域网** IPv4（优先 192.168.x.x / 10.x.x.x）。告诉用户：

| 项 | 值 |
|---|---|
| 主机 | `<LAN IP>` |
| 端口 | `43131` |
| 令牌 | `<token>` |

并给下一步（一句话就够）：
> Home Assistant → 设置 → 设备与服务 → 添加集成 → 搜 **DeepSeek Harness** → 填上面三项。

再告诉用户两件事：

- 在**这台电脑**的浏览器打开 <http://127.0.0.1:43131/> 可以随时查看/复制/轮换令牌
  （只接受本机访问，从别的机器打开会 403，属正常）；
- HA 侧边栏的「DeepSeek Harness」面板要正常显示，工作台插件（43132）必须在跑——这一步已经装好了。

## 第 8 步：可选配置

要改端口/时区/令牌来源，编辑该 profile 的 `cordis.patch.yml` 里对应那行（**改完必须重启**）：

```yaml
- id: ha-bridge
  name: dsh-ha-bridge
  config:
    host: 0.0.0.0          # 只给本机用就写 127.0.0.1
    port: 43131
    timeZone: Asia/Shanghai
    # token: '固定值'      # 留空＝用自动生成并持久化的那个
    # setupPage: false     # 关掉本机设置页

- id: ha-workbench
  name: dsh-ha-workbench
  config:
    host: 0.0.0.0
    port: 43132            # HA 选项里的「工作台端口」要对上
    # webPort: 43129       # 省略＝跟随 Harness 自己的 web 端口
    # token: '…'           # 只在桥也固定了 token 时才填
```

## 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| `install_bundle` 报 engines / peer 不满足 | DSH 太旧（插件要求 `>=0.2.0`） | 让用户升级 DSH Desktop，别硬装 |
| 装完 `/api/health` 连不上 | Host 插件还没加载（ESM 缓存） | 重启 DSH Desktop；或再执行一次 `install_bundle` 触发重载 |
| 报 `listen EADDRINUSE 43131` | 旧版或别的程序占着端口 | 先 `remove_bundle` 旧版；或改 `port` |
| 报 `listen EADDRINUSE 43132` | 旧的工作台进程还在跑（早期是独立 node 进程） | 结束那个进程，或改 `port` |
| `/api/health` 返回 401 | 令牌不对（轮换过 / 拿的是别的机器的） | 重新取 `state.json` 或 `/setup/token` |
| `/` 或 `/setup/token` 返回 403 | 不是从本机访问（设计如此） | 让用户在那台电脑上打开 |
| 重启后插件没了 | 包没进 `dsh.profile.bundles`（当初是 pnpm 装的） | 重装：只走 `install_bundle` |
| 面板写「ha-workbench 没在 43132 回答」 | 工作台插件没装 / 没加载 / 端口不对 | 按第 6 步装；重启 DSH 后 `curl 127.0.0.1:43132/__health` |
| 工作台日志「no token yet」 | 桥还没启动过，`state.json` 里没有令牌 | 先确保桥装好并启动过（第 5 步通过），再重启 DSH |
| HA 里添加集成报 `cannot_connect` | HA 到这台机器 43131 不通 | 查防火墙/同网段；先用另一台机器 `curl` 这台 IP 的 43131 |
| HA 报 `invalid_auth` | 令牌轮换后 HA 还存着旧的 | HA 里对集成点「重新认证」粘新令牌 |
| 服务器返回 404 | `latest.json` 里的 `url` 与文件名不一致 | 按服务器实际文件名取 |

## 升级 / 卸载

- **升级**：对要升级的那个包重复第 2～4 步（`latest.json` 版本更高时）。两个包版本各自独立。
  旧 generation 会在下次重启时清理。
- **卸载**：`plugin_manager remove_bundle dsh-ha-bridge`（和/或 `dsh-ha-workbench`），重启后生效；
  令牌文件 `$DSH_HOME/ha-bridge/state.json` 可保留（重装后仍是同一个令牌），不需要了再删。
- **换服务器地址**：只改本文件顶部的两个 URL，其余步骤不变。

## 不要做的事

- 不要把令牌写进任何会被提交/上传的文件，也不要用它去访问别的机器。
- 不要把 43131 / 43132 端口映射到公网、不要开 UPnP。
- 不要用 `dsh plugin add` 代替插件管理器（见"边界"）。
- 不要在未告知用户的情况下重启 DSH Desktop。
