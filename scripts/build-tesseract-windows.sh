#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET_ARCH="${TARGET_ARCH:-x64}"
case "$TARGET_ARCH" in
  x64) target=win32-x64; triplet=x64-windows-static; vs_arch=x64 ;;
  arm64) target=win32-arm64; triplet=arm64-windows-static; vs_arch=ARM64 ;;
  *) echo "Error: Unsupported Windows architecture: $TARGET_ARCH" >&2; exit 2 ;;
esac
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/tesseract-windows-XXXXXX")"
LEPTONICA_VERSION="1.82.0"
LEPTONICA_SHA256="40fa9ac1e815b91e0fa73f0737e60c9eec433a95fa123f95f2573dd3127dd669"
TESSERACT_VERSION="5.5.3"
TESSERACT_SHA256="9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884"
VCPKG_COMMIT="11ace808cc8a3a941f386e33726b992b22ba9e5a"
VCPKG_ROOT="$BUILD_DIR/vcpkg"
TESSERACT_DIR="$PROJECT_ROOT/resources/tesseract/$target"
VCPKG_LIB_DIR="$(cygpath -m "$VCPKG_ROOT/installed/$triplet/lib")"
WEBP_LIBRARIES="$VCPKG_LIB_DIR/libwebp.lib;$VCPKG_LIB_DIR/libsharpyuv.lib"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

git clone --quiet --filter=blob:none https://github.com/microsoft/vcpkg.git "$VCPKG_ROOT"
git -C "$VCPKG_ROOT" checkout --quiet "$VCPKG_COMMIT"
bootstrap_script="$(cygpath -w "$VCPKG_ROOT/bootstrap-vcpkg.bat")"
MSYS2_ARG_CONV_EXCL='/c' cmd.exe /c "$bootstrap_script -disableMetrics"
"$VCPKG_ROOT/vcpkg.exe" install \
  giflib \
  libjpeg-turbo \
  libpng \
  tiff \
  zlib \
  libwebp \
  openjpeg \
  --triplet "$triplet"

curl -fsSL -o "$BUILD_DIR/leptonica.tar.gz" \
  "https://github.com/DanBloomberg/leptonica/archive/refs/tags/$LEPTONICA_VERSION.tar.gz"
curl -fsSL -o "$BUILD_DIR/tesseract.tar.gz" \
  "https://github.com/tesseract-ocr/tesseract/archive/refs/tags/$TESSERACT_VERSION.tar.gz"
echo "$LEPTONICA_SHA256  $BUILD_DIR/leptonica.tar.gz" | sha256sum -c -
echo "$TESSERACT_SHA256  $BUILD_DIR/tesseract.tar.gz" | sha256sum -c -
tar -xzf "$BUILD_DIR/leptonica.tar.gz" -C "$BUILD_DIR"
tar -xzf "$BUILD_DIR/tesseract.tar.gz" -C "$BUILD_DIR"

cmake -S "$BUILD_DIR/leptonica-$LEPTONICA_VERSION" -B "$BUILD_DIR/leptonica-build" \
  -G "Visual Studio 18 2026" \
  -A "$vs_arch" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DSW_BUILD=OFF \
  "-DWEBP_LIBRARY=$WEBP_LIBRARIES" \
  -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/leptonica-install" \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_TARGET_TRIPLET="$triplet" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_PROG=OFF
cmake --build "$BUILD_DIR/leptonica-build" --config Release --parallel
cmake --install "$BUILD_DIR/leptonica-build" --config Release
cmake -S "$BUILD_DIR/tesseract-$TESSERACT_VERSION" -B "$BUILD_DIR/tesseract-build" \
  -G "Visual Studio 18 2026" \
  -A "$vs_arch" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$BUILD_DIR/leptonica-install" \
  -DLeptonica_DIR="$BUILD_DIR/leptonica-install/lib/cmake/leptonica" \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_TARGET_TRIPLET="$triplet" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TRAINING_TOOLS=OFF \
  -DBUILD_TESTS=OFF \
  -DDISABLE_ARCHIVE=ON \
  -DDISABLE_CURL=ON \
  -DOPENMP_BUILD=OFF \
  -DGRAPHICS_DISABLED=ON
cmake --build "$BUILD_DIR/tesseract-build" --config Release --parallel --target tesseract
cmake --install "$BUILD_DIR/tesseract-build" --config Release --prefix "$BUILD_DIR/tesseract-install"

rm -rf "$TESSERACT_DIR"
mkdir -p "$TESSERACT_DIR/bin"
cp "$BUILD_DIR/tesseract-install/bin/tesseract.exe" "$TESSERACT_DIR/bin/"
"$TESSERACT_DIR/bin/tesseract.exe" --version
