#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_SVG="$ROOT_DIR/resources/icon.svg"
OUT_DIR="$ROOT_DIR/resources"

if ! command -v magick >/dev/null 2>&1; then
  echo "Error: ImageMagick (magick) is required to build icons." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "Error: iconutil is required to build macOS .icns icons." >&2
  exit 1
fi

if [[ ! -f "$SRC_SVG" ]]; then
  echo "Error: source icon not found: $SRC_SVG" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/evb-icons.XXXXXX")"
ICONSET_DIR="$TMP_DIR/icon.iconset"
MASTER_PNG="$TMP_DIR/icon-1024.png"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$ICONSET_DIR"

# Render a high-resolution master icon from SVG with preserved transparency,
# then derive platform assets.
magick -background none "$SRC_SVG" \
  -alpha on \
  -define svg:background-color=none \
  -resize 1024x1024 \
  "$MASTER_PNG"

# Shared PNG for Linux/Electron runtime.
magick "$MASTER_PNG" -resize 512x512 "$OUT_DIR/icon.png"

# Windows ICO with DPI-aware sizes recommended by Electron + Microsoft.
magick "$MASTER_PNG" \
  -define icon:auto-resize=16,20,24,32,40,48,64,128,256 \
  "$OUT_DIR/icon.ico"

# macOS ICNS iconset slices.
for size in 16 32 128 256 512; do
  magick "$MASTER_PNG" -resize "${size}x${size}" "$ICONSET_DIR/icon_${size}x${size}.png"
  magick "$MASTER_PNG" -resize "$((size * 2))x$((size * 2))" "$ICONSET_DIR/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$ICONSET_DIR" -o "$OUT_DIR/icon.icns"

echo "Generated:"
echo "  $OUT_DIR/icon.png"
echo "  $OUT_DIR/icon.ico"
echo "  $OUT_DIR/icon.icns"
