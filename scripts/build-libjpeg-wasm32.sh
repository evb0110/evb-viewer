#!/usr/bin/env bash
# Builds the libjpeg-turbo decoder the browser engines link for PDF DCT
# images: libjpeg-turbo's 8-bit decompressor and the adapter
# native/pdf-image-combine/src/jpeg_wasm/evb_jpeg.c, compiled for wasm32 into
# one static archive. pdf-image-combine's build script links it when the
# target is wasm32; native builds keep their Rust decoder and need no C.
#
# Output: native/pdf-image-combine/src/jpeg_wasm/libevb_jpeg.a and SOURCE.json.
# Needs wasi-sdk $WASI_SDK_VERSION for this host at $WASI_SDK
# (https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-27).
# Rebuilding from the same inputs gives the same archive bytes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WASI_SDK_VERSION="27.0"
LIBJPEG_TURBO_VERSION="3.1.2"
LIBJPEG_TURBO_SHA256="8f0012234b464ce50890c490f18194f913a7b1f4e6a03d6644179fa0f867d0cf"
OUT_DIR="$PROJECT_ROOT/native/pdf-image-combine/src/jpeg_wasm"
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/libjpeg-wasm32-XXXXXX")"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

: "${WASI_SDK:?Set WASI_SDK to an extracted wasi-sdk $WASI_SDK_VERSION}"
if [ ! -f "$WASI_SDK/VERSION" ]; then
  echo "Error: $WASI_SDK/VERSION not found; WASI_SDK must be an extracted wasi-sdk $WASI_SDK_VERSION" >&2
  exit 2
fi
actual_version="$(head -n 1 "$WASI_SDK/VERSION")"
if [ "$actual_version" != "$WASI_SDK_VERSION" ]; then
  echo "Error: wasi-sdk $WASI_SDK_VERSION is required, found $actual_version" >&2
  exit 2
fi

curl -fsSL -o "$BUILD_DIR/libjpeg-turbo.tar.gz" \
  "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/$LIBJPEG_TURBO_VERSION/libjpeg-turbo-$LIBJPEG_TURBO_VERSION.tar.gz"
echo "$LIBJPEG_TURBO_SHA256  $BUILD_DIR/libjpeg-turbo.tar.gz" | shasum -a 256 -c -
tar -xzf "$BUILD_DIR/libjpeg-turbo.tar.gz" -C "$BUILD_DIR"
source_dir="$BUILD_DIR/libjpeg-turbo-$LIBJPEG_TURBO_VERSION/src"

# The decompressor: common units, then the per-precision wrappers jdmaster
# references even though the adapter admits 8-bit samples only.
sources=(
  jcomapi.c jdapimin.c jdatasrc.c jdhuff.c jdinput.c jdlhuff.c jdmarker.c
  jdmaster.c jdphuff.c jdtrans.c jmemmgr.c jmemnobs.c jpeg_nbits.c jaricom.c
  jdarith.c
)
for unit in jdapistd jdcolor jddiffct jdlossls jdmainct jdpostct jdsample jutils; do
  sources+=("wrapper/$unit-8.c" "wrapper/$unit-12.c" "wrapper/$unit-16.c")
done
for unit in jdcoefct jddctmgr jdmerge jidctflt jidctfst jidctint jidctred jquant1 jquant2; do
  sources+=("wrapper/$unit-8.c" "wrapper/$unit-12.c")
done

# libjpeg's allocations go through the adapter's allocator. No SIMD, no
# exceptions, no stack protector: the module stays import-free.
flags=(
  --target=wasm32-wasi -O3 -DNDEBUG -DNO_GETENV -mno-simd128
  -ffunction-sections -fdata-sections -fno-stack-protector
  -Dmalloc=evb_jpeg_malloc -Dfree=evb_jpeg_free
  "-ffile-prefix-map=$BUILD_DIR=/build" "-ffile-prefix-map=$PROJECT_ROOT=/project"
  -I "$OUT_DIR" -I "$source_dir"
)
objects=()
index=0
for unit in "${sources[@]}" ADAPTER; do
  if [ "$unit" = ADAPTER ]; then input="$OUT_DIR/evb_jpeg.c"; else input="$source_dir/$unit"; fi
  object="$BUILD_DIR/$(printf '%02d' "$index")-$(basename "$input" .c).o"
  "$WASI_SDK/bin/clang" "${flags[@]}" -c "$input" -o "$object"
  objects+=("$object")
  index=$((index + 1))
done

rm -f "$OUT_DIR/libevb_jpeg.a"
"$WASI_SDK/bin/llvm-ar" crsD "$OUT_DIR/libevb_jpeg.a" "${objects[@]}"

digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
# pdf-image-combine's build script refuses an archive whose inputs changed
# after it was built: each input's hash, relative to the crate.
cat > "$OUT_DIR/SOURCE.json" <<JSON
{
  "libjpegTurbo": {
    "version": "$LIBJPEG_TURBO_VERSION",
    "url": "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/$LIBJPEG_TURBO_VERSION/libjpeg-turbo-$LIBJPEG_TURBO_VERSION.tar.gz",
    "sha256": "$LIBJPEG_TURBO_SHA256"
  },
  "wasiSdk": "$WASI_SDK_VERSION",
  "inputs": {
    "src/jpeg_wasm/evb_jpeg.c": "$(digest "$OUT_DIR/evb_jpeg.c")",
    "src/jpeg_wasm/jconfig.h": "$(digest "$OUT_DIR/jconfig.h")",
    "src/jpeg_wasm/jconfigint.h": "$(digest "$OUT_DIR/jconfigint.h")",
    "../../scripts/build-libjpeg-wasm32.sh": "$(digest "$SCRIPT_DIR/build-libjpeg-wasm32.sh")"
  },
  "archive": {
    "src/jpeg_wasm/libevb_jpeg.a": "$(digest "$OUT_DIR/libevb_jpeg.a")"
  }
}
JSON
echo "Built $OUT_DIR/libevb_jpeg.a ($(digest "$OUT_DIR/libevb_jpeg.a"))"
