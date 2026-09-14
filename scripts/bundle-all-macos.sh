#!/bin/bash
# Bundle all required native tools for the Electron app on macOS
# Run this script to prepare the app for local distribution builds.
# Mirrors the CI bundling steps in .github/workflows/build.yml.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOTAL_STEPS=3

# Fetch the published archives for this target. Exit code 3 means the target
# has none yet, so the source build below still produces its tools.
# EVB_RUNTIME_BINARIES_FROM_SOURCE=1 skips the fetch to rebuild the archives.
if [ "${EVB_RUNTIME_BINARIES_FROM_SOURCE:-0}" != 1 ]; then
  fetch_status=0
  node --import tsx "$SCRIPT_DIR/fetchRuntimeBinaries.ts" || fetch_status=$?
  if [ "$fetch_status" -eq 0 ]; then
      exit 0
  elif [ "$fetch_status" -ne 3 ]; then
      exit "$fetch_status"
  fi
fi

echo "=============================================="
echo "  Bundling all native tools for Electron app"
echo "=============================================="
echo ""

# Ensure Homebrew dependencies are installed
echo "Checking Homebrew dependencies..."
DEPS=(tesseract poppler qpdf djvulibre)
MISSING=()
for dep in "${DEPS[@]}"; do
    if ! brew list --formula "$dep" &>/dev/null; then
        MISSING+=("$dep")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "Installing missing Homebrew packages: ${MISSING[*]}"
    brew install "${MISSING[@]}"
else
    echo "All Homebrew dependencies present."
fi
echo ""

# Step 1: Bundle Tesseract OCR
echo "Step 1/$TOTAL_STEPS: Bundling Tesseract..."
echo ""
"$SCRIPT_DIR/bundle-tesseract-macos.sh"
echo ""

# Step 2: Bundle PDF tools (Poppler + qpdf)
echo "Step 2/$TOTAL_STEPS: Bundling PDF tools (Poppler, qpdf)..."
echo ""
"$SCRIPT_DIR/bundle-pdf-tools-macos.sh"
echo ""

# Step 3: Bundle DjVuLibre tools
echo "Step 3/$TOTAL_STEPS: Bundling DjVuLibre (ddjvu, djvused, djvudump)..."
echo ""
"$SCRIPT_DIR/bundle-djvu-macos.sh"
echo ""

echo "=============================================="
echo "  All native tools bundled successfully!"
echo "=============================================="
echo ""
echo "You can now build the app with: pnpm dist -- --mac"
