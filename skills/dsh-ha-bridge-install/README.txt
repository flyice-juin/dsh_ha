dsh-ha-bridge —— Home Assistant × DeepSeek Harness 桥接插件
============================================================

这个目录里有四个文件：

  SKILL.md      给 DSH 里的 AI 看的安装说明书（推荐用这个）
  fetch.ps1     Windows 下载 + 校验脚本
  fetch.sh      macOS / Linux 下载 + 校验脚本
  latest.json   版本清单（脚本读它）
  dsh-ha-bridge-<版本>.tgz   插件包本体


方式一：交给 AI（最省事）
------------------------
1. 把 SKILL.md 放到这台电脑的 skills 目录：
     Windows:  %USERPROFILE%\.agents\skills\dsh-ha-bridge-install\SKILL.md
     macOS:    ~/.agents/skills/dsh-ha-bridge-install/SKILL.md
   目录名要和 SKILL.md 里的 name 一致，放完重启 DSH Desktop。
2. 在 DSH 里说一句：「按 dsh-ha-bridge-install 技能，帮我装 HA 桥接」。
3. AI 会下载、校验、安装、验证，最后把「主机 / 端口 / 令牌」三项告诉你。

（不想放技能目录也行：直接把 SKILL.md 拖进对话，说「照这个装」。）


方式二：自己装
------------
1. 下载校验（Windows）：
     powershell -ExecutionPolicy Bypass -File fetch.ps1 -BaseUrl <发布地址>
   macOS / Linux：
     ./fetch.sh <发布地址>
2. 打开 DSH Desktop → 插件 → 安装 → 选下载好的 .tgz（或粘贴本地路径）。
3. 浏览器打开 http://127.0.0.1:43131/ ，复制令牌。
4. Home Assistant → 设置 → 设备与服务 → 添加集成 → 搜 “DeepSeek Harness”
   → 填 主机（这台电脑的局域网 IP）、端口 43131、令牌。

注意
----
- 不要用 `dsh plugin add` / `pnpm add` 安装：桌面版只加载 profile 里
  dsh.profile.bundles 列出的包，裸 pnpm 装的不会生效。
- 令牌等于这台电脑上 DSH 的完整操作权限，只给可信的人。
- 不要在路由器上把 43131 映射到公网。
- 装完如果要改端口，改 profile 的 cordis.patch.yml 里 id: ha-bridge 那一行，重启生效。