#!/bin/bash
# Bundle all required native tools for Windows (x64 and arm64)
# Runs in Git Bash on CI — downloads pre-built release ZIPs for x64,
# uses MSYS2 clangarm64 packages for native arm64 binaries.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources"
TEMP_DIR="/tmp/win-bundle-$$"
CACHE_DIR="${WIN_BUNDLE_CACHE_DIR:-$PROJECT_ROOT/.cache/win-tools}"
source "$SCRIPT_DIR/win-system-dll-pattern.sh"
source "$SCRIPT_DIR/sha256-file.sh"

# TARGET_ARCH can be set by CI (the release arm64 lane runs on a native ARM64
# runner; the script remains usable from an x64 host for static cross-bundling).
# x64: downloads pre-built release ZIPs from upstream projects.
# arm64: downloads native aarch64 binaries from MSYS2's clangarm64 repository.
PLATFORM_ARCH="win32-${TARGET_ARCH:-x64}"

echo "=========================================="
echo "Bundling native tools for $PLATFORM_ARCH"
echo "=========================================="

mkdir -p "$TEMP_DIR"
mkdir -p "$CACHE_DIR"

TESSERACT_DIR="$RESOURCES_DIR/tesseract/$PLATFORM_ARCH"
POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"
DJVU_DIR="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"

# ==========================================
# Version configuration (x64 path)
# ==========================================
TESSERACT_TAG="v5.4.0.20240606"
TESSERACT_INSTALLER="tesseract-ocr-w64-setup-5.4.0.20240606.exe"
DJVULIBRE_INSTALLER="DjVuLibre-3.5.28_DjView-4.12_Setup.exe"
DJVULIBRE_SF_PATH="DjVuLibre_Windows/3.5.28%2B4.12"
TESSERACT_SHA256="c885fff6998e0608ba4bb8ab51436e1c6775c2bafc2559a19b423e18678b60c9"
DJVULIBRE_SHA256="16c0a63926d0380280f35c8d9570efe01032c03c262ba61aa72a341b8cb58469"

# ==========================================
# Helper functions
# ==========================================
download() {
  local url="$1"
  local dest="$2"
  local cache_key="${3:-$(basename "$dest")}"
  local expected_sha256="${4:-}"
  local cache_path="$CACHE_DIR/$cache_key"

  verify_sha256() {
    local path="$1"
    local label="$2"
    if [ -z "$expected_sha256" ]; then
      echo "Error: Missing SHA256 pin for release-critical archive $label"
      return 1
    fi

    local actual_sha256
    actual_sha256="$(sha256_file "$path")"
    if [ "$actual_sha256" != "$expected_sha256" ]; then
      echo "Error: SHA256 mismatch for $label"
      echo "  expected: $expected_sha256"
      echo "  actual:   $actual_sha256"
      return 1
    fi
  }

  if [ -s "$cache_path" ]; then
    echo "  Using cache: $cache_key"
    if ! verify_sha256 "$cache_path" "$cache_key"; then
      return 1
    fi
    cp "$cache_path" "$dest"
    return
  fi

  echo "  Downloading: $cache_key"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    # The archive cache is the primary source on CI; a download means the
    # cache missed or the cache service failed. Surface that instead of
    # silently depending on upstream availability.
    echo "::warning::Windows native-tool cache miss for $cache_key; downloading from upstream with pinned checksum verification."
  fi
  # Keep the partial archive at a stable path. A connection reset must resume
  # the bytes already received instead of restarting a large SourceForge
  # transfer from zero. The outer retry loop also covers curl versions that do
  # not classify an interrupted transfer as retryable.
  local temp_cache="${cache_path}.part"
  if ! "$SCRIPT_DIR/release/run-with-retries.sh" 5 10 "Windows native archive download ($cache_key)" \
    curl -fSL --show-error --retry 3 --retry-all-errors --retry-delay 5 \
    --retry-max-time 1800 --connect-timeout 30 --max-time 3600 \
    --continue-at - -o "$temp_cache" "$url"; then
    echo "Error: Unable to download $cache_key after resumable retries"
    return 1
  fi
  if ! verify_sha256 "$temp_cache" "$cache_key"; then
    rm -f "$temp_cache"
    return 1
  fi
  mv "$temp_cache" "$cache_path"
  cp "$cache_path" "$dest"
}

require_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "Error: Missing $label at $path"
    exit 1
  fi
}

require_directory() {
  local path="$1"
  local label="$2"
  if [ ! -d "$path" ]; then
    echo "Error: Missing $label at $path"
    exit 1
  fi
}

copy_required_tool() {
  local source="$1"
  local dest_dir="$2"
  local label="$3"
  require_file "$source" "$label"
  cp "$source" "$dest_dir/"
}

MSYS2_ARM64_RUNTIME_DLL_EXCLUDES=(
  libpango_training.dll
)

should_exclude_msys2_runtime_dll() {
  local dll_name
  dll_name="$(basename "$1" | tr '[:upper:]' '[:lower:]')"

  local excluded_name
  for excluded_name in "${MSYS2_ARM64_RUNTIME_DLL_EXCLUDES[@]}"; do
    if [ "$dll_name" = "$excluded_name" ]; then
      return 0
    fi
  done

  return 1
}

copy_msys2_runtime_dlls() {
  local source_bin="$1"
  local dest_bin="$2"
  local copied=0
  local skipped=0
  local dll_path

  shopt -s nullglob
  for dll_path in "$source_bin"/*.dll; do
    if should_exclude_msys2_runtime_dll "$dll_path"; then
      echo "  Skipping MSYS2 training/development DLL: $(basename "$dll_path")"
      skipped=$((skipped + 1))
      continue
    fi

    cp "$dll_path" "$dest_bin/"
    copied=$((copied + 1))
  done
  shopt -u nullglob

  if [ "$copied" -eq 0 ]; then
    echo "Error: No MSYS2 runtime DLLs found in $source_bin"
    exit 1
  fi

  echo "  Copied $copied MSYS2 runtime DLLs to $dest_bin (skipped $skipped training/development DLLs)"
}

clean_dir() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
}

pe_arch() {
  local file_path="$1"
  local arch
  arch="$(objdump -f "$file_path" 2>/dev/null | sed -n 's/^architecture: \([^,]*\).*/\1/p' | head -n 1)" || true
  if [ -n "$arch" ]; then
    echo "$arch"
    return
  fi
  # Fallback: x64 objdump cannot parse ARM64 PE files (no pei-aarch64 BFD target).
  # Use the file command to detect machine type from the PE header.
  local file_output
  file_output="$(file "$file_path" 2>/dev/null)" || return 0
  if echo "$file_output" | grep -qi 'Aarch64'; then
    echo "aarch64"
  elif echo "$file_output" | grep -qi 'x86-64'; then
    echo "i386:x86-64"
  fi
}

find_dependency_match() {
  local search_root="$1"
  local dep_name="$2"
  local target_arch="$3"
  local first_match=""

  while IFS= read -r candidate; do
    [ -n "$first_match" ] || first_match="$candidate"
    if [ -z "$target_arch" ]; then
      echo "$candidate"
      return 0
    fi

    local candidate_arch
    candidate_arch="$(pe_arch "$candidate")"
    if [ "$candidate_arch" = "$target_arch" ]; then
      echo "$candidate"
      return 0
    fi
  done < <(find "$search_root" -type f -iname "$dep_name" -print)

  if [ -n "$first_match" ]; then
    echo "$first_match"
    return 0
  fi

  return 1
}

bundle_dependency_closure() {
  local search_root="$1"
  local dest_bin="$2"
  local expected_arch="$3"

  local pending=("$dest_bin/ddjvu.exe" "$dest_bin/djvused.exe" "$dest_bin/djvudump.exe")
  local pending_index=0
  declare -A seen_deps=()

  while [ "$pending_index" -lt "${#pending[@]}" ]; do
    local binary="${pending[$pending_index]}"
    pending_index=$((pending_index + 1))

    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      local dep_lc
      dep_lc="$(printf '%s' "$dep" | tr '[:upper:]' '[:lower:]')"

      if [[ -n "${seen_deps[$dep_lc]+x}" ]]; then
        continue
      fi

      local dep_source
      dep_source="$(find_dependency_match "$search_root" "$dep" "$expected_arch" || true)"
      if [ -z "$dep_source" ]; then
        if [[ "$dep_lc" =~ $system_dll_pattern ]]; then
          continue
        fi
        echo "Error: Missing non-system DjVu dependency \"$dep\" needed by $(basename "$binary")"
        exit 1
      fi

      local dep_dest="$dest_bin/$(basename "$dep_source")"
      cp "$dep_source" "$dep_dest"
      seen_deps["$dep_lc"]=1
      pending+=("$dep_dest")
    done < <(objdump -p "$binary" 2>/dev/null | awk '/DLL Name:/{print $3}')
  done
}

verify_directory_architecture() {
  local target_dir="$1"
  local expected_arch="$2"
  local file_path

  while IFS= read -r file_path; do
    local actual_arch
    actual_arch="$(pe_arch "$file_path")"
    if [ -z "$actual_arch" ]; then
      continue
    fi
    if [ "$actual_arch" != "$expected_arch" ]; then
      echo "Error: Architecture mismatch for $(basename "$file_path"): expected $expected_arch, got $actual_arch"
      exit 1
    fi
  done < <(find "$target_dir" -maxdepth 1 -type f \( -iname '*.exe' -o -iname '*.dll' \) -print)
}

# ==========================================
# ARM64: Native binaries via MSYS2 clangarm64
# ==========================================
bundle_arm64_via_msys2() {
  echo ""
  echo "=========================================="
  echo "ARM64: Downloading native aarch64 binaries via MSYS2"
  echo "=========================================="

  local msys2_root="${MSYS2_ROOT:-/c/msys64}"
  local pacman="$msys2_root/usr/bin/pacman.exe"
  local zstd="$msys2_root/usr/bin/zstd.exe"
  local tar="$msys2_root/usr/bin/tar.exe"
  local iso_root="$CACHE_DIR/msys2-arm64"
  local staging="$TEMP_DIR/msys2-staging"
  local staging_for_msys2

  for required_tool in "$pacman" "$zstd" "$tar"; do
    if [ ! -x "$required_tool" ]; then
      echo "Error: MSYS2 ARM64 bundle tool not found at $required_tool"
      exit 1
    fi
  done

  mkdir -p "$iso_root/var/lib/pacman" "$iso_root/var/cache/pacman/pkg" "$iso_root/etc"
  mkdir -p "$staging"

  # Git Bash and the provisioned MSYS2 installation have different POSIX
  # roots. Pass the staging directory to MSYS2's native tar.exe as a Windows
  # path so it does not resolve Git Bash's /tmp inside the MSYS2 root.
  if ! command -v cygpath >/dev/null 2>&1; then
    echo "Error: cygpath is required to pass the Git Bash staging path to MSYS2 tar"
    exit 1
  fi
  staging_for_msys2="$(cygpath -w "$staging")"

  cat > "$iso_root/etc/pacman.conf" <<'PACMAN_CONF'
[options]
Architecture = aarch64
SigLevel = Required DatabaseOptional

[clangarm64]
Server = https://mirror.msys2.org/mingw/clangarm64/
Server = https://repo.msys2.org/mingw/clangarm64/
PACMAN_CONF

  local pacman_opts=(
    --config "$iso_root/etc/pacman.conf"
    --dbpath "$iso_root/var/lib/pacman"
    --cachedir "$iso_root/var/cache/pacman/pkg"
  )

  local packages=(
    mingw-w64-clang-aarch64-tesseract-ocr
    mingw-w64-clang-aarch64-poppler
    mingw-w64-clang-aarch64-qpdf
    mingw-w64-clang-aarch64-djvulibre
  )

  # The redirector hands out volunteer mirrors, and a slow one aborts the whole
  # transaction. Downloaded packages stay in the cache directory, so a retry
  # only fetches what the previous attempt left behind.
  echo "  Syncing clangarm64 package database..."
  "$SCRIPT_DIR/release/run-with-retries.sh" 3 15 "clangarm64 package database sync" \
    "$pacman" "${pacman_opts[@]}" -Sy
  echo "  Resolving clangarm64 package source..."
  "$pacman" "${pacman_opts[@]}" -Sp --noconfirm "${packages[@]}" >/dev/null

  echo "  Downloading packages and dependencies..."
  "$SCRIPT_DIR/release/run-with-retries.sh" 3 15 "clangarm64 package download" \
    "$pacman" "${pacman_opts[@]}" -Sw --noconfirm "${packages[@]}"

  echo "  Extracting packages..."
  for pkg in "$iso_root/var/cache/pacman/pkg"/mingw-w64-clang-aarch64-*.pkg.tar.zst; do
    [ -f "$pkg" ] || continue
    "$zstd" -dq "$pkg" --stdout | "$tar" -xf - -C "$staging_for_msys2"
  done

  local arm64_bin="$staging/clangarm64/bin"
  if [ ! -d "$arm64_bin" ]; then
    echo "Error: Expected directory $arm64_bin not found after extraction"
    exit 1
  fi

  echo ""
  echo "  Setting up Tesseract (arm64)..."
  clean_dir "$TESSERACT_DIR/bin"
  require_file "$arm64_bin/tesseract.exe" "tesseract.exe (arm64)"
  cp "$arm64_bin/tesseract.exe" "$TESSERACT_DIR/bin/"
  copy_msys2_runtime_dlls "$arm64_bin" "$TESSERACT_DIR/bin"
  echo "  Tesseract: $(ls "$TESSERACT_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$TESSERACT_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

  echo ""
  echo "  Setting up Poppler (arm64)..."
  clean_dir "$POPPLER_DIR"
  mkdir -p "$POPPLER_DIR/bin"
  for tool in pdfinfo.exe pdftoppm.exe pdftotext.exe pdfimages.exe pdftocairo.exe; do
    require_file "$arm64_bin/$tool" "$tool (arm64)"
    cp "$arm64_bin/$tool" "$POPPLER_DIR/bin/"
  done
  copy_msys2_runtime_dlls "$arm64_bin" "$POPPLER_DIR/bin"
  # Poppler on Windows also relies on runtime data/config directories.
  # Without these, pdftoppm can crash on some PDFs with access violations.
  if [ -d "$staging/clangarm64/share/poppler" ]; then
    mkdir -p "$POPPLER_DIR/share"
    cp -R "$staging/clangarm64/share/poppler" "$POPPLER_DIR/share/"
  fi
  if [ -d "$staging/clangarm64/etc/fonts" ]; then
    mkdir -p "$POPPLER_DIR/etc"
    cp -R "$staging/clangarm64/etc/fonts" "$POPPLER_DIR/etc/"
  fi
  echo "  Poppler: $(ls "$POPPLER_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$POPPLER_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

  echo ""
  echo "  Setting up qpdf (arm64)..."
  clean_dir "$QPDF_DIR/bin"
  require_file "$arm64_bin/qpdf.exe" "qpdf.exe (arm64)"
  cp "$arm64_bin/qpdf.exe" "$QPDF_DIR/bin/"
  copy_msys2_runtime_dlls "$arm64_bin" "$QPDF_DIR/bin"
  echo "  qpdf: $(ls "$QPDF_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$QPDF_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

  echo ""
  echo "  Setting up DjVuLibre (arm64)..."
  clean_dir "$DJVU_DIR/bin"
  clean_dir "$DJVU_DIR/lib"
  require_file "$arm64_bin/ddjvu.exe" "ddjvu.exe (arm64)"
  require_file "$arm64_bin/djvused.exe" "djvused.exe (arm64)"
  require_file "$arm64_bin/djvudump.exe" "djvudump.exe (arm64)"
  cp "$arm64_bin/ddjvu.exe" "$DJVU_DIR/bin/"
  cp "$arm64_bin/djvused.exe" "$DJVU_DIR/bin/"
  cp "$arm64_bin/djvudump.exe" "$DJVU_DIR/bin/"
  copy_msys2_runtime_dlls "$arm64_bin" "$DJVU_DIR/bin"
  echo "  DjVuLibre: $(ls "$DJVU_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$DJVU_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

  echo ""
  echo "  Verifying aarch64 architecture..."
  verify_directory_architecture "$TESSERACT_DIR/bin" "aarch64"
  verify_directory_architecture "$POPPLER_DIR/bin" "aarch64"
  verify_directory_architecture "$QPDF_DIR/bin" "aarch64"
  verify_directory_architecture "$DJVU_DIR/bin" "aarch64"
}

if [ "${TARGET_ARCH:-x64}" = "arm64" ]; then
  bundle_arm64_via_msys2
else

# ==========================================
# 1. Tesseract (UB-Mannheim)
# ==========================================
echo ""
echo "=========================================="
echo "1. Bundling Tesseract (${TESSERACT_TAG})..."
echo "=========================================="

TESSERACT_DIR="$RESOURCES_DIR/tesseract/$PLATFORM_ARCH"
clean_dir "$TESSERACT_DIR/bin"

TESSERACT_URL="https://github.com/UB-Mannheim/tesseract/releases/download/${TESSERACT_TAG}/${TESSERACT_INSTALLER}"
download "$TESSERACT_URL" "$TEMP_DIR/tesseract-setup.exe" "tesseract-${TESSERACT_TAG}.exe" "$TESSERACT_SHA256"

echo "  Extracting with 7z..."
7z x -y "$TEMP_DIR/tesseract-setup.exe" -o"$TEMP_DIR/tesseract" > /dev/null 2>&1

TESSERACT_EXE="$(find "$TEMP_DIR/tesseract" -name 'tesseract.exe' -print -quit)"
if [ -z "$TESSERACT_EXE" ]; then
  echo "Error: Failed to locate extracted tesseract.exe"
  exit 1
fi
TESSERACT_EXTRACTED="$(dirname "$TESSERACT_EXE")"

echo "  Copying binaries and DLLs..."
copy_required_tool "$TESSERACT_EXTRACTED/tesseract.exe" "$TESSERACT_DIR/bin" "tesseract.exe"
find "$TEMP_DIR/tesseract" -maxdepth 4 -name '*.dll' -exec cp {} "$TESSERACT_DIR/bin/" \; 2>/dev/null || true

echo "  Tesseract: $(ls "$TESSERACT_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$TESSERACT_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 2. Poppler (oschwartz10612)
# ==========================================
echo ""
echo "=========================================="
echo "2. Bundling Poppler from the verified runtime manifest..."
echo "=========================================="

POPPLER_DIR="$RESOURCES_DIR/poppler/$PLATFORM_ARCH"
clean_dir "$POPPLER_DIR"
mkdir -p "$POPPLER_DIR/bin"

if ! command -v cygpath >/dev/null 2>&1; then
  echo "Error: cygpath is required to pass the Git Bash cache path to the Windows Node runtime"
  exit 1
fi
POPPLER_CACHE_DIR_FOR_NODE="$(cygpath -w "$CACHE_DIR")"
# The retry helper writes retry notices to stdout. Keep only the final CLI path
# so a retry cannot turn the archive filename into a malformed shell value.
POPPLER_ARCHIVE_WINDOWS="$("$SCRIPT_DIR/release/run-with-retries.sh" 5 10 "Windows Poppler archive download" \
  node --import tsx "$SCRIPT_DIR/runRuntimeBinaryArchiveCli.ts" fetch poppler "$PLATFORM_ARCH" "$POPPLER_CACHE_DIR_FOR_NODE" \
  | tail -n 1)"
POPPLER_ARCHIVE="$(cygpath -u "$POPPLER_ARCHIVE_WINDOWS")"
POPPLER_MEMBER_PATHS_FILE="$TEMP_DIR/poppler-members.paths"
node --import tsx "$SCRIPT_DIR/runRuntimeBinaryArchiveCli.ts" verify-members poppler "$POPPLER_ARCHIVE_WINDOWS" paths > "$POPPLER_MEMBER_PATHS_FILE"

echo "  Extracting..."
unzip -qo "$POPPLER_ARCHIVE" -d "$TEMP_DIR/poppler"

POPPLER_EXE_RELATIVE="$(sed -n '1p' "$POPPLER_MEMBER_PATHS_FILE")"
if [ -z "$POPPLER_EXE_RELATIVE" ]; then
  echo "Error: Verified Poppler member list did not return an executable"
  exit 1
fi
POPPLER_BIN="$(dirname "$TEMP_DIR/poppler/$POPPLER_EXE_RELATIVE")"
POPPLER_ROOT="$(dirname "$(dirname "$POPPLER_BIN")")"

echo "  Copying binaries and DLLs..."
POPPLER_EXE_MEMBER_PATHS_FILE="$TEMP_DIR/poppler-exe-members.paths"
if ! awk 'tolower($0) ~ /\.exe$/ {print}' "$POPPLER_MEMBER_PATHS_FILE" > "$POPPLER_EXE_MEMBER_PATHS_FILE"; then
  echo "Error: Failed to read validated Poppler executable member paths"
  exit 1
fi
while IFS= read -r executable_entry; do
  copy_required_tool "$TEMP_DIR/poppler/$executable_entry" "$POPPLER_DIR/bin" "$(basename "$executable_entry")"
done < "$POPPLER_EXE_MEMBER_PATHS_FILE"
POPPLER_DLL_MEMBER_PATHS_FILE="$TEMP_DIR/poppler-dll-members.paths"
if ! awk 'tolower($0) ~ /\.dll$/ {print}' "$POPPLER_MEMBER_PATHS_FILE" > "$POPPLER_DLL_MEMBER_PATHS_FILE"; then
  echo "Error: Failed to read validated Poppler DLL member paths"
  exit 1
fi
while IFS= read -r dll_entry; do
  copy_required_tool "$TEMP_DIR/poppler/$dll_entry" "$POPPLER_DIR/bin" "$(basename "$dll_entry")"
done < "$POPPLER_DLL_MEMBER_PATHS_FILE"
POPPLER_EXPECTED_EXE_COUNT="$(awk 'END {print NR}' "$POPPLER_EXE_MEMBER_PATHS_FILE")"
POPPLER_COPIED_EXE_COUNT="$(find "$POPPLER_DIR/bin" -maxdepth 1 -type f -iname '*.exe' | wc -l)"
if [ "$POPPLER_EXPECTED_EXE_COUNT" -eq 0 ] || [ "$POPPLER_COPIED_EXE_COUNT" -ne "$POPPLER_EXPECTED_EXE_COUNT" ]; then
  echo "Error: Copied $POPPLER_COPIED_EXE_COUNT Poppler executables, expected $POPPLER_EXPECTED_EXE_COUNT"
  exit 1
fi
# The five shipped Poppler CLI tools use poppler.dll directly and never import
# the optional GLib binding. Upstream includes poppler-glib.dll without its GLib
# runtime closure, so retaining it creates an unusable orphan and needlessly
# expands the package. Keep the CLI closure minimal and independently valid.
rm -f "$POPPLER_DIR/bin/poppler-glib.dll"
POPPLER_EXPECTED_DLL_COUNT="$(awk 'END {print NR}' "$POPPLER_DLL_MEMBER_PATHS_FILE")"
POPPLER_COPIED_DLL_COUNT="$(find "$POPPLER_DIR/bin" -maxdepth 1 -type f -iname '*.dll' | wc -l)"
if [ "$POPPLER_EXPECTED_DLL_COUNT" -eq 0 ] || [ "$POPPLER_COPIED_DLL_COUNT" -ne "$POPPLER_EXPECTED_DLL_COUNT" ]; then
  echo "Error: Copied $POPPLER_COPIED_DLL_COUNT Poppler DLLs, expected $POPPLER_EXPECTED_DLL_COUNT"
  exit 1
fi

# Poppler on Windows also relies on runtime data/config directories.
# Without these, pdftoppm can crash on some PDFs with access violations.
require_directory "$POPPLER_ROOT/share/poppler" "Poppler data directory from the verified archive"
mkdir -p "$POPPLER_DIR/share"
cp -R "$POPPLER_ROOT/share/poppler" "$POPPLER_DIR/share/"

if [ -d "$POPPLER_ROOT/Library/etc/fonts" ]; then
  mkdir -p "$POPPLER_DIR/etc"
  cp -R "$POPPLER_ROOT/Library/etc/fonts" "$POPPLER_DIR/etc/"
elif [ -d "$POPPLER_ROOT/etc/fonts" ]; then
  mkdir -p "$POPPLER_DIR/etc"
  cp -R "$POPPLER_ROOT/etc/fonts" "$POPPLER_DIR/etc/"
fi

echo "  Poppler: $(ls "$POPPLER_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$POPPLER_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 3. qpdf
# ==========================================
echo ""
echo "=========================================="
echo "3. Bundling qpdf from the verified runtime manifest..."
echo "=========================================="

QPDF_DIR="$RESOURCES_DIR/qpdf/$PLATFORM_ARCH"
clean_dir "$QPDF_DIR/bin"

if ! command -v cygpath >/dev/null 2>&1; then
  echo "Error: cygpath is required to pass the Git Bash cache path to the Windows Node runtime"
  exit 1
fi
QPDF_CACHE_DIR_FOR_NODE="$(cygpath -w "$CACHE_DIR")"
# The retry helper writes retry notices to stdout. Keep only the final CLI path
# so a retry cannot turn the archive filename into a malformed shell value.
QPDF_ARCHIVE_WINDOWS="$("$SCRIPT_DIR/release/run-with-retries.sh" 5 10 "Windows qpdf archive download" \
  node --import tsx "$SCRIPT_DIR/runRuntimeBinaryArchiveCli.ts" fetch qpdf "$PLATFORM_ARCH" "$QPDF_CACHE_DIR_FOR_NODE" \
  | tail -n 1)"
QPDF_ARCHIVE="$(cygpath -u "$QPDF_ARCHIVE_WINDOWS")"
QPDF_MEMBER_PATHS_FILE="$TEMP_DIR/qpdf-members.paths"
node --import tsx "$SCRIPT_DIR/runRuntimeBinaryArchiveCli.ts" verify-members "$QPDF_ARCHIVE_WINDOWS" paths > "$QPDF_MEMBER_PATHS_FILE"

echo "  Extracting..."
unzip -qo "$QPDF_ARCHIVE" -d "$TEMP_DIR/qpdf"

QPDF_EXE_RELATIVE="$(sed -n '1p' "$QPDF_MEMBER_PATHS_FILE")"
QPDF_EXE="$TEMP_DIR/qpdf/$QPDF_EXE_RELATIVE"
require_file "$QPDF_EXE" "qpdf.exe from the verified qpdf archive"

echo "  Copying binaries and DLLs..."
copy_required_tool "$QPDF_EXE" "$QPDF_DIR/bin" "qpdf.exe"
QPDF_DLL_MEMBER_PATHS_FILE="$TEMP_DIR/qpdf-dll-members.paths"
if ! tail -n +2 "$QPDF_MEMBER_PATHS_FILE" > "$QPDF_DLL_MEMBER_PATHS_FILE"; then
  echo "Error: Failed to read validated qpdf DLL member paths"
  exit 1
fi
while IFS= read -r dll_entry; do
  copy_required_tool "$TEMP_DIR/qpdf/$dll_entry" "$QPDF_DIR/bin" "$(basename "$dll_entry")"
done < "$QPDF_DLL_MEMBER_PATHS_FILE"
QPDF_EXPECTED_DLL_COUNT="$(awk 'END {print NR}' "$QPDF_DLL_MEMBER_PATHS_FILE")"
QPDF_COPIED_DLL_COUNT="$(find "$QPDF_DIR/bin" -maxdepth 1 -type f -iname '*.dll' | wc -l)"
if [ "$QPDF_EXPECTED_DLL_COUNT" -eq 0 ] || [ "$QPDF_COPIED_DLL_COUNT" -ne "$QPDF_EXPECTED_DLL_COUNT" ]; then
  echo "Error: Copied $QPDF_COPIED_DLL_COUNT qpdf DLLs, expected $QPDF_EXPECTED_DLL_COUNT"
  exit 1
fi

echo "  qpdf: $(ls "$QPDF_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$QPDF_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

# ==========================================
# 4. DjVuLibre (SourceForge)
# ==========================================
echo ""
echo "=========================================="
echo "4. Bundling DjVuLibre..."
echo "=========================================="

DJVU_DIR="$RESOURCES_DIR/djvulibre/$PLATFORM_ARCH"
clean_dir "$DJVU_DIR/bin"
clean_dir "$DJVU_DIR/lib"

if ! command -v objdump >/dev/null 2>&1; then
  echo "Error: objdump is required to bundle DjVu dependencies safely"
  exit 1
fi

DJVULIBRE_URL="https://sourceforge.net/projects/djvu/files/${DJVULIBRE_SF_PATH}/${DJVULIBRE_INSTALLER}/download"
download "$DJVULIBRE_URL" "$TEMP_DIR/djvulibre-setup.exe" "djvulibre-${DJVULIBRE_SF_PATH//\//_}.exe" "$DJVULIBRE_SHA256"

echo "  Extracting with 7z..."
7z x -y "$TEMP_DIR/djvulibre-setup.exe" -o"$TEMP_DIR/djvulibre" > /dev/null 2>&1

DJVU_DDJVU_EXE="$(find "$TEMP_DIR/djvulibre" -name 'ddjvu.exe' -print -quit)"
if [ -z "$DJVU_DDJVU_EXE" ]; then
  echo "Error: Failed to locate extracted ddjvu.exe"
  exit 1
fi
DJVU_EXTRACTED="$(dirname "$DJVU_DDJVU_EXE")"

echo "  Copying binaries and DLLs..."
copy_required_tool "$DJVU_EXTRACTED/ddjvu.exe" "$DJVU_DIR/bin" "ddjvu.exe"
copy_required_tool "$DJVU_EXTRACTED/djvused.exe" "$DJVU_DIR/bin" "djvused.exe"
copy_required_tool "$DJVU_EXTRACTED/djvudump.exe" "$DJVU_DIR/bin" "djvudump.exe"

DJVU_ARCH="$(pe_arch "$DJVU_DIR/bin/ddjvu.exe")"
if [ -z "$DJVU_ARCH" ]; then
  echo "Error: Failed to detect architecture for DjVu binaries"
  exit 1
fi

bundle_dependency_closure "$TEMP_DIR/djvulibre" "$DJVU_DIR/bin" "$DJVU_ARCH"
verify_directory_architecture "$DJVU_DIR/bin" "$DJVU_ARCH"

echo "  DjVuLibre: $(ls "$DJVU_DIR/bin/"*.exe 2>/dev/null | wc -l) exe, $(ls "$DJVU_DIR/bin/"*.dll 2>/dev/null | wc -l) dlls"

fi  # end x64/arm64 branch

# ==========================================
# Note: Unpaper is intentionally unavailable on Windows packages until a
# reproducible, architecture-verified source is added. Runtime preprocessing
# validation must report unpaper as missing on win32-* packages.
# ==========================================
echo ""
echo "Note: Unpaper is intentionally unavailable on Windows packages."

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

verify_tool "$TESSERACT_DIR/bin/tesseract.exe" "tesseract"
verify_tool "$POPPLER_DIR/bin/pdfinfo.exe" "pdfinfo"
verify_tool "$POPPLER_DIR/bin/pdftoppm.exe" "pdftoppm"
verify_tool "$POPPLER_DIR/bin/pdftocairo.exe" "pdftocairo"
verify_tool "$POPPLER_DIR/bin/pdftotext.exe" "pdftotext"
verify_tool "$POPPLER_DIR/bin/pdfimages.exe" "pdfimages"
verify_dir "$POPPLER_DIR/share/poppler" "poppler data directory"
verify_tool "$QPDF_DIR/bin/qpdf.exe" "qpdf"
verify_tool "$DJVU_DIR/bin/ddjvu.exe" "ddjvu"
verify_tool "$DJVU_DIR/bin/djvused.exe" "djvused"
verify_tool "$DJVU_DIR/bin/djvudump.exe" "djvudump"

# Treat the current large upstream Windows OCR distribution as an explicit,
# measured budget. This prevents silent growth while a smaller source-built PE
# payload remains an evidence-gated follow-up.
node "$SCRIPT_DIR/release/windows-tesseract-payload-policy.mjs" "$TESSERACT_DIR/bin"

windows_pe_files="$(mktemp)"
find "$TESSERACT_DIR/bin" "$POPPLER_DIR/bin" "$QPDF_DIR/bin" "$DJVU_DIR/bin" \
  -type f \( -iname '*.exe' -o -iname '*.dll' \) -print > "$windows_pe_files"
if [ "${TARGET_ARCH:-x64}" = "arm64" ]; then
  allowed_pe_machines="arm64"
else
  allowed_pe_machines="ia32,x64"
fi
node "$SCRIPT_DIR/release/windows-pe-dependencies.mjs" verify \
  --allowed-machines "$allowed_pe_machines" \
  --system-dll-pattern-file "$SCRIPT_DIR/win-system-dll-pattern.sh" \
  --file-list "$windows_pe_files"
rm -f "$windows_pe_files"

if [ "$missing_count" -gt 0 ]; then
  echo ""
  echo "Error: Bundle verification failed ($missing_count required files missing)"
  exit 1
fi

echo ""
echo "Total bundle size:"
du -sh "$TESSERACT_DIR" "$POPPLER_DIR" "$QPDF_DIR" "$DJVU_DIR" 2>/dev/null || true

# Cleanup
echo ""
echo "Cleaning up temp files..."
rm -rf "$TEMP_DIR"

echo ""
echo "Done!"
