#!/usr/bin/env bash
# Builds the browser OCR engine: the desktop's pinned Tesseract and Leptonica,
# compiled to WebAssembly (SIMD128, single-threaded) as the stock command-line
# program. The browser runs one fresh instance per page with the same
# arguments desktop passes to its native binary.
#
# Output: $OUT_DIR/evb-tesseract.mjs (ES module factory) and evb-tesseract.wasm.
# Needs an activated emsdk at EMSCRIPTEN_VERSION (source emsdk_env.sh first).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/tesseract-source-pins.sh
. "$SCRIPT_DIR/tesseract-source-pins.sh"
EMSCRIPTEN_VERSION="6.0.12"
OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/.devkit/tmp/tesseract-wasm}"
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/tesseract-wasm-XXXXXX")"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

actual_version="$(emcc -dumpversion)"
if [ "$actual_version" != "$EMSCRIPTEN_VERSION" ]; then
  echo "Error: Emscripten $EMSCRIPTEN_VERSION is required, found $actual_version" >&2
  exit 2
fi
embuilder build zlib

curl -fsSL -o "$BUILD_DIR/tesseract.tar.gz" \
  "https://github.com/tesseract-ocr/tesseract/archive/refs/tags/$TESSERACT_VERSION.tar.gz"
curl -fsSL -o "$BUILD_DIR/leptonica.tar.gz" \
  "https://github.com/DanBloomberg/leptonica/archive/refs/tags/$LEPTONICA_VERSION.tar.gz"
echo "$TESSERACT_SHA256  $BUILD_DIR/tesseract.tar.gz" | sha256sum -c -
echo "$LEPTONICA_SHA256  $BUILD_DIR/leptonica.tar.gz" | sha256sum -c -
tar -xzf "$BUILD_DIR/tesseract.tar.gz" -C "$BUILD_DIR"
tar -xzf "$BUILD_DIR/leptonica.tar.gz" -C "$BUILD_DIR"
# The only source change: WebAssembly has no cpuid, and SIMD128 provides the
# SSE4.1 intrinsics Tesseract's dot product uses.
patch -p0 -d "$BUILD_DIR/tesseract-$TESSERACT_VERSION" \
  < "$SCRIPT_DIR/patches/tesseract-$TESSERACT_VERSION-simddetect-emscripten.patch"

# Deterministic paths in the binary, whatever the temporary directory is.
prefix_map="-ffile-prefix-map=$BUILD_DIR=/build"
simd_flags="-msimd128 -sUSE_ZLIB=1 $prefix_map"

# Leptonica needs zlib for Tesseract's PDF renderer; without it the text-only
# PDF content stream is garbage. Pages arrive as PNM, so no image codecs.
emcmake cmake -S "$BUILD_DIR/leptonica-$LEPTONICA_VERSION" -B "$BUILD_DIR/leptonica-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/leptonica-install" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_PROG=OFF \
  -DSW_BUILD=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_GIF=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_JPEG=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_TIFF=ON \
  -DCMAKE_DISABLE_FIND_PACKAGE_PkgConfig=ON \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_C_FLAGS="$simd_flags"
cmake --build "$BUILD_DIR/leptonica-build" --parallel "$(nproc)"
cmake --install "$BUILD_DIR/leptonica-build"

# The desktop recipe's options, plus WebAssembly SIMD through the SSE4.1 path.
# Link: an ES module factory for workers (and Node, for tests), no eval (the
# site CSP has no unsafe-eval), main run on demand, pdf.ttf embedded.
link_flags=(
  -sUSE_ZLIB=1
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createTesseractModule
  -sENVIRONMENT=worker,node
  -sDYNAMIC_EXECUTION=0
  -sINVOKE_RUN=0
  -sEXIT_RUNTIME=0
  -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB
  -sMAXIMUM_MEMORY=4GB
  -sSTACK_SIZE=8MB
  "--embed-file=$BUILD_DIR/tesseract-$TESSERACT_VERSION/tessdata/pdf.ttf@/tessdata/pdf.ttf"
)
emcmake cmake -S "$BUILD_DIR/tesseract-$TESSERACT_VERSION" -B "$BUILD_DIR/tesseract-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$BUILD_DIR/leptonica-install" \
  -DLeptonica_DIR="$BUILD_DIR/leptonica-install/lib/cmake/leptonica" \
  -DBUILD_TRAINING_TOOLS=OFF \
  -DBUILD_TESTS=OFF \
  -DDISABLE_ARCHIVE=ON \
  -DDISABLE_CURL=ON \
  -DDISABLE_TIFF=ON \
  -DOPENMP_BUILD=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DGRAPHICS_DISABLED=ON \
  -DENABLE_CCACHE=OFF \
  -DENABLE_PRECOMPILED_HEADERS=OFF \
  -DHAVE_AVX=OFF \
  -DHAVE_AVX2=OFF \
  -DHAVE_AVX512F=OFF \
  -DHAVE_FMA=OFF \
  -DHAVE_SSE4_1=ON \
  -DCMAKE_C_FLAGS="$simd_flags" \
  -DCMAKE_CXX_FLAGS="$simd_flags" \
  -DCMAKE_EXE_LINKER_FLAGS="${link_flags[*]}" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build "$BUILD_DIR/tesseract-build" --parallel "$(nproc)" --target tesseract

mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/tesseract-build/bin/tesseract.wasm" "$OUT_DIR/evb-tesseract.wasm"
# The toolchain names the factory .js although EXPORT_ES6 makes it an ES module;
# it names its .wasm after the build output, so point it at the shipped name.
sed 's/tesseract\.wasm/evb-tesseract.wasm/g' "$BUILD_DIR/tesseract-build/bin/tesseract.js" > "$OUT_DIR/evb-tesseract.mjs"
grep -q 'evb-tesseract.wasm' "$OUT_DIR/evb-tesseract.mjs"
sha256sum "$OUT_DIR/evb-tesseract.mjs" "$OUT_DIR/evb-tesseract.wasm"
