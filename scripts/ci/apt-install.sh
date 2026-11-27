#!/usr/bin/env bash
# Configures speed-ordered Ubuntu apt mirrors and optionally installs packages
# on a GitHub runner without letting a stalled mirror hold the job for its
# whole timeout budget.
#
# Usage:
#   scripts/ci/apt-install.sh --configure-only
#   scripts/ci/apt-install.sh <package>...
set -euo pipefail

as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

configure_apt_mirrors() {
    local mirror_list=/etc/apt/apt-mirrors.txt
    local probe_timeout_seconds=5
    local source_pattern codename outcomes index mirror outcome elapsed priority source
    local -a candidates timed stalled ordered

    case "$(dpkg --print-architecture)" in
        amd64)
            source_pattern='(azure\.)?(archive|security)\.ubuntu\.com/ubuntu'
            candidates=(
                http://archive.ubuntu.com/ubuntu/
                http://mirrors.edge.kernel.org/ubuntu/
                http://mirrors.mit.edu/ubuntu/
                http://ubuntu.mirrors.ovh.net/ubuntu/
            )
            ;;
        *)
            source_pattern='(azure\.)?ports\.ubuntu\.com/ubuntu-ports'
            candidates=(
                http://ports.ubuntu.com/ubuntu-ports/
                http://mirrors.mit.edu/ubuntu-ports/
                http://ftp.fau.de/ubuntu-ports/
            )
            ;;
    esac

    codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)
    outcomes=$(mktemp -d)

    probe_mirror() {
        local candidate="$1" result_file="$2" started
        started=$(date +%s%N)
        if ! timeout $((probe_timeout_seconds + 3)) /usr/lib/apt/apt-helper download-file \
            "${candidate}dists/${codename}/InRelease" "$result_file.InRelease" \
            -o Acquire::http::Timeout="$probe_timeout_seconds" \
            -o Acquire::Retries=0 \
            -o Acquire::ForceIPv4=true >/dev/null 2>&1; then
            echo stalled > "$result_file"
            return
        fi
        echo $(( ($(date +%s%N) - started) / 1000000 )) > "$result_file"
    }

    index=0
    for mirror in "${candidates[@]}"; do
        probe_mirror "$mirror" "$outcomes/$index" &
        index=$((index + 1))
    done
    wait

    timed=()
    stalled=()
    index=0
    for mirror in "${candidates[@]}"; do
        outcome=$(cat "$outcomes/$index")
        if [ "$outcome" = stalled ]; then
            stalled+=("$mirror")
            echo "apt mirror $mirror is not answering; keeping it as a fallback only" >&2
        else
            timed+=("$outcome $mirror")
        fi
        index=$((index + 1))
    done
    rm -rf "$outcomes"

    ordered=()
    if [ "${#timed[@]}" -gt 0 ]; then
        while read -r elapsed mirror; do
            ordered+=("$mirror")
            echo "apt mirror $mirror answered probe in ${elapsed} ms" >&2
        done < <(printf '%s\n' "${timed[@]}" | sort -n)
    fi
    ordered+=("${stalled[@]}")

    priority=0
    for mirror in "${ordered[@]}"; do
        priority=$((priority + 1))
        printf '%s\tpriority:%s\n' "$mirror" "$priority"
    done | as_root tee "$mirror_list" >/dev/null

    as_root tee /etc/apt/apt.conf.d/80evb-mirror-failover >/dev/null <<'CONF'
Acquire::Retries "0";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::ForceIPv4 "true";
DPkg::Lock::Timeout "120";
CONF

    for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
        if [ -f "$source" ]; then
            as_root sed -i -E "s#https?://${source_pattern}/?#mirror+file:$mirror_list#g" "$source"
        fi
    done
}

if [ "$#" -eq 1 ] && [ "$1" = "--configure-only" ]; then
    configure_apt_mirrors
    exit 0
fi

if [ "$#" -eq 0 ]; then
    echo "usage: $0 [--configure-only | <package>...]" >&2
    exit 2
fi

for package in "$@"; do
    if [[ -z "$package" || "$package" == -* ]]; then
        echo "invalid package argument: $package" >&2
        exit 2
    fi
done

configure_apt_mirrors

apt_opts=()

# Only the Ubuntu archive serves the packages this script installs. The runner
# image also lists dl.google.com and packages.microsoft.com, whose indexes fail
# `apt-get update` with "Hash Sum mismatch" while they are mid-publish, so
# update and install from a source directory that holds the Ubuntu entries alone.
ubuntu_source_parts=$(mktemp -d)
trap 'rm -rf "$ubuntu_source_parts"' EXIT
for source in /etc/apt/sources.list.d/*; do
    case "$(basename "$source")" in
        ubuntu.sources|ubuntu*.list)
            as_root cp "$source" "$ubuntu_source_parts"/
            ;;
    esac
done
if [ -n "$(ls -A "$ubuntu_source_parts")" ]; then
    apt_opts+=(-o "Dir::Etc::sourceparts=$ubuntu_source_parts")
fi

for attempt in 1 2; do
    if as_root timeout 90 apt-get "${apt_opts[@]}" update \
        && as_root env DEBIAN_FRONTEND=noninteractive timeout 300 apt-get "${apt_opts[@]}" install -y --no-install-recommends "$@"; then
        exit 0
    fi
    if [ "$attempt" -lt 2 ]; then
        echo "apt install attempt ${attempt} failed; retrying" >&2
        sleep $((attempt * 15))
    fi
done

echo "apt install failed after 2 attempts: $*" >&2
exit 1
