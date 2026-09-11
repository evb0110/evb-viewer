#!/bin/bash
# Bundle all required native tools for Linux x64
# Runs on Ubuntu CI runner — installs via apt, copies binaries + .so deps
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

echo "=========================================="
echo "Bundling native tools for $PLATFORM_ARCH"
echo "=========================================="

APT_TIMEOUT_UPDATE_SECONDS=600
APT_TIMEOUT_INSTALL_SECONDS=900
APT_RETRY_FLAGS=(
  -o
  Acquire::Retries=1
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

# The pinned image reads archive.ubuntu.com alone. Point the Ubuntu entries at
# a mirror list so apt moves to the kernel.org mirror, then the security
# archive, when the canonical archive stalls; on 2026-09-11 it hung the
# install for the whole 900s budget. Plain http keeps this independent of
# ca-certificates, which is installed below; apt verifies the signed indexes
# either way. ports.ubuntu.com has no kernel.org mirror, so arm64 keeps its
# sources.
configure_apt_mirror_fallback() {
  if [ "$ARCH" != x86_64 ]; then
    return 0
  fi

  local mirror_list=/etc/apt/apt-mirrors.txt
  local source
  printf '%s\tpriority:%s\n' \
    http://archive.ubuntu.com/ubuntu/ 1 \
    http://mirrors.edge.kernel.org/ubuntu/ 2 \
    http://security.ubuntu.com/ubuntu/ 3 \
    | as_root tee "$mirror_list" >/dev/null
  for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    if [ -f "$source" ]; then
      as_root sed -i -E \
        "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#mirror+file:$mirror_list#g" \
        "$source"
    fi
  done
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
configure_apt_mirror_fallback
run_apt_with_timeout "$APT_TIMEOUT_UPDATE_SECONDS" apt-get "${APT_RETRY_FLAGS[@]}" update -qq
run_apt_with_timeout "$APT_TIMEOUT_INSTALL_SECONDS" apt-get "${APT_RETRY_FLAGS[@]}" install -y -qq \
  tesseract-ocr \
  poppler-utils \
  qpdf \
  djvulibre-bin \
  build-essential \
  git \
  meson \
  ninja-build \
  pkg-config \
  python3-sphinx \
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

TESSERACT_DIR="$RESOURCES_DIR/tesseract/$PLATFORM_ARCH"
reset_bundle_dir "$TESSERACT_DIR"
bundle_tool "tesseract" "$TESSERACT_DIR"
bundle_lib_deps "$TESSERACT_DIR/lib"
fix_lib_rpaths "$TESSERACT_DIR/lib"

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

QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"
reset_bundle_dir "$QPDF_DIR"
bundle_tool "qpdf" "$QPDF_DIR"
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
# 5. Unpaper
# ==========================================
echo ""
echo "=========================================="
echo "5. Bundling Unpaper..."
echo "=========================================="

# Unpaper lives alongside tesseract in the same directory
UNPAPER_BUILD_DIR="$(mktemp -d /tmp/evb-unpaper-linux-XXXXXX)"
UNPAPER_INSTALL_DIR="$UNPAPER_BUILD_DIR/install"
FFMPEG_INSTALL_DIR="$UNPAPER_BUILD_DIR/ffmpeg-install"
trap 'rm -rf "$UNPAPER_BUILD_DIR"' EXIT
"$SCRIPT_DIR/build-minimal-ffmpeg-for-unpaper.sh" "$UNPAPER_BUILD_DIR/ffmpeg-build" "$FFMPEG_INSTALL_DIR"
git clone https://github.com/unpaper/unpaper.git "$UNPAPER_BUILD_DIR/unpaper"
git -C "$UNPAPER_BUILD_DIR/unpaper" checkout unpaper-7.0.0
if [ "$(git -C "$UNPAPER_BUILD_DIR/unpaper" rev-parse HEAD)" != "5211a623d48858eae154213a61bccbc368b19ca0" ]; then
  echo "Error: Pinned unpaper tag resolved to an unexpected commit"
  exit 1
fi
PKG_CONFIG_PATH="$FFMPEG_INSTALL_DIR/lib/pkgconfig" \
LDFLAGS="-Wl,-rpath,$FFMPEG_INSTALL_DIR/lib" \
meson setup "$UNPAPER_BUILD_DIR/unpaper/build-minimal" \
  "$UNPAPER_BUILD_DIR/unpaper" \
  --prefix="$UNPAPER_INSTALL_DIR" \
  --buildtype=release \
  -Dstrip=true
meson compile -C "$UNPAPER_BUILD_DIR/unpaper/build-minimal"
meson install -C "$UNPAPER_BUILD_DIR/unpaper/build-minimal"
PATH="$UNPAPER_INSTALL_DIR/bin:$PATH" \
LD_LIBRARY_PATH="$FFMPEG_INSTALL_DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
bundle_tool "unpaper" "$TESSERACT_DIR"
bundle_lib_deps "$TESSERACT_DIR/lib"
fix_lib_rpaths "$TESSERACT_DIR/lib"

unexpected_video_libraries="$(find "$TESSERACT_DIR/lib" -maxdepth 1 -type f \
  \( -name 'libx26*' -o -name 'libaom*' -o -name 'libSvt*' -o -name 'librav1e*' \
     -o -name 'libvpx*' -o -name 'libdav1d*' -o -name 'libvmaf*' \) -print)"
if [ -n "$unexpected_video_libraries" ]; then
  echo "Error: Unexpected video-codec closure leaked into the Linux unpaper bundle:"
  echo "$unexpected_video_libraries" | sed 's/^/  /'
  exit 1
fi
linked_av_libraries="$(LD_LIBRARY_PATH="$TESSERACT_DIR/lib" ldd "$TESSERACT_DIR/bin/unpaper" \
  | awk '{print $1}' | grep '^libav' || true)"
for required_av_library in libavcodec libavformat libavutil; do
  if ! echo "$linked_av_libraries" | grep -q "^${required_av_library}\."; then
    echo "Error: Minimal Linux unpaper is missing required $required_av_library linkage"
    exit 1
  fi
done

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
verify_tool "$TESSERACT_DIR/bin/unpaper" "unpaper"
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
