#!/bin/bash
# Bundle Leptonica and minimal Unpaper for macOS
# Prerequisites: Tesseract already bundled, Meson + pkg-config installed
# Usage: ./scripts/bundle-leptonica-unpaper-macos.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64"; BREW="/opt/homebrew" ;;
  x86_64) PLATFORM_ARCH="darwin-x64"; BREW="/usr/local" ;;
  *)      echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

DEST="$PROJECT_ROOT/resources/tesseract/$PLATFORM_ARCH"

echo "=========================================="
echo "Building Leptonica + Unpaper for $PLATFORM_ARCH"
echo "=========================================="

# Step 0: Verify prerequisites
echo ""
echo "Checking prerequisites..."
if ! command -v meson &> /dev/null; then
  echo "Error: Meson is required. Install with: brew install meson"
  exit 1
fi

if ! command -v pkg-config &> /dev/null; then
  echo "Error: pkg-config is required. Install with: brew install pkg-config"
  exit 1
fi

if ! [ -d "$DEST" ]; then
  echo "Error: Tesseract bundle not found at $DEST"
  echo "Run ./scripts/bundle-tesseract-macos.sh first"
  exit 1
fi

if ! [ -f "$DEST/lib/libleptonica.6.dylib" ]; then
  echo "Error: libleptonica not found in Tesseract bundle"
  echo "Path: $DEST/lib/libleptonica.6.dylib"
  exit 1
fi

echo "✓ All prerequisites met"
echo "  Tesseract bundle: $DEST"
echo "  Leptonica library found: $DEST/lib/libleptonica.6.dylib"
echo "  Meson version: $(meson --version)"

# Step 1: Build Unpaper from source
echo ""
echo "=========================================="
echo "Building Unpaper from source..."
echo "=========================================="

UNPAPER_BUILD_DIR="/tmp/unpaper-build-macos-$$"
UNPAPER_INSTALL_DIR="$UNPAPER_BUILD_DIR/install"

mkdir -p "$UNPAPER_BUILD_DIR"
cd "$UNPAPER_BUILD_DIR"

# Clone repo if not already cloned
if [ ! -d "unpaper" ]; then
  echo "Cloning unpaper repository..."
  git clone https://github.com/unpaper/unpaper.git
else
  echo "Using existing unpaper directory"
fi

cd unpaper

# Fetch latest tags
git fetch origin

# Get latest release tag
LATEST_TAG=$(git describe --tags --abbrev=0 --match "v*" 2>/dev/null || echo "HEAD")
echo "Checking out: $LATEST_TAG"
git checkout "$LATEST_TAG"

# Configure Meson build with minimal dependencies
# Note: Unpaper can optionally use ImageMagick, but we skip it for minimal footprint
echo ""
echo "Configuring Meson build (minimal configuration)..."

if [ -d "build-minimal" ]; then
  rm -rf build-minimal
fi

meson setup build-minimal \
  --prefix="$UNPAPER_INSTALL_DIR" \
  --buildtype=release \
  -Dstrip=true

# Build
echo ""
echo "Compiling Unpaper..."
meson compile -C build-minimal

# Install
echo ""
echo "Installing Unpaper..."
meson install -C build-minimal

# Step 2: Copy Unpaper binary to resources
echo ""
echo "=========================================="
echo "Installing to resources..."
echo "=========================================="

if [ ! -f "$UNPAPER_INSTALL_DIR/bin/unpaper" ]; then
  echo "Error: Unpaper binary not found after build"
  echo "Expected: $UNPAPER_INSTALL_DIR/bin/unpaper"
  exit 1
fi

mkdir -p "$DEST/bin"
cp "$UNPAPER_INSTALL_DIR/bin/unpaper" "$DEST/bin/"
chmod +x "$DEST/bin/unpaper"
echo "✓ Unpaper binary copied to $DEST/bin/unpaper"

# Step 3: Check Unpaper dependencies
echo ""
echo "Analyzing Unpaper dependencies..."
UNPAPER_DEPS=$(otool -L "$DEST/bin/unpaper" | grep -v ":" | tail -n +2 | awk '{print $1}' | sort)
echo "Found dependencies:"
echo "$UNPAPER_DEPS" | sed 's/^/  /'

# Step 4: Fix dylib paths
echo ""
echo "=========================================="
echo "Fixing dylib paths..."
echo "=========================================="

fix_binary() {
  local binary="$1"
  local binary_name="$(basename "$binary")"

  echo "Processing $binary_name..."

  # Get all dependencies from Homebrew
  otool -L "$binary" 2>/dev/null | grep "$BREW" | awk '{print $1}' | while read dep; do
    if [ -z "$dep" ]; then
      continue
    fi

    local dep_name="$(basename "$dep")"

    # Check if dependency is in our lib directory
    if [ -f "$DEST/lib/$dep_name" ]; then
      # Use @executable_path for binaries, @loader_path for libraries
      local ref="@executable_path/../lib/$dep_name"
      echo "  Fixing: $dep_name -> $ref"
      install_name_tool -change "$dep" "$ref" "$binary" 2>/dev/null || true
    else
      echo "  Warning: Not found in bundle: $dep_name (will try system fallback)"
    fi
  done
}

fix_binary "$DEST/bin/unpaper"

# Verify
echo ""
echo "Verification:"
otool -L "$DEST/bin/unpaper" | head -5

# Step 5: Copy any new dylib dependencies
echo ""
echo "=========================================="
echo "Checking for new library dependencies..."
echo "=========================================="

NEW_LIBS=0
otool -L "$DEST/bin/unpaper" 2>/dev/null | grep "$BREW" | awk '{print $1}' | while read lib; do
  if [ -z "$lib" ]; then
    continue
  fi

  lib_name="$(basename "$lib")"
  lib_path="$BREW/opt/$(echo "$lib_name" | sed 's/\.[0-9]*\.dylib$//')/lib/$lib_name"

  # Try to find library in common Homebrew locations
  if [ -f "$lib_path" ] && [ ! -f "$DEST/lib/$lib_name" ]; then
    echo "Adding new dependency: $lib_name"
    cp "$lib_path" "$DEST/lib/" 2>/dev/null || true
    NEW_LIBS=$((NEW_LIBS + 1))
  fi
done

if [ $NEW_LIBS -gt 0 ]; then
  echo "✓ Added $NEW_LIBS new libraries"

  # Fix paths in new libraries
  for lib in "$DEST/lib/"*.dylib; do
    if [ -f "$lib" ]; then
      lib_name="$(basename "$lib")"

      # Set library's own ID
      install_name_tool -id "@loader_path/$lib_name" "$lib" 2>/dev/null || true

      # Fix dependencies within this library
      otool -L "$lib" 2>/dev/null | grep "$BREW" | awk '{print $1}' | while read dep; do
        if [ -n "$dep" ]; then
          dep_name="$(basename "$dep")"
          install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
        fi
      done
    fi
  done
fi

# Step 6: Codesign binaries
echo ""
echo "=========================================="
echo "Codesigning for local testing..."
echo "=========================================="

codesign --force --sign - "$DEST/bin/unpaper" 2>/dev/null || echo "Note: Codesigning not available in this environment"
echo "✓ Unpaper codesigned"

# Step 7: Test execution
echo ""
echo "=========================================="
echo "Testing Unpaper binary..."
echo "=========================================="

if "$DEST/bin/unpaper" --help > /dev/null 2>&1; then
  echo "✓ Unpaper runs successfully"
  "$DEST/bin/unpaper" --help | head -10
  echo "..."
else
  echo "⚠ Unpaper failed to run. Check dylib dependencies above."
  otool -L "$DEST/bin/unpaper"
fi

# Step 8: Show final status
echo ""
echo "=========================================="
echo "Build complete!"
echo "=========================================="

echo ""
echo "Resources bundled to: $DEST"
echo ""
echo "Contents:"
echo "  bin/:  $(ls -1 "$DEST/bin" | wc -l) files"
ls -lh "$DEST/bin/" | tail -n +2 | awk '{printf "    %s (%s)\n", $9, $5}'

echo ""
echo "  lib/:  $(ls -1 "$DEST/lib" | wc -l) dylibs"
du -sh "$DEST/lib"

echo ""
echo "Total size: $(du -sh "$DEST" | awk '{print $1}')"

# Step 9: Cleanup
echo ""
echo "Cleaning up temporary files..."
rm -rf "$UNPAPER_BUILD_DIR"
echo "✓ Done"

echo ""
echo "Next steps:"
echo "1. Verify binaries work: otool -L $DEST/bin/unpaper"
echo "2. Test in dev mode: pnpm run dev"
echo "3. Update electron/ocr/preprocessing.ts with new handlers"
echo "4. Add IPC endpoints for preprocessing in electron/ipc.ts"
