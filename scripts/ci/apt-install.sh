#!/usr/bin/env bash
# Installs apt packages on a GitHub runner without letting a stalled mirror
# hold the job for its whole timeout budget. `select-apt-mirrors.sh` probes
# the Ubuntu mirrors and writes the fallback chain apt reads through
# `mirror+file:/etc/apt/apt-mirrors.txt`; the options below keep each
# request short and send a failed file to the next mirror instead of
# retrying the one that just timed out, so apt reaches a working mirror well
# inside the hard budget on each command.
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

bash "$(dirname "$0")/select-apt-mirrors.sh"

apt_opts=(
    -o Acquire::Retries=0
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
