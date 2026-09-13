#!/bin/bash
# Bundle Tesseract and dependencies for macOS
# Makes binaries relocatable using @executable_path and @loader_path
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/lib/macos-dylib-bundle.sh"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64"; BREW="/opt/homebrew" ;;
  x86_64) PLATFORM_ARCH="darwin-x64"; BREW="/usr/local" ;;
  *)      echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Fetch the published archives for this target. Exit code 3 means the target
# has none yet, so the source build below still produces its tools.
# EVB_RUNTIME_BINARIES_FROM_SOURCE=1 skips the fetch to rebuild the archives.
if [ "${EVB_RUNTIME_BINARIES_FROM_SOURCE:-0}" != 1 ]; then
  fetch_status=0
  node --import tsx "$SCRIPT_DIR/fetchRuntimeBinaries.ts" --target "$PLATFORM_ARCH" || fetch_status=$?
  if [ "$fetch_status" -eq 0 ]; then
    exit 0
  elif [ "$fetch_status" -ne 3 ]; then
    exit "$fetch_status"
  fi
fi

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

# Seed with the direct libraries expected by the bundled tesseract binary.
cp -L "$BREW/opt/tesseract/lib/libtesseract.5.dylib" "$DEST/lib/"
cp -L "$BREW/opt/leptonica/lib/libleptonica.6.dylib" "$DEST/lib/"
cp -L "$BREW/opt/libarchive/lib/libarchive.13.dylib" "$DEST/lib/"

# Homebrew formulas gain transitive dependencies over time. Copy the closure so
# signed app smoke tests catch missing dylibs before release packaging does.
macos_bundle_dylib_closure "$DEST/lib" "$BREW" "$DEST/bin/tesseract"

echo "Fixing library paths..."
echo "  Shared dependency closure copied, relocated, and verified"

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
