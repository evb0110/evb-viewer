#!/bin/bash
# Bundle all required native tools for Windows (x64 and arm64)
# Runs in Git Bash on CI — downloads pre-built release ZIPs
# Set TARGET_ARCH=arm64 to cross-bundle for Windows ARM (uses x64 binaries via WoW64)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources"
TEMP_DIR="/tmp/win-bundle-$$"

# TARGET_ARCH can be set by CI for cross-compilation (e.g., arm64 on x64 runner).
# Native arm64 Windows builds don't exist for most tools, so arm64 bundles
# contain x64 binaries that run via WoW64 emulation on Windows ARM devices.
PLATFORM_ARCH="win32-${TARGET_ARCH:-x64}"

echo "=========================================="
echo "Bundling native tools for $PLATFORM_ARCH"
echo "=========================================="

mkdir -p "$TEMP_DIR"

# ==========================================
# Version configuration
# ==========================================
TESSERACT_VERSION="5.5.1"
TESSERACT_DATE="20250401"
POPPLER_VERSION="25.02.0"
QPDF_VERSION="11.10.1"
DJVULIBRE_VERSION="3.5.28"

# ==========================================
# Helper functions
# ==========================================
download() {
  local url="$1"
  local dest="$2"
  echo "  Downloading: $(basename "$dest")"
  curl -fSL --retry 3 --retry-delay 5 -o "$dest" "$url"
}

# ==========================================
# 1. Tesseract (UB-Mannheim)
# ==========================================
echo ""
echo "=========================================="
echo "1. Bundling Tesseract ${TESSERACT_VERSION}..."
echo "=========================================="

TESSERACT_DIR="$RESOURCES_DIR/tesseract/$PLATFORM_ARCH"
mkdir -p "$TESSERACT_DIR/bin"

TESSERACT_ZIP="tesseract-ocr-w64-setup-${TESSERACT_VERSION}.${TESSERACT_DATE}.exe"
TESSERACT_URL="https://github.com/UB-Mannheim/tesseract/releases/download/v${TESSERACT_VERSION}/tesseract-ocr-w64-v${TESSERACT_VERSION}.${TESSERACT_DATE}.zip"

download "$TESSERACT_URL" "$TEMP_DIR/tesseract.zip"

echo "  Extracting..."
unzip -qo "$TEMP_DIR/tesseract.zip" -d "$TEMP_DIR/tesseract"

# Find the extracted directory (may vary by release)
TESSERACT_EXTRACTED="$(find "$TEMP_DIR/tesseract" -name 'tesseract.exe' -print -quit | xargs dirname 2>/dev/null || true)"

if [ -z "$TESSERACT_EXTRACTED" ]; then
  # Try alternative structure
  TESSERACT_EXTRACTED="$TEMP_DIR/tesseract"
fi

echo "  Copying binaries and DLLs..."
cp "$TESSERACT_EXTRACTED/tesseract.exe" "$TESSERACT_DIR/bin/" 2>/dev/null || true
# Copy all DLLs from the tesseract directory
find "$TESSERACT_EXTRACTED" -maxdepth 2 -name '*.dll' -exec cp {} "$TESSERACT_DIR/bin/" \; 2>/dev/null || true

echo "  Tesseract: $(ls "$TESSERACT_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$TESSERACT_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 2. Poppler (oschwartz10612)
# ==========================================
echo ""
echo "=========================================="
echo "2. Bundling Poppler ${POPPLER_VERSION}..."
echo "=========================================="

POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
mkdir -p "$POPPLER_DIR/bin"

POPPLER_URL="https://github.com/oschwartz10612/poppler-windows/releases/download/v${POPPLER_VERSION}/Release-${POPPLER_VERSION}-0.zip"
download "$POPPLER_URL" "$TEMP_DIR/poppler.zip"

echo "  Extracting..."
unzip -qo "$TEMP_DIR/poppler.zip" -d "$TEMP_DIR/poppler"

POPPLER_BIN="$(find "$TEMP_DIR/poppler" -name 'pdftoppm.exe' -print -quit | xargs dirname 2>/dev/null || echo "$TEMP_DIR/poppler/poppler-${POPPLER_VERSION}/Library/bin")"

echo "  Copying binaries and DLLs..."
for tool in pdftoppm.exe pdftotext.exe pdfinfo.exe pdfimages.exe; do
  cp "$POPPLER_BIN/$tool" "$POPPLER_DIR/bin/" 2>/dev/null || echo "  Warning: $tool not found"
done
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
echo "3. Bundling qpdf ${QPDF_VERSION}..."
echo "=========================================="

QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"
mkdir -p "$QPDF_DIR/bin"

QPDF_URL="https://github.com/qpdf/qpdf/releases/download/v${QPDF_VERSION}/qpdf-${QPDF_VERSION}-msvc64.zip"
download "$QPDF_URL" "$TEMP_DIR/qpdf.zip"

echo "  Extracting..."
unzip -qo "$TEMP_DIR/qpdf.zip" -d "$TEMP_DIR/qpdf"

QPDF_BIN="$(find "$TEMP_DIR/qpdf" -name 'qpdf.exe' -print -quit | xargs dirname 2>/dev/null || echo "$TEMP_DIR/qpdf/qpdf-${QPDF_VERSION}/bin")"

echo "  Copying binaries and DLLs..."
cp "$QPDF_BIN/qpdf.exe" "$QPDF_DIR/bin/" 2>/dev/null || true
cp "$QPDF_BIN/"*.dll "$QPDF_DIR/bin/" 2>/dev/null || true

echo "  qpdf: $(ls "$QPDF_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$QPDF_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 4. DjVuLibre
# ==========================================
echo ""
echo "=========================================="
echo "4. Bundling DjVuLibre ${DJVULIBRE_VERSION}..."
echo "=========================================="

DJVU_DIR="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"
mkdir -p "$DJVU_DIR/bin" "$DJVU_DIR/lib"

DJVULIBRE_URL="https://github.com/ArtifexSoftware/djvulibre/releases/download/release.${DJVULIBRE_VERSION}/djvulibre-${DJVULIBRE_VERSION}-win64.zip"
download "$DJVULIBRE_URL" "$TEMP_DIR/djvulibre.zip"

echo "  Extracting..."
unzip -qo "$TEMP_DIR/djvulibre.zip" -d "$TEMP_DIR/djvulibre"

# Find the extracted binaries
DJVU_EXTRACTED="$(find "$TEMP_DIR/djvulibre" -name 'ddjvu.exe' -print -quit | xargs dirname 2>/dev/null || true)"

if [ -n "$DJVU_EXTRACTED" ]; then
  echo "  Copying binaries and DLLs..."
  cp "$DJVU_EXTRACTED/ddjvu.exe" "$DJVU_DIR/bin/" 2>/dev/null || true
  cp "$DJVU_EXTRACTED/djvused.exe" "$DJVU_DIR/bin/" 2>/dev/null || true
  cp "$DJVU_EXTRACTED/"*.dll "$DJVU_DIR/bin/" 2>/dev/null || true
  # Also check parent/sibling directories for DLLs
  find "$(dirname "$DJVU_EXTRACTED")" -name '*.dll' -exec cp {} "$DJVU_DIR/bin/" \; 2>/dev/null || true
else
  echo "  Warning: Could not locate DjVuLibre binaries in extracted archive"
  echo "  You may need to adjust DJVULIBRE_URL or extract manually"
fi

echo "  DjVuLibre: $(ls "$DJVU_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$DJVU_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# Note: Unpaper is not available on Windows
# ==========================================
echo ""
echo "Note: Unpaper is not available on Windows — falls back to system PATH"

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
  fi
}

verify_tool "$TESSERACT_DIR/bin/tesseract.exe" "tesseract"
verify_tool "$POPPLER_DIR/bin/pdftoppm.exe" "pdftoppm"
verify_tool "$POPPLER_DIR/bin/pdftotext.exe" "pdftotext"
verify_tool "$POPPLER_DIR/bin/pdfimages.exe" "pdfimages"
verify_tool "$QPDF_DIR/bin/qpdf.exe" "qpdf"
verify_tool "$DJVU_DIR/bin/ddjvu.exe" "ddjvu"
verify_tool "$DJVU_DIR/bin/djvused.exe" "djvused"

echo ""
echo "Total bundle size:"
du -sh "$TESSERACT_DIR" "$POPPLER_DIR" "$QPDF_DIR" "$DJVU_DIR" 2>/dev/null || true

# Cleanup
echo ""
echo "Cleaning up temp files..."
rm -rf "$TEMP_DIR"

echo ""
echo "Done!"
