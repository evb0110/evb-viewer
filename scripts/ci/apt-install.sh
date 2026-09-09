#!/usr/bin/env bash
# Installs apt packages on a GitHub runner without letting a stalled mirror
# hold the job for its whole timeout budget. The runner image resolves
# Ubuntu sources through a mirror list whose first entry,
# azure.archive.ubuntu.com, has stalled `apt-get update` for 27 minutes
# inside a 30-minute job, and apt's per-request Acquire timeouts did not
# abort the stall. Dropping that mirror sends apt straight to the canonical
# archive; a hard per-command timeout plus a retry loop turns any remaining
# outage into a fast failure with a few chances to clear.
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
if [ -f "$mirror_list" ] && grep -q 'azure.archive.ubuntu.com' "$mirror_list"; then
    sudo sed -i '/azure\.archive\.ubuntu\.com/d' "$mirror_list"
    if ! grep -q 'archive.ubuntu.com' "$mirror_list"; then
        echo 'https://archive.ubuntu.com/ubuntu/	priority:1' | sudo tee -a "$mirror_list" >/dev/null
    fi
fi

apt_opts=(
    -o Acquire::Retries=3
    -o Acquire::http::Timeout=30
    -o Acquire::https::Timeout=30
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
