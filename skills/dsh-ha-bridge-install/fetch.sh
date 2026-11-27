#!/usr/bin/env bash
# Download and verify the dsh-ha-bridge plugin tarball, then print how to install it.
#
#   ./fetch.sh https://example.com/dsh-ha-bridge
#
# This script only fetches bytes. Installing is the plugin manager's job, because
# DSH Desktop only loads packages listed in the profile's `dsh.profile.bundles`.
set -euo pipefail

base="${1:?用法: ./fetch.sh <BaseUrl>}"
base="${base%/}"
out_dir="${TMPDIR:-/tmp}/dsh-ha-bridge"
mkdir -p "$out_dir"

meta="$(curl -fsSL "$base/latest.json")"
version="$(printf '%s' "$meta" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
file="$(printf '%s' "$meta" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
sha="$(printf '%s' "$meta" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

[ -n "$version" ] && [ -n "$file" ] && [ -n "$sha" ] || { echo "latest.json 缺少 version/url/sha256" >&2; exit 1; }

case "$file" in
  http://*|https://*) url="$file" ;;
  *) url="$base/$file" ;;
esac

target="$out_dir/dsh-ha-bridge-$version.tgz"
echo "==> download $url"
curl -fSL "$url" -o "$target"

echo "==> verify sha256"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$target" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$target" | awk '{print $1}')"
fi
if [ "$actual" != "$sha" ]; then
  rm -f "$target"
  echo "SHA256 不匹配：期望 $sha，实际 $actual（已删除下载文件）" >&2
  exit 1
fi
echo "    ok $actual"

cat <<EOF

文件已就绪：$target

把它装进 DSH：
  1. DSH Desktop → 插件 → 安装 → 选择/粘贴上面的路径；或者把这个路径交给 DSH 里的 AI，让它用 plugin_manager 安装。
  2. 装完打开 http://127.0.0.1:43131/ 取令牌，填进 Home Assistant 的 DeepSeek Harness 集成。

不要用 'dsh plugin add'：它只改 pnpm 依赖，不会把插件加进 profile 的 bundle 列表，装了也不会加载。
EOF