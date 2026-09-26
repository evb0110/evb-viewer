#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET="darwin-arm64"
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/tesseract-macos-XXXXXX")"
BREW_PREFIX="$(brew --prefix)"
LEPTONICA_VERSION="1.82.0"
LEPTONICA_SHA256="40fa9ac1e815b91e0fa73f0737e60c9eec433a95fa123f95f2573dd3127dd669"
GIFLIB_VERSION="5.2.2"
GIFLIB_SHA256="be7ffbd057cadebe2aa144542fd90c6838c6a083b5e8a9048b8ee3b66b29d5fb"
TESSERACT_VERSION="5.5.3"
TESSERACT_SHA256="9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884"
TESSERACT_DIR="$PROJECT_ROOT/resources/tesseract/$TARGET"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

if [ "$(uname -m)" != arm64 ]; then
  echo "Error: Tesseract release binaries must be built on Apple Silicon." >&2
  exit 1
fi

brew install gnu-tar jpeg-turbo libpng libtiff webp openjpeg
OPENJPEG_LIBDIR="$(pkg-config --variable=libdir libopenjp2)"
curl -fsSL -o "$BUILD_DIR/giflib.tar.gz" \
  "https://sourceforge.net/projects/giflib/files/giflib-$GIFLIB_VERSION.tar.gz/download"
curl -fsSL -o "$BUILD_DIR/leptonica.tar.gz" \
  "https://github.com/DanBloomberg/leptonica/archive/refs/tags/$LEPTONICA_VERSION.tar.gz"
curl -fsSL -o "$BUILD_DIR/tesseract.tar.gz" \
  "https://github.com/tesseract-ocr/tesseract/archive/refs/tags/$TESSERACT_VERSION.tar.gz"
echo "$GIFLIB_SHA256  $BUILD_DIR/giflib.tar.gz" | shasum -a 256 -c -
echo "$LEPTONICA_SHA256  $BUILD_DIR/leptonica.tar.gz" | shasum -a 256 -c -
echo "$TESSERACT_SHA256  $BUILD_DIR/tesseract.tar.gz" | shasum -a 256 -c -
tar -xzf "$BUILD_DIR/giflib.tar.gz" -C "$BUILD_DIR"
tar -xzf "$BUILD_DIR/leptonica.tar.gz" -C "$BUILD_DIR"
tar -xzf "$BUILD_DIR/tesseract.tar.gz" -C "$BUILD_DIR"

make -C "$BUILD_DIR/giflib-$GIFLIB_VERSION" libgif.a
mkdir -p "$BUILD_DIR/giflib-install/include" "$BUILD_DIR/giflib-install/lib"
cp "$BUILD_DIR/giflib-$GIFLIB_VERSION/gif_lib.h" "$BUILD_DIR/giflib-install/include/"
cp "$BUILD_DIR/giflib-$GIFLIB_VERSION/libgif.a" "$BUILD_DIR/giflib-install/lib/"
cmake -S "$BUILD_DIR/leptonica-$LEPTONICA_VERSION" -B "$BUILD_DIR/leptonica-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-I$BREW_PREFIX/include/libpng16" \
  -DCMAKE_EXE_LINKER_FLAGS="-L$OPENJPEG_LIBDIR" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DGIF_INCLUDE_DIR="$BUILD_DIR/giflib-install/include" \
  -DGIF_LIBRARY="$BUILD_DIR/giflib-install/lib/libgif.a" \
  -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/leptonica-install" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_PROG=OFF
cmake --build "$BUILD_DIR/leptonica-build" --parallel "$(sysctl -n hw.logicalcpu)"
cmake --install "$BUILD_DIR/leptonica-build"
cmake -S "$BUILD_DIR/tesseract-$TESSERACT_VERSION" -B "$BUILD_DIR/tesseract-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS="-L$OPENJPEG_LIBDIR" \
  -DCMAKE_PREFIX_PATH="$BUILD_DIR/leptonica-install" \
  -DLeptonica_DIR="$BUILD_DIR/leptonica-install/lib/cmake/leptonica" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TRAINING_TOOLS=OFF \
  -DBUILD_TESTS=OFF \
  -DDISABLE_ARCHIVE=ON \
  -DDISABLE_CURL=ON \
  -DOPENMP_BUILD=OFF \
  -DGRAPHICS_DISABLED=ON
cmake --build "$BUILD_DIR/tesseract-build" --parallel "$(sysctl -n hw.logicalcpu)" --target tesseract

rm -rf "$TESSERACT_DIR"
mkdir -p "$TESSERACT_DIR/bin" "$TESSERACT_DIR/lib"
cp "$BUILD_DIR/tesseract-build/bin/tesseract" "$TESSERACT_DIR/bin/"
source "$SCRIPT_DIR/lib/macos-dylib-bundle.sh"
macos_bundle_dylib_closure "$TESSERACT_DIR/lib" "$BREW_PREFIX" "$TESSERACT_DIR/bin/tesseract"
"$TESSERACT_DIR/bin/tesseract" --version
