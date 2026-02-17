#!/bin/bash
# Bundle all required native tools for Windows (x64 and arm64)
# Runs in Git Bash on CI — downloads pre-built release ZIPs
# Set TARGET_ARCH=arm64 to cross-bundle for Windows ARM (uses x64 binaries via WoW64)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources"
TEMP_DIR="/tmp/win-bundle-$$"
CACHE_DIR="${WIN_BUNDLE_CACHE_DIR:-$PROJECT_ROOT/.cache/win-tools}"
source "$SCRIPT_DIR/win-system-dll-pattern.sh"

# TARGET_ARCH can be set by CI for cross-compilation (e.g., arm64 on x64 runner).
# Native arm64 Windows builds don't exist for most tools, so arm64 bundles
# contain x64 binaries that run via WoW64 emulation on Windows ARM devices.
PLATFORM_ARCH="win32-${TARGET_ARCH:-x64}"

echo "=========================================="
echo "Bundling native tools for $PLATFORM_ARCH"
echo "=========================================="

mkdir -p "$TEMP_DIR"
mkdir -p "$CACHE_DIR"

# ==========================================
# Version configuration
# ==========================================
TESSERACT_TAG="v5.4.0.20240606"
TESSERACT_INSTALLER="tesseract-ocr-w64-setup-5.4.0.20240606.exe"
POPPLER_VERSION="25.12.0"
QPDF_VERSION="12.3.2"
DJVULIBRE_INSTALLER="DjVuLibre-3.5.28_DjView-4.12_Setup.exe"
DJVULIBRE_SF_PATH="DjVuLibre_Windows/3.5.28%2B4.12"

# ==========================================
# Helper functions
# ==========================================
download() {
  local url="$1"
  local dest="$2"
  local cache_key="${3:-$(basename "$dest")}"
  local cache_path="$CACHE_DIR/$cache_key"

  if [ -s "$cache_path" ]; then
    echo "  Using cache: $cache_key"
    cp "$cache_path" "$dest"
    return
  fi

  echo "  Downloading: $cache_key"
  local temp_cache="${cache_path}.part-$$"
  curl -fSL --retry 3 --retry-delay 5 -o "$temp_cache" "$url"
  mv "$temp_cache" "$cache_path"
  cp "$cache_path" "$dest"
}

require_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "Error: Missing $label at $path"
    exit 1
  fi
}

copy_required_tool() {
  local source="$1"
  local dest_dir="$2"
  local label="$3"
  require_file "$source" "$label"
  cp "$source" "$dest_dir/"
}

clean_dir() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
}

pe_arch() {
  local file_path="$1"
  objdump -f "$file_path" 2>/dev/null | sed -n 's/^architecture: \([^,]*\).*/\1/p' | head -n 1
}

find_dependency_match() {
  local search_root="$1"
  local dep_name="$2"
  local target_arch="$3"
  local first_match=""

  while IFS= read -r candidate; do
    [ -n "$first_match" ] || first_match="$candidate"
    if [ -z "$target_arch" ]; then
      echo "$candidate"
      return 0
    fi

    local candidate_arch
    candidate_arch="$(pe_arch "$candidate")"
    if [ "$candidate_arch" = "$target_arch" ]; then
      echo "$candidate"
      return 0
    fi
  done < <(find "$search_root" -type f -iname "$dep_name" -print)

  if [ -n "$first_match" ]; then
    echo "$first_match"
    return 0
  fi

  return 1
}

bundle_dependency_closure() {
  local search_root="$1"
  local dest_bin="$2"
  local expected_arch="$3"

  local pending=("$dest_bin/ddjvu.exe" "$dest_bin/djvused.exe")
  local pending_index=0
  local seen_deps_file="$TEMP_DIR/djvu-seen-deps.txt"
  : > "$seen_deps_file"

  while [ "$pending_index" -lt "${#pending[@]}" ]; do
    local binary="${pending[$pending_index]}"
    pending_index=$((pending_index + 1))

    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      local dep_lc
      dep_lc="$(printf '%s' "$dep" | tr '[:upper:]' '[:lower:]')"

      if grep -Fxiq "$dep_lc" "$seen_deps_file"; then
        continue
      fi

      local dep_source
      dep_source="$(find_dependency_match "$search_root" "$dep" "$expected_arch" || true)"
      if [ -z "$dep_source" ]; then
        if [[ "$dep_lc" =~ $system_dll_pattern ]]; then
          continue
        fi
        echo "Error: Missing non-system DjVu dependency \"$dep\" needed by $(basename "$binary")"
        exit 1
      fi

      local dep_dest="$dest_bin/$(basename "$dep_source")"
      cp "$dep_source" "$dep_dest"
      printf '%s\n' "$dep_lc" >> "$seen_deps_file"
      pending+=("$dep_dest")
    done < <(objdump -p "$binary" 2>/dev/null | awk '/DLL Name:/{print $3}')
  done

  rm -f "$seen_deps_file"
}

verify_directory_architecture() {
  local target_dir="$1"
  local expected_arch="$2"
  local file_path

  while IFS= read -r file_path; do
    local actual_arch
    actual_arch="$(pe_arch "$file_path")"
    if [ -z "$actual_arch" ]; then
      continue
    fi
    if [ "$actual_arch" != "$expected_arch" ]; then
      echo "Error: Architecture mismatch for $(basename "$file_path"): expected $expected_arch, got $actual_arch"
      exit 1
    fi
  done < <(find "$target_dir" -maxdepth 1 -type f \( -iname '*.exe' -o -iname '*.dll' \) -print)
}

# ==========================================
# 1. Tesseract (UB-Mannheim)
# ==========================================
echo ""
echo "=========================================="
echo "1. Bundling Tesseract (${TESSERACT_TAG})..."
echo "=========================================="

TESSERACT_DIR="$RESOURCES_DIR/tesseract/$PLATFORM_ARCH"
clean_dir "$TESSERACT_DIR/bin"

TESSERACT_URL="https://github.com/UB-Mannheim/tesseract/releases/download/${TESSERACT_TAG}/${TESSERACT_INSTALLER}"
download "$TESSERACT_URL" "$TEMP_DIR/tesseract-setup.exe" "tesseract-${TESSERACT_TAG}.exe"

echo "  Extracting with 7z..."
7z x -y "$TEMP_DIR/tesseract-setup.exe" -o"$TEMP_DIR/tesseract" > /dev/null 2>&1

TESSERACT_EXE="$(find "$TEMP_DIR/tesseract" -name 'tesseract.exe' -print -quit)"
if [ -z "$TESSERACT_EXE" ]; then
  echo "Error: Failed to locate extracted tesseract.exe"
  exit 1
fi
TESSERACT_EXTRACTED="$(dirname "$TESSERACT_EXE")"

echo "  Copying binaries and DLLs..."
copy_required_tool "$TESSERACT_EXTRACTED/tesseract.exe" "$TESSERACT_DIR/bin" "tesseract.exe"
find "$TEMP_DIR/tesseract" -maxdepth 4 -name '*.dll' -exec cp {} "$TESSERACT_DIR/bin/" \; 2>/dev/null || true

echo "  Tesseract: $(ls "$TESSERACT_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$TESSERACT_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 2. Poppler (oschwartz10612)
# ==========================================
echo ""
echo "=========================================="
echo "2. Bundling Poppler ${POPPLER_VERSION}..."
echo "=========================================="

POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
clean_dir "$POPPLER_DIR/bin"

POPPLER_URL="https://github.com/oschwartz10612/poppler-windows/releases/download/v${POPPLER_VERSION}-0/Release-${POPPLER_VERSION}-0.zip"
download "$POPPLER_URL" "$TEMP_DIR/poppler.zip" "poppler-${POPPLER_VERSION}.zip"

echo "  Extracting..."
unzip -qo "$TEMP_DIR/poppler.zip" -d "$TEMP_DIR/poppler"

POPPLER_PDFTOPPM="$(find "$TEMP_DIR/poppler" -name 'pdftoppm.exe' -print -quit)"
if [ -z "$POPPLER_PDFTOPPM" ]; then
  echo "Error: Failed to locate extracted pdftoppm.exe"
  exit 1
fi
POPPLER_BIN="$(dirname "$POPPLER_PDFTOPPM")"

echo "  Copying binaries and DLLs..."
for tool in pdftoppm.exe pdftotext.exe pdfimages.exe; do
  copy_required_tool "$POPPLER_BIN/$tool" "$POPPLER_DIR/bin" "$tool"
done
# Optional utility
if [ -f "$POPPLER_BIN/pdfinfo.exe" ]; then
  cp "$POPPLER_BIN/pdfinfo.exe" "$POPPLER_DIR/bin/"
fi
# Copy all DLLs
find "$(dirname "$POPPLER_BIN")" -name '*.dll' -exec cp {} "$POPPLER_DIR/bin/" \; 2>/dev/null || true
# Also check directly in bin dir
cp "$POPPLER_BIN/"*.dll "$POPPLER_DIR/bin/" 2>/dev/null || true

echo "  Poppler: $(ls "$POPPLER_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$POPPLER_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 3. qpdf
# ==========================================
echo ""
echo "=========================================="
echo "3. Bundling qpdf v${QPDF_VERSION}..."
echo "=========================================="

QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"
clean_dir "$QPDF_DIR/bin"

QPDF_URL="https://github.com/qpdf/qpdf/releases/download/v${QPDF_VERSION}/qpdf-${QPDF_VERSION}-msvc64.zip"
download "$QPDF_URL" "$TEMP_DIR/qpdf.zip" "qpdf-${QPDF_VERSION}.zip"

echo "  Extracting..."
unzip -qo "$TEMP_DIR/qpdf.zip" -d "$TEMP_DIR/qpdf"

QPDF_EXE="$(find "$TEMP_DIR/qpdf" -name 'qpdf.exe' -print -quit)"
if [ -z "$QPDF_EXE" ]; then
  echo "Error: Failed to locate extracted qpdf.exe"
  exit 1
fi
QPDF_BIN="$(dirname "$QPDF_EXE")"

echo "  Copying binaries and DLLs..."
copy_required_tool "$QPDF_BIN/qpdf.exe" "$QPDF_DIR/bin" "qpdf.exe"
cp "$QPDF_BIN/"*.dll "$QPDF_DIR/bin/" 2>/dev/null || true

echo "  qpdf: $(ls "$QPDF_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$QPDF_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 4. DjVuLibre (SourceForge)
# ==========================================
echo ""
echo "=========================================="
echo "4. Bundling DjVuLibre..."
echo "=========================================="

DJVU_DIR="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"
clean_dir "$DJVU_DIR/bin"
clean_dir "$DJVU_DIR/lib"

if ! command -v objdump >/dev/null 2>&1; then
  echo "Error: objdump is required to bundle DjVu dependencies safely"
  exit 1
fi

DJVULIBRE_URL="https://sourceforge.net/projects/djvu/files/${DJVULIBRE_SF_PATH}/${DJVULIBRE_INSTALLER}/download"
download "$DJVULIBRE_URL" "$TEMP_DIR/djvulibre-setup.exe" "djvulibre-${DJVULIBRE_SF_PATH//\//_}.exe"

echo "  Extracting with 7z..."
7z x -y "$TEMP_DIR/djvulibre-setup.exe" -o"$TEMP_DIR/djvulibre" > /dev/null 2>&1

DJVU_DDJVU_EXE="$(find "$TEMP_DIR/djvulibre" -name 'ddjvu.exe' -print -quit)"
if [ -z "$DJVU_DDJVU_EXE" ]; then
  echo "Error: Failed to locate extracted ddjvu.exe"
  exit 1
fi
DJVU_EXTRACTED="$(dirname "$DJVU_DDJVU_EXE")"

echo "  Copying binaries and DLLs..."
copy_required_tool "$DJVU_EXTRACTED/ddjvu.exe" "$DJVU_DIR/bin" "ddjvu.exe"
copy_required_tool "$DJVU_EXTRACTED/djvused.exe" "$DJVU_DIR/bin" "djvused.exe"

DJVU_ARCH="$(pe_arch "$DJVU_DIR/bin/ddjvu.exe")"
if [ -z "$DJVU_ARCH" ]; then
  echo "Error: Failed to detect architecture for DjVu binaries"
  exit 1
fi

bundle_dependency_closure "$TEMP_DIR/djvulibre" "$DJVU_DIR/bin" "$DJVU_ARCH"
verify_directory_architecture "$DJVU_DIR/bin" "$DJVU_ARCH"

echo "  DjVuLibre: $(ls "$DJVU_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$DJVU_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# Note: Unpaper is currently not bundled on Windows
# ==========================================
echo ""
echo "Note: Unpaper is currently not bundled on Windows."

# ==========================================
# Verification
# ==========================================
echo ""
echo "=========================================="
echo "Verification"
echo "=========================================="

verify_tool() {
  local path="$1"
  local name="$2"
  if [ -f "$path" ]; then
    local size
    size="$(du -h "$path" | awk '{print $1}')"
    echo "  OK  $name ($size)"
  else
    echo "  MISSING  $name"
    missing_count=$((missing_count + 1))
  fi
}

missing_count=0

verify_tool "$TESSERACT_DIR/bin/tesseract.exe" "tesseract"
verify_tool "$POPPLER_DIR/bin/pdftoppm.exe" "pdftoppm"
verify_tool "$POPPLER_DIR/bin/pdftotext.exe" "pdftotext"
verify_tool "$POPPLER_DIR/bin/pdfimages.exe" "pdfimages"
verify_tool "$QPDF_DIR/bin/qpdf.exe" "qpdf"
verify_tool "$DJVU_DIR/bin/ddjvu.exe" "ddjvu"
verify_tool "$DJVU_DIR/bin/djvused.exe" "djvused"

if [ "$missing_count" -gt 0 ]; then
  echo ""
  echo "Error: Bundle verification failed ($missing_count required files missing)"
  exit 1
fi

echo ""
echo "Total bundle size:"
du -sh "$TESSERACT_DIR" "$POPPLER_DIR" "$QPDF_DIR" "$DJVU_DIR" 2>/dev/null || true

# Cleanup
echo ""
echo "Cleaning up temp files..."
rm -rf "$TEMP_DIR"

echo ""
echo "Done!"
