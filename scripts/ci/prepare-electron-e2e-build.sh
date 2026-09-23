#!/bin/bash
set -euo pipefail

target_project="${1:-}"
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: scripts/ci/prepare-electron-e2e-build.sh <vitest-project>' >&2
  exit 1
fi

platform_arch="$(node -p "process.platform + '-' + process.arch")"
required_paths=(
  'dist-electron/main.js'
  'dist-electron/preload.cjs'
  'dist-electron/package.json'
  'dist-electron/pdf.worker.mjs'
)
native_paths=()

case "$target_project" in
  e2e-regression)
    native_paths=(
      ".tmp/pdf-image-combine/$platform_arch/bin/evb-pdf-image-combine"
      ".tmp/pdf-page-ops/$platform_arch/bin/evb-pdf-page-ops"
      ".tmp/scan-cleanup/$platform_arch/bin/evb-scan-cleanup"
    )
    ;;
  e2e-save-pipeline|e2e-native-save-reopen)
    native_paths=(
      ".tmp/pdf-page-ops/$platform_arch/bin/evb-pdf-page-ops"
    )
    ;;
  e2e-rapid-navigation)
    # The rapid-navigation project also exercises the native opening-preview
    # path. Its shared macOS build is downloaded from another job, so restore
    # executable permission for pdf-page-ops before the --no-build suite runs.
    native_paths=(
      ".tmp/pdf-page-ops/$platform_arch/bin/evb-pdf-page-ops"
    )
    ;;
  *)
    printf '%s\n' "Unsupported Electron E2E project for the shared build: $target_project" >&2
    exit 1
    ;;
esac

if [ "${#native_paths[@]}" -gt 0 ]; then
  required_paths+=("${native_paths[@]}")
fi
missing_paths=()
for required_path in "${required_paths[@]}"; do
  if [ ! -f "$required_path" ]; then
    missing_paths+=("$required_path")
  fi
done

if [ "${#missing_paths[@]}" -gt 0 ]; then
  printf '%s\n' "[electron-e2e-build] Shared build artifact is missing or incomplete for $target_project." >&2
  printf 'Missing: %s\n' "${missing_paths[@]}" >&2
  printf '%s\n' 'The suite is configured with --no-build and will not rebuild. Download the artifact electron-e2e-build-<run-id> from the same workflow run.' >&2
  exit 1
fi

# Artifacts drop the executable bit, and the e2e preflight probes every helper
# staged under .tmp, not only the ones this project requires. Restore it on
# every helper the shared build carries.
for native_path in .tmp/*/"$platform_arch"/bin/evb-*; do
  if [ -f "$native_path" ]; then
    chmod +x "$native_path"
  fi
done

printf '%s\n' "[electron-e2e-build] Prepared shared build for $target_project ($platform_arch)."
