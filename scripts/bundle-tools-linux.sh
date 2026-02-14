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

# Install all required tools
echo ""
echo "Installing tools via apt..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  tesseract-ocr \
  poppler-utils \
  qpdf \
  djvulibre-bin \
  unpaper \
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
bundle_tool "tesseract" "$TESSERACT_DIR"
bundle_lib_deps "$TESSERACT_DIR/lib"
fix_lib_rpaths "$TESSERACT_DIR/lib"

# ==========================================
# 2. Poppler (pdftoppm, pdftotext, pdfimages)
# ==========================================
echo ""
echo "=========================================="
echo "2. Bundling Poppler tools..."
echo "=========================================="

POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
for tool in pdftoppm pdftotext pdfimages; do
  bundle_tool "$tool" "$POPPLER_DIR"
done
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
bundle_tool "qpdf" "$QPDF_DIR"
bundle_lib_deps "$QPDF_DIR/lib"
fix_lib_rpaths "$QPDF_DIR/lib"

# ==========================================
# 4. DjVuLibre (ddjvu, djvused)
# ==========================================
echo ""
echo "=========================================="
echo "4. Bundling DjVuLibre..."
echo "=========================================="

DJVU_DIR="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"
for tool in ddjvu djvused; do
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
bundle_tool "unpaper" "$TESSERACT_DIR"
bundle_lib_deps "$TESSERACT_DIR/lib"
fix_lib_rpaths "$TESSERACT_DIR/lib"

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
  fi
}

verify_tool "$TESSERACT_DIR/bin/tesseract" "tesseract"
verify_tool "$TESSERACT_DIR/bin/unpaper" "unpaper"
verify_tool "$POPPLER_DIR/bin/pdftoppm" "pdftoppm"
verify_tool "$POPPLER_DIR/bin/pdftotext" "pdftotext"
verify_tool "$POPPLER_DIR/bin/pdfimages" "pdfimages"
verify_tool "$QPDF_DIR/bin/qpdf" "qpdf"
verify_tool "$DJVU_DIR/bin/ddjvu" "ddjvu"
verify_tool "$DJVU_DIR/bin/djvused" "djvused"

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
