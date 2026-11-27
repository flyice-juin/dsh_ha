<#
  Download and verify the dsh-ha-bridge plugin tarball, then print how to install it.

  This script only fetches bytes. Installing is the plugin manager's job, because
  DSH Desktop only loads packages listed in the profile's `dsh.profile.bundles`.

  Usage:
    powershell -ExecutionPolicy Bypass -File fetch.ps1 -BaseUrl https://example.com/dsh-ha-bridge
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [string]$OutDir = (Join-Path $env:TEMP 'dsh-ha-bridge')
)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')

Write-Host "==> latest.json"
$meta = Invoke-RestMethod "$BaseUrl/latest.json"
if (-not $meta.version -or -not $meta.url -or -not $meta.sha256) {
  throw "latest.json 缺少 version/url/sha256"
}
Write-Host "    version : $($meta.version)"

$url = if ($meta.url -match '^https?://') { $meta.url } else { "$BaseUrl/$($meta.url)" }
$target = Join-Path $OutDir ("dsh-ha-bridge-{0}.tgz" -f $meta.version)
New-Item -ItemType Directory -Force $OutDir | Out-Null

Write-Host "==> download $url"
Invoke-WebRequest $url -OutFile $target

Write-Host "==> verify sha256"
$actual = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $meta.sha256.ToLower()) {
  Remove-Item $target -Force
  throw "SHA256 不匹配：期望 $($meta.sha256)，实际 $actual（已删除下载文件）"
}
Write-Host "    ok $actual"

Write-Host ""
Write-Host "文件已就绪：$target"
Write-Host ""
Write-Host "把它装进 DSH："
Write-Host "  1. DSH Desktop → 插件 → 安装 → 选择/粘贴上面的路径；或者把这个路径交给 DSH 里的 AI，让它用 plugin_manager 安装。"
Write-Host "  2. 装完打开 http://127.0.0.1:43131/ 取令牌，填进 Home Assistant 的 DeepSeek Harness 集成。"
Write-Host ""
Write-Host "不要用 'dsh plugin add'：它只改 pnpm 依赖，不会把插件加进 profile 的 bundle 列表，装了也不会加载。"