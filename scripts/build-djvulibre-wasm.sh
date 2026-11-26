#!/usr/bin/env bash
# Builds the unified DjVuLibre WebAssembly engine (used by both browser Web
# Workers and Electron desktop worker_threads): DjVuLibre 3.5.30 compiled to
# single-threaded WebAssembly (SIMD128, -O3) with Emscripten's built-in libjpeg
# and EVB's minimal C bridge (scripts/djvulibre-wasm/evb_djvulibre_bridge.cpp).
#
# Output: $OUT_DIR/evb-djvulibre.mjs (ES module factory) and evb-djvulibre.wasm.
# Needs an activated emsdk at EMSCRIPTEN_VERSION (source emsdk_env.sh first).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EMSCRIPTEN_VERSION="6.0.12"
DJVULIBRE_VERSION="3.5.30"
DJVULIBRE_SHA256="ee5e457d4cfebe566f94b99e5e3d3cc7f5c79ddb741c2ac2ba2e456f00329644"
OUT_DIR="${OUT_DIR:-$PROJECT_ROOT/.devkit/tmp/djvulibre-wasm}"
TMP_ROOT="${TMPDIR:-$PROJECT_ROOT/.devkit/tmp}"
mkdir -p "$TMP_ROOT"
BUILD_DIR="$(mktemp -d "$TMP_ROOT/djvulibre-wasm-XXXXXX")"
trap 'wait 2>/dev/null || true; rm -rf -- "$BUILD_DIR"' EXIT

actual_version="$(emcc -dumpversion)"
if [ "$actual_version" != "$EMSCRIPTEN_VERSION" ]; then
  echo "Error: Emscripten $EMSCRIPTEN_VERSION is required, found $actual_version" >&2
  exit 2
fi

embuilder build libjpeg
sysroot="$(em-config CACHE)/sysroot"

TARBALL="${DJVULIBRE_TARBALL:-$BUILD_DIR/djvulibre-$DJVULIBRE_VERSION.tar.gz}"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL -o "$TARBALL" \
    "https://downloads.sourceforge.net/djvu/djvulibre-$DJVULIBRE_VERSION.tar.gz"
fi
if command -v sha256sum >/dev/null 2>&1; then
  echo "$DJVULIBRE_SHA256  $TARBALL" | sha256sum -c -
else
  echo "$DJVULIBRE_SHA256  $TARBALL" | shasum -a 256 -c -
fi
tar -xzf "$TARBALL" -C "$BUILD_DIR"

SRC_DIR="$BUILD_DIR/djvulibre-$DJVULIBRE_VERSION"
patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/patches/djvulibre-$DJVULIBRE_VERSION-emscripten-nothreads.patch"

# Minimal autoconf config.h for Emscripten wasm32 (single-threaded, little-endian, libjpeg).
cat > "$SRC_DIR/config.h" <<'EOF'
#define HAVE_CONFIG_H 1
#define UNIX 1
#define HAS_MEMMAP 0
#define HAVE_NAMESPACES 1
#define HAVE_EXCEPTIONS 1
#define HAVE_STDINCLUDES 1
#define HAVE_TYPENAME 1
#define HAVE_LONG_LONG_INT 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_MEMORY_H 1
#define HAVE_STRINGS_H 1
#define HAVE_UNISTD_H 1
#define HAVE_WCHAR_H 1
#define HAVE_WCTYPE_H 1
#define HAVE_WCSRTOMBS 1
#define HAVE_MBSRTOWCS 1
#define HAVE_MBSTATE_T 1
#define HAS_WCHAR 1
#define HAS_WCTYPE 1
#define HAS_MBSTATE 1
#define HAVE_ICONV 0
#define HAVE_JPEG 1
#define HAVE_VSNPRINTF 1
#define HAVE_SNPRINTF 1
#define HAVE_STRERROR 1
#define HAVE_ISWSPACE 1
#define HAVE_PUTC_UNLOCKED 1
#define NEED_JPEG_DECODER 1
#define DIR_DATADIR "/usr/local/share"
#define VERSION "3.5.30"
EOF

# Core decoder/reader/inspection subset of libdjvulibre (omits encoders,
# PostScript/XML exporters, and threaded ddjvuapi wrapper).
LIBDJVU_SOURCES=(
  Arrays.cpp
  BSByteStream.cpp
  BSEncodeByteStream.cpp
  ByteStream.cpp
  DataPool.cpp
  DjVmDir.cpp
  DjVmDir0.cpp
  DjVmDoc.cpp
  DjVmNav.cpp
  DjVuAnno.cpp
  DjVuDocument.cpp
  DjVuErrorList.cpp
  DjVuFile.cpp
  DjVuFileCache.cpp
  DjVuGlobal.cpp
  DjVuGlobalMemory.cpp
  DjVuImage.cpp
  DjVuInfo.cpp
  DjVuMessage.cpp
  DjVuMessageLite.cpp
  DjVuNavDir.cpp
  DjVuPalette.cpp
  DjVuPort.cpp
  DjVuText.cpp
  GBitmap.cpp
  GContainer.cpp
  GException.cpp
  GIFFManager.cpp
  GMapAreas.cpp
  GOS.cpp
  GPixmap.cpp
  GRect.cpp
  GScaler.cpp
  GSmartPointer.cpp
  GString.cpp
  GThreads.cpp
  GURL.cpp
  GUnicode.cpp
  IFFByteStream.cpp
  IW44EncodeCodec.cpp
  IW44Image.cpp
  JB2Image.cpp
  JPEGDecoder.cpp
  MMRDecoder.cpp
  MMX.cpp
  UnicodeByteStream.cpp
  XMLTags.cpp
  ZPCodec.cpp
  atomic.cpp
  debug.cpp
)

OBJ_DIR="$BUILD_DIR/obj"
mkdir -p "$OBJ_DIR"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

# Deterministic paths in the binary, whatever the temporary directory is.
# DjVuLibre uses C++ exceptions for malformed streams, so keep them catchable.
COMMON_FLAGS=(
  -O3
  -msimd128
  -fexceptions
  -ffunction-sections
  -fdata-sections
  -sUSE_LIBJPEG=1
  -DHAVE_CONFIG_H=1
  -DDJVUAPI=
  -DDDJVUAPI=
  -DMINILISPAPI=
  -DNDEBUG
  -I"$SRC_DIR"
  -I"$SRC_DIR/libdjvu"
  -I"$sysroot/include"
  "-ffile-prefix-map=$BUILD_DIR=/build"
  "-ffile-prefix-map=$PROJECT_ROOT=/project"
  -Wno-deprecated-declarations
  -Wno-register
  -Wno-c++11-narrowing
)

compile_one() {
  local src="$1"
  local out="$2"
  em++ "${COMMON_FLAGS[@]}" -std=gnu++14 -c "$src" -o "$out"
}

export -f compile_one
export OBJ_DIR SRC_DIR

pids=()
OBJECTS=()
for file in "${LIBDJVU_SOURCES[@]}"; do
  obj="$OBJ_DIR/${file%.cpp}.o"
  OBJECTS+=("$obj")
  em++ "${COMMON_FLAGS[@]}" -std=gnu++14 -c "$SRC_DIR/libdjvu/$file" -o "$obj" &
  pids+=($!)
  if [ "${#pids[@]}" -ge "$JOBS" ]; then
    wait "${pids[0]}"
    pids=("${pids[@]:1}")
  fi
done

BRIDGE_OBJ="$OBJ_DIR/evb_djvulibre_bridge.o"
em++ "${COMMON_FLAGS[@]}" -std=gnu++17 -c "$SCRIPT_DIR/djvulibre-wasm/evb_djvulibre_bridge.cpp" -o "$BRIDGE_OBJ" &
pids+=($!)
OBJECTS+=("$BRIDGE_OBJ")

for pid in "${pids[@]}"; do
  wait "$pid"
done

EXPORTED_FUNCTIONS='["_malloc","_free","_evb_djvu_open","_evb_djvu_close","_evb_djvu_clear_cache","_evb_djvu_provide_component","_evb_djvu_get_doc_info","_evb_djvu_get_page_info","_evb_djvu_get_page_structure","_evb_djvu_render_page","_evb_djvu_get_outline","_evb_djvu_get_page_text","_evb_djvu_page_has_text","_evb_djvu_get_metadata","_evb_djvu_output_ptr","_evb_djvu_output_len","_evb_djvu_release_output","_evb_djvu_error_ptr","_evb_djvu_error_len","_evb_djvu_missing_component_ptr","_evb_djvu_missing_component_len","_evb_djvu_render_width","_evb_djvu_render_height","_evb_djvu_render_present"]'

mkdir -p "$OUT_DIR"
em++ -O3 -msimd128 -fexceptions -sUSE_LIBJPEG=1 \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createDjvuLibreModule \
  -sENVIRONMENT=worker,node \
  -sDYNAMIC_EXECUTION=0 \
  -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=0 \
  -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16MB \
  -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
  "${OBJECTS[@]}" \
  -o "$BUILD_DIR/evb-djvulibre.js"

cp "$BUILD_DIR/evb-djvulibre.wasm" "$OUT_DIR/evb-djvulibre.wasm"
cp "$BUILD_DIR/evb-djvulibre.js" "$OUT_DIR/evb-djvulibre.mjs"
grep -q 'evb-djvulibre.wasm' "$OUT_DIR/evb-djvulibre.mjs"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT_DIR/evb-djvulibre.mjs" "$OUT_DIR/evb-djvulibre.wasm"
else
  shasum -a 256 "$OUT_DIR/evb-djvulibre.mjs" "$OUT_DIR/evb-djvulibre.wasm"
fi
ls -lh "$OUT_DIR/evb-djvulibre.mjs" "$OUT_DIR/evb-djvulibre.wasm"
