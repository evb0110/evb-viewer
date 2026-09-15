#!/bin/bash
# Bundle native tools on the pinned Ubuntu packaging image for x64 and arm64.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  PLATFORM_ARCH="linux-x64" ;;
  aarch64) PLATFORM_ARCH="linux-arm64" ;;
  *)       echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Fetch the published archives for this target. Exit code 3 means at least
# one family needs the source build below.
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

echo "=========================================="
echo "Bundling native tools for $PLATFORM_ARCH"
echo "=========================================="

APT_TIMEOUT_UPDATE_SECONDS=600
APT_TIMEOUT_INSTALL_SECONDS=900
APT_RETRY_FLAGS=(
  -o
  Acquire::Retries=0
  -o
  Acquire::http::Timeout=15
  -o
  Acquire::https::Timeout=15
  -o
  Dpkg::Use-Pty=0
)

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_apt_with_timeout() {
  local timeout_seconds="$1"
  shift

  as_root env DEBIAN_FRONTEND=noninteractive timeout --foreground "${timeout_seconds}s" "$@"
}

reset_bundle_dir() {
  local bundle_dir="$1"
  if [ -z "$bundle_dir" ]; then
    echo "Error: Refusing to reset an empty Linux bundle path" >&2
    return 1
  fi
  rm -rf -- "$bundle_dir"
}

# Install all required tools
echo ""
echo "Installing tools via apt..."
bash "$SCRIPT_DIR/ci/select-apt-mirrors.sh"
run_apt_with_timeout "$APT_TIMEOUT_UPDATE_SECONDS" apt-get "${APT_RETRY_FLAGS[@]}" update -qq
run_apt_with_timeout "$APT_TIMEOUT_INSTALL_SECONDS" apt-get "${APT_RETRY_FLAGS[@]}" install -y -qq \
  libleptonica-dev \
  poppler-utils \
  djvulibre-bin \
  build-essential \
  cmake \
  curl \
  libjpeg-turbo8-dev \
  zlib1g-dev \
  pkg-config \
  ca-certificates \
  patchelf

# System .so paths to exclude (provided by glibc / base system)
EXCLUDE_PATTERN="^(libc\.|libpthread\.|libdl\.|ld-linux|libm\.|librt\.|libgcc_s\.|libstdc\+\+)"

# Helper: copy a binary and its .so dependencies
bundle_tool() {
  local tool_name="$1"
  local dest_dir="$2"
  local binary_path

  binary_path="$(which "$tool_name" 2>/dev/null || true)"
  if [ -z "$binary_path" ]; then
    echo "  Warning: $tool_name not found in PATH, skipping"
    return 1
  fi

  mkdir -p "$dest_dir/bin" "$dest_dir/lib"

  echo "  Copying $tool_name from $binary_path"
  cp "$binary_path" "$dest_dir/bin/"

  # Find and copy non-system .so dependencies
  # Collect into variable first — piping into while creates a subshell that
  # interacts badly with set -euo pipefail (silent exit on transient failures).
  local deps
  deps="$(ldd "$binary_path" 2>/dev/null | grep "=> /" | awk '{print $3}')" || true

  local lib
  for lib in $deps; do
    local lib_name
    lib_name="$(basename "$lib")"

    # Skip system libraries
    if echo "$lib_name" | grep -qE "$EXCLUDE_PATTERN"; then
      continue
    fi

    if [ ! -f "$dest_dir/lib/$lib_name" ]; then
      cp "$lib" "$dest_dir/lib/"
    fi
  done

  # Set RPATH on binary to find libs relative to itself
  patchelf --set-rpath '$ORIGIN/../lib' "$dest_dir/bin/$tool_name"

  # Strip binary
  strip --strip-all "$dest_dir/bin/$tool_name" 2>/dev/null || true

  return 0
}

# Helper: fix RPATH on all .so files in a lib directory
fix_lib_rpaths() {
  local lib_dir="$1"

  if [ ! -d "$lib_dir" ]; then
    return
  fi

  for lib in "$lib_dir"/*.so*; do
    if [ -f "$lib" ]; then
      patchelf --set-rpath '$ORIGIN' "$lib" 2>/dev/null || true
      strip --strip-all "$lib" 2>/dev/null || true
    fi
  done
}

# Helper: also bundle .so deps of .so files (transitive deps)
bundle_lib_deps() {
  local lib_dir="$1"

  if [ ! -d "$lib_dir" ]; then
    return
  fi

  local added=1
  while [ "$added" -gt 0 ]; do
    added=0
    for lib in "$lib_dir"/*.so*; do
      if [ ! -f "$lib" ]; then
        continue
      fi
      local lib_deps
      lib_deps="$(ldd "$lib" 2>/dev/null | grep "=> /" | awk '{print $3}')" || true

      local dep
      for dep in $lib_deps; do
        local dep_name
        dep_name="$(basename "$dep")"
        if echo "$dep_name" | grep -qE "$EXCLUDE_PATTERN"; then
          continue
        fi
        if [ ! -f "$lib_dir/$dep_name" ]; then
          cp "$dep" "$lib_dir/"
          echo "    Added transitive dep: $dep_name"
          added=1
        fi
      done
    done
  done
}

# ==========================================
# 1. Tesseract
# ==========================================
echo ""
echo "=========================================="
echo "1. Bundling Tesseract..."
echo "=========================================="

TESSERACT_VERSION="5.5.3"
TESSERACT_SHA256="9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884"
mkdir -p "$PROJECT_ROOT/.devkit/tmp"
TESSERACT_BUILD_DIR="$(mktemp -d "$PROJECT_ROOT/.devkit/tmp/tesseract-linux-XXXXXX")"
trap 'rm -rf -- "$TESSERACT_BUILD_DIR"' EXIT
curl -fsSL -o "$TESSERACT_BUILD_DIR/tesseract.tar.gz" \
  "https://github.com/tesseract-ocr/tesseract/archive/refs/tags/$TESSERACT_VERSION.tar.gz"
echo "$TESSERACT_SHA256  $TESSERACT_BUILD_DIR/tesseract.tar.gz" | sha256sum -c -
tar -xzf "$TESSERACT_BUILD_DIR/tesseract.tar.gz" -C "$TESSERACT_BUILD_DIR"
cmake -S "$TESSERACT_BUILD_DIR/tesseract-$TESSERACT_VERSION" -B "$TESSERACT_BUILD_DIR/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TRAINING_TOOLS=OFF \
  -DBUILD_TESTS=OFF \
  -DDISABLE_ARCHIVE=ON \
  -DDISABLE_CURL=ON \
  -DOPENMP_BUILD=OFF \
  -DBUILD_SHARED_LIBS=OFF
cmake --build "$TESSERACT_BUILD_DIR/build" --parallel "$(nproc)" --target tesseract

TESSERACT_DIR="$RESOURCES_DIR/tesseract/$PLATFORM_ARCH"
reset_bundle_dir "$TESSERACT_DIR"
PATH="$TESSERACT_BUILD_DIR/build/bin:$PATH" \
bundle_tool "tesseract" "$TESSERACT_DIR"
bundle_lib_deps "$TESSERACT_DIR/lib"
fix_lib_rpaths "$TESSERACT_DIR/lib"
"$TESSERACT_DIR/bin/tesseract" --version
rm -rf -- "$TESSERACT_BUILD_DIR"
trap - EXIT

# ==========================================
# 2. Poppler (pdfinfo, pdftoppm, pdftotext, pdfimages)
# ==========================================
echo ""
echo "=========================================="
echo "2. Bundling Poppler tools..."
echo "=========================================="

POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
reset_bundle_dir "$POPPLER_DIR"
for tool in pdfinfo pdftoppm pdftotext pdfimages; do
  bundle_tool "$tool" "$POPPLER_DIR"
done
if [ -d /usr/share/poppler ]; then
  mkdir -p "$POPPLER_DIR/share"
  cp -a /usr/share/poppler "$POPPLER_DIR/share/"
else
  echo "Warning: /usr/share/poppler not found; bundled Poppler data directory will be absent"
fi
if [ -d /etc/fonts ]; then
  mkdir -p "$POPPLER_DIR/etc"
  cp -a /etc/fonts "$POPPLER_DIR/etc/"
else
  echo "Warning: /etc/fonts not found; bundled Fontconfig directory will be absent"
fi
bundle_lib_deps "$POPPLER_DIR/lib"
fix_lib_rpaths "$POPPLER_DIR/lib"

# ==========================================
# 3. qpdf
# ==========================================
echo ""
echo "=========================================="
echo "3. Bundling qpdf..."
echo "=========================================="

# Ubuntu 22.04 ships qpdf 10.6, but the MRC extractor and the word-loss audit
# use qpdf 11 JSON v2 options, so build a pinned release against this glibc.
QPDF_VERSION="11.9.1"
QPDF_SHA256="2ba4d248f9567a27c146b9772ef5dc93bd9622317978455ffe91b259340d13d1"
QPDF_BUILD_DIR="$(mktemp -d /tmp/evb-qpdf-linux-XXXXXX)"
curl -fsSL -o "$QPDF_BUILD_DIR/qpdf.tar.gz" \
  "https://github.com/qpdf/qpdf/releases/download/v$QPDF_VERSION/qpdf-$QPDF_VERSION.tar.gz"
echo "$QPDF_SHA256  $QPDF_BUILD_DIR/qpdf.tar.gz" | sha256sum -c -
tar -xzf "$QPDF_BUILD_DIR/qpdf.tar.gz" -C "$QPDF_BUILD_DIR"
cmake -S "$QPDF_BUILD_DIR/qpdf-$QPDF_VERSION" -B "$QPDF_BUILD_DIR/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DREQUIRE_CRYPTO_NATIVE=ON \
  -DUSE_IMPLICIT_CRYPTO=OFF \
  -DBUILD_STATIC_LIBS=OFF \
  -DBUILD_DOC=OFF \
  -DINSTALL_EXAMPLES=OFF
cmake --build "$QPDF_BUILD_DIR/build" --parallel "$(nproc)" --target qpdf

QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"
reset_bundle_dir "$QPDF_DIR"
PATH="$QPDF_BUILD_DIR/build/qpdf:$PATH" \
bundle_tool "qpdf" "$QPDF_DIR"
rm -rf "$QPDF_BUILD_DIR"
bundle_lib_deps "$QPDF_DIR/lib"
fix_lib_rpaths "$QPDF_DIR/lib"

# ==========================================
# 4. DjVuLibre (ddjvu, djvused, djvudump)
# ==========================================
echo ""
echo "=========================================="
echo "4. Bundling DjVuLibre..."
echo "=========================================="

DJVU_DIR="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"
reset_bundle_dir "$DJVU_DIR"
for tool in ddjvu djvused djvudump; do
  bundle_tool "$tool" "$DJVU_DIR"
done
bundle_lib_deps "$DJVU_DIR/lib"
fix_lib_rpaths "$DJVU_DIR/lib"

# ==========================================
# Verification
# ==========================================
echo ""
echo "=========================================="
echo "Verification"
echo "=========================================="

verify_tool() {
  local path="$1"
  local name="$2"
  if [ -f "$path" ]; then
    local size
    size="$(du -h "$path" | awk '{print $1}')"
    echo "  OK  $name ($size)"
  else
    echo "  MISSING  $name"
    missing_count=$((missing_count + 1))
  fi
}

verify_dir() {
  local path="$1"
  local name="$2"
  if [ -d "$path" ]; then
    echo "  OK  $name ($path)"
  else
    echo "  MISSING  $name"
    missing_count=$((missing_count + 1))
  fi
}

missing_count=0

verify_tool "$TESSERACT_DIR/bin/tesseract" "tesseract"
verify_tool "$POPPLER_DIR/bin/pdfinfo" "pdfinfo"
verify_tool "$POPPLER_DIR/bin/pdftoppm" "pdftoppm"
verify_tool "$POPPLER_DIR/bin/pdftotext" "pdftotext"
verify_tool "$POPPLER_DIR/bin/pdfimages" "pdfimages"
verify_dir "$POPPLER_DIR/share/poppler" "poppler data directory"
verify_dir "$POPPLER_DIR/etc/fonts" "fontconfig directory"
verify_tool "$QPDF_DIR/bin/qpdf" "qpdf"
verify_tool "$DJVU_DIR/bin/ddjvu" "ddjvu"
verify_tool "$DJVU_DIR/bin/djvused" "djvused"
verify_tool "$DJVU_DIR/bin/djvudump" "djvudump"

if [ "$missing_count" -gt 0 ]; then
  echo ""
  echo "Error: Bundle verification failed ($missing_count required files missing)"
  exit 1
fi

echo ""
echo "Library counts:"
for dir in "$TESSERACT_DIR" "$POPPLER_DIR" "$QPDF_DIR" "$DJVU_DIR"; do
  if [ -d "$dir/lib" ]; then
    count="$(find "$dir/lib" -name '*.so*' | wc -l)"
    echo "  $(basename "$(dirname "$dir")"): $count .so files"
  fi
done

echo ""
echo "Total bundle size:"
du -sh "$TESSERACT_DIR" "$POPPLER_DIR" "$QPDF_DIR" "$DJVU_DIR" 2>/dev/null || true

echo ""
echo "Done!"
