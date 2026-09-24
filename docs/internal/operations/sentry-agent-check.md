# Sentry agent check

Use this document when a request says `check Sentry`, `verify Sentry`, `look at
Sentry`, or `inspect Sentry` without naming a more specific operation. How
reporting works is in [sentry-runbook.md](./sentry-runbook.md).

## What the request means

The default is a read-only health and evidence check. It does not change a
Sentry setting, rotate a credential, deploy code, resolve or delete an issue,
create or close a GitHub issue, or move a board item.

The words below select a different operation:

| User wording | Operation | External state changed |
| --- | --- | --- |
| `check`, `verify`, `look at`, `inspect` | Read current evidence and report it | No |
| `triage` or `investigate` | Review issues and prepare a bounded remediation record | No |
| `file an issue` | Create the explicitly requested remediation record | GitHub issue only |
| `configure`, `enable`, `disable`, `rotate`, or `change settings` | Change account, project, alert, consent, or credential state | Yes, only in the named scope |
| `deploy`, `publish`, or `release` | Build or deploy the named release | Yes, only in the named scope |

If the wording does not select one of these operations, stay in the first row.

## Read-only procedure

1. Record `HEAD`, `origin/main`, and the release being checked. Do not pull,
   rebase, or clean a checkout another writer owns.
2. For the release's workflow run, confirm the `Upload Sentry source maps` step
   ran and succeeded on every desktop target:

   ```sh
   gh run list --repo evb0110/evb-viewer --workflow release.yml --limit 5 \
     --json databaseId,headSha,conclusion
   gh run view <run-id> --repo evb0110/evb-viewer --json jobs
   ```

3. List unresolved production issues for each project with the pinned CLI,
   keeping the query bounded:

   ```sh
   pnpm exec sentry-cli issues list \
     --org "$SENTRY_ORG" \
     --project "$SENTRY_DESKTOP_PROJECT" \
     --query 'is:unresolved environment:production' \
     --pages 5 \
     --max-rows 500
   ```

   Repeat with `SENTRY_WEB_PROJECT`. Treat page caps, rate limits and missing
   authorization as `Unknown`, not as an empty queue.
4. For a named issue, read only the project, release, environment,
   `diagnostic_code` tag, Error ID and top application frame. If any field the
   scrubber does not allowlist appears, stop and follow the privacy incident
   procedure in the runbook.

## Report shape

```text
Sentry check
Mode: read-only
Repository: <HEAD>; origin/main: <SHA>; release: <value>
Source maps: <uploaded on every desktop target | Fail | Unknown>
Desktop issues: <summary | Unknown and why>
Web issues: <summary | Unknown and why>
Privacy: <Pass | Incident | Unknown>
Actions taken: none
```

## What requires a new instruction

Stop and obtain an explicit operation before sending test events, changing
DSNs, consent, alerts, retention or project settings, uploading or deleting
Sentry data, rotating or revealing credentials, deploying, or creating, editing
or closing GitHub issues. Permission to work autonomously does not change the
meaning of a bare read-only check.
