#!/bin/bash
set -euo pipefail

source "$(dirname "$0")/release/platform-arch.sh"

if [ "$#" -ne 2 ]; then
  release_target_usage "$0"
  exit 1
fi

platform="$1"
arch="$2"
release_dir="release"
resolve_release_target_platform_arch "$platform" "$arch" >/dev/null

detect_release_host_platform
host_platform="$RELEASE_HOST_PLATFORM"

if [ "$platform" != "$host_platform" ]; then
  echo "Skipping startup check for $platform-$arch on host $host_platform"
  exit 0
fi

# This verifier is intentionally mac-only today. Treat that as a current
# coverage gap, not as proof that Linux/Windows packaged startup is verified.
if [ "$platform" != "mac" ]; then
  echo "Error: Startup verification is currently implemented only for mac targets"
  exit 1
fi

app_path="$release_dir/mac-$arch/EVB Viewer.app"
if [ ! -d "$app_path" ]; then
  app_path=""
  while IFS= read -r candidate; do
    app_path="$candidate"
    break
  done < <(find "$release_dir" -maxdepth 4 -type d -name 'EVB Viewer.app' | sort)
fi

if [ -z "$app_path" ] || [ ! -d "$app_path" ]; then
  echo "Error: Could not find packaged app bundle in $release_dir/"
  exit 1
fi

app_exec="$app_path/Contents/MacOS/EVB Viewer"
artifact_root="${EVB_PACKAGED_STARTUP_ARTIFACT_DIR:-.devkit/test/packaged-core-pdf-smoke}"
mkdir -p "$artifact_root"
artifact_dir="$(mktemp -d "$artifact_root/packaged-startup-$platform-$arch.XXXXXX")"
task_dir="$(mktemp -d "${TMPDIR:-/tmp}/evb-packaged-startup-$platform-$arch.XXXXXX")"
log_dir="$task_dir/electron-logs"
user_data_dir="$task_dir/user-data"
{
  printf 'artifact_root=%s\n' "$artifact_root"
  printf 'artifact_dir=%s\n' "$artifact_dir"
  printf 'task_dir=%s\n' "$task_dir"
  printf 'user_data_dir=%s\n' "$user_data_dir"
  printf 'log_dir=%s\n' "$log_dir"
} > "$artifact_dir/selected-paths.txt"
runner_pid=""
cleanup() {
  local exit_code=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  if [ -n "$runner_pid" ]; then
    if kill -0 "$runner_pid" >/dev/null 2>&1; then
      kill -TERM "$runner_pid" >/dev/null 2>&1 || true
    fi
    if ! wait "$runner_pid" >/dev/null 2>&1; then
      cleanup_status=1
      echo "Error: packaged startup runner cleanup failed; preserving owned workspace: $task_dir" >&2
    fi
  fi
  if [ -n "$task_dir" ] && [ -d "$task_dir" ]; then
    # The runner retains its launch copy if shutdown could not be verified.
    # Keep that directory too; removing it could break a surviving owned app.
    if [ "$cleanup_status" -ne 0 ] || find "$task_dir" -maxdepth 1 -name 'hidden-packaged-app-*' | grep -q .; then
      echo "Preserved packaged startup workspace for unfinished cleanup: $task_dir"
    else
      rm -rf "$task_dir"
    fi
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    return "$cleanup_status"
  fi
  return "$exit_code"
}
trap cleanup EXIT
forward_signal() {
  local signal="$1"
  if [ -n "$runner_pid" ] && kill -0 "$runner_pid" >/dev/null 2>&1; then
    kill "-$signal" "$runner_pid" >/dev/null 2>&1 || true
  fi
}
trap 'forward_signal INT; exit 130' INT
trap 'forward_signal TERM; exit 143' TERM

EVB_STARTUP_TRACE=1 \
EVB_FILE_LOG_DIR="$log_dir" \
node --import tsx scripts/release/runPackagedAutomation.ts \
  --executable "$app_exec" \
  --work-directory "$task_dir" \
  -- \
  --no-sandbox \
  --disable-setuid-sandbox &
runner_pid=$!

main_log="$log_dir/main.log"
window_log="$log_dir/window.log"
ready_marker="$(pnpm exec tsx scripts/release/printPackagedStartupReadyMarker.ts)"

timeout_secs=50
deadline=$((SECONDS + timeout_secs))
ready=0
while [ "$SECONDS" -lt "$deadline" ]; do
  renderer_ready=0
  if [ -f "$main_log" ] && grep -F -q "$ready_marker" "$main_log"; then
    renderer_ready=1
  fi

  if [ "$renderer_ready" -eq 1 ] && kill -0 "$runner_pid" >/dev/null 2>&1; then
    ready=1
    break
  fi

  if ! kill -0 "$runner_pid" >/dev/null 2>&1; then
    break
  fi

  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "Error: Packaged app failed startup verification"
  echo "--- main.log ---"
  cat "$main_log" 2>/dev/null || true
  echo "--- window.log ---"
  cat "$window_log" 2>/dev/null || true
  exit 1
fi

echo "Packaged startup verification passed for $platform-$arch"
