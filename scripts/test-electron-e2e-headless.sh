#!/bin/bash
set -euo pipefail

platform="$(uname -s)"
case "$platform" in
  Darwin) node_platform="darwin" ;;
  Linux) node_platform="linux" ;;
  *) node_platform="$(printf '%s' "$platform" | tr '[:upper:]' '[:lower:]')" ;;
esac

IFS=$'\t' read -r no_focus hide_window hidden_app_bundle host_display_isolation < <(
  node --import tsx scripts/electron-run/printElectronE2EHeadlessRunnerConfig.ts "$node_platform"
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
  test_command=(pnpm exec vitest run --project "$target_project" "$@")
else
  echo "Usage: $0 --no-build <vitest-project> [vitest files, title filters, and arguments...]" >&2
  exit 1
fi


case "$node_platform:$(locale charmap 2>/dev/null || true)" in
  # Chromium encodes dropped and native file paths through the locale, so a
  # non-UTF-8 inherited locale (LANG=C on a service host) mangles non-Latin names.
  linux:UTF-8) ;;
  linux:*) export LANG=C.UTF-8 LC_ALL=C.UTF-8 ;;
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
  # xvfb-run sets DISPLAY only. A shell from a Wayland desktop also exports
  # WAYLAND_DISPLAY, and Chromium's Ozone layer then picks the desktop
  # compositor over the private X server.
  unset WAYLAND_DISPLAY
  export XDG_SESSION_TYPE=x11
  # Fit the canonical 900x672 content window at native scale 2, including
  # its frame. A 1200-pixel screen clips its height at that scale.
  exec xvfb-run -a -s "-screen 0 ${EVB_XVFB_SCREEN:-1920x1440x24}" "${test_command[@]}"
fi

exec "${test_command[@]}"
