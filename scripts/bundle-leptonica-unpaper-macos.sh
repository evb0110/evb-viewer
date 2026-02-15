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

# Step 3: Resolve and bundle dependencies recursively
echo ""
echo "=========================================="
echo "Resolving and fixing dylib dependencies..."
echo "=========================================="

copy_deps_recursive() {
  local dest_lib="$1"
  shift
  local files=("$@")
  local added=1

  while [ "$added" -gt 0 ]; do
    added=0
    for file in "${files[@]}"; do
      [ -f "$file" ] || continue
      local deps
      deps="$(otool -L "$file" 2>/dev/null | awk 'NR > 1 {print $1}' || true)"
      for dep in $deps; do
        case "$dep" in
          /usr/lib/*|/System/*)
            continue
            ;;
        esac

        local dep_name
        dep_name="$(basename "$dep")"

        local dep_source=""
        if [[ "$dep" == "$BREW/"* ]] && [ -f "$dep" ]; then
          dep_source="$dep"
        else
          dep_source="$(find "$BREW" -type f -name "$dep_name" -print -quit 2>/dev/null || true)"
        fi

        if [ -z "$dep_source" ]; then
          continue
        fi

        if [ ! -f "$dest_lib/$dep_name" ]; then
          cp -L "$dep_source" "$dest_lib/$dep_name"
          echo "  Added dependency: $dep_name"
          files+=("$dest_lib/$dep_name")
          added=1
        fi
      done
    done
  done
}

fix_lib_paths() {
  local lib="$1"
  local lib_name
  lib_name="$(basename "$lib")"

  install_name_tool -id "@loader_path/$lib_name" "$lib" 2>/dev/null || true

  local brew_deps
  brew_deps="$(otool -L "$lib" 2>/dev/null | grep "$BREW/" | awk '{print $1}' || true)"
  for dep in $brew_deps; do
    local dep_name
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done

  local rpath_deps
  rpath_deps="$(otool -L "$lib" 2>/dev/null | grep "@rpath" | awk '{print $1}' || true)"
  for dep in $rpath_deps; do
    local dep_name
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done
}

fix_bin_paths() {
  local bin="$1"

  local brew_deps
  brew_deps="$(otool -L "$bin" 2>/dev/null | grep "$BREW/" | awk '{print $1}' || true)"
  for dep in $brew_deps; do
    local dep_name
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin" 2>/dev/null || true
  done

  local rpath_deps
  rpath_deps="$(otool -L "$bin" 2>/dev/null | grep "@rpath" | awk '{print $1}' || true)"
  for dep in $rpath_deps; do
    local dep_name
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin" 2>/dev/null || true
  done
}

copy_deps_recursive "$DEST/lib" "$DEST/bin/unpaper" "$DEST/lib/"*.dylib

for lib in "$DEST/lib/"*.dylib; do
  [ -f "$lib" ] || continue
  fix_lib_paths "$lib"
done
fix_bin_paths "$DEST/bin/unpaper"

# Run one more pass after rewriting to catch newly-visible deps.
copy_deps_recursive "$DEST/lib" "$DEST/bin/unpaper" "$DEST/lib/"*.dylib

for lib in "$DEST/lib/"*.dylib; do
  [ -f "$lib" ] || continue
  fix_lib_paths "$lib"
done
fix_bin_paths "$DEST/bin/unpaper"

unresolved="$(otool -L "$DEST/bin/unpaper" 2>/dev/null | grep "$BREW/" || true)"
if [ -n "$unresolved" ]; then
  echo "Error: Unresolved Homebrew references remain in unpaper:"
  echo "$unresolved" | sed 's/^/  /'
  exit 1
fi

echo "✓ All unpaper dependencies are bundled and relinked"

# Step 6: Codesign binaries
echo ""
echo "=========================================="
echo "Codesigning for local testing..."
echo "=========================================="

codesign --force --sign - "$DEST/lib/"*.dylib "$DEST/bin/unpaper" 2>/dev/null || echo "Note: Codesigning not available in this environment"
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
