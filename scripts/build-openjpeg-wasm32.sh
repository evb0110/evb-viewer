#!/usr/bin/env bash
# Builds the OpenJPEG decoder the browser engines link for PDF JPXDecode
# images: OpenJPEG 2.5.4, the release the desktop's bundled Poppler links,
# with native/pdf-image-combine/src/jpx_wasm/openjpeg-2.5.4-dwt-fma.patch and
# the adapter evb_jpx.c beside it, compiled for wasm32 into one static archive
# with the few wasi-libc members OpenJPEG references. pdf-image-combine's build
# script links it when the target is wasm32; native builds keep their Rust
# decoder and need no C.
#
# Output: native/pdf-image-combine/src/jpx_wasm/libevb_jpx.a and SOURCE.json.
# Needs wasi-sdk $WASI_SDK_VERSION for this host at $WASI_SDK
# (https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-27).
# Rebuilding from the same inputs gives the same archive bytes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WASI_SDK_VERSION="27.0"
OPENJPEG_VERSION="2.5.4"
OPENJPEG_SHA256="a695fbe19c0165f295a8531b1e4e855cd94d0875d2f88ec4b61080677e27188a"
OUT_DIR="$PROJECT_ROOT/native/pdf-image-combine/src/jpx_wasm"
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/openjpeg-wasm32-XXXXXX")"
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

curl -fsSL -o "$BUILD_DIR/openjpeg.tar.gz" \
  "https://github.com/uclouvain/openjpeg/archive/refs/tags/v$OPENJPEG_VERSION.tar.gz"
echo "$OPENJPEG_SHA256  $BUILD_DIR/openjpeg.tar.gz" | shasum -a 256 -c -
tar -xzf "$BUILD_DIR/openjpeg.tar.gz" -C "$BUILD_DIR"
source_root="$BUILD_DIR/openjpeg-$OPENJPEG_VERSION"
patch -s -d "$source_root" -p1 < "$OUT_DIR/openjpeg-$OPENJPEG_VERSION-dwt-fma.patch"
source_dir="$source_root/src/lib/openjp2"

# The library's units, without opj_malloc.c and opj_clock.c, which the
# adapter replaces. Unreferenced encoder and file-stream code is discarded
# when the engine links.
units=(
  thread bio cio dwt event ht_dec image invert j2k jp2 mct mqc openjpeg pi t1 t2
  tcd tgt function_list sparse_array
)

# No SIMD, threads or stack protector; diagnostics and environment reads go
# to the adapter's no-op shims. The module stays import-free.
flags=(
  --target=wasm32-wasi -O3 -DNDEBUG -DOPJ_STATIC -DMUTEX_stub -mno-simd128
  -ffunction-sections -fdata-sections -fno-stack-protector
  -Dfprintf=evb_jpx_fprintf -Dprintf=evb_jpx_printf
  -Dvsnprintf=evb_jpx_vsnprintf -Dgetenv=evb_jpx_getenv
  "-ffile-prefix-map=$BUILD_DIR=/build" "-ffile-prefix-map=$PROJECT_ROOT=/project"
  -I "$OUT_DIR" -I "$source_dir"
)
objects=()
index=0
for unit in "${units[@]}" ADAPTER; do
  if [ "$unit" = ADAPTER ]; then input="$OUT_DIR/evb_jpx.c"; else input="$source_dir/$unit.c"; fi
  object="$BUILD_DIR/$(printf '%02d' "$index")-$(basename "$input" .c).o"
  "$WASI_SDK/bin/clang" "${flags[@]}" -c "$input" -o "$object"
  objects+=("$object")
  index=$((index + 1))
done

# The libc functions OpenJPEG calls, from the SDK's own wasi-libc: string and
# integer parsing, sorting, rounding, and fmaf for the patched wavelet step.
libc_dir="$BUILD_DIR/libc"
mkdir -p "$libc_dir"
for member in strcmp.o atoi.o lrintf.o qsort.o qsort_nr.o fmaf.o fenv.o; do
  (cd "$libc_dir" && "$WASI_SDK/bin/llvm-ar" x "$WASI_SDK/share/wasi-sysroot/lib/wasm32-wasip1/libc.a" "$member")
  objects+=("$libc_dir/$member")
done

rm -f "$OUT_DIR/libevb_jpx.a"
"$WASI_SDK/bin/llvm-ar" crsD "$OUT_DIR/libevb_jpx.a" "${objects[@]}"

digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
# pdf-image-combine's build script refuses an archive whose inputs changed
# after it was built: each input's hash, relative to the crate.
cat > "$OUT_DIR/SOURCE.json" <<JSON
{
  "openjpeg": {
    "version": "$OPENJPEG_VERSION",
    "url": "https://github.com/uclouvain/openjpeg/archive/refs/tags/v$OPENJPEG_VERSION.tar.gz",
    "sha256": "$OPENJPEG_SHA256"
  },
  "wasiSdk": "$WASI_SDK_VERSION",
  "inputs": {
    "src/jpx_wasm/evb_jpx.c": "$(digest "$OUT_DIR/evb_jpx.c")",
    "src/jpx_wasm/opj_config.h": "$(digest "$OUT_DIR/opj_config.h")",
    "src/jpx_wasm/opj_config_private.h": "$(digest "$OUT_DIR/opj_config_private.h")",
    "src/jpx_wasm/openjpeg-$OPENJPEG_VERSION-dwt-fma.patch": "$(digest "$OUT_DIR/openjpeg-$OPENJPEG_VERSION-dwt-fma.patch")",
    "../../scripts/build-openjpeg-wasm32.sh": "$(digest "$SCRIPT_DIR/build-openjpeg-wasm32.sh")"
  },
  "archive": {
    "src/jpx_wasm/libevb_jpx.a": "$(digest "$OUT_DIR/libevb_jpx.a")"
  }
}
JSON
echo "Built $OUT_DIR/libevb_jpx.a ($(digest "$OUT_DIR/libevb_jpx.a"))"
