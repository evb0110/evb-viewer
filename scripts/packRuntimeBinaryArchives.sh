#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ARCHIVE_DIR="${EVB_RUNTIME_BINARY_ARCHIVE_DIR:-$PROJECT_ROOT/.devkit/tmp/runtime-archives}"
TARGETS=(darwin-arm64 linux-x64 win32-x64)
FAMILIES=(tesseract poppler qpdf djvulibre)

mkdir -p "$ARCHIVE_DIR"
find "$ARCHIVE_DIR" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name 'SHA256SUMS' \) -delete

pack_tree() {
  local archive_name="$1"
  local relative_root="$2"
  if [ ! -d "$PROJECT_ROOT/resources/$relative_root" ]; then
    echo "Error: tracked resource tree is missing: resources/$relative_root" >&2
    exit 1
  fi
  tar --sort=name \
    --mtime='UTC 1970-01-01' \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --pax-option=delete=atime,delete=ctime \
    -C "$PROJECT_ROOT/resources" \
    -cf - "$relative_root" | gzip -n > "$ARCHIVE_DIR/$archive_name.tar.gz"
}

for family in "${FAMILIES[@]}"; do
  for target in "${TARGETS[@]}"; do
    pack_tree "$family-$target" "$family/$target"
  done
done
pack_tree tesseract-tessdata tesseract/tessdata

sha256sum "$ARCHIVE_DIR"/*.tar.gz | sort -k2 | tee "$ARCHIVE_DIR/SHA256SUMS"
echo "Wrote runtime archive assets to $ARCHIVE_DIR"
