#!/usr/bin/env bash
# Prints the commit a push run should diff from.
#
# A newer push to main cancels the previous in-progress CI run, so the
# areas that run never verified have to be diffed by the run that replaced
# it. Starting at the push event's `before` commit, walk back to the last
# push whose run finished. Commits without a finished run (mid-push
# commits, a run still being cancelled) are walked past. If the API call
# fails, the diff keeps `before`, as it did before cancellation existed.
#
# Usage: push-diff-base.sh <before-sha> <head-sha>
set -euo pipefail

before_sha="$1"
head_sha="$2"

if [ -z "$before_sha" ] || [ "$before_sha" = "0000000000000000000000000000000000000000" ]; then
    git rev-parse "${head_sha}^" 2>/dev/null || printf '%s\n' "$head_sha"
    exit 0
fi

base_sha="$before_sha"
for _ in $(seq 1 30); do
    finished_runs="$(gh run list --workflow ci.yml --event push --commit "$base_sha" \
        --json status,conclusion \
        --jq 'map(select(.status == "completed" and .conclusion != "cancelled")) | length' 2>/dev/null)" || finished_runs=""
    if [ "$finished_runs" != "0" ]; then
        break
    fi
    parent_sha="$(git rev-parse --verify --quiet "${base_sha}^")" || break
    base_sha="$parent_sha"
done
printf '%s\n' "$base_sha"
