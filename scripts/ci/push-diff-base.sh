#!/usr/bin/env bash
# Prints the commit a push run should diff from.
#
# Skipping a lane claims the base already proved it, so the base has to be
# a commit whose push run actually succeeded. A cancelled, unfinished, or
# failed run proves nothing, and diffing from a failed run lets a red lane
# stay skipped on every later commit that does not touch its paths, which
# turns a broken tree into a green `gates_ok`. Starting at the push event's
# `before` commit, intersect its first-parent history (up to 30 commits) with
# completed successful push runs of this workflow on the current branch in one
# API query. When no such commit is in reach (or for a new ref with an empty or
# all-zero `before`), emit `unavailable-push-base` so the classifier fails open
# and selects every job.
#
# A merged pull request proves itself. When the head is a merge of the proved
# `before` commit and a pull request head that contains it, with the same tree
# as that head, and a run of the workflow passed on that head, the run already
# covered everything that changed since the proved base. The script then prints
# the head itself so the classifier selects only the smoke check. An in-flight
# `before` run is never accepted as proved.
#
# Usage: push-diff-base.sh <before-sha> <head-sha> [workflow-file]
set -euo pipefail

before_sha="$1"
head_sha="$2"
workflow_file="${3:-ci.yml}"

if [ -z "$before_sha" ] || [ "$before_sha" = "0000000000000000000000000000000000000000" ]; then
    printf '%s\n' 'unavailable-push-base'
    exit 0
fi

if [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GITHUB_REF_NAME:-}" ]; then
    printf '%s\n' 'unavailable-push-base'
    exit 0
fi

ancestors="$(git rev-list --first-parent -n 30 "$before_sha" 2>/dev/null || true)"
if [ -z "$ancestors" ]; then
    printf '%s\n' 'unavailable-push-base'
    exit 0
fi

passing_push_shas="$(gh api --method GET \
    "repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow_file}/runs" \
    -f event=push \
    -f branch="${GITHUB_REF_NAME}" \
    -f per_page=100 \
    --jq '.workflow_runs[] | select(.status == "completed" and .conclusion == "success") | .head_sha' 2>/dev/null)" || {
    # The API is unreachable, so no base can be trusted to have proved anything.
    printf '%s\n' 'unavailable-push-base'
    exit 0
}

base_sha=""
while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if printf '%s\n' "$passing_push_shas" | grep -Fxq "$candidate" \
        && git merge-base --is-ancestor "$candidate" "$head_sha" 2>/dev/null; then
        base_sha="$candidate"
        break
    fi
done <<< "$ancestors"

if [ -z "$base_sha" ]; then
    printf '%s\n' 'unavailable-push-base'
    exit 0
fi

merged_tree_passed() {
    local pr_head_sha passing_runs
    [ "$(git rev-parse --verify --quiet "${head_sha}^1" 2>/dev/null || true)" = "$before_sha" ] || return 1
    pr_head_sha="$(git rev-parse --verify --quiet "${head_sha}^2" 2>/dev/null)" || return 1
    [ "$(git rev-parse "${head_sha}^{tree}" 2>/dev/null)" = "$(git rev-parse "${pr_head_sha}^{tree}" 2>/dev/null)" ] || return 1
    git merge-base --is-ancestor "$before_sha" "$pr_head_sha" 2>/dev/null || return 1
    passing_runs="$(gh api --method GET \
        "repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow_file}/runs" \
        -f head_sha="$pr_head_sha" \
        -f per_page=20 \
        --jq '[.workflow_runs[] | select(.status == "completed" and .conclusion == "success" and (.event == "push" or (.event == "pull_request" and any(.pull_requests[]?; .base.ref == env.GITHUB_REF_NAME))))] | length' 2>/dev/null)" || return 1
    [ "${passing_runs:-0}" -gt 0 ]
}

if [ "$base_sha" = "$before_sha" ] && merged_tree_passed; then
    base_sha="$head_sha"
fi

printf '%s\n' "$base_sha"
