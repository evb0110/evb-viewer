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
# Each tier asks about its own runs: a tier only skips a lane because its own
# base already proved that lane, so the workflow to look at is the caller's.
#
# A merged pull request proves itself. When the head is a merge of the proved
# `before` commit and a pull request head that contains it, with the same tree
# as that head, and a run of the workflow passed on that head, the run already
# covered everything that changed since the proved base. The script then
# prints the head itself: nothing is left to classify, and the caller runs
# only its smoke check.
#
# Usage: push-diff-base.sh <before-sha> <head-sha> [workflow-file]
set -euo pipefail

before_sha="$1"
head_sha="$2"
workflow_file="${3:-ci.yml}"

if [ -z "$before_sha" ] || [ "$before_sha" = "0000000000000000000000000000000000000000" ]; then
    parent_sha="$(git rev-parse --verify --quiet "${head_sha}^" 2>/dev/null || true)"
    if [ -n "$parent_sha" ]; then
        printf '%s\n' "$parent_sha"
    else
        printf '%s\n' 'unavailable-push-base'
    fi
    exit 0
fi

# Usage: count_passing_runs <sha> [gh run list filter...]
count_passing_runs() {
    gh run list --workflow "$workflow_file" --commit "$@" \
        --json status,conclusion \
        --jq 'map(select(.status == "completed" and .conclusion == "success")) | length' 2>/dev/null
}

merged_tree_passed() {
    local pr_head_sha
    [ "$(git rev-parse --verify --quiet "${head_sha}^1")" = "$before_sha" ] || return 1
    pr_head_sha="$(git rev-parse --verify --quiet "${head_sha}^2")" || return 1
    [ "$(git rev-parse "${head_sha}^{tree}")" = "$(git rev-parse "${pr_head_sha}^{tree}")" ] || return 1
    git merge-base --is-ancestor "$before_sha" "$pr_head_sha" || return 1
    [ "$(count_passing_runs "$pr_head_sha")" -gt 0 ]
}

base_sha="$before_sha"
for _ in $(seq 1 30); do
    passing_runs="$(count_passing_runs "$base_sha" --event push)" || {
        # The API is unreachable, so no base can be trusted to have proved anything.
        printf '%s\n' 'unavailable-push-base'
        exit 0
    }
    if [ "$passing_runs" != "0" ]; then
        if [ "$base_sha" = "$before_sha" ] && merged_tree_passed; then
            base_sha="$head_sha"
        fi
        printf '%s\n' "$base_sha"
        exit 0
    fi
    parent_sha="$(git rev-parse --verify --quiet "${base_sha}^")" || break
    base_sha="$parent_sha"
done
printf '%s\n' 'unavailable-push-base'
