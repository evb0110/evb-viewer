#!/usr/bin/env bash
# Prints the commit a push run should diff from.
#
# Skipping a lane claims the base already proved it, so the base has to be
# a commit whose push run actually succeeded. A cancelled, unfinished, or
# failed run proves nothing, and diffing from a failed run lets a red lane
# stay skipped on every later commit that does not touch its paths, which
# turns a broken tree into a green `gates_ok`. Starting at the push event's
# `before` commit, walk back to the last push whose run concluded
# successfully. When no such commit is in reach, emit an unresolvable base
# so the classifier fails open and runs every gate.
#
# Usage: push-diff-base.sh <before-sha> <head-sha>
set -euo pipefail

before_sha="$1"
head_sha="$2"

if [ -z "$before_sha" ] || [ "$before_sha" = "0000000000000000000000000000000000000000" ]; then
    parent_sha="$(git rev-parse --verify --quiet "${head_sha}^" 2>/dev/null || true)"
    if [ -n "$parent_sha" ]; then
        printf '%s\n' "$parent_sha"
    else
        printf '%s\n' 'unavailable-push-base'
    fi
    exit 0
fi

base_sha="$before_sha"
for _ in $(seq 1 30); do
    passing_runs="$(gh run list --workflow ci.yml --event push --commit "$base_sha" \
        --json status,conclusion \
        --jq 'map(select(.status == "completed" and .conclusion == "success")) | length' 2>/dev/null)" || {
        # The API is unreachable, so no base can be trusted to have proved anything.
        printf '%s\n' 'unavailable-push-base'
        exit 0
    }
    if [ "$passing_runs" != "0" ]; then
        printf '%s\n' "$base_sha"
        exit 0
    fi
    parent_sha="$(git rev-parse --verify --quiet "${base_sha}^")" || break
    base_sha="$parent_sha"
done
printf '%s\n' 'unavailable-push-base'
