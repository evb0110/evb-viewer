#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <platform: mac|win|linux> <arch: x64|arm64>"
  exit 1
fi

platform="$1"
arch="$2"

host_platform=""
case "$(uname -s)" in
  Darwin)
    host_platform="mac"
    ;;
  Linux)
    host_platform="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    host_platform="win"
    ;;
  *)
    echo "Error: Unsupported host platform $(uname -s)"
    exit 1
    ;;
esac

if [ "$platform" != "$host_platform" ]; then
  echo "Skipping startup check for $platform-$arch on host $host_platform"
  exit 0
fi

if [ "$platform" != "mac" ]; then
  echo "Error: Startup verification is currently implemented only for mac targets"
  exit 1
fi

app_path="dist/mac-$arch/EVB Viewer.app"
if [ ! -d "$app_path" ]; then
  app_path=""
  while IFS= read -r candidate; do
    app_path="$candidate"
    break
  done < <(find dist -maxdepth 4 -type d -name 'EVB Viewer.app' | sort)
fi

if [ -z "$app_path" ] || [ ! -d "$app_path" ]; then
  echo "Error: Could not find packaged app bundle in dist/"
  exit 1
fi

port=3235
if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Error: TCP port $port is already in use; stop running app instances first"
  lsof -nP -iTCP:$port -sTCP:LISTEN || true
  exit 1
fi

log_dir="${TMPDIR:-/tmp}/electron-logs"
rm -rf "$log_dir"
mkdir -p "$log_dir"

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/evb-packaged-startup.XXXXXX")"
app_copy="$scratch_dir/EVB Viewer.app"
stdout_log="$scratch_dir/app-stdout.log"

app_pid=""
cleanup() {
  if [ -n "$app_pid" ] && kill -0 "$app_pid" >/dev/null 2>&1; then
    kill "$app_pid" >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -rf "$scratch_dir"
}
trap cleanup EXIT

cp -R "$app_path" "$app_copy"

"$app_copy/Contents/MacOS/EVB Viewer" >"$stdout_log" 2>&1 &
app_pid=$!

main_log="$log_dir/main.log"
server_log="$log_dir/server.log"
window_log="$log_dir/window.log"

timeout_secs=50
deadline=$((SECONDS + timeout_secs))
ready=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -f "$stdout_log" ] && grep -q 'ERR_MODULE_NOT_FOUND' "$stdout_log"; then
    break
  fi

  if [ -f "$server_log" ] \
    && [ -f "$window_log" ] \
    && grep -q 'Server verified ready' "$server_log" \
    && grep -q 'BrowserWindow created and loadURL dispatched' "$window_log"; then
    ready=1
    break
  fi

  if ! kill -0 "$app_pid" >/dev/null 2>&1; then
    break
  fi

  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "Error: Packaged app failed startup verification"
  echo "--- main.log ---"
  cat "$main_log" 2>/dev/null || true
  echo "--- server.log ---"
  cat "$server_log" 2>/dev/null || true
  echo "--- window.log ---"
  cat "$window_log" 2>/dev/null || true
  echo "--- app stdout/stderr ---"
  cat "$stdout_log" 2>/dev/null || true
  exit 1
fi

echo "Packaged startup verification passed for $platform-$arch"
