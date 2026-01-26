#!/bin/bash
# Bundle Poppler and qpdf binaries for macOS
# These are required for PDF rendering and manipulation
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

POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"

echo "=========================================="
echo "Bundling PDF tools for $PLATFORM_ARCH"
echo "=========================================="

# Check for Homebrew
if ! command -v brew &> /dev/null; then
    echo "Error: Homebrew is required. Install from https://brew.sh"
    exit 1
fi

# Install/update poppler and qpdf via Homebrew
echo ""
echo "Installing/updating poppler and qpdf via Homebrew..."
brew install poppler qpdf || brew upgrade poppler qpdf || true

# Get Homebrew prefix (handles both Intel and Apple Silicon)
BREW_PREFIX="$(brew --prefix)"

echo ""
echo "=========================================="
echo "Bundling Poppler binaries..."
echo "=========================================="

mkdir -p "$POPPLER_DIR/bin"
mkdir -p "$POPPLER_DIR/lib"

# Find poppler binaries
POPPLER_BIN="$BREW_PREFIX/bin"
POPPLER_LIB="$BREW_PREFIX/lib"

# Copy binaries
for tool in pdftoppm pdftotext pdfinfo pdfimages; do
    if [ -f "$POPPLER_BIN/$tool" ]; then
        echo "  Copying $tool..."
        cp "$POPPLER_BIN/$tool" "$POPPLER_DIR/bin/"
    else
        echo "  Warning: $tool not found"
    fi
done

# Copy required libraries for Poppler
echo ""
echo "Copying Poppler libraries..."

# Function to copy library and its dependencies
copy_lib_with_deps() {
    local lib="$1"
    local dest="$2"
    local lib_name
    lib_name="$(basename "$lib")"

    if [ ! -f "$dest/$lib_name" ] && [ -f "$lib" ]; then
        cp "$lib" "$dest/"
        echo "    Copied: $lib_name"
    fi
}

# Core poppler library
for lib in "$POPPLER_LIB"/libpoppler*.dylib; do
    [ -f "$lib" ] && copy_lib_with_deps "$lib" "$POPPLER_DIR/lib"
done

# Dependencies
DEPS=(
    "libfreetype.6.dylib"
    "libfontconfig.1.dylib"
    "libjpeg.8.dylib"
    "libpng16.16.dylib"
    "libtiff.6.dylib"
    "liblcms2.2.dylib"
    "libopenjp2.7.dylib"
    "libnss3.dylib"
    "libnspr4.dylib"
    "libexpat.1.dylib"
    "libiconv.2.dylib"
    "libintl.8.dylib"
)

for dep in "${DEPS[@]}"; do
    lib_path="$POPPLER_LIB/$dep"
    if [ -f "$lib_path" ]; then
        copy_lib_with_deps "$lib_path" "$POPPLER_DIR/lib"
    fi
done

# Fix library paths using install_name_tool
echo ""
echo "Fixing library paths..."
for bin in "$POPPLER_DIR/bin"/*; do
    if [ -f "$bin" ]; then
        # Change rpath to look in ../lib
        install_name_tool -add_rpath "@executable_path/../lib" "$bin" 2>/dev/null || true

        # Update library references
        for lib in "$POPPLER_DIR/lib"/*.dylib; do
            lib_name="$(basename "$lib")"
            install_name_tool -change "$POPPLER_LIB/$lib_name" "@rpath/$lib_name" "$bin" 2>/dev/null || true
            install_name_tool -change "$BREW_PREFIX/opt/poppler/lib/$lib_name" "@rpath/$lib_name" "$bin" 2>/dev/null || true
        done
    fi
done

echo ""
echo "=========================================="
echo "Bundling qpdf..."
echo "=========================================="

mkdir -p "$QPDF_DIR/bin"
mkdir -p "$QPDF_DIR/lib"

# Copy qpdf binary
if [ -f "$BREW_PREFIX/bin/qpdf" ]; then
    echo "  Copying qpdf..."
    cp "$BREW_PREFIX/bin/qpdf" "$QPDF_DIR/bin/"
else
    echo "Error: qpdf not found"
    exit 1
fi

# Copy qpdf libraries
for lib in "$POPPLER_LIB"/libqpdf*.dylib; do
    [ -f "$lib" ] && copy_lib_with_deps "$lib" "$QPDF_DIR/lib"
done

# qpdf dependencies
QPDF_DEPS=(
    "libjpeg.8.dylib"
    "libz.1.dylib"
    "libssl.3.dylib"
    "libcrypto.3.dylib"
)

for dep in "${QPDF_DEPS[@]}"; do
    lib_path="$POPPLER_LIB/$dep"
    if [ -f "$lib_path" ]; then
        copy_lib_with_deps "$lib_path" "$QPDF_DIR/lib"
    fi
done

# Fix qpdf library paths
echo ""
echo "Fixing qpdf library paths..."
for bin in "$QPDF_DIR/bin"/*; do
    if [ -f "$bin" ]; then
        install_name_tool -add_rpath "@executable_path/../lib" "$bin" 2>/dev/null || true

        for lib in "$QPDF_DIR/lib"/*.dylib; do
            lib_name="$(basename "$lib")"
            install_name_tool -change "$POPPLER_LIB/$lib_name" "@rpath/$lib_name" "$bin" 2>/dev/null || true
            install_name_tool -change "$BREW_PREFIX/opt/qpdf/lib/$lib_name" "@rpath/$lib_name" "$bin" 2>/dev/null || true
        done
    fi
done

echo ""
echo "=========================================="
echo "Verifying bundles..."
echo "=========================================="

echo ""
echo "Poppler:"
for tool in pdftoppm pdftotext; do
    if [ -f "$POPPLER_DIR/bin/$tool" ]; then
        echo "  ✓ $tool ($(du -h "$POPPLER_DIR/bin/$tool" | awk '{print $1}'))"
    else
        echo "  ✗ $tool NOT FOUND"
    fi
done

echo ""
echo "qpdf:"
if [ -f "$QPDF_DIR/bin/qpdf" ]; then
    echo "  ✓ qpdf ($(du -h "$QPDF_DIR/bin/qpdf" | awk '{print $1}'))"
else
    echo "  ✗ qpdf NOT FOUND"
fi

echo ""
echo "=========================================="
echo "Bundle complete!"
echo "=========================================="
echo ""
echo "Poppler: $POPPLER_DIR"
echo "qpdf:    $QPDF_DIR"
echo ""
echo "Total size:"
du -sh "$POPPLER_DIR" "$QPDF_DIR" 2>/dev/null || true
