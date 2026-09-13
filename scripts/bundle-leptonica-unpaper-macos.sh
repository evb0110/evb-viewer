#!/bin/bash
# Bundle Leptonica and minimal Unpaper for macOS
# Prerequisites: Tesseract already bundled, build tools, Meson, pkg-config, and sphinx-doc
# Usage: ./scripts/bundle-leptonica-unpaper-macos.sh
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
UNPAPER_TAG="unpaper-7.0.0"
UNPAPER_COMMIT="5211a623d48858eae154213a61bccbc368b19ca0"

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

if ! command -v sphinx-build &> /dev/null && command -v brew &> /dev/null; then
  SPHINX_BIN="$(brew --prefix sphinx-doc 2>/dev/null || true)/bin"
  if [ -x "$SPHINX_BIN/sphinx-build" ]; then
    export PATH="$SPHINX_BIN:$PATH"
  fi
fi

if ! command -v sphinx-build &> /dev/null; then
  echo "Error: sphinx-build is required. Install with: brew install sphinx-doc"
  echo "If Homebrew leaves sphinx-doc keg-only, add its bin directory to PATH."
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
FFMPEG_INSTALL_DIR="$UNPAPER_BUILD_DIR/ffmpeg-install"

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

git fetch --tags origin "$UNPAPER_TAG"

echo "Checking out pinned unpaper release: $UNPAPER_TAG ($UNPAPER_COMMIT)"
git checkout "$UNPAPER_TAG"
ACTUAL_UNPAPER_COMMIT="$(git rev-parse HEAD)"
if [ "$ACTUAL_UNPAPER_COMMIT" != "$UNPAPER_COMMIT" ]; then
  echo "Error: Pinned unpaper tag resolved to $ACTUAL_UNPAPER_COMMIT, expected $UNPAPER_COMMIT"
  exit 1
fi

# Unpaper 7 requires libavformat/libavcodec/libavutil, but the Homebrew FFmpeg
# closure includes dozens of unrelated video codecs. Build only the PNM
# reader/writer surface used by OCR preprocessing.
"$SCRIPT_DIR/build-minimal-ffmpeg-for-unpaper.sh" "$UNPAPER_BUILD_DIR/ffmpeg-build" "$FFMPEG_INSTALL_DIR"
export PKG_CONFIG_PATH="$FFMPEG_INSTALL_DIR/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LDFLAGS="-Wl,-rpath,$FFMPEG_INSTALL_DIR/lib ${LDFLAGS:-}"

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

mkdir -p "$DEST/lib"
for ffmpeg_library_name in libavcodec libavformat libavutil; do
  ffmpeg_lib="$(find "$FFMPEG_INSTALL_DIR/lib" -maxdepth 1 \( -type f -o -type l \) \
    -name "${ffmpeg_library_name}.*.dylib" -print \
    | awk -F/ -v name="$ffmpeg_library_name" '$NF ~ ("^" name "\\.[0-9]+\\.dylib$") {print; exit}')"
  if [ -z "$ffmpeg_lib" ]; then
    echo "Error: Minimal FFmpeg did not install a canonical $ffmpeg_library_name SONAME"
    exit 1
  fi
  cp -L "$ffmpeg_lib" "$DEST/lib/$(basename "$ffmpeg_lib")"
done

# Step 3: Resolve and bundle dependencies recursively
echo ""
echo "=========================================="
echo "Resolving and fixing dylib dependencies..."
echo "=========================================="

macos_bundle_dylib_closure "$DEST/lib" "$BREW" "$DEST/bin/unpaper"

unresolved="$(otool -L "$DEST/bin/unpaper" 2>/dev/null | grep -E "$BREW/|$FFMPEG_INSTALL_DIR/" || true)"
if [ -n "$unresolved" ]; then
  echo "Error: Unresolved Homebrew references remain in unpaper:"
  echo "$unresolved" | sed 's/^/  /'
  exit 1
fi

unexpected_ffmpeg_closure="$(find "$DEST/lib" -maxdepth 1 -type f \
  \( -name 'libav*' -o -name 'libx26*' -o -name 'libaom*' -o -name 'libSvt*' \
     -o -name 'librav1e*' -o -name 'libvpx*' -o -name 'libdav1d*' -o -name 'libvmaf*' \) \
  ! -name 'libavcodec.*.dylib' ! -name 'libavformat.*.dylib' ! -name 'libavutil.*.dylib' -print)"
if [ -n "$unexpected_ffmpeg_closure" ]; then
  echo "Error: Unexpected video-codec closure leaked into the unpaper bundle:"
  echo "$unexpected_ffmpeg_closure" | sed 's/^/  /'
  exit 1
fi

linked_av_libraries="$(otool -L "$DEST/bin/unpaper" 2>/dev/null | awk 'NR > 1 {print $1}' | xargs -n1 basename | grep '^libav' || true)"
for required_av_library in libavcodec libavformat libavutil; do
  if ! echo "$linked_av_libraries" | grep -q "^${required_av_library}\."; then
    echo "Error: Minimal unpaper is missing required $required_av_library linkage"
    exit 1
  fi
done

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
  echo "Error: Unpaper failed to run. Check dylib dependencies above."
  otool -L "$DEST/bin/unpaper"
  exit 1
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
echo "3. Update electron/features/ocr/worker/tryPreprocessOcrImage.ts with new handlers"
echo "4. Add IPC endpoints for preprocessing in electron/platform-ipc/registerIpcHandlers.ts"
