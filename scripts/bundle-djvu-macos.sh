#!/bin/bash
# Bundle DjVuLibre tools (ddjvu, djvused, djvudump) for macOS
# Copies from Homebrew, fixes dylib paths, ad-hoc codesigns
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="${EVB_DJVU_RESOURCES_DIR:-$PROJECT_ROOT/resources}"
source "$SCRIPT_DIR/lib/macos-dylib-bundle.sh"

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PLATFORM_ARCH="darwin-arm64" ;;
  x86_64) PLATFORM_ARCH="darwin-x64" ;;
  *)      echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
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

DEST="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"

echo "=========================================="
echo "Bundling DjVuLibre for $PLATFORM_ARCH"
echo "=========================================="

# Check for Homebrew
if ! command -v brew &> /dev/null; then
  echo "Error: Homebrew is required. Install from https://brew.sh"
  exit 1
fi

for required_command in otool install_name_tool codesign; do
  if ! command -v "$required_command" &> /dev/null; then
    echo "Error: Required macOS bundling command not found: $required_command"
    exit 1
  fi
done

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

for tool in ddjvu djvused djvudump; do
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
cp -L "$DJVU_OPT/lib/libdjvulibre.21.dylib" "$DEST/lib/"
echo "  Copied libdjvulibre.21.dylib"

# Homebrew formulas gain and lose transitive dependencies independently of
# DjVuLibre. Derive the complete non-system closure from the installed Mach-O
# files instead of maintaining another formula snapshot here.
macos_bundle_dylib_closure "$DEST/lib" "$BREW_PREFIX" "$DEST/bin/"*

# ==========================================
# Fix library paths
# ==========================================
echo ""
echo "Fixing library paths..."

echo "  Shared dependency closure copied, relocated, and verified"

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
echo "djvudump dependencies:"
otool -L "$DEST/bin/djvudump"

echo ""
echo "libdjvulibre dependencies:"
otool -L "$DEST/lib/libdjvulibre.21.dylib"

# Test run
echo ""
echo "Testing ddjvu..."
smoke_output="$(mktemp)"
smoke_exit_code=0
if "$DEST/bin/ddjvu" --help > "$smoke_output" 2>&1; then
  smoke_exit_code=0
else
  smoke_exit_code=$?
fi
if node "$PROJECT_ROOT/scripts/release/assert-packaged-tool-smoke.mjs" \
  ddjvu "$smoke_exit_code" "$smoke_output"; then
  rm -f "$smoke_output"
  echo "  ddjvu runs successfully"
else
  cat "$smoke_output"
  rm -f "$smoke_output"
  echo "Error: Bundled ddjvu failed its smoke test"
  exit 1
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
