#!/bin/bash
# Bundle Python page-processor for macOS using PyInstaller
# Creates a standalone executable that can be bundled with the Electron app
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$PROJECT_ROOT/python/page-processor"
RESOURCES_DIR="$PROJECT_ROOT/resources/page-processing"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64" ;;
  x86_64) PLATFORM_ARCH="darwin-x64" ;;
  *)      echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

OUTPUT_DIR="$RESOURCES_DIR/$PLATFORM_ARCH"

echo "=========================================="
echo "Bundling page-processor for $PLATFORM_ARCH"
echo "=========================================="

# Step 1: Verify prerequisites
echo ""
echo "Checking prerequisites..."

if ! command -v python3 &> /dev/null; then
  echo "Error: python3 is required"
  exit 1
fi

if [ ! -d "$PYTHON_DIR" ]; then
  echo "Error: Python source directory not found at $PYTHON_DIR"
  exit 1
fi

if [ ! -f "$PYTHON_DIR/requirements.txt" ]; then
  echo "Error: requirements.txt not found in $PYTHON_DIR"
  exit 1
fi

echo "  Python: $(python3 --version)"
echo "  Source: $PYTHON_DIR"
echo "  Output: $OUTPUT_DIR"

# Step 2: Create output directory
echo ""
echo "Creating output directory..."
mkdir -p "$OUTPUT_DIR"

# Step 3: Create virtual environment
echo ""
echo "=========================================="
echo "Setting up virtual environment..."
echo "=========================================="

cd "$PYTHON_DIR"

# Remove existing venv if present
if [ -d ".venv" ]; then
  echo "Removing existing virtual environment..."
  rm -rf .venv
fi

echo "Creating new virtual environment..."
python3 -m venv .venv

echo "Activating virtual environment..."
source .venv/bin/activate

# Step 4: Install dependencies
echo ""
echo "=========================================="
echo "Installing dependencies..."
echo "=========================================="

pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller

echo "  Installed packages:"
pip list | grep -E "(pyinstaller|pdf|ocr|pillow)" | sed 's/^/    /' || true

# Step 5: Build with PyInstaller
echo ""
echo "=========================================="
echo "Building with PyInstaller..."
echo "=========================================="

# Clean previous build artifacts
rm -rf build dist *.spec

# Remove any previous bundled output (file for --onefile or dir for --onedir)
rm -rf "$OUTPUT_DIR/bin/page-processor"

pyinstaller \
  --onedir \
  --clean \
  --name page-processor \
  --distpath "$OUTPUT_DIR/bin" \
  main.py

echo "  Build completed"

# Step 6: Cleanup
echo ""
echo "=========================================="
echo "Cleaning up..."
echo "=========================================="

deactivate

echo "Removing build artifacts..."
rm -rf "$PYTHON_DIR/.venv"
rm -rf "$PYTHON_DIR/build"
rm -rf "$PYTHON_DIR/__pycache__"
rm -f "$PYTHON_DIR"/*.spec

# Also clean any nested __pycache__ directories
find "$PYTHON_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

echo "  Cleanup completed"

# Step 7: Verify output
echo ""
echo "=========================================="
echo "Verifying build..."
echo "=========================================="

BINARY_PATH="$OUTPUT_DIR/bin/page-processor/page-processor"

if [ ! -f "$BINARY_PATH" ]; then
  echo "Error: Build failed - binary not found at $BINARY_PATH"
  exit 1
fi

echo "  Binary exists: $BINARY_PATH"
echo "  Size: $(du -h "$BINARY_PATH" | awk '{print $1}')"

# Make sure it's executable
chmod +x "$BINARY_PATH"

# Test run
echo ""
echo "Testing binary..."
if "$BINARY_PATH" --version; then
  echo ""
  echo "  Binary runs successfully"
else
  echo ""
  echo "Error: Binary failed to run"
  exit 1
fi

# Step 8: Summary
echo ""
echo "=========================================="
echo "Build complete!"
echo "=========================================="
echo ""
echo "Output: $BINARY_PATH"
echo "Size:   $(du -h "$BINARY_PATH" | awk '{print $1}')"
echo ""
echo "Next steps:"
echo "1. Test the binary: $BINARY_PATH --help"
echo "2. Integrate with Electron app"
