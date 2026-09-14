#!/bin/bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

usage() {
  cat <<'EOF'
Usage: scripts/check-native-tools-source-matrix.sh [--all]

Default mode:
- Validate native tool resources for the current host platform/arch

--all mode:
- Validate source readiness for the full release matrix. Generated non-host
  native tool folders may be absent locally when a CI bundling script owns that
  target.
  Other host resources are still required unless
  EVB_NATIVE_TOOLS_ALLOW_HOST_CI_GEN=1 is set for a pre-bundle CI quality gate.
EOF
}

check_all=0
if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi
if [ "$#" -eq 1 ]; then
  case "$1" in
    --all)
      check_all=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
fi

missing=0
tag_file="$(mktemp)"
manifest_entries_file="$(mktemp)"
trap 'rm -f "$tag_file" "$manifest_entries_file"' EXIT
native_manifest_cli=(node --import tsx scripts/nativeResourceManifestCli.ts)

resolve_host_tag() {
  local uname_s
  local uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"

  local platform=""
  local arch=""

  case "$uname_s" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) platform="win32" ;;
    *)
      echo "Error: Unsupported host platform: $uname_s"
      exit 1
      ;;
  esac

  case "$uname_m" in
    x86_64|amd64|x64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "Error: Unsupported host architecture: $uname_m"
      exit 1
      ;;
  esac

  echo "${platform}-${arch}"
}

host_tag="$(resolve_host_tag)"
allow_host_ci_gen="${EVB_NATIVE_TOOLS_ALLOW_HOST_CI_GEN:-0}"

has_ci_bundler_for_tag() {
  local tag="$1"
  case "$tag" in
    darwin-arm64|darwin-x64)
      [ -f "scripts/bundle-tesseract-macos.sh" ] \
        && [ -f "scripts/bundle-pdf-tools-macos.sh" ] \
        && [ -f "scripts/bundle-djvu-macos.sh" ] \
        && [ -f "scripts/build-macos-pdf-print-dialog.sh" ]
      ;;
    linux-arm64|linux-x64)
      [ -f "scripts/bundle-tools-linux.sh" ]
      ;;
    win32-arm64|win32-x64)
      [ -f "scripts/bundle-tools-windows.sh" ]
      ;;
    *)
      return 1
      ;;
  esac
}

mark_missing() {
  local path="$1"
  local label="$2"
  local tag="$3"

  if [ "$check_all" -eq 1 ] \
    && { [ "$tag" != "$host_tag" ] || [ "$allow_host_ci_gen" = "1" ]; } \
    && has_ci_bundler_for_tag "$tag"; then
    echo "  CI-GEN  $label: $path"
    return
  fi

  echo "  MISSING $label: $path"
  missing=1
}

check_file_for_tag() {
  local path="$1"
  local label="$2"
  local tag="$3"
  if [ ! -f "$path" ]; then
    mark_missing "$path" "$label" "$tag"
  else
    echo "  OK      $label: $path"
  fi
}

check_dir_for_tag() {
  local path="$1"
  local label="$2"
  local tag="$3"
  if [ ! -d "$path" ]; then
    mark_missing "$path" "$label" "$tag"
  else
    echo "  OK      $label: $path"
  fi
}

check_windows_arm64_runtime_dll_policy() {
  local bundler="scripts/bundle-tools-windows.sh"
  local failed=0

  echo "== Checking Windows ARM64 runtime DLL bundle policy =="

  if ! grep -Fq "MSYS2_ARM64_RUNTIME_DLL_EXCLUDES=(" "$bundler" \
    || ! grep -Fq "libpango_training.dll" "$bundler"; then
    echo "  FAIL    Windows ARM64 MSYS2 bundle policy must exclude libpango_training.dll"
    failed=1
  fi

  local required_runtime_copy
  for required_runtime_copy in \
    'copy_msys2_runtime_dlls "$arm64_bin" "$TESSERACT_DIR/bin"' \
    'copy_msys2_runtime_dlls "$arm64_bin" "$POPPLER_DIR/bin"' \
    'copy_msys2_runtime_dlls "$arm64_bin" "$QPDF_DIR/bin"' \
    'copy_msys2_runtime_dlls "$arm64_bin" "$DJVU_DIR/bin"'
  do
    if ! grep -Fq "$required_runtime_copy" "$bundler"; then
      echo "  FAIL    Missing ARM64 runtime DLL copy policy: $required_runtime_copy"
      failed=1
    fi
  done

  local blind_copy
  for blind_copy in \
    'cp "$arm64_bin/"*.dll "$TESSERACT_DIR/bin/"' \
    'cp "$arm64_bin/"*.dll "$POPPLER_DIR/bin/"' \
    'cp "$arm64_bin/"*.dll "$QPDF_DIR/bin/"' \
    'cp "$arm64_bin/"*.dll "$DJVU_DIR/bin/"'
  do
    if grep -Fq "$blind_copy" "$bundler"; then
      echo "  FAIL    ARM64 Windows bundler must not blindly copy MSYS2 DLLs: $blind_copy"
      failed=1
    fi
  done

  if [ "$failed" -ne 0 ]; then
    missing=1
    return
  fi

  echo "  OK      libpango_training.dll is excluded and ARM64 bundles use the runtime DLL policy"
}

check_tag() {
  local tag="$1"
  local entry_type
  local entry_path
  local entry_label

  echo "== Checking $tag =="
  if ! "${native_manifest_cli[@]}" source-matrix "$tag" > "$manifest_entries_file"; then
    echo "Error: Unable to load native resource manifest entries for $tag" >&2
    exit 1
  fi

  while IFS=$'\t' read -r entry_type entry_path entry_label; do
    [ -n "$entry_type" ] || continue
    case "$entry_type" in
      file)
        check_file_for_tag "$entry_path" "$entry_label" "$tag"
        ;;
      directory)
        check_dir_for_tag "$entry_path" "$entry_label" "$tag"
        ;;
      *)
        echo "Error: Unsupported native resource manifest entry type for $tag: $entry_type" >&2
        exit 1
        ;;
    esac
  done < "$manifest_entries_file"

}

if [ "$check_all" -eq 1 ]; then
  "${native_manifest_cli[@]}" matrix-tags > "$tag_file"
else
  resolve_host_tag >> "$tag_file"
fi

sort -u "$tag_file" -o "$tag_file"

while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  check_tag "$tag"
done < "$tag_file"

if [ ! -d "resources/tesseract/tessdata" ]; then
  echo "MISSING tessdata directory: resources/tesseract/tessdata"
  missing=1
elif ! find "resources/tesseract/tessdata" -maxdepth 1 -type f -name '*.traineddata' -print -quit | grep -q .; then
  echo "MISSING traineddata files in resources/tesseract/tessdata"
  missing=1
else
  echo "OK tessdata directory and traineddata files present"
  if [ ! -s "resources/tesseract/tessdata/pdf.ttf" ]; then
    echo "MISSING Tesseract PDF font: resources/tesseract/tessdata/pdf.ttf"
    missing=1
  else
    echo "OK Tesseract PDF font: resources/tesseract/tessdata/pdf.ttf"
  fi
  if [ "${EVB_BUILD_ARTIFACTS_PREPARED:-0}" != "1" ]; then
    node --import tsx scripts/generateElectronBuilderResources.ts
  fi
fi

if [ "$missing" -ne 0 ]; then
  if [ "$check_all" -eq 1 ]; then
    echo "Native tool source matrix check failed (--all)."
  else
    echo "Native tool source matrix check failed (host tag)."
  fi
  exit 1
fi

echo ""
bash "$root_dir/scripts/check-win-dll-allowlist.sh"
check_windows_arm64_runtime_dll_policy

if [ "$missing" -ne 0 ]; then
  echo "Native tool source matrix check failed (Windows ARM64 runtime DLL policy)."
  exit 1
fi

if [ "$check_all" -eq 1 ]; then
  echo "Native tool source matrix check passed (--all)."
else
  echo "Native tool source matrix check passed (host tag)."
fi
