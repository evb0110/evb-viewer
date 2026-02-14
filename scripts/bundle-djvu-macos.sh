#!/bin/bash
# Bundle DjVuLibre tools (ddjvu, djvused) for macOS
# Copies from Homebrew, fixes dylib paths, ad-hoc codesigns
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64" ;;
  x86_64) PLATFORM_ARCH="darwin-x64" ;;
  *)      echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

DEST="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"

echo "=========================================="
echo "Bundling DjVuLibre for $PLATFORM_ARCH"
echo "=========================================="

# Check for Homebrew
if ! command -v brew &> /dev/null; then
  echo "Error: Homebrew is required. Install from https://brew.sh"
  exit 1
fi

# Install/update djvulibre
echo ""
echo "Installing/updating djvulibre via Homebrew..."
brew install djvulibre || brew upgrade djvulibre || true

BREW_PREFIX="$(brew --prefix)"

# Create directories
mkdir -p "$DEST/bin" "$DEST/lib"

# Clean previous build
rm -f "$DEST/bin/"* "$DEST/lib/"*

# ==========================================
# Copy binaries
# ==========================================
echo ""
echo "Copying binaries..."

for tool in ddjvu djvused; do
  if [ -f "$BREW_PREFIX/bin/$tool" ]; then
    cp "$BREW_PREFIX/bin/$tool" "$DEST/bin/"
    echo "  Copied $tool"
  else
    echo "  Error: $tool not found at $BREW_PREFIX/bin/$tool"
    exit 1
  fi
done

# ==========================================
# Copy libraries
# ==========================================
echo ""
echo "Copying libraries..."

DJVU_OPT="$BREW_PREFIX/opt/djvulibre"

# Core DjVuLibre library
cp "$DJVU_OPT/lib/libdjvulibre.21.dylib" "$DEST/lib/"
echo "  Copied libdjvulibre.21.dylib"

# DjVuLibre dependencies
DEPS=(
  "jpeg-turbo/lib/libjpeg.8.dylib"
  "xz/lib/liblzma.5.dylib"
  "libtiff/lib/libtiff.6.dylib"
  "zstd/lib/libzstd.1.dylib"
)

for dep in "${DEPS[@]}"; do
  lib_path="$BREW_PREFIX/opt/$dep"
  if [ -f "$lib_path" ]; then
    lib_name="$(basename "$lib_path")"
    cp "$lib_path" "$DEST/lib/"
    echo "  Copied $lib_name"
  else
    echo "  Warning: Not found: $lib_path"
  fi
done

# ==========================================
# Fix library paths
# ==========================================
echo ""
echo "Fixing library paths..."

# Fix all libraries: set ID and rewrite Homebrew references
for lib in "$DEST/lib/"*.dylib; do
  lib_name="$(basename "$lib")"

  # Set the library's own ID
  install_name_tool -id "@loader_path/$lib_name" "$lib" 2>/dev/null || true

  # Fix Homebrew dependencies to use @loader_path
  brew_deps="$(otool -L "$lib" | grep "$BREW_PREFIX" | awk '{print $1}')" || true
  for dep in $brew_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done

  # Fix @rpath references
  rpath_deps="$(otool -L "$lib" | grep "@rpath" | awk '{print $1}')" || true
  for dep in $rpath_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done

  echo "  Fixed $lib_name"
done

# Fix binaries: point to ../lib/
echo ""
echo "Fixing binary paths..."
for bin in "$DEST/bin/"*; do
  bin_name="$(basename "$bin")"

  brew_deps="$(otool -L "$bin" | grep "$BREW_PREFIX" | awk '{print $1}')" || true
  for dep in $brew_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin"
  done

  rpath_deps="$(otool -L "$bin" | grep "@rpath" | awk '{print $1}')" || true
  for dep in $rpath_deps; do
    dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$bin"
  done

  echo "  Fixed $bin_name"
done

# ==========================================
# Codesign
# ==========================================
echo ""
echo "Codesigning (ad-hoc)..."

codesign --force --sign - "$DEST/bin/"* "$DEST/lib/"*.dylib
echo "  Done"

# ==========================================
# Verify
# ==========================================
echo ""
echo "=========================================="
echo "Verification"
echo "=========================================="

echo ""
echo "ddjvu dependencies:"
otool -L "$DEST/bin/ddjvu"

echo ""
echo "djvused dependencies:"
otool -L "$DEST/bin/djvused"

echo ""
echo "libdjvulibre dependencies:"
otool -L "$DEST/lib/libdjvulibre.21.dylib"

# Test run
echo ""
echo "Testing ddjvu..."
if "$DEST/bin/ddjvu" --help > /dev/null 2>&1; then
  echo "  ddjvu runs successfully"
else
  echo "  Warning: ddjvu test failed — check dependencies above"
fi

echo ""
echo "Files:"
ls -lh "$DEST/bin/"
echo ""
ls -lh "$DEST/lib/"

echo ""
echo "Total size: $(du -sh "$DEST" | awk '{print $1}')"
echo ""
echo "Done!"
