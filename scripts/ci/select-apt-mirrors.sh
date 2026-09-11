#!/usr/bin/env bash
# Points apt's Ubuntu sources at a probed, speed-ordered mirror list so a
# stalled archive does not stall the job. apt's mirror method sends every file
# to the mirror with the best priority first and keeps the rest as alternates
# for that one file only; it never remembers that a mirror failed, and on a
# timeout it retries the same URI `Acquire::Retries` times before it tries an
# alternate. With archive.ubuntu.com dead on 2026-09-11, each of the ~200
# packages the Linux bundle installs paid those timeouts before reaching the
# next mirror, and the install ran out its 900-second budget. So the order is
# decided here, once. Every candidate is probed at the same time with apt's
# own downloader, so a dead mirror costs the slowest probe rather than the sum.
# Mirrors that answer every probe are written fastest first, which puts the
# nearest region ahead without a region table: from the OVH VPS in France
# the OVH mirror finished three probes in 130 ms and the US mirrors took
# over 600 ms, while a US runner sees the reverse. The mirrors that stalled
# follow as alternates. Callers pass `Acquire::Retries=0`
# so a file that still fails moves to the next mirror at once. The Azure
# mirrors the runner image lists first stay out: azure.archive.ubuntu.com
# stalled `apt-get update` for 27 minutes without tripping apt's request
# timeouts, so a probe cannot vouch for it. Every candidate below served
# jammy and noble on 2026-09-11; the ports list is shorter because most
# archive mirrors do not carry ubuntu-ports.
set -euo pipefail

mirror_list=/etc/apt/apt-mirrors.txt
probes_per_mirror=3
probe_timeout_seconds=5

case "$(dpkg --print-architecture)" in
    amd64)
        source_pattern='(azure\.)?(archive|security)\.ubuntu\.com/ubuntu'
        candidates=(
            http://archive.ubuntu.com/ubuntu/
            http://security.ubuntu.com/ubuntu/
            http://mirrors.edge.kernel.org/ubuntu/
            http://mirror.math.princeton.edu/pub/ubuntu/
            http://mirrors.mit.edu/ubuntu/
            http://mirror.us.leaseweb.net/ubuntu/
            http://ubuntu.mirror.constant.com/
            http://ubuntu.osuosl.org/ubuntu/
            http://mirrors.ocf.berkeley.edu/ubuntu/
            http://ftp.halifax.rwth-aachen.de/ubuntu/
            http://ftp.fau.de/ubuntu/
            http://mirror.nl.leaseweb.net/ubuntu/
            http://ubuntu.mirrors.ovh.net/ubuntu/
            http://mirror.bytemark.co.uk/ubuntu/
            http://de.archive.ubuntu.com/ubuntu/
            http://fr.archive.ubuntu.com/ubuntu/
            http://ftp.jaist.ac.jp/pub/Linux/ubuntu/
            http://mirror.kakao.com/ubuntu/
            http://mirrors.tuna.tsinghua.edu.cn/ubuntu/
            http://mirror.aarnet.edu.au/pub/ubuntu/archive/
        )
        ;;
    *)
        source_pattern='(azure\.)?ports\.ubuntu\.com/ubuntu-ports'
        candidates=(
            http://ports.ubuntu.com/ubuntu-ports/
            http://ftp.fau.de/ubuntu-ports/
            http://mirrors.mit.edu/ubuntu-ports/
            http://mirrors.ocf.berkeley.edu/ubuntu-ports/
            http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/
            http://mirror.aarnet.edu.au/pub/ubuntu/ports/
        )
        ;;
esac

as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)
outcomes=$(mktemp -d)
trap 'rm -rf "$outcomes"' EXIT

# Writes the probe time in milliseconds, or "stalled" once any probe fails.
probe_mirror() {
    local mirror="$1" outcome="$2" probe started
    started=$(date +%s%N)
    for ((probe = 0; probe < probes_per_mirror; probe++)); do
        if ! /usr/lib/apt/apt-helper download-file \
            "${mirror}dists/${codename}/InRelease" "$outcome.InRelease" \
            -o Acquire::http::Timeout="$probe_timeout_seconds" \
            -o Acquire::Retries=0 \
            -o Acquire::ForceIPv4=true >/dev/null 2>&1; then
            echo stalled > "$outcome"
            return
        fi
    done
    echo $(( ($(date +%s%N) - started) / 1000000 )) > "$outcome"
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

ordered=()
if [ "${#timed[@]}" -gt 0 ]; then
    while read -r elapsed mirror; do
        ordered+=("$mirror")
        echo "apt mirror $mirror answered ${probes_per_mirror} probes in ${elapsed} ms" >&2
    done < <(printf '%s\n' "${timed[@]}" | sort -n)
fi
ordered+=("${stalled[@]}")

priority=0
for mirror in "${ordered[@]}"; do
    priority=$((priority + 1))
    printf '%s\tpriority:%s\n' "$mirror" "$priority"
done | as_root tee "$mirror_list" >/dev/null

for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    if [ -f "$source" ]; then
        as_root sed -i -E "s#https?://${source_pattern}/?#mirror+file:$mirror_list#g" "$source"
    fi
done
