#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SESSION_ROOT="$PROJECT_ROOT/.devkit/sessions"
XVFB_ROOT="$PROJECT_ROOT/.devkit/headless-xvfb"
SCREEN_SPEC="${EVB_XVFB_SCREEN:-1440x1000x24}"

if [ "${1:-}" = "--" ]; then
  shift
fi

platform="$(uname -s)"

if [ "$platform" != "Linux" ]; then
  export EVB_AUTOMATION_NO_FOCUS=1
  export EVB_AUTOMATION_HIDE_WINDOW=1
  if [ "$platform" = "Darwin" ]; then
    export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1
  fi
  exec pnpm electron:run "$@"
fi

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "Xvfb is required for headless Linux Electron runs. Run bash scripts/setup-linux-dev-host.sh." >&2
  exit 1
fi

export EVB_AUTOMATION_DISABLE_SANDBOX="${EVB_AUTOMATION_DISABLE_SANDBOX:-1}"
export EVB_AUTOMATION_HIDE_WINDOW="${EVB_AUTOMATION_HIDE_WINDOW:-0}"

session_name="default"
stop_all=0
command=""
args=("$@")

for ((index = 0; index < ${#args[@]}; index += 1)); do
  arg="${args[$index]}"
  case "$arg" in
    --session=*)
      session_name="${arg#--session=}"
      ;;
    --session|-s)
      index=$((index + 1))
      session_name="${args[$index]:-default}"
      ;;
    --all)
      stop_all=1
      ;;
    -*)
      ;;
    *)
      if [ -z "$command" ]; then
        command="$arg"
      fi
      ;;
  esac
done

if [[ ! "$session_name" =~ ^[A-Za-z0-9_.-]+$ ]] || [[ "$session_name" == *..* ]]; then
  echo "Invalid session name: $session_name" >&2
  exit 1
fi

xvfb_dir="$XVFB_ROOT/$session_name"
pid_file="$xvfb_dir/xvfb.pid"
display_file="$xvfb_dir/xvfb-display"
owner_file="$xvfb_dir/xvfb-owner"
log_file="$xvfb_dir/xvfb.log"
started_xvfb=0
started_pid=""
started_executable=""
started_start_time=""
started_boot_id=""
started_commandline=""
started_display=""
started_run_id=""
ownership_reason=""

is_pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

read_proc_executable() {
  readlink "/proc/$1/exe" 2>/dev/null
}

read_proc_start_time() {
  local stat_line rest
  stat_line="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  rest="${stat_line##*) }"
  set -- $rest
  [ "$#" -ge 20 ] && printf '%s\n' "${20}"
}

read_proc_boot_id() {
  cat /proc/sys/kernel/random/boot_id 2>/dev/null
}

read_proc_commandline() {
  local commandline
  commandline="$(tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null)" || return 1
  printf '%s\n' "${commandline% }"
}

read_process_identity() {
  local pid="$1"
  [ -r "/proc/$pid/stat" ] || return 1
  process_executable="$(read_proc_executable "$pid")" || return 1
  process_start_time="$(read_proc_start_time "$pid")" || return 1
  process_boot_id="$(read_proc_boot_id)" || return 1
  process_commandline="$(read_proc_commandline "$pid")" || return 1
  [ -n "$process_executable" ] && [ -n "$process_start_time" ] && \
    [ -n "$process_boot_id" ] && [ -n "$process_commandline" ]
}

read_pid() {
  if [ -f "$pid_file" ]; then
    cat "$pid_file"
  fi
}

read_display() {
  if [ -f "$display_file" ]; then
    cat "$display_file"
  fi
}

read_owner_record() {
  local key value
  record_pid=""
  record_executable=""
  record_start_time=""
  record_boot_id=""
  record_display=""
  record_screen_spec=""
  record_session=""
  record_run_id=""
  record_commandline=""
  if [ ! -f "$owner_file" ]; then
    ownership_reason="no atomic Xvfb ownership record"
    return 1
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      pid) record_pid="$value" ;;
      executable) record_executable="$value" ;;
      start_time) record_start_time="$value" ;;
      boot_id) record_boot_id="$value" ;;
      display) record_display="$value" ;;
      screen_spec) record_screen_spec="$value" ;;
      session) record_session="$value" ;;
      run_id) record_run_id="$value" ;;
      commandline) record_commandline="$value" ;;
      '') ;;
      *) ownership_reason="unknown field in Xvfb ownership record"; return 1 ;;
    esac
  done < "$owner_file"
  if [ -z "$record_pid" ] || [ -z "$record_executable" ] || \
    [ -z "$record_start_time" ] || [ -z "$record_boot_id" ] || \
    [ -z "$record_display" ] || [ -z "$record_screen_spec" ] || \
    [ -z "$record_session" ] || [ -z "$record_run_id" ] || \
    [ -z "$record_commandline" ]; then
    ownership_reason="incomplete Xvfb ownership record"
    return 1
  fi
}

ownership_matches_record() {
  local pid="$record_pid"
  if ! [[ "$pid" =~ ^[0-9]+$ ]] || [ "$pid" -le 0 ]; then
    ownership_reason="ownership record has an invalid PID"
    return 1
  fi
  if ! read_process_identity "$pid"; then
    ownership_reason="process identity is unavailable for PID $pid"
    return 1
  fi
  if [ "$record_session" != "$session_name" ]; then
    ownership_reason="ownership record belongs to another session"
    return 1
  fi
  if [ "$process_executable" != "$record_executable" ]; then
    ownership_reason="executable identity mismatch for PID $pid"
    return 1
  fi
  if [ "$process_start_time" != "$record_start_time" ]; then
    ownership_reason="process start time mismatch for PID $pid"
    return 1
  fi
  if [ "$process_boot_id" != "$record_boot_id" ]; then
    ownership_reason="host boot identity mismatch for PID $pid"
    return 1
  fi
  if [ "$process_commandline" != "$record_commandline" ]; then
    ownership_reason="Xvfb display arguments mismatch for PID $pid"
    return 1
  fi
  case " $process_commandline " in
    *" $record_display "*) ;;
    *) ownership_reason="Xvfb display arguments mismatch for PID $pid"; return 1 ;;
  esac
  case " $process_commandline " in
    *" -screen 0 $record_screen_spec "*) ;;
    *) ownership_reason="Xvfb display arguments mismatch for PID $pid"; return 1 ;;
  esac
  case " $process_commandline " in
    *" -nolisten tcp "*) ;;
    *) ownership_reason="Xvfb display arguments mismatch for PID $pid"; return 1 ;;
  esac
  return 0
}

stop_started_process() {
  local pid="$started_pid"
  [ -n "$pid" ] || return 0
  if read_process_identity "$pid" && \
    [ "$process_executable" = "$started_executable" ] && \
    [ "$process_start_time" = "$started_start_time" ] && \
    [ "$process_boot_id" = "$started_boot_id" ] && \
    [ "$process_commandline" = "$started_commandline" ]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

atomic_write_owner_record() {
  local temporary_file="$xvfb_dir/.xvfb-owner.$$.tmp"
  umask 077
  {
    printf 'pid=%s\n' "$started_pid"
    printf 'executable=%s\n' "$started_executable"
    printf 'start_time=%s\n' "$started_start_time"
    printf 'boot_id=%s\n' "$started_boot_id"
    printf 'display=%s\n' "$started_display"
    printf 'screen_spec=%s\n' "$SCREEN_SPEC"
    printf 'session=%s\n' "$session_name"
    printf 'run_id=%s\n' "$started_run_id"
    printf 'commandline=%s\n' "$started_commandline"
  } > "$temporary_file"
  mv -f "$temporary_file" "$owner_file"
}

report_untrusted_ownership() {
  echo "Refusing Xvfb ownership for session '$session_name': $ownership_reason. Evidence remains in $owner_file." >&2
}

find_free_display() {
  local number
  for number in $(seq 90 150); do
    if [ ! -e "/tmp/.X11-unix/X$number" ]; then
      echo ":$number"
      return 0
    fi
  done
  echo "No free Xvfb display found in :90..:150" >&2
  return 1
}

stop_xvfb_for_session() {
  if ! read_owner_record || ! ownership_matches_record; then
    report_untrusted_ownership
    return 1
  fi
  local pid="$record_pid"
  if ! ownership_matches_record; then
    report_untrusted_ownership
    return 1
  fi
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
  local deadline=$((SECONDS + 10))
  while is_pid_alive "$pid" && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.05
  done
  if is_pid_alive "$pid"; then
    ownership_reason="owned Xvfb did not exit after SIGTERM"
    echo "Refusing to clear Xvfb ownership for session '$session_name': $ownership_reason." >&2
    return 1
  fi
  if read_owner_record && [ "$record_pid" = "$pid" ]; then
    rm -f "$owner_file" "$pid_file" "$display_file"
  fi
}

stop_all_xvfb() {
  local session_dir file result=0
  shopt -s nullglob
  for session_dir in "$XVFB_ROOT"/*; do
    [ -d "$session_dir" ] || continue
    file="$session_dir/xvfb-owner"
    if [ ! -f "$file" ] && [ ! -f "$session_dir/xvfb.pid" ]; then
      continue
    fi
    xvfb_dir="$session_dir"
    pid_file="$xvfb_dir/xvfb.pid"
    display_file="$xvfb_dir/xvfb-display"
    owner_file="$file"
    session_name="$(basename "$xvfb_dir")"
    stop_xvfb_for_session || result=1
  done
  return "$result"
}

start_xvfb_for_session() {
  local existing_display display lock_dir
  mkdir -p "$xvfb_dir"

  lock_dir="$xvfb_dir/.start-lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    ownership_reason="another Xvfb start owns the session lock"
    report_untrusted_ownership
    return 1
  fi

  if read_owner_record && ownership_matches_record; then
    rmdir "$lock_dir"
    export DISPLAY="$record_display"
    return 0
  fi
  if [ -f "$owner_file" ]; then
    report_untrusted_ownership
    rmdir "$lock_dir"
    return 1
  fi
  if [ -f "$pid_file" ] || [ -f "$display_file" ]; then
    echo "Ignoring legacy PID-only Xvfb evidence for session '$session_name'; it will not be adopted or signalled." >&2
    mv "$pid_file" "$pid_file.legacy.$$.bak" 2>/dev/null || true
    mv "$display_file" "$display_file.legacy.$$.bak" 2>/dev/null || true
  fi

  display="$(find_free_display)"
  if command -v setsid >/dev/null 2>&1; then
    setsid Xvfb "$display" -screen 0 "$SCREEN_SPEC" -nolisten tcp >"$log_file" 2>&1 </dev/null &
  else
    nohup Xvfb "$display" -screen 0 "$SCREEN_SPEC" -nolisten tcp >"$log_file" 2>&1 </dev/null &
  fi
  started_pid="$!"
  started_display="$display"
  sleep 0.5

  if ! read_process_identity "$started_pid"; then
    echo "Xvfb failed to start for display $display. See $log_file." >&2
    stop_started_process
    rmdir "$lock_dir"
    return 1
  fi

  started_executable="$process_executable"
  started_start_time="$process_start_time"
  started_boot_id="$process_boot_id"
  started_commandline="$process_commandline"
  started_run_id="${session_name}-$$-$(date +%s%N)"
  atomic_write_owner_record
  printf '%s\n' "$started_pid" > "$pid_file"
  printf '%s\n' "$started_display" > "$display_file"
  rmdir "$lock_dir"
  started_xvfb=1
  export DISPLAY="$started_display"
}

command="${command:-}"

if [ "$command" = "stop" ]; then
  if [ "$stop_all" -eq 1 ]; then
    pnpm electron:run "$@"
    stop_all_xvfb
  else
    existing_display="$(read_display || true)"
    if [ -n "$existing_display" ]; then
      export DISPLAY="$existing_display"
    fi
    pnpm electron:run "$@"
    stop_xvfb_for_session
  fi
  exit 0
fi

case "$command" in
  ""|help|list|status)
    existing_display="$(read_display || true)"
    if [ -n "$existing_display" ]; then
      export DISPLAY="$existing_display"
    fi
    exec pnpm electron:run "$@"
    ;;
  *)
    start_xvfb_for_session
    ;;
esac

cleanup_on_exit() {
  local exit_code=$?
  if [ "$started_xvfb" -eq 1 ]; then
    stop_xvfb_for_session
  fi
  exit "$exit_code"
}

# A detached start runs in the background so an INT/TERM/HUP during the
# readiness wait reaches this shell and can undo the partial start: the
# runner is asked to stop the session, and an Xvfb started here is torn
# down. A successful start keeps Xvfb alive for the persistent session.
startd_pid=""

interrupted_startd() {
  local signal_name="$1" signal_number="$2"
  trap - INT TERM HUP
  echo "Headless $command for session '$session_name' interrupted by SIG$signal_name; stopping the session." >&2
  if is_pid_alive "$startd_pid"; then
    kill -TERM "$startd_pid" >/dev/null 2>&1 || true
    wait "$startd_pid" >/dev/null 2>&1 || true
  fi
  if ! pnpm electron:run --session="$session_name" stop; then
    echo "Session '$session_name' may still be running after the interrupted $command. Run: bash scripts/electron-run-headless.sh --session=$session_name stop" >&2
  fi
  if [ "$started_xvfb" -eq 1 ]; then
    stop_xvfb_for_session
  fi
  exit "$((128 + signal_number))"
}

case "$command" in
  startd|restartd)
    trap 'interrupted_startd INT 2' INT
    trap 'interrupted_startd TERM 15' TERM
    trap 'interrupted_startd HUP 1' HUP
    pnpm electron:run "$@" &
    startd_pid=$!
    if wait "$startd_pid"; then
      trap - INT TERM HUP
      exit 0
    fi
    trap - INT TERM HUP
    if [ "$started_xvfb" -eq 1 ]; then
      stop_xvfb_for_session
    fi
    exit 1
    ;;
  *)
    trap cleanup_on_exit EXIT
    pnpm electron:run "$@"
    ;;
esac
