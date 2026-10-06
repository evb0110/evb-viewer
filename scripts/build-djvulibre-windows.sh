#!/usr/bin/env bash
set -euo pipefail

# Cross-builds ddjvu, djvused and djvudump for Windows as self-contained
# static executables from pinned sources, with the monitor ownership fix in
# scripts/patches (#991). Runs on Linux x64 or macOS.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TARGET="${1:-}"
case "$TARGET" in
  win32-x64) HOST=x86_64-w64-mingw32; MACHINE=x64; CMAKE_PROCESSOR=AMD64 ;;
  win32-arm64) HOST=aarch64-w64-mingw32; MACHINE=arm64; CMAKE_PROCESSOR=ARM64 ;;
  *) echo "Usage: scripts/build-djvulibre-windows.sh <win32-x64|win32-arm64>" >&2; exit 2 ;;
esac

LLVM_MINGW_VERSION=20260922
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    LLVM_MINGW_NAME="llvm-mingw-$LLVM_MINGW_VERSION-ucrt-ubuntu-22.04-x86_64"
    LLVM_MINGW_SHA256=bb7bb7654b33d5aa8712acb837c963b2e0c56352560c76105270a3268c665c21
    ;;
  Darwin-*)
    LLVM_MINGW_NAME="llvm-mingw-$LLVM_MINGW_VERSION-ucrt-macos-universal"
    LLVM_MINGW_SHA256=52e5f5a7b131021d0c39a37a38fa380a1da7885cd04bd61afd0cd4ecfb8bc1f3
    ;;
  *) echo "Error: no pinned llvm-mingw toolchain for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
ZLIB_VERSION=1.3.2
ZLIB_SHA256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
JPEG_VERSION=3.2.0
JPEG_SHA256=6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e
TIFF_VERSION=4.7.2
TIFF_SHA256=672bd7d10aee4606171afb864f3570b83340f6a33e2c186dc0512f7145ffdf6a
DJVULIBRE_VERSION=3.5.30
DJVULIBRE_SHA256=ee5e457d4cfebe566f94b99e5e3d3cc7f5c79ddb741c2ac2ba2e456f00329644

TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/djvulibre-$MACHINE-XXXXXX")"
PREFIX="$BUILD_DIR/prefix"
trap 'rm -rf -- "$BUILD_DIR"' EXIT
JOBS="$(getconf _NPROCESSORS_ONLN)"
# Keeps the temporary build path out of the binaries so builds are reproducible.
REPRO_FLAGS="-ffile-prefix-map=$BUILD_DIR=."

fetch() {
  local url="$1" sha256="$2" archive="$BUILD_DIR/${1##*/}"
  curl -fsSL "$url" -o "$archive"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$sha256  $archive" | sha256sum -c -
  else
    echo "$sha256  $archive" | shasum -a 256 -c -
  fi
  tar -xf "$archive" -C "$BUILD_DIR"
}

fetch "https://github.com/mstorsjo/llvm-mingw/releases/download/$LLVM_MINGW_VERSION/$LLVM_MINGW_NAME.tar.xz" "$LLVM_MINGW_SHA256"
fetch "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_SHA256"
fetch "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/$JPEG_VERSION/libjpeg-turbo-$JPEG_VERSION.tar.gz" "$JPEG_SHA256"
fetch "https://download.osgeo.org/libtiff/tiff-$TIFF_VERSION.tar.gz" "$TIFF_SHA256"
fetch "https://downloads.sourceforge.net/djvu/djvulibre-$DJVULIBRE_VERSION.tar.gz" "$DJVULIBRE_SHA256"
export PATH="$BUILD_DIR/$LLVM_MINGW_NAME/bin:$PATH"

cmake_build() {
  local source="$1"
  shift
  cmake -S "$source" -B "$source/build" \
    -DCMAKE_SYSTEM_NAME=Windows \
    -DCMAKE_SYSTEM_PROCESSOR="$CMAKE_PROCESSOR" \
    -DCMAKE_C_COMPILER="$HOST-clang" \
    -DCMAKE_CXX_COMPILER="$HOST-clang++" \
    -DCMAKE_RC_COMPILER="$HOST-windres" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$REPRO_FLAGS" \
    -DCMAKE_CXX_FLAGS="$REPRO_FLAGS" \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_PREFIX_PATH="$PREFIX" \
    -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    "$@"
  cmake --build "$source/build" --parallel "$JOBS"
  cmake --install "$source/build"
}

cmake_build "$BUILD_DIR/zlib-$ZLIB_VERSION" -DZLIB_BUILD_TESTING=OFF -DZLIB_BUILD_SHARED=OFF
# The official DjVuLibre Windows build uses IJG libjpeg without SIMD.
cmake_build "$BUILD_DIR/libjpeg-turbo-$JPEG_VERSION" -DENABLE_SHARED=OFF -DWITH_TURBOJPEG=OFF -DWITH_SIMD=OFF
# tiff2pdf behind `ddjvu -format=pdf` needs libtiff with JPEG and Deflate.
cmake_build "$BUILD_DIR/tiff-$TIFF_VERSION" \
  -Dtiff-tools=OFF -Dtiff-tests=OFF -Dtiff-contrib=OFF -Dtiff-docs=OFF -Dtiff-cxx=OFF \
  -Djbig=OFF -Dlerc=OFF -Dlzma=OFF -Dzstd=OFF -Dwebp=OFF -Dlibdeflate=OFF

DJVULIBRE_DIR="$BUILD_DIR/djvulibre-$DJVULIBRE_VERSION"
patch -d "$DJVULIBRE_DIR" -p1 < "$SCRIPT_DIR/patches/djvulibre-$DJVULIBRE_VERSION-win32-monitor-owner.patch"
(
  cd "$DJVULIBRE_DIR"
  # Empty export macros link the library into the executables.
  ./configure --host="$HOST" --disable-shared --enable-static \
    --disable-xmltools --disable-desktopfiles \
    CC="$HOST-clang" CXX="$HOST-clang++" \
    CPPFLAGS="-I$PREFIX/include -DDDJVUAPI= -DDJVUAPI= -DMINILISPAPI=" \
    CFLAGS="-O2 $REPRO_FLAGS" CXXFLAGS="-O2 $REPRO_FLAGS" \
    JPEG_LIBS="-L$PREFIX/lib -ljpeg" \
    TIFF_LIBS="-L$PREFIX/lib -ltiff -ljpeg -lzs"
  make -j"$JOBS" -C libdjvu
  # -all-static makes libtool link the C++ runtime statically as well.
  make -j"$JOBS" -C tools ddjvu.exe djvused.exe djvudump.exe LDFLAGS="-all-static -Wl,--no-insert-timestamp"
)

DESTINATION="$PROJECT_ROOT/resources/djvulibre/$TARGET/bin"
rm -rf "$PROJECT_ROOT/resources/djvulibre/$TARGET"
mkdir -p "$DESTINATION"
for tool in ddjvu djvused djvudump; do
  cp "$DJVULIBRE_DIR/tools/$tool.exe" "$DESTINATION/"
done
find "$DESTINATION" -maxdepth 1 -type f -iname '*.exe' > "$BUILD_DIR/pe-files.txt"
node "$SCRIPT_DIR/release/windows-pe-dependencies.mjs" verify \
  --allowed-machines "$MACHINE" \
  --system-dll-pattern-file "$SCRIPT_DIR/win-system-dll-pattern.sh" \
  --file-list "$BUILD_DIR/pe-files.txt"

echo "Built patched DjVuLibre $DJVULIBRE_VERSION for $TARGET."
