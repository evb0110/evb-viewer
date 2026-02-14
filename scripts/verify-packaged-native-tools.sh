#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <platform: mac|win|linux> <arch: x64|arm64>"
  exit 1
fi

platform="$1"
arch="$2"

case "$platform" in
  mac)
    platform_arch="darwin-$arch"
    exe_suffix=""
    ;;
  win)
    platform_arch="win32-$arch"
    exe_suffix=".exe"
    ;;
  linux)
    platform_arch="linux-$arch"
    exe_suffix=""
    ;;
  *)
    echo "Error: Unsupported platform '$platform'"
    exit 1
    ;;
esac

resource_root=""
while IFS= read -r -d '' candidate; do
  if [ -d "$candidate/tesseract/$platform_arch" ]; then
    resource_root="$candidate"
    break
  fi
done < <(find dist -type d \( -name resources -o -name Resources \) -print0)

if [ -z "$resource_root" ]; then
  echo "Error: Could not locate packaged resources for $platform_arch in dist/"
  exit 1
fi

echo "Verifying packaged native tools in: $resource_root"

check_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "Error: Missing $label ($path)"
    exit 1
  fi
}

check_file "$resource_root/tesseract/$platform_arch/bin/tesseract$exe_suffix" "tesseract binary"

tessdata_dir="$resource_root/tesseract/tessdata"
if [ ! -d "$tessdata_dir" ]; then
  echo "Error: Missing tessdata directory ($tessdata_dir)"
  exit 1
fi
if ! find "$tessdata_dir" -maxdepth 1 -type f -name '*.traineddata' -print -quit | grep -q .; then
  echo "Error: No traineddata files found in $tessdata_dir"
  exit 1
fi

check_file "$resource_root/poppler/$platform_arch/bin/pdftoppm$exe_suffix" "pdftoppm binary"
check_file "$resource_root/poppler/$platform_arch/bin/pdftotext$exe_suffix" "pdftotext binary"
check_file "$resource_root/qpdf/$platform_arch/bin/qpdf$exe_suffix" "qpdf binary"
check_file "$resource_root/djvulibre/$platform_arch/bin/ddjvu$exe_suffix" "ddjvu binary"
check_file "$resource_root/djvulibre/$platform_arch/bin/djvused$exe_suffix" "djvused binary"

if [ "$platform" = "mac" ]; then
  unresolved=0
  while IFS= read -r file; do
    refs="$(otool -L "$file" 2>/dev/null | grep -E '/opt/homebrew|/usr/local/opt|/usr/local/Cellar' || true)"
    if [ -n "$refs" ]; then
      echo "Error: Unresolved Homebrew reference in $file"
      echo "$refs" | sed 's/^/  /'
      unresolved=1
    fi
  done < <(find \
    "$resource_root/tesseract/$platform_arch/bin/tesseract" \
    "$resource_root/tesseract/$platform_arch/lib" \
    "$resource_root/poppler/$platform_arch/bin" \
    "$resource_root/poppler/$platform_arch/lib" \
    "$resource_root/qpdf/$platform_arch/bin" \
    "$resource_root/qpdf/$platform_arch/lib" \
    "$resource_root/djvulibre/$platform_arch/bin" \
    "$resource_root/djvulibre/$platform_arch/lib" \
    -type f)

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
fi

echo "Native tool packaging verification passed for $platform_arch"
