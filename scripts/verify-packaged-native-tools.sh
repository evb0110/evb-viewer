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

check_dir() {
  local path="$1"
  local label="$2"
  if [ ! -d "$path" ]; then
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
if [ "$platform" = "win" ]; then
  check_file "$resource_root/poppler/$platform_arch/bin/pdftocairo$exe_suffix" "pdftocairo binary"
  check_dir "$resource_root/poppler/$platform_arch/share/poppler" "poppler data directory"
  check_dir "$resource_root/poppler/$platform_arch/etc/fonts" "poppler fontconfig directory"
fi
check_file "$resource_root/qpdf/$platform_arch/bin/qpdf$exe_suffix" "qpdf binary"
check_file "$resource_root/djvulibre/$platform_arch/bin/ddjvu$exe_suffix" "ddjvu binary"
check_file "$resource_root/djvulibre/$platform_arch/bin/djvused$exe_suffix" "djvused binary"

find_tool_files() {
  local tag="$1"
  local kind="$2"
  local dirs=(
    "$resource_root/tesseract/$tag/$kind"
    "$resource_root/poppler/$tag/$kind"
    "$resource_root/qpdf/$tag/$kind"
    "$resource_root/djvulibre/$tag/$kind"
  )

  for dir in "${dirs[@]}"; do
    if [ -d "$dir" ]; then
      find "$dir" -type f
    fi
  done
}

if [ "$platform" = "mac" ]; then
  unresolved=0
  while IFS= read -r file; do
    refs="$(otool -L "$file" 2>/dev/null | grep -E '/opt/homebrew|/usr/local/opt|/usr/local/Cellar' || true)"
    if [ -n "$refs" ]; then
      echo "Error: Unresolved Homebrew reference in $file"
      echo "$refs" | sed 's/^/  /'
      unresolved=1
    fi
  done < <(
    if [ -f "$resource_root/tesseract/$platform_arch/bin/tesseract" ]; then
      echo "$resource_root/tesseract/$platform_arch/bin/tesseract"
    fi
    find_tool_files "$platform_arch" "bin"
    find_tool_files "$platform_arch" "lib"
  )

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
fi

if [ "$platform" = "linux" ]; then
  if ! command -v ldd >/dev/null 2>&1; then
    echo "Error: ldd is required for linux dependency verification"
    exit 1
  fi

  unresolved=0
  while IFS= read -r file; do
    if ! file "$file" 2>/dev/null | grep -q 'ELF'; then
      continue
    fi

    refs="$(ldd "$file" 2>/dev/null || true)"
    if echo "$refs" | grep -q 'not found'; then
      echo "Error: Missing shared library dependency in $file"
      echo "$refs" | sed 's/^/  /'
      unresolved=1
    fi
  done < <(
    find_tool_files "$platform_arch" "bin"
    find_tool_files "$platform_arch" "lib"
  )

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
fi

if [ "$platform" = "win" ]; then
  if ! command -v objdump >/dev/null 2>&1; then
    echo "Error: objdump is required for windows dependency verification"
    exit 1
  fi

  script_dir="$(cd "$(dirname "$0")" && pwd)"
  source "$script_dir/win-system-dll-pattern.sh"

  bundled_dlls_file="$(mktemp)"
  trap 'rm -f "$bundled_dlls_file"' EXIT

  while IFS= read -r file; do
    basename "$file" | tr '[:upper:]' '[:lower:]' >> "$bundled_dlls_file"
  done < <(find_tool_files "$platform_arch" "bin" | grep -i '\.dll$' || true)
  sort -u -o "$bundled_dlls_file" "$bundled_dlls_file"

  unresolved=0
  while IFS= read -r file; do
    while IFS= read -r dep; do
      dep_lc="$(printf '%s' "$dep" | tr '[:upper:]' '[:lower:]')"
      if [[ "$dep_lc" =~ $system_dll_pattern ]]; then
        continue
      fi
      if ! grep -Fxq "$dep_lc" "$bundled_dlls_file"; then
        # MinGW/MSYS2 DLLs may be named with lib prefix (e.g. libglib-2.0-0.dll)
        # while the import table references the non-prefixed name (glib-2.0-0.dll)
        if ! grep -Fxq "lib$dep_lc" "$bundled_dlls_file"; then
          echo "Error: Missing bundled DLL dependency \"$dep\" for $file"
          unresolved=1
        fi
      fi
    done < <(objdump -p "$file" 2>/dev/null | awk '/DLL Name:/{print $3}')
  done < <(find_tool_files "$platform_arch" "bin" | grep -Ei '\.(exe|dll)$' || true)

  rm -f "$bundled_dlls_file"
  trap - EXIT

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
fi

echo "Native tool packaging verification passed for $platform_arch"
