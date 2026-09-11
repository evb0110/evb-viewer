#!/usr/bin/env bash
# Installs apt packages on a GitHub runner without letting a stalled mirror
# hold the job for its whole timeout budget. The runner image resolves
# Ubuntu sources through `mirror+file:/etc/apt/apt-mirrors.txt`; apt tries
# the entries by ascending priority and moves to the next one when a fetch
# fails, so the list below is the fallback chain. The canonical archive goes
# first, the kernel.org mirror takes over when it stalls (on 2026-09-11 it
# timed out on one request in four for over an hour and failed four release
# attempts), and the security archive comes last. The Azure mirror the image
# ships as its first entry stays out: it stalled `apt-get update` for 27
# minutes inside a 30-minute job, and apt's per-request timeouts did not
# abort the stall. Per-request timeouts are short and retried once so apt
# reaches the next mirror well inside the hard budget on each command.
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <package>..." >&2
    exit 2
fi

for package in "$@"; do
    if [[ -z "$package" || "$package" == -* ]]; then
        echo "invalid package argument: $package" >&2
        exit 2
    fi
done

mirror_list=/etc/apt/apt-mirrors.txt
if [ -f "$mirror_list" ]; then
    if grep -q 'archive.ubuntu.com/ubuntu/' "$mirror_list"; then
        printf '%s\tpriority:%s\n' \
            https://archive.ubuntu.com/ubuntu/ 1 \
            https://mirrors.edge.kernel.org/ubuntu/ 2 \
            https://security.ubuntu.com/ubuntu/ 3 \
            | sudo tee "$mirror_list" >/dev/null
    else
        # An arm64 runner lists ports.ubuntu.com, which kernel.org does not mirror.
        sudo sed -i '/azure\.archive\.ubuntu\.com/d' "$mirror_list"
    fi
fi

apt_opts=(
    -o Acquire::Retries=1
    -o Acquire::http::Timeout=15
    -o Acquire::https::Timeout=15
    -o Acquire::ForceIPv4=true
    -o DPkg::Lock::Timeout=120
)

# Only the Ubuntu archive serves the packages this script installs. The runner
# image also lists dl.google.com and packages.microsoft.com, whose indexes fail
# `apt-get update` with "Hash Sum mismatch" while they are mid-publish, so
# update and install from a source directory that holds the Ubuntu entries alone.
ubuntu_source_parts=$(mktemp -d)
for source in /etc/apt/sources.list.d/*; do
    case "$(basename "$source")" in
        ubuntu.sources|ubuntu*.list)
            sudo cp "$source" "$ubuntu_source_parts"/
            ;;
    esac
done
if [ -n "$(ls -A "$ubuntu_source_parts")" ]; then
    apt_opts+=(-o "Dir::Etc::sourceparts=$ubuntu_source_parts")
fi

for attempt in 1 2; do
    if sudo timeout 90 apt-get "${apt_opts[@]}" update \
        && sudo DEBIAN_FRONTEND=noninteractive timeout 300 apt-get "${apt_opts[@]}" install -y --no-install-recommends "$@"; then
        exit 0
    fi
    if [ "$attempt" -lt 2 ]; then
        echo "apt install attempt ${attempt} failed; retrying" >&2
        sleep $((attempt * 15))
    fi
done

echo "apt install failed after 2 attempts: $*" >&2
exit 1
