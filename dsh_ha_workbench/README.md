# dsh-ha-workbench

在路径前缀后面把 DeepSeek Harness 的 Web 工作台暴露出来，供 Home Assistant 侧边栏面板直接嵌入。

## 安装

它和 `dsh-ha-bridge` 是两个插件，都要装（桥负责 API，本插件负责面板里的工作台）：

1. DSH → 插件 → 安装，选 `dsh-ha-workbench-0.1.0.tgz`（或 `plugin_manager install_bundle`）；
2. 重启 DSH Desktop，让 Host 插件按启动批次加载；
3. 验证：`curl http://127.0.0.1:43132/__health` 应回 `{"ok":true,...}`。

**令牌不用配**：路径前缀就是**桥的令牌**，本插件从 `$DSH_HOME/ha-bridge/state.json` 读
（桥首次启动时写入；两个插件同批启动时会等它最多 20 秒）。

## 为什么需要它

Harness 的浏览器界面用「每次进程启动都变的 launch token → `HttpOnly; SameSite=Strict` cookie」认证，
跨站 iframe 拿不到这个 cookie；它的 WebSocket 准入还会校验 `Origin`，外来 Origin 直接 403。
所以「HA 面板里 iframe 一个 `?token=` 地址」这条路是死的（见 `DSH-HA桥接说明.md` 六.1）。

但这个界面本身是**可搬路径的**：`index.html` 由服务器注入 `<base href="./">`，所有应用路由都是
文档相对路径（`"/api/x".slice(1)`），WebSocket 也按 `document.baseURI` 解析。于是只要换个前缀，
整个 SPA 照样跑。这个插件做的就是：

- 用**路径前缀**当前缀即是凭据（浏览器能带、不需要 cookie）；
- 自己向上游说 cookie，浏览器完全不需要 cookie；
- 把 `Host` / `Origin` 伪装成上游自己的地址，过准入；
- 双向流式转发（大文件上传/下载不落缓冲区），并转发 WebSocket。

```
浏览器 ──/api/dsh_harness/workbench/<token>/──► HA 代理 ──► 本插件 :43132 ──► Harness :43129
         (token 在路径里，HA 会话不需要)                    (注入 cookie)        (原生工作台)
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__health` | `{ok,name,version}`，不含任何密钥，供 HA 探活 |
| * | `/<token>/…` | 转发到 Harness Web 监听器（`webHost:webPort`） |
| * | `/<token>/api/remote.mux` | WebSocket 中转（会话实时流） |

`<token>` 就是桥插件的 bearer token —— HA 侧已经存了它，所以不需要第二份配置。

## 按面板裁剪客户端插件（方案 B）

代理会在发给浏览器的 `index.html` 里改写 `globalThis["__DSH_BOOT__"]` 这份启动清单，
把明确不需要的客户端插件剔掉。**只影响走代理的浏览器面板**，DSH Desktop 自己的窗口不受影响。

当前剔除项（`lib/proxy.js` 的 `DROPPED_CLIENT_PLUGINS`）：

| 插件 | 原因 |
|---|---|
| `dsh-desktop-workbenches` | 桌面壳的「工作台」界面；且它启动就 `fetch('/api/desktop-workbenches/state')` 根绝对路径，前缀下必然 404 |
| `dsh-desktop-onboarding` | 桌面壳的引导；同样有根绝对路径调用 |

改这份清单的三条纪律（每条都对应 loader 的真实约束）：

1. **只能删叶子**。清单里每个插件带 `inject` 数组，删掉被别人依赖的插件会让那个插件永远等不到依赖（界面卡在加载）。
   删之前先确认没有别的条目的 `inject` 里出现这个 id——脚本见 `tests/proxy.test.mjs` 里那条「drops the desktop-only plugins」的断言思路。
2. **`batches[].entries` 必须同步删**。`parseBootManifest` 会校验批次里引用的 id 都存在，漏删直接抛错、整个页面起不来。
   批次条目被删空时整条批次一起丢掉。
3. **不要给 `plugins/??…` 的 URL 加查询参数**。这条路由按查询精确匹配，多一个参数就是 404，整页白屏。

另外：代理还会把文档设成 `cache-control: no-store`，并丢弃浏览器的 `If-None-Match`/`If-Modified-Since`，
否则改完清单后浏览器可能继续用旧 HTML/旧包，出现「明明改了却没生效」。

## 手机端：把侧栏收起来（`PHONE_EDITS`）

DSH 的 Shell 在窄屏上仍然留一条 56px 竖排图标栏（工作台、插件、自动化任务、工作区树、设置），
手机上那份菜单用不到，但两件必要动作——打开会话列表、新建会话——恰好就在里面。

DSH 自己有一套替代：macOS 桌面上侧栏完全收起时，frame 会把这两个按钮挂进标题栏的
`shell.leading` 座位：

```js
const leadingMounted = darwin && sidebarCollapsed;
```

代理只去掉这一行的 `darwin && `，于是任何平台收起侧栏都会挂这个座位；面板在 ≤720px 的样式里
把第一列压到 0、把座位挪到左上角，剩下的（图标、tooltip、aria、快捷键）全是 DSH 自己的。

| 保险 | 行为 |
|---|---|
| 源码对不上（DSH 升级改了这行） | 整个 bundle 原样返回 + 日志警告一次；面板的 `:has([data-shell-leading])` 不匹配 → 图标栏保留，功能照旧 |
| 桌面窗口 | 不受影响：DSH Desktop 直接读 43129，不经过本代理；就算走代理，宽屏 CSS 也会把座位藏起来 |
| 别的行 | 一行都不改（`collapsedWidth` 保持原样，竖排栏仍是 56px，由面板的样式在窄屏压到 0） |

这个 bundle 只有被读进内存才改写得到，所以 `PHONE_BUNDLE` 也要出现在 `sendRewritten` 的
buffering 条件里（否则它和普通资源一样被 pipe 透传）。对应测试：`tests/proxy.test.mjs` 的
「mounts the window-chrome seat…」与「leaves a layout bundle it cannot recognise…」。

## 第三方插件里的根绝对路径

Harness 自己的 client 插件都是文档相对的，但**第三方/桌面插件不一定**，实测已有两处：

| 插件 | 写法 | 前缀下的后果 |
|---|---|---|
| `dsh-desktop-workbenches` | `fetch('/api/desktop-workbenches/state')` | 打到 HA 根 → `404: Not Found`（纯文本，它先 `json()` 后判 `ok`，界面报 `Unexpected non-whitespace character after JSON at position 3`） |
| `@zhangfengshun/dsh-remote-ssh` | `fetch("/remote-ssh/api/" + m)`、`new URL("/remote-ssh/write", window.location.origin)` | 同上 → 工作区/服务器列表静默为空，控制台刷 404 |

代理对这类 bundle（URL 里带 `dsh-desktop` 或 `remote-ssh`）做三处改写，然后才发给浏览器：

```
"/api/desktop     → "api/desktop
"/remote-ssh/     → "remote-ssh/
, window.location.origin) → , document.baseURI)
```

`document.baseURI` 是页面自己所在目录，因此这些请求留在前缀里、经代理直达 DSH 的真实路由。
新增第三方插件时，先在它的 `client.js` 里搜以斜杠开头的路由字面量（例如 `/api/…`、`/remote-ssh/…`、`window.location.origin`），有就按同样办法加进 `BUNDLE_REWRITES` 和 `BUNDLE_MARKERS`。

## 配置

`cordis.patch.yml` 里一行（默认值就是下面这些，一般不用改）：

```yaml
- insert:
    - id: ha-workbench
      name: dsh-ha-workbench
      config:
        host: 0.0.0.0        # 监听地址
        port: 43132          # 监听端口，HA 选项里的「工作台端口」要对上
        webHost: 127.0.0.1   # Harness Web 监听器
        # webPort: 43129     # 省略 = 跟随 Harness 自己的 web 端口
        # token: '…'         # 只在桥也固定了 token 时才填
```

## 认证材料怎么来的

Harness 进程内 `ctx.connection.authenticatedUrl(url)` 会给出带本次 launch token 的 URL；
插件拿它换一次 `dsh-auth-*` cookie，缓存起来，上游 401 时重换一次（Harness 重启后 token 会变）。
浏览器侧永远看不到这个 cookie。

## 两种跑法（当前部署用第 2 种）

### 1. 进程内插件（形态标准，但热加载不可靠）

`package.json` 带 `dsh.bundle.patch`，正常安装后会由 Harness 在启动时加载本插件。
调试时也试过在 profile 的 `cordis.patch.yml` 里插一行 `file:///…/index.js`，但**实测不可靠**：
改 `id`/`name` 触发 reconcile 时会把旧实例释放掉，却不保证创建新实例（端口就此空掉）。
要么等一次 Harness 重启，要么按下面的独立进程跑。

### 2. 独立进程（当前实际部署）

```
%LOCALAPPDATA%\dsh-ha-workbench\       运行时副本
    run.cmd                            设好 WORKBENCH_TOKEN 等环境变量后起 node
    tools\serve.mjs                    从 harness.log 抓当前 launch token
```

- 由 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-ha-workbench.vbs`
  在登录时隐藏启动，日志写 `%LOCALAPPDATA%\dsh-ha-workbench.log`；
- 和插件共用同一份 `lib/proxy.js`、`lib/cookie.js`，行为一致；
- 区别是它在 Harness 进程外拿不到 `ctx.connection`，改为每次刷新凭据时**重新读日志里的 launch token**，
  所以 Harness 重启（token 轮换）后它自己会恢复，不用管；
- 手动启停：`run.cmd`（启动）/ `taskkill /IM node.exe`（粗暴）或按日志里的 pid。

改代码后的发布：把 `index.js`/`lib/`/`tools/` 覆盖到 `%LOCALAPPDATA%\dsh-ha-workbench`，
再重启那个 node 进程即可（`run.cmd` 不缓存模块）。
