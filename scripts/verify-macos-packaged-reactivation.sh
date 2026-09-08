#!/bin/bash
set -euo pipefail

source "$(dirname "$0")/release/platform-arch.sh"

if [ "$#" -ne 2 ]; then
  release_target_usage "$0"
  exit 1
fi

platform="$1"
arch="$2"
resolve_release_target_platform_arch "$platform" "$arch" >/dev/null
detect_release_host_platform

if [ "$platform" != "mac" ] || [ "$RELEASE_HOST_PLATFORM" != "mac" ]; then
  echo "Error: packaged reactivation verification requires a mac target on a mac host"
  exit 1
fi

app_path="${EVB_REACTIVATION_APP_PATH:-release/mac-$arch/EVB Viewer.app}"
if [ ! -d "$app_path" ]; then
  echo "Error: Could not find packaged app bundle: $app_path"
  exit 1
fi
app_path="$(cd "$app_path" && pwd -P)"
app_exec="$app_path/Contents/MacOS/EVB Viewer"
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ ! -x "$app_exec" ]; then
  echo "Error: Could not find executable packaged app bundle: $app_path"
  exit 1
fi

local_production_identity_test=1
github_hosted_ci=0
if [ "${CI:-}" = "true" ] \
  && [ "${GITHUB_ACTIONS:-}" = "true" ] \
  && [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]; then
  github_hosted_ci=1
  local_production_identity_test=0
fi
if [ "$github_hosted_ci" -ne 1 ] && [ "${EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST:-}" != "1" ]; then
  echo "Error: this diagnostic exercises the production bundle identity through Dock and LaunchServices"
  echo "Use a GitHub-hosted CI runner, or set EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST=1 after explicit approval."
  exit 1
fi

accessibility_enabled="$(osascript -e 'tell application "System Events" to get UI elements enabled' 2>/dev/null || true)"
if [ "$accessibility_enabled" != "true" ]; then
  echo "Error: Accessibility access is required for packaged reactivation assertions"
  echo "Grant Accessibility access to the terminal or CI runner executing this script, then retry."
  exit 2
fi

token="evb-reactivation-smoke-$$-$(date +%s)"
artifact_dir="${EVB_REACTIVATION_ARTIFACT_DIR:-.devkit/test/macos-packaged-reactivation/$token}"
mkdir -p "$artifact_dir"
artifact_dir="$(cd "$artifact_dir" && pwd -P)"
probe="$artifact_dir/macos-app-lifecycle-probe"
xcrun swiftc scripts/macos-app-lifecycle-probe.swift -o "$probe"
user_data_dir="$artifact_dir/user-data"
log_dir="$artifact_dir/electron-logs"
main_log="$log_dir/main.log"
window_log="$log_dir/window.log"
app_pid=""
passed=0
dock_snapshot="$artifact_dir/dock-before.plist"
dock_url=""
dock_item_preexisted=0

mkdir -p "$log_dir"

if [ "$local_production_identity_test" -eq 1 ]; then
  defaults export com.apple.dock "$dock_snapshot" >/dev/null
  dock_url="$(xcrun swift -e 'import Foundation; print(URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).absoluteString)' "$app_path")"
  if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -F "$dock_url" >/dev/null; then
    dock_item_preexisted=1
  fi
fi

print_evidence() {
  echo "Evidence retained at: $artifact_dir"
  echo "--- main.log ---"
  tail -n 200 "$main_log" 2>/dev/null || true
  echo "--- window.log ---"
  tail -n 200 "$window_log" 2>/dev/null || true
}

is_tokenized_canary() {
  [ -n "$app_pid" ] && ps -p "$app_pid" -o command= 2>/dev/null \
    | awk -v executable="$app_exec" -v token="$token" '
        index($0, executable) && index($0, token) { found = 1 }
        END { exit found ? 0 : 1 }
      '
}

cleanup() {
  if is_tokenized_canary; then
    kill "$app_pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do
      kill -0 "$app_pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
  fi
  # The verifier launches a workspace build through LaunchServices. Remove
  # only that exact registration so retained release artifacts do not become
  # extra PDF/DjVu handlers in Finder's Open With menu.
  if [ -x "$lsregister" ] && [ -d "$app_path" ]; then
    "$lsregister" -u "$app_path" >/dev/null 2>&1 || true
  fi
  if [ "$passed" -ne 1 ]; then
    print_evidence
  fi
  if [ "$local_production_identity_test" -eq 1 ] && [ "$dock_item_preexisted" -eq 0 ]; then
    current_dock="$artifact_dir/dock-current.plist"
    defaults export com.apple.dock "$current_dock" >/dev/null
    plutil -convert xml1 "$current_dock"
    dock_index="$(plutil -p "$current_dock" | awk -v target="$dock_url" '
      /^[[:space:]]+[0-9]+ => \{/ { item_index=$1 }
      index($0, target) { print item_index; exit }
    ')"
    if [ -n "$dock_index" ]; then
      /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$dock_index" "$current_dock"
      defaults import com.apple.dock "$current_dock" >/dev/null
      launchctl kickstart -k "gui/$(id -u)/com.apple.Dock.agent"
    fi
  fi
}
trap cleanup EXIT

find_canary_pid() {
  ps -axo pid=,command= | awk -v executable="$app_exec" -v token="$token" '
    !found && index($0, executable) && index($0, token) { pid = $1; found = 1 }
    END { if (found) print pid }
  '
}

wait_for_canary() {
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    app_pid="$(find_canary_pid)"
    if [ -n "$app_pid" ]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_for_ready_marker() {
  local marker="$1"
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if is_tokenized_canary && [ -f "$main_log" ] && grep -F -q "$marker" "$main_log"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

focus_finder() {
  open -a Finder
  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$probe" not-frontmost "$app_pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

activate_canary() {
  open -a "$app_path"
}

assert_frontmost_visible_window() {
  local label="$1"
  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$probe" ready "$app_pid" >/dev/null 2>&1; then
      echo "Passed: $label"
      return 0
    fi
    sleep 0.1
  done
  echo "Error: $label did not produce a frontmost, visible, non-minimized canary window"
  return 1
}

set_canary_minimized() {
  "$probe" minimize "$app_pid" >/dev/null
  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    "$probe" not-visible "$app_pid" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

hide_canary() {
  "$probe" hide "$app_pid" >/dev/null
  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    "$probe" not-visible "$app_pid" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

close_last_canary_window() {
  "$probe" close "$app_pid" >/dev/null

  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if is_tokenized_canary && "$probe" no-window "$app_pid" >/dev/null 2>&1; then
      echo "Passed: closing the last window kept the macOS app alive without a window"
      return 0
    fi
    sleep 0.1
  done
  echo "Error: closing the last window did not preserve normal macOS application lifecycle"
  return 1
}

terminate_canary_and_wait_for_exit() {
  local process_pids
  process_pids="$(
    {
      echo "$app_pid"
      pgrep -P "$app_pid" 2>/dev/null || true
    } | awk 'NF && !seen[$1]++ { print $1 }'
  )"
  "$probe" terminate "$app_pid" >/dev/null

  local deadline=$((SECONDS + 55))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local running_pid=""
    for process_pid in $process_pids; do
      if kill -0 "$process_pid" >/dev/null 2>&1; then
        running_pid="$process_pid"
        break
      fi
    done
    if [ -z "$running_pid" ]; then
      echo "Passed: explicit application termination exited the app process tree"
      return 0
    fi
    sleep 0.1
  done
  echo "Error: packaged canary process tree remained alive after explicit application termination"
  return 1
}

assert_bundle_replaceable() {
  local moved_app_path="${app_path}.exit-smoke-moved"
  if [ -e "$moved_app_path" ]; then
    echo "Error: temporary bundle replacement path already exists: $moved_app_path"
    return 1
  fi

  mv "$app_path" "$moved_app_path"
  if ! mv "$moved_app_path" "$app_path"; then
    echo "Error: packaged app bundle could not be restored after replacement probe"
    return 1
  fi
  echo "Passed: exited app bundle can be moved for replacement"
}

env -u ELECTRON_RUN_AS_NODE open -n -a "$app_path" \
  --env "EVB_FILE_LOG_DIR=$log_dir" \
  --env "EVB_AUTOMATION_USER_DATA_DIR=$user_data_dir" \
  --env "EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1" \
  --args \
  --evb-startup-trace \
  --evb-launchservices-smoke="$token" \
  --user-data-dir="$user_data_dir"

if ! wait_for_canary; then
  echo "Error: LaunchServices did not start the tokenized packaged canary"
  exit 1
fi

ready_marker="$(pnpm exec tsx scripts/release/printPackagedStartupReadyMarker.ts)"
if ! wait_for_ready_marker "$ready_marker"; then
  echo "Error: packaged canary did not reach its ready marker"
  exit 1
fi

activate_canary
assert_frontmost_visible_window "cold packaged startup and exact-path activation"

for cycle in $(seq 1 20); do
  focus_finder || { echo "Error: Finder did not become frontmost for cycle $cycle"; exit 1; }
  activate_canary
  assert_frontmost_visible_window "visible LaunchServices reactivation $cycle/20"
done

set_canary_minimized
focus_finder
activate_canary
assert_frontmost_visible_window "minimized-window LaunchServices recovery"

hide_canary
focus_finder
activate_canary
assert_frontmost_visible_window "hidden-application LaunchServices recovery"

close_last_canary_window
focus_finder
activate_canary
assert_frontmost_visible_window "last-window-closed LaunchServices recovery"
terminate_canary_and_wait_for_exit
assert_bundle_replaceable

passed=1
echo "Packaged macOS reactivation verification passed for $platform-$arch"
echo "Evidence retained at: $artifact_dir"
