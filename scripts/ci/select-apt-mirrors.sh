#!/usr/bin/env bash
# Points apt's Ubuntu sources at a probed mirror list so a stalled archive
# does not stall the job. apt's mirror method sends every file to the mirror
# with the best priority first and keeps the rest as alternates for that one
# file only; it never remembers that a mirror failed, and on a timeout it
# retries the same URI `Acquire::Retries` times before it tries an alternate.
# With archive.ubuntu.com dead on 2026-09-11, each of the ~200 packages the
# Linux bundle installs paid those timeouts before reaching kernel.org, and
# the install ran out its 900-second budget. So the order is decided here,
# once: each mirror is probed with apt's own downloader, mirrors that answer
# every probe keep their preference order at the front, and the rest follow
# as alternates. Callers pass `Acquire::Retries=0` so a file that still
# fails moves to the next mirror at once. The Azure mirror the runner image
# lists first stays out: it stalled `apt-get update` for 27 minutes without
# tripping apt's request timeouts. Only the amd64 archive has these mirrors;
# an arm64 runner keeps ports.ubuntu.com and just drops the Azure entry.
set -euo pipefail

mirror_list=/etc/apt/apt-mirrors.txt
preferred_mirrors=(
    http://archive.ubuntu.com/ubuntu/
    http://mirrors.edge.kernel.org/ubuntu/
    http://security.ubuntu.com/ubuntu/
)
probes_per_mirror=3

as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

if [ "$(dpkg --print-architecture)" != amd64 ]; then
    if [ -f "$mirror_list" ]; then
        as_root sed -i '/azure\.archive\.ubuntu\.com/d' "$mirror_list"
    fi
    exit 0
fi

codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)
probe_target=$(mktemp)
trap 'rm -f "$probe_target"' EXIT

mirror_answers() {
    local mirror="$1"
    local probe
    for ((probe = 0; probe < probes_per_mirror; probe++)); do
        if ! /usr/lib/apt/apt-helper download-file \
            "${mirror}dists/${codename}/InRelease" "$probe_target" \
            -o Acquire::http::Timeout=5 -o Acquire::Retries=0 \
            -o Acquire::ForceIPv4=true >/dev/null 2>&1; then
            return 1
        fi
    done
}

healthy=()
stalled=()
for mirror in "${preferred_mirrors[@]}"; do
    if mirror_answers "$mirror"; then
        healthy+=("$mirror")
    else
        stalled+=("$mirror")
        echo "apt mirror $mirror is not answering; keeping it as a fallback only" >&2
    fi
done

priority=0
for mirror in "${healthy[@]}" "${stalled[@]}"; do
    priority=$((priority + 1))
    printf '%s\tpriority:%s\n' "$mirror" "$priority"
done | as_root tee "$mirror_list" >/dev/null

for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    if [ -f "$source" ]; then
        as_root sed -i -E \
            "s#https?://(archive|security)\.ubuntu\.com/ubuntu/?#mirror+file:$mirror_list#g" \
            "$source"
    fi
done
