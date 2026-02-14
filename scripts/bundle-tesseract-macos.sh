#!/bin/bash
# Bundle Tesseract and dependencies for macOS
# Makes binaries relocatable using @executable_path and @loader_path
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
echo "Bundling Tesseract for $PLATFORM_ARCH..."
echo "Homebrew prefix: $BREW"

# Create directories
mkdir -p "$DEST/bin" "$DEST/lib"

# Clean previous build
rm -f "$DEST/bin/"* "$DEST/lib/"*

echo "Copying binaries and libraries..."

# Copy tesseract binary
cp "$BREW/bin/tesseract" "$DEST/bin/"

# Copy all required dylibs
# Core libraries
cp "$BREW/opt/tesseract/lib/libtesseract.5.dylib" "$DEST/lib/"
cp "$BREW/opt/leptonica/lib/libleptonica.6.dylib" "$DEST/lib/"
cp "$BREW/opt/libarchive/lib/libarchive.13.dylib" "$DEST/lib/"

# Leptonica dependencies (image formats)
cp "$BREW/opt/libpng/lib/libpng16.16.dylib" "$DEST/lib/"
cp "$BREW/opt/jpeg-turbo/lib/libjpeg.8.dylib" "$DEST/lib/"
cp "$BREW/opt/giflib/lib/libgif.dylib" "$DEST/lib/"
cp "$BREW/opt/libtiff/lib/libtiff.6.dylib" "$DEST/lib/"
cp "$BREW/opt/webp/lib/libwebp.7.dylib" "$DEST/lib/"
cp "$BREW/opt/webp/lib/libwebpmux.3.dylib" "$DEST/lib/"
cp "$BREW/opt/webp/lib/libsharpyuv.0.dylib" "$DEST/lib/"
cp "$BREW/opt/openjpeg/lib/libopenjp2.7.dylib" "$DEST/lib/"

# libarchive dependencies (compression)
cp "$BREW/opt/xz/lib/liblzma.5.dylib" "$DEST/lib/"
cp "$BREW/opt/zstd/lib/libzstd.1.dylib" "$DEST/lib/"
cp "$BREW/opt/lz4/lib/liblz4.1.dylib" "$DEST/lib/"
cp "$BREW/opt/libb2/lib/libb2.1.dylib" "$DEST/lib/"

echo "Fixing library paths..."

# Helper function to fix a library's dependencies
fix_lib() {
  local lib="$1"
  local lib_name="$(basename "$lib")"

  # Set the library's own ID to use @loader_path
  install_name_tool -id "@loader_path/$lib_name" "$lib" 2>/dev/null || true

  # Fix all Homebrew dependencies to use @loader_path
  local brew_deps
  brew_deps="$(otool -L "$lib" | grep "$BREW" | awk '{print $1}')" || true
  for dep in $brew_deps; do
    local dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done

  # Fix @rpath references to use @loader_path
  local rpath_deps
  rpath_deps="$(otool -L "$lib" | grep "@rpath" | awk '{print $1}')" || true
  for dep in $rpath_deps; do
    local dep_name="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$dep_name" "$lib" 2>/dev/null || true
  done
}

# Fix all libraries
for lib in "$DEST/lib/"*.dylib; do
  echo "  Fixing $(basename "$lib")..."
  fix_lib "$lib"
done

echo "Fixing tesseract binary..."

# Fix the tesseract binary to use @executable_path/../lib/
TESS_DEPS="$(otool -L "$DEST/bin/tesseract" | grep "$BREW" | awk '{print $1}')" || true
for dep in $TESS_DEPS; do
  dep_name="$(basename "$dep")"
  install_name_tool -change "$dep" "@executable_path/../lib/$dep_name" "$DEST/bin/tesseract"
done

echo "Verifying..."

# Verify tesseract binary
echo ""
echo "=== tesseract binary dependencies ==="
otool -L "$DEST/bin/tesseract"

# Verify one library
echo ""
echo "=== libtesseract.5.dylib dependencies ==="
otool -L "$DEST/lib/libtesseract.5.dylib"

# Ad-hoc codesign for local testing
echo ""
echo "=== Codesigning (ad-hoc) ==="
codesign --force --sign - "$DEST/bin/tesseract" "$DEST/lib/"*.dylib

# Test run
echo ""
echo "=== Testing binary ==="
"$DEST/bin/tesseract" --version

echo ""
echo "Done! Tesseract bundled to $DEST"
echo ""
echo "Files:"
ls -la "$DEST/bin/"
ls -la "$DEST/lib/"
