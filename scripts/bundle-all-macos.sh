#!/bin/bash
# Bundle all required tools for the Electron app on macOS
# Run this script to prepare the app for distribution
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=============================================="
echo "  Bundling all tools for Electron app"
echo "=============================================="
echo ""

# Step 1: Bundle PDF tools (Poppler + qpdf)
echo "Step 1/3: Bundling PDF tools (Poppler, qpdf)..."
echo ""
"$SCRIPT_DIR/bundle-pdf-tools-macos.sh"

echo ""
echo ""

# Step 2: Bundle DjVuLibre tools
echo "Step 2/3: Bundling DjVuLibre (ddjvu, djvused)..."
echo ""
"$SCRIPT_DIR/bundle-djvu-macos.sh"

echo ""
echo ""

# Step 3: Bundle Python page-processor
echo "Step 3/3: Bundling Python page-processor..."
echo ""
"$SCRIPT_DIR/bundle-page-processor-macos.sh"

echo ""
echo "=============================================="
echo "  All tools bundled successfully!"
echo "=============================================="
echo ""
echo "You can now build and run the Electron app."
echo "The page processing feature should work without"
echo "requiring any external tool installations."
