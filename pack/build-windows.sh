#!/usr/bin/env bash
# Builds a portable Windows package: pack/out/LopHocChu-windows-x64.zip
# Nothing to install on the streaming PC: the zip carries node.exe, the built pages, the server and a .bat to start it.
# The server and its libraries are bundled into ONE file with esbuild (a node_modules folder is thousands of tiny files
# that Windows' "Extract All" + Defender take minutes to unpack).
#
#   bash pack/build-windows.sh            (needs curl, unzip, zip, npm/npx)
#   NODE_VERSION=v24.22.2 bash pack/build-windows.sh
#   VERSION=2026.11.05.2000 bash pack/build-windows.sh   (default: current date + time)
#
# All libraries are plain JavaScript (no native addons), so building on Linux/macOS is fine for Windows.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.22.2}"          # Node 24 LTS: still supports Windows 10
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/pack/.cache"
OUT="$ROOT/pack/out"
APP="$OUT/LopHocChu"
ZIP="$OUT/LopHocChu-windows-x64.zip"
NODE_ZIP="node-$NODE_VERSION-win-x64.zip"

mkdir -p "$CACHE"
rm -rf "$APP" "$ZIP"; mkdir -p "$APP/node" "$APP/public"

# 1. node.exe, checked against the official SHA-256 list
if [ ! -f "$CACHE/$NODE_ZIP" ]; then
  echo "→ Tải Node.js $NODE_VERSION cho Windows"
  curl -fL --progress-bar -o "$CACHE/$NODE_ZIP.part" "https://nodejs.org/dist/$NODE_VERSION/$NODE_ZIP"
  mv "$CACHE/$NODE_ZIP.part" "$CACHE/$NODE_ZIP"
fi
curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
want="$(grep " $NODE_ZIP\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)"
have="$(shasum -a 256 "$CACHE/$NODE_ZIP" | cut -d' ' -f1)"
[ -n "$want" ] && [ "$want" = "$have" ] || { echo "✗ SHA-256 của $NODE_ZIP không khớp, dừng lại"; rm -f "$CACHE/$NODE_ZIP"; exit 1; }
echo "→ SHA-256 node.exe khớp với nodejs.org"
unzip -q -j -o "$CACHE/$NODE_ZIP" "node-$NODE_VERSION-win-x64/node.exe" "node-$NODE_VERSION-win-x64/LICENSE" -d "$APP/node"

# 2. pages (vite build: the question files are compiled in) + the server in one file
#    --ignore-scripts: msedge-tts has a preinstall that only allows pnpm; nothing needs a build step
( cd "$ROOT" && npm ci --no-audit --no-fund --ignore-scripts --loglevel=error && npx vite build --logLevel warn )
cp -R "$ROOT/dist" "$APP/dist"
cp -R "$ROOT/public/assets" "$APP/public/assets"
rm -rf "$APP/public/assets/audio"   # background music stays on the streamer's machine (copyright)
echo "→ Gộp server + thư viện thành 1 file"
# vite is only used in development (NODE_ENV != production): leave it out of the bundle
( cd "$ROOT" && npx -y esbuild@0.25.10 server.ts --bundle --platform=node --format=esm --target=node20 \
    --external:vite --minify-syntax --legal-comments=none --log-level=error \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --outfile="$APP/server.mjs" )
VERSION="${VERSION:-$(date +%Y.%m.%d.%H%M)}"
printf '%s' "$VERSION" > "$APP/version.txt"
cp "$ROOT/LICENSE" "$APP/LICENSE.txt"
{ echo "Thư viện được gộp trong server.mjs và giấy phép của chúng"; echo
  for f in "$ROOT"/node_modules/{*,@*/*}/LICENSE*; do [ -f "$f" ] || continue
    d="${f%/*}"; echo "==== ${d#"$ROOT"/node_modules/} ===="; cat "$f"; echo; done; } > "$APP/THIRD-PARTY-LICENSES.txt"

# 3. launcher + guide with Windows line endings (guide gets a UTF-8 BOM so every Notepad shows the accents)
sed 's/$/\r/' "$ROOT/pack/Mo-Lop-Hoc-Chu.bat" > "$APP/Mo-Lop-Hoc-Chu.bat"
{ printf '\xEF\xBB\xBF'; sed 's/$/\r/' "$ROOT/pack/HUONG-DAN.txt"; } > "$APP/HUONG-DAN.txt"

# 4. zip (no zip tool, e.g. Git Bash on Windows: the folder pack/out/LopHocChu is the package)
if command -v zip >/dev/null; then
  ( cd "$OUT" && zip -qr -X "$(basename "$ZIP")" "$(basename "$APP")" )
  echo "✓ Xong: $ZIP ($(du -h "$ZIP" | cut -f1)) · phiên bản $VERSION"
else
  echo "✓ Xong (không có lệnh zip): $APP · phiên bản $VERSION"
fi
