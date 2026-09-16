#!/bin/bash
set -euo pipefail

platform="$(uname -s)"
case "$platform" in
  Darwin) node_platform="darwin" ;;
  Linux) node_platform="linux" ;;
  *) node_platform="$(printf '%s' "$platform" | tr '[:upper:]' '[:lower:]')" ;;
esac

IFS=$'\t' read -r no_focus hide_window hidden_app_bundle host_display_isolation < <(
  pnpm exec tsx scripts/electron-run/printElectronE2EHeadlessRunnerConfig.ts "$node_platform"
)

if [ "${1:-}" = "--no-build" ]; then
  target_project="${2:-}"
  if [ -z "$target_project" ]; then
    echo "--no-build requires a Vitest project name." >&2
    exit 1
  fi
  if [ "$target_project" = "e2e-visible-window" ]; then
    echo "The visible-window project cannot run through the headless runner." >&2
    exit 1
  fi
  shift 2
  target_id="$target_project-no-build"
  test_command=(pnpm exec vitest run --project "$target_project" "$@")
else
  echo "Usage: $0 --no-build <vitest-project> [vitest files, title filters, and arguments...]" >&2
  exit 1
fi

if [ "${EVB_E2E_SHARED_BUILD_REQUIRED:-0}" = "1" ]; then
  bash scripts/ci/prepare-electron-e2e-build.sh "$target_project"
fi

case "$target_project" in
  e2e-blocking-smoke|e2e-draw-shapes|e2e-large-pdf|e2e-native-save-reopen|e2e-regression|e2e-save-pipeline|e2e-xlarge-pdf)
    if [ "${EVB_PDF_PAGE_OPS_DISABLE:-0}" != "1" ]; then
      export EVB_PDF_PAGE_OPS_ENABLE=1
    fi
    PATH="$PATH" node scripts/assert-electron-native-page-ops.mjs "$target_project"
    ;;
esac

export EVB_AUTOMATION_DISABLE_SANDBOX=1
export EVB_AUTOMATION_NO_FOCUS="$no_focus"
export EVB_AUTOMATION_HIDE_WINDOW="$hide_window"
export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE="$hidden_app_bundle"

if [ "$host_display_isolation" = "xvfb" ]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "xvfb-run is required for headless Linux Electron E2E. Run bash scripts/setup-linux-dev-host.sh." >&2
    exit 1
  fi
  exec node scripts/validation-gates.mjs heavy --id="electron-${target_id//:/-}" --weight=2 -- \
    xvfb-run -a "${test_command[@]}"
fi

exec node scripts/validation-gates.mjs heavy --id="electron-${target_id//:/-}" --weight=2 -- \
  "${test_command[@]}"
