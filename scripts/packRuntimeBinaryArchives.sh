#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ARCHIVE_DIR="${EVB_RUNTIME_BINARY_ARCHIVE_DIR:-$PROJECT_ROOT/.devkit/tmp/runtime-archives}"
TARGET="${1:-}"
case "$TARGET" in
  darwin-arm64|linux-x64|linux-arm64|win32-x64|win32-arm64) ;;
  *) echo "Usage: scripts/packRuntimeBinaryArchives.sh <platform-arch>" >&2; exit 2 ;;
esac
FAMILIES=(tesseract poppler qpdf djvulibre)
TAR_BIN="${TAR_BIN:-tar}"
if [ "$(uname -s)" = Darwin ] && [ "${TAR_BIN:-tar}" = tar ]; then
  TAR_BIN=gtar
fi
command -v "$TAR_BIN" >/dev/null 2>&1 || {
  echo "Error: GNU tar is required to create deterministic runtime archives." >&2
  exit 1
}

mkdir -p "$ARCHIVE_DIR"
find "$ARCHIVE_DIR" -maxdepth 1 -type f -name '*.tar.gz' -delete

pack_tree() {
  local family="$1"
  local relative_root="$family/$TARGET"
  local archive_name="$family-$TARGET"
  if [ "$family" = tesseract ]; then
    archive_name="tesseract-$TARGET-5.5.3"
  fi
  if [ ! -d "$PROJECT_ROOT/resources/$relative_root" ]; then
    echo "Error: runtime resource tree is missing: resources/$relative_root" >&2
    exit 1
  fi
  if [ "$family" != tesseract ] && { [ "$TARGET" = darwin-arm64 ] || [ "$TARGET" = win32-x64 ]; }; then
    local cached_archive
    cached_archive="$(find "$PROJECT_ROOT/.cache/runtime-binaries" -maxdepth 1 -type f \
      -name "$family-$TARGET-*.tar-gz" -print -quit 2>/dev/null || true)"
    if [ -z "$cached_archive" ]; then
      echo "Error: verified v1 archive cache is missing for $family-$TARGET." >&2
      exit 1
    fi
    cp "$cached_archive" "$ARCHIVE_DIR/$archive_name.tar.gz"
    return
  fi
  "$TAR_BIN" --sort=name \
    --mtime='UTC 1970-01-01' \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --pax-option=delete=atime,delete=ctime \
    -C "$PROJECT_ROOT/resources" \
    -cf - "$relative_root" | gzip -n > "$ARCHIVE_DIR/$archive_name.tar.gz"
}

for family in "${FAMILIES[@]}"; do
  pack_tree "$family"
done

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARCHIVE_DIR"/*.tar.gz | sort -k2 | tee "$ARCHIVE_DIR/SHA256SUMS"
else
  shasum -a 256 "$ARCHIVE_DIR"/*.tar.gz | sort -k2 | tee "$ARCHIVE_DIR/SHA256SUMS"
fi
echo "Wrote $TARGET runtime archives to $ARCHIVE_DIR"
