#!/bin/bash
set -euo pipefail

source "$(dirname "$0")/release/platform-arch.sh"
source "$(dirname "$0")/release/packaged-native-root-set.sh"
source "$(dirname "$0")/sha256-file.sh"

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <platform: mac|win|linux> <arch: x64|arm64> [release-dir]"
  exit 1
fi

platform="$1"
arch="$2"
release_dir="${3:-release}"
resolve_release_target_platform_arch "$platform" "$arch"
platform_arch="$RELEASE_PLATFORM_ARCH"

release_entries_file="$(mktemp)"
trap 'rm -f "$release_entries_file"' EXIT
if ! node --import tsx scripts/nativeResourceManifestCli.ts packaged-entries "$platform_arch" > "$release_entries_file"; then
  echo "Error: Unable to load packaged release targets"
  exit 1
fi
if ! awk -F'\037' 'NF != 6 || $1 == "" || $3 == "" || $4 == "" || $5 == "" || $6 == "" { exit 1 }' "$release_entries_file"; then
  echo "Error: Packaged release targets are not six unit-separated fields per row"
  exit 1
fi
sentinel_family_root=""
while IFS=$'\037' read -r entry_scope staged_root _relative_path _entry_type _entry_label _entry_id; do
  if [ "$entry_scope" = "native" ] && [ -n "$staged_root" ]; then
    sentinel_family_root="$staged_root"
    break
  fi
done < "$release_entries_file"
if [ -z "$sentinel_family_root" ]; then
  echo "Error: Release target manifest has no native tool families"
  exit 1
fi

resource_root=""
native_tool_root=""
mac_app_path=""
if [ "$platform" = "mac" ]; then
  while IFS= read -r -d '' candidate; do
    if [ -d "$candidate/$sentinel_family_root/$platform_arch" ]; then
      native_tool_root="$candidate"
      contents_dir="$(dirname "$(dirname "$candidate")")"
      resource_root="$contents_dir/Resources"
      mac_app_path="$(dirname "$contents_dir")"
      break
    fi
  done < <(find "$release_dir" -path "*/Contents/MacOS/native-tools" -type d -print0)
else
  while IFS= read -r -d '' candidate; do
    if [ -d "$candidate/$sentinel_family_root/$platform_arch" ]; then
      resource_root="$candidate"
      native_tool_root="$candidate"
      break
    fi
  done < <(find "$release_dir" -type d \( -name resources -o -name Resources \) -print0)
fi

if [ -z "$resource_root" ] || [ -z "$native_tool_root" ]; then
  echo "Error: Could not locate packaged native tools for $platform_arch in $release_dir/"
  exit 1
fi

echo "Verifying packaged native tools in: $native_tool_root"

# Derive the packaged native tool family roots and generated binaries from the single
# release-target manifest (scripts/nativeResourceManifest.ts) so this verifier, the
# staging generator, and the afterPack hook never drift on their target lists.
packaged_family_roots=()
while IFS=$'\037' read -r entry_scope staged_root _relative_path _entry_type _entry_label _entry_id; do
  if [ "$entry_scope" = "native" ]; then
    append_packaged_family_root "$staged_root"
  fi
done < "$release_entries_file"

check_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "Error: Missing $label ($path)"
    exit 1
  fi
}

check_dir() {
  local path="$1"
  local label="$2"
  if [ ! -d "$path" ]; then
    echo "Error: Missing $label ($path)"
    exit 1
  fi
}

check_no_absolute_symlinks() {
  local root="$1"
  local label="$2"
  local has_absolute_symlink=0

  while IFS= read -r -d '' link_path; do
    local target
    target="$(readlink "$link_path" || true)"
    case "$target" in
      /*)
        echo "Error: Absolute symlink in $label: $link_path -> $target"
        has_absolute_symlink=1
        ;;
    esac
  done < <(find "$root" -type l -print0)

  if [ "$has_absolute_symlink" -ne 0 ]; then
    exit 1
  fi
}

get_bundled_language_codes() {
  pnpm exec tsx scripts/printOcrLanguageCodes.ts --bundled
}

verify_tessdata_bundle_complete() {
  local tessdata_path="$1"
  local missing=0
  local registry_code
  while IFS= read -r bundled_code; do
    [ -n "$bundled_code" ] || continue
    if [ ! -s "$tessdata_path/$bundled_code.traineddata" ]; then
      echo "Error: Missing default packaged tessdata \"$bundled_code\" ($tessdata_path/$bundled_code.traineddata)"
      missing=1
    fi
  done < <(get_bundled_language_codes)

  local traineddata_file
  while IFS= read -r -d '' traineddata_file; do
    local code
    code="$(basename "$traineddata_file" .traineddata)"
    if ! get_bundled_language_codes | grep -Fxq "$code"; then
      echo "Error: Packaged tessdata contains non-default language \"$code\" ($traineddata_file)"
      missing=1
    fi
  done < <(find "$tessdata_path" -maxdepth 1 -type f -name '*.traineddata' -print0)

  if [ "$missing" -ne 0 ]; then
    exit 1
  fi
}

verify_tesseract_pdf_font() {
  local tessdata_path="$1"
  local font_path="$tessdata_path/pdf.ttf"
  check_file "$font_path" "Tesseract PDF font"

  local expected_sha256
  expected_sha256="$(node --import tsx -e "import {TESSERACT_PDF_FONT_SHA256} from './scripts/tesseractPdfFont.ts'; console.log(TESSERACT_PDF_FONT_SHA256)")"
  local actual_sha256
  actual_sha256="$(sha256_file "$font_path")"
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "Error: Tesseract PDF font SHA-256 mismatch ($font_path)"
    echo "  expected: $expected_sha256"
    echo "  actual:   $actual_sha256"
    exit 1
  fi
}

macos_macho_arch_for_release_arch() {
  case "$1" in
    arm64)
      echo "arm64"
      ;;
    x64)
      echo "x86_64"
      ;;
    *)
      echo "Error: Unsupported macOS release architecture for Mach-O verification: $1"
      exit 1
      ;;
  esac
}

check_macos_file_arch() {
  local file_path="$1"
  local expected_arch="$2"
  if ! file "$file_path" 2>/dev/null | grep -q 'Mach-O'; then
    return 0
  fi

  local archs
  archs="$(lipo -archs "$file_path" 2>/dev/null || true)"
  if [ -z "$archs" ]; then
    echo "Error: Unable to determine Mach-O architecture for $file_path"
    return 1
  fi

  case " $archs " in
    *" $expected_arch "*)
      return 0
      ;;
    *)
      echo "Error: $file_path does not contain expected architecture $expected_arch (found: $archs)"
      return 1
      ;;
  esac
}

is_macos_app_adhoc_signed() {
  local app_path="$1"
  if [ -z "$app_path" ] || [ ! -d "$app_path" ]; then
    return 1
  fi

  local sign_info
  sign_info="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"
  echo "$sign_info" | grep -Eq 'Signature=adhoc|TeamIdentifier=not set'
}

tessdata_dir=""
while IFS=$'\037' read -r entry_scope staged_root relative_path entry_type entry_label entry_id; do
  if [ "$entry_scope" = "native" ]; then
    entry_path="$native_tool_root/$staged_root/$platform_arch/$relative_path"
  else
    entry_path="$resource_root/$relative_path"
  fi
  if [ "$entry_type" = "file" ]; then
    check_file "$entry_path" "$entry_label"
  else
    check_dir "$entry_path" "$entry_label"
  fi
  if [ "$entry_id" = "tessdata" ]; then
    tessdata_dir="$entry_path"
  fi
done < "$release_entries_file"
if [ -z "$tessdata_dir" ]; then
  echo "Error: Release target manifest has no tessdata resource"
  exit 1
fi
if ! find "$tessdata_dir" -maxdepth 1 -type f -name '*.traineddata' -print -quit | grep -q .; then
  echo "Error: No traineddata files found in $tessdata_dir"
  exit 1
fi
verify_tessdata_bundle_complete "$tessdata_dir"
verify_tesseract_pdf_font "$tessdata_dir"

packaged_entry_path() {
  local requested_id="$1"
  local entry_scope
  local staged_root
  local relative_path
  local entry_type
  local entry_label
  local entry_id
  while IFS=$'\037' read -r entry_scope staged_root relative_path entry_type entry_label entry_id; do
    if [ "$entry_scope" = "native" ] && [ "$entry_id" = "$requested_id" ]; then
      echo "$native_tool_root/$staged_root/$platform_arch/$relative_path"
      return
    fi
  done < "$release_entries_file"
  echo "Error: Release target manifest has no packaged entry '$requested_id'" >&2
  return 1
}

find_tool_files() {
  local tag="$1"
  local kind="$2"
  local staged_root

  for staged_root in "${packaged_family_roots[@]}"; do
    local dir="$native_tool_root/$staged_root/$tag/$kind"
    if [ -d "$dir" ]; then
      find "$dir" -type f
    fi
  done
}

run_macos_tool_once() {
  local command_path="$1"
  shift
  "$command_path" "$@"
}

run_macos_ad_hoc_payload_smoke_mirror() {
  local tool_name="$1"
  shift
  local tool_path="$1"
  shift
  local relative_tool_path="${tool_path#"$native_tool_root"/}"
  local tool_family="${relative_tool_path%%/*}"
  local remaining_path="${relative_tool_path#*/}"
  local tool_tag="${remaining_path%%/*}"
  local payload_root="$native_tool_root/$tool_family/$tool_tag"
  local temp_dir
  local mirror_root
  local mirror_payload_root
  local mirror_tool_path
  local output_file
  local exit_code=0

  if [ "$relative_tool_path" = "$tool_path" ] || [ "$tool_family" = "$relative_tool_path" ] || [ "$tool_tag" = "$remaining_path" ]; then
    echo "Error: Unable to mirror packaged tool path: $tool_path"
    return 1
  fi
  if [ ! -d "$payload_root" ]; then
    echo "Error: Missing packaged payload root for smoke mirror ($payload_root)"
    return 1
  fi

  temp_dir="$(mktemp -d)"
  mirror_root="$temp_dir/native-tools"
  mirror_payload_root="$mirror_root/$tool_family/$tool_tag"
  mirror_tool_path="$mirror_root/$relative_tool_path"
  output_file="$(mktemp)"

  mkdir -p "$(dirname "$mirror_payload_root")"
  cp -R "$payload_root" "$mirror_payload_root"

  echo "Ad-hoc macOS app execution was killed by provenance policy; smoke testing copied signed payload outside .app: $mirror_tool_path $*"
  if run_macos_tool_once "$mirror_tool_path" "$@" >"$output_file" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi

  if ! node scripts/release/assert-packaged-tool-smoke.mjs "$tool_name" "$exit_code" "$output_file"; then
    cat "$output_file"
    rm -rf "$temp_dir"
    rm -f "$output_file"
    return 1
  fi

  rm -rf "$temp_dir"
  rm -f "$output_file"
  return 0
}

run_macos_packaged_tool_smoke() {
  local tool_name="$1"
  shift
  local tool_path="$1"
  shift
  local output_file
  output_file="$(mktemp)"

  if [ ! -f "$tool_path" ]; then
    echo "Error: Missing packaged tool for smoke test ($tool_path)"
    exit 1
  fi

  echo "Smoke testing packaged tool: $tool_path $*"
  local exit_code=0
  local attempt=1
  local max_attempts=18
  local is_adhoc_app=0
  if is_macos_app_adhoc_signed "$mac_app_path"; then
    is_adhoc_app=1
    max_attempts=1
  fi
  while true; do
    : >"$output_file"
    if run_macos_tool_once "$tool_path" "$@" >"$output_file" 2>&1
    then
      exit_code=0
    else
      exit_code=$?
    fi

    if [ "$exit_code" -ne 137 ] || [ "$attempt" -ge "$max_attempts" ]; then
      break
    fi

    echo "Packaged tool was killed by macOS immediately after signing; verifying signature and retrying ($attempt/$max_attempts): $tool_path"
    codesign --verify --strict --verbose=2 "$tool_path"
    sleep 5
    attempt=$((attempt + 1))
  done

  if [ "$exit_code" -eq 137 ] && [ "$is_adhoc_app" -eq 1 ]; then
    codesign --verify --strict --verbose=2 "$tool_path"
    if run_macos_ad_hoc_payload_smoke_mirror "$tool_name" "$tool_path" "$@"; then
      rm -f "$output_file"
      return
    fi
  fi

  if ! node scripts/release/assert-packaged-tool-smoke.mjs "$tool_name" "$exit_code" "$output_file"; then
    cat "$output_file"
    rm -f "$output_file"
    if [ "$exit_code" -eq 0 ]; then
      exit 1
    fi
    exit "$exit_code"
  fi

  rm -f "$output_file"
}

host_release_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      echo "x64"
      ;;
    arm64|aarch64)
      echo "arm64"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

host_can_execute_target() {
  local target_platform="$1"
  local target_arch="$2"
  local host_os
  host_os="$(uname -s)"
  local host_arch
  host_arch="$(host_release_arch)"

  if [ "$host_arch" != "$target_arch" ]; then
    return 1
  fi

  case "$target_platform:$host_os" in
    linux:Linux)
      return 0
      ;;
    win:MINGW*|win:MSYS*|win:CYGWIN*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

windows_pe_allowed_machines_for_release_arch() {
  case "$1" in
    arm64)
      echo "arm64"
      ;;
    x64)
      echo "ia32,x64"
      ;;
    *)
      echo "Error: Unsupported Windows release architecture for PE verification: $1"
      exit 1
      ;;
  esac
}

# Shares the one exit-code and output-signature policy with the macOS helper
# (scripts/release/native-tool-smoke-policy.mjs) instead of carrying a second,
# looser expectation per call site.
run_host_packaged_tool_smoke() {
  local tool_name="$1"
  shift
  local tool_path="$1"
  shift
  local output_file
  output_file="$(mktemp)"

  if [ ! -f "$tool_path" ]; then
    echo "Error: Missing packaged tool for smoke test ($tool_path)"
    exit 1
  fi

  echo "Smoke testing packaged tool: $tool_path $*"
  local exit_code=0
  "$tool_path" "$@" >"$output_file" 2>&1 || exit_code=$?

  if ! node scripts/release/assert-packaged-tool-smoke.mjs "$tool_name" "$exit_code" "$output_file"; then
    cat "$output_file"
    rm -f "$output_file"
    if [ "$exit_code" -eq 0 ]; then
      exit 1
    fi
    exit "$exit_code"
  fi

  rm -f "$output_file"
}

# Version and protocol numbers are schema-additive-stable, so they cannot tell a
# current sidecar from one built before the fields its consumers now read. This
# runs the packaged binary over a synthesized spread and asserts the fold-clip
# terms come back in the metadata it writes.
run_packaged_scan_cleanup_fold_clip_smoke() {
  local tool_path="$1"

  if [ ! -f "$tool_path" ]; then
    echo "Error: Missing packaged tool for fold-clip smoke test ($tool_path)"
    exit 1
  fi

  echo "Functionally smoke testing packaged sidecar metadata: $tool_path"
  if ! node scripts/release/assert-packaged-scan-cleanup-fold-clip.mjs "$tool_path"; then
    exit 1
  fi
}

if [ "$platform" = "mac" ]; then
  if ! command -v lipo >/dev/null 2>&1; then
    echo "Error: lipo is required for macOS architecture verification"
    exit 1
  fi
  if ! command -v file >/dev/null 2>&1; then
    echo "Error: file is required for macOS architecture verification"
    exit 1
  fi

  expected_macho_arch="$(macos_macho_arch_for_release_arch "$arch")"
  readonly_update_payload=0
  while IFS= read -r payload_path; do
    echo "Error: macOS update payload is not owner-writable; ShipIt cannot remove quarantine metadata: $payload_path"
    readonly_update_payload=1
  done < <(find "$native_tool_root" \( -type f -o -type d \) ! -perm -u+w -print)
  if [ "$readonly_update_payload" -ne 0 ]; then
    exit 1
  fi

  unresolved=0
  arch_mismatch=0
  while IFS= read -r file; do
    refs="$(otool -L "$file" 2>/dev/null | grep -E '/opt/homebrew|/usr/local/opt|/usr/local/Cellar' || true)"
    if [ -n "$refs" ]; then
      echo "Error: Unresolved Homebrew reference in $file"
      echo "$refs" | sed 's/^/  /'
      unresolved=1
    fi

    if ! check_macos_file_arch "$file" "$expected_macho_arch"; then
      arch_mismatch=1
    fi
  done < <(
    find_tool_files "$platform_arch" "bin"
    find_tool_files "$platform_arch" "lib"
  )

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi
  if [ "$arch_mismatch" -ne 0 ]; then
    exit 1
  fi

  run_macos_packaged_tool_smoke "djvused" "$(packaged_entry_path djvused)" --help
  run_macos_packaged_tool_smoke "djvudump" "$(packaged_entry_path djvudump)" --help
  # ddjvu prints usage to stdout and exits 1 for --help on healthy builds.
  run_macos_packaged_tool_smoke "ddjvu" "$(packaged_entry_path ddjvu)" --help
  run_macos_packaged_tool_smoke "qpdf" "$(packaged_entry_path qpdf)" --version
  run_macos_packaged_tool_smoke "pdfinfo" "$(packaged_entry_path pdfinfo)" -v
  run_macos_packaged_tool_smoke "pdftoppm" "$(packaged_entry_path pdftoppm)" -v
  run_macos_packaged_tool_smoke "pdftotext" "$(packaged_entry_path pdftotext)" -v
  run_macos_packaged_tool_smoke "pdf-print-dialog" "$(packaged_entry_path pdf-print-dialog)" --version
  run_macos_packaged_tool_smoke "evb-pdf-image-combine" "$(packaged_entry_path evb-pdf-image-combine)" --version
  run_macos_packaged_tool_smoke "evb-pdf-image-combine-protocol" "$(packaged_entry_path evb-pdf-image-combine)" --protocol-version
  run_macos_packaged_tool_smoke "evb-pdf-image-combine-compact-manifest" "$(packaged_entry_path evb-pdf-image-combine)" --compact-manifest
  run_macos_packaged_tool_smoke "evb-pdf-page-ops" "$(packaged_entry_path evb-pdf-page-ops)" --version
  run_macos_packaged_tool_smoke "evb-pdf-search" "$(packaged_entry_path evb-pdf-search)" --version
  run_macos_packaged_tool_smoke "evb-scan-cleanup" "$(packaged_entry_path evb-scan-cleanup)" --version
  run_macos_packaged_tool_smoke "evb-scan-cleanup-protocol" "$(packaged_entry_path evb-scan-cleanup)" --protocol-version
  if is_macos_app_adhoc_signed "$mac_app_path"; then
    echo "Named gap: skipping the packaged sidecar fold-clip smoke for $platform_arch; an ad-hoc signed app is killed by provenance policy when run in place, and this smoke needs the packaged binary to write its own outputs."
  else
    run_packaged_scan_cleanup_fold_clip_smoke "$(packaged_entry_path evb-scan-cleanup)"
  fi
  run_macos_packaged_tool_smoke "tesseract" "$(packaged_entry_path tesseract)" --version
  run_macos_packaged_tool_smoke "unpaper" "$(packaged_entry_path unpaper)" --help
fi

if [ "$platform" = "linux" ]; then
  if ! command -v ldd >/dev/null 2>&1; then
    echo "Error: ldd is required for linux dependency verification"
    exit 1
  fi

  unresolved=0
  while IFS= read -r file; do
    if ! file "$file" 2>/dev/null | grep -q 'ELF'; then
      continue
    fi

    refs="$(ldd "$file" 2>/dev/null || true)"
    if echo "$refs" | grep -q 'not found'; then
      echo "Error: Missing shared library dependency in $file"
      echo "$refs" | sed 's/^/  /'
      unresolved=1
    fi
  done < <(
    find_tool_files "$platform_arch" "bin"
    find_tool_files "$platform_arch" "lib"
  )

  if [ "$unresolved" -ne 0 ]; then
    exit 1
  fi

  if host_can_execute_target "$platform" "$arch"; then
    run_host_packaged_tool_smoke "tesseract" "$(packaged_entry_path tesseract)" --version
    run_host_packaged_tool_smoke "unpaper" "$(packaged_entry_path unpaper)" --help
    run_host_packaged_tool_smoke "evb-scan-cleanup" "$(packaged_entry_path evb-scan-cleanup)" --version
    run_host_packaged_tool_smoke "evb-scan-cleanup-protocol" "$(packaged_entry_path evb-scan-cleanup)" --protocol-version
    run_packaged_scan_cleanup_fold_clip_smoke "$(packaged_entry_path evb-scan-cleanup)"
  else
    echo "Named gap: no packaged-binary execution evidence for $platform_arch; host $(uname -s)/$(uname -m) cannot execute the target. Evidence for this leg is limited to the static ELF dependency checks above."
  fi
fi

if [ "$platform" = "win" ]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  node "$script_dir/release/windows-tesseract-payload-policy.mjs" \
    "$(dirname "$(packaged_entry_path tesseract)")"
  windows_pe_files="$(mktemp)"
  trap 'rm -f "$windows_pe_files"' EXIT
  find_tool_files "$platform_arch" "bin" | grep -Ei '\.(exe|dll)$' > "$windows_pe_files" || true

  if ! node "$script_dir/release/windows-pe-dependencies.mjs" verify \
    --allowed-machines "$(windows_pe_allowed_machines_for_release_arch "$arch")" \
    --system-dll-pattern-file "$script_dir/win-system-dll-pattern.sh" \
    --file-list "$windows_pe_files"
  then
    exit 1
  fi

  rm -f "$windows_pe_files"
  trap - EXIT

  if host_can_execute_target "$platform" "$arch"; then
    run_host_packaged_tool_smoke "tesseract" "$(packaged_entry_path tesseract)" --version
    run_host_packaged_tool_smoke "evb-scan-cleanup" "$(packaged_entry_path evb-scan-cleanup)" --version
    run_host_packaged_tool_smoke "evb-scan-cleanup-protocol" "$(packaged_entry_path evb-scan-cleanup)" --protocol-version
    run_packaged_scan_cleanup_fold_clip_smoke "$(packaged_entry_path evb-scan-cleanup)"
  else
    echo "Named gap: no packaged-binary execution evidence for $platform_arch; host $(uname -s)/$(uname -m) cannot execute the target. The release workflow uses windows-11-arm for this lane; this fallback is retained for cross-host invocations. Evidence for this invocation is limited to the static PE machine, dependency, and tesseract payload checks above."
  fi
fi

echo "Native tool packaging verification passed for $platform_arch"
