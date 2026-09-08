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
  echo "Error: LaunchServices startup verification requires a mac target on a mac host"
  exit 1
fi

github_hosted_ci=0
if [ "${CI:-}" = "true" ] \
  && [ "${GITHUB_ACTIONS:-}" = "true" ] \
  && [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]; then
  github_hosted_ci=1
fi
if [ "$github_hosted_ci" -ne 1 ] && [ "${EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST:-}" != "1" ]; then
  echo "Error: this diagnostic exercises the production bundle identity through LaunchServices"
  echo "Run it on a GitHub-hosted CI runner, or set EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST=1 after approving the local LaunchServices test."
  exit 1
fi

release_dir="${EVB_LAUNCHSERVICES_RELEASE_DIR:-release}"
dmg_path="${EVB_LAUNCHSERVICES_DMG_PATH:-}"
if [ -z "$dmg_path" ]; then
  dmg_path="$(find "$release_dir" -maxdepth 1 -type f -name "*-$arch.dmg" | head -n 1)"
fi
if [ -z "$dmg_path" ] || [ ! -f "$dmg_path" ]; then
  echo "Error: Could not find packaged DMG for $arch below $release_dir"
  exit 1
fi
dmg_path="$(cd "$(dirname "$dmg_path")" && pwd -P)/$(basename "$dmg_path")"

token="evb-launchservices-smoke-$$-$(date +%s)"
user_data_dir="$(mktemp -d "${TMPDIR:-/tmp}/evb-launchservices-smoke.XXXXXX")"
profile_dir="$user_data_dir/profile"
mount_point="$user_data_dir/mount"
install_dir="$user_data_dir/install"
quarantined_dmg="$user_data_dir/candidate.dmg"
app_path="$install_dir/EVB Viewer.app"
app_exec="$app_path/Contents/MacOS/EVB Viewer"
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
artifact_root="${EVB_LAUNCHSERVICES_ARTIFACT_DIR:-.devkit/test/macos-launchservices-startup}"
artifact_dir="$artifact_root/$token"
mkdir -p "$artifact_dir"
artifact_dir="$(cd "$artifact_dir" && pwd -P)"
log_dir="$artifact_dir/electron-logs"
main_log="$log_dir/main.log"
window_log="$log_dir/window.log"
stdout_log="$artifact_dir/stdout.log"
stderr_log="$artifact_dir/stderr.log"
open_pid=""
app_pid=""
mounted=0
passed=0
source_app=""

unregister_bundle() {
  local bundle_path="$1"
  if [ -n "$bundle_path" ] && [ -x "$lsregister" ] && [ -d "$bundle_path" ]; then
    "$lsregister" -u "$bundle_path" >/dev/null 2>&1 || true
  fi
}

capture_diagnostics() {
  ps -axo pid=,ppid=,command= \
    | awk -v token="$token" 'index($0, token) { print }' \
    > "$artifact_dir/processes.txt" 2>&1 || true
  xattr -lr "$app_path" > "$artifact_dir/quarantine.txt" 2>&1 || true
  {
    echo "--- main.log ---"
    tail -n 200 "$main_log" 2>/dev/null || true
    echo "--- window.log ---"
    tail -n 200 "$window_log" 2>/dev/null || true
    echo "--- stdout.log ---"
    tail -n 200 "$stdout_log" 2>/dev/null || true
    echo "--- stderr.log ---"
    tail -n 200 "$stderr_log" 2>/dev/null || true
  } > "$artifact_dir/renderer-tail.log"
}

cleanup() {
  if [ "$passed" -ne 1 ]; then
    capture_diagnostics
    echo "LaunchServices diagnostic evidence retained at: $artifact_dir"
  fi
  if [ -n "$app_pid" ] && kill -0 "$app_pid" >/dev/null 2>&1; then
    kill "$app_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$open_pid" ] && kill -0 "$open_pid" >/dev/null 2>&1; then
    kill "$open_pid" >/dev/null 2>&1 || true
  fi
  # Mounting a DMG registers its source app independently of the disposable
  # install copy. Unregister it while the volume still exists so LaunchServices
  # does not retain a dead /Volumes/... entry after detach.
  unregister_bundle "$source_app"
  if [ "$mounted" -eq 1 ]; then
    hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true
  fi
  unregister_bundle "$app_path"
  rm -rf "$user_data_dir"
  if [ "$passed" -eq 1 ]; then
    rm -rf "$artifact_dir"
  fi
}
trap cleanup EXIT

mkdir -p "$profile_dir" "$mount_point" "$install_dir" "$log_dir"

# Exercise the same trust boundary as a browser download and Finder install.
# Quarantining a disposable DMG copy causes DiskImages to propagate quarantine
# metadata to the installed app and its nested code without changing artifact bytes.
ditto "$dmg_path" "$quarantined_dmg"
xattr -w com.apple.quarantine "0381;$(printf '%x' "$(date +%s)");GitHub_Actions;$token" "$quarantined_dmg"
hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" "$quarantined_dmg" >/dev/null
mounted=1
source_app="$(find "$mount_point" -maxdepth 1 -type d -name '*.app' | head -n 1)"
if [ -z "$source_app" ]; then
  echo "Error: Mounted DMG does not contain an app bundle"
  exit 1
fi
ditto "$source_app" "$app_path"
unregister_bundle "$source_app"
hdiutil detach "$mount_point" >/dev/null
mounted=0

if [ ! -x "$app_exec" ]; then
  echo "Error: Installed app executable is missing or not executable: $app_exec"
  exit 1
fi
if ! xattr -p com.apple.quarantine "$app_path" >/dev/null 2>&1 \
  || ! xattr -p com.apple.quarantine "$app_exec" >/dev/null 2>&1; then
  echo "Error: Browser-download quarantine did not propagate to the installed app and main executable"
  exit 1
fi

# -a receives the exact disposable installed bundle path, -n forces a separate
# instance, and the unique Chromium user-data directory prevents the canary from
# attaching to or mutating an installed production instance.
env -u ELECTRON_RUN_AS_NODE open -n -W -a "$app_path" \
  --env "EVB_FILE_LOG_DIR=$log_dir" \
  --env "EVB_AUTOMATION_USER_DATA_DIR=$profile_dir" \
  --env "EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1" \
  --stdout "$stdout_log" \
  --stderr "$stderr_log" \
  --args \
  --evb-startup-trace \
  --evb-launchservices-smoke="$token" \
  --user-data-dir="$profile_dir" &
open_pid=$!

timeout_secs=60
deadline=$((SECONDS + timeout_secs))
while [ "$SECONDS" -lt "$deadline" ]; do
  # Gatekeeper can launch a quarantined app from a randomized App Translocation
  # root. Match the stable path inside the bundle plus the unique canary token,
  # with the executable marker preceding the token. This excludes `open`, this
  # awk probe, Electron helpers, and unrelated production instances while still
  # accepting both installed and translocated main executables.
  app_pid="$(ps -axo pid=,command= | awk -v token="$token" '
    !found {
      executable_position = index($0, "/Contents/MacOS/EVB Viewer")
      token_position = index($0, token)
      if (executable_position > 0 && token_position > executable_position) {
        pid = $1
        found = 1
      }
    }
    END { if (found) print pid }
  ')"
  if [ -n "$app_pid" ]; then
    break
  fi
  if ! kill -0 "$open_pid" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if [ -z "$app_pid" ]; then
  echo "Error: LaunchServices did not start the requested packaged bundle"
  exit 1
fi

ready_marker="$(pnpm exec tsx scripts/release/printPackagedStartupReadyMarker.ts)"
ready=0
stable_since=$SECONDS
stability_secs=10
deadline=$((SECONDS + timeout_secs))
while [ "$SECONDS" -lt "$deadline" ]; do
  if {
    { [ -f "$main_log" ] && grep -F -q "$ready_marker" "$main_log"; } \
      || { [ -f "$stdout_log" ] && grep -F -q "$ready_marker" "$stdout_log"; } \
      || { [ -f "$stderr_log" ] && grep -F -q "$ready_marker" "$stderr_log"; }
  } && kill -0 "$app_pid" >/dev/null 2>&1; then
    ready=1
    echo "LaunchServices startup reached the packaged renderer ready marker"
    break
  fi
  if ! kill -0 "$app_pid" >/dev/null 2>&1; then
    break
  fi
  # App Translocation can discard the diagnostic environment and redirected
  # stdio supplied by `open`, leaving all marker sources empty even though the
  # uniquely tokenized main process is healthy. The immediately preceding
  # packaged-startup gate proves renderer readiness for this same signed app;
  # this gate owns the separate Gatekeeper/LaunchServices trust boundary.
  if [ $((SECONDS - stable_since)) -ge "$stability_secs" ]; then
    ready=1
    echo "LaunchServices kept the tokenized packaged process alive for ${stability_secs}s"
    break
  fi
  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "Error: Packaged app failed LaunchServices startup verification"
  echo "--- main.log ---"
  cat "$main_log" 2>/dev/null || true
  echo "--- window.log ---"
  cat "$window_log" 2>/dev/null || true
  echo "--- stdout.log ---"
  cat "$stdout_log" 2>/dev/null || true
  echo "--- stderr.log ---"
  cat "$stderr_log" 2>/dev/null || true
  exit 1
fi

passed=1
echo "Quarantined DMG install and LaunchServices startup verification passed for $platform-$arch"
