#!/usr/bin/env bash
# Builds the browser qpdf engine: the desktop's qpdf 12.3.2 compiled to
# WebAssembly as the stock command-line program, with qpdf's built-in crypto
# provider and the toolchain's zlib and libjpeg. The browser runs it in one
# worker (app/platform/browser-api/browserQpdfEngine.worker.ts) with the
# command lines desktop runs, from packages/pdf-core/qpdfCommands.ts.
#
# Output: $OUT_DIR/evb-qpdf.mjs (ES module factory) and evb-qpdf.wasm.
# Needs an activated emsdk at EMSCRIPTEN_VERSION (source emsdk_env.sh first).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EMSCRIPTEN_VERSION="6.0.12"
QPDF_VERSION="12.3.2"
QPDF_SHA256="6cba2f9f2cd887d905faeb99e0e51a307b217920d1bbf3e9cfbb2e8178a2deda"
OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/.devkit/tmp/qpdf-wasm}"
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/qpdf-wasm-XXXXXX")"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

actual_version="$(emcc -dumpversion)"
if [ "$actual_version" != "$EMSCRIPTEN_VERSION" ]; then
  echo "Error: Emscripten $EMSCRIPTEN_VERSION is required, found $actual_version" >&2
  exit 2
fi
embuilder build zlib libjpeg
sysroot="$(em-config CACHE)/sysroot"

curl -fsSL -o "$BUILD_DIR/qpdf.tar.gz" \
  "https://github.com/qpdf/qpdf/releases/download/v$QPDF_VERSION/qpdf-$QPDF_VERSION.tar.gz"
echo "$QPDF_SHA256  $BUILD_DIR/qpdf.tar.gz" | shasum -a 256 -c -
tar -xzf "$BUILD_DIR/qpdf.tar.gz" -C "$BUILD_DIR"

# Deterministic paths in the binary, whatever the temporary directory is.
# qpdf reports malformed input through C++ exceptions, so every object is
# compiled with them and the link keeps them catchable.
compile_flags="-fexceptions -sUSE_ZLIB=1 -sUSE_LIBJPEG=1 -ffile-prefix-map=$BUILD_DIR=/build"

# Link: an ES module factory for workers (and Node, for tests), no eval (the
# site CSP has no unsafe-eval), main run on demand, the runtime kept alive
# between commands. No threads, so no cross-origin isolation is needed.
link_flags=(
  "$compile_flags"
  -sDISABLE_EXCEPTION_CATCHING=0
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createQpdfModule
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
)

# Desktop's Linux recipe selects the same built-in crypto provider; secure
# randomness stays on (Emscripten reads /dev/urandom from Web Crypto).
emcmake cmake -S "$BUILD_DIR/qpdf-$QPDF_VERSION" -B "$BUILD_DIR/qpdf-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_STATIC_LIBS=ON \
  -DBUILD_DOC=OFF \
  -DINSTALL_EXAMPLES=OFF \
  -DUSE_IMPLICIT_CRYPTO=OFF \
  -DREQUIRE_CRYPTO_NATIVE=ON \
  -DDEFAULT_CRYPTO=native \
  -DCMAKE_DISABLE_FIND_PACKAGE_PkgConfig=ON \
  -DZLIB_H_PATH="$sysroot/include" \
  -DZLIB_LIB_PATH="$sysroot/lib/wasm32-emscripten/libz.a" \
  -DLIBJPEG_H_PATH="$sysroot/include" \
  -DLIBJPEG_LIB_PATH="$sysroot/lib/wasm32-emscripten/libjpeg.a" \
  -DCMAKE_C_FLAGS="$compile_flags" \
  -DCMAKE_CXX_FLAGS="$compile_flags" \
  -DCMAKE_EXE_LINKER_FLAGS="${link_flags[*]}"
cmake --build "$BUILD_DIR/qpdf-build" --parallel --target qpdf

mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/qpdf-build/qpdf/qpdf.wasm" "$OUT_DIR/evb-qpdf.wasm"
# The toolchain names the factory .js although EXPORT_ES6 makes it an ES module;
# it names its .wasm after the build output, so point it at the shipped name.
sed 's/qpdf\.wasm/evb-qpdf.wasm/g' "$BUILD_DIR/qpdf-build/qpdf/qpdf.js" > "$OUT_DIR/evb-qpdf.mjs"
grep -q 'evb-qpdf.wasm' "$OUT_DIR/evb-qpdf.mjs"
shasum -a 256 "$OUT_DIR/evb-qpdf.mjs" "$OUT_DIR/evb-qpdf.wasm"
