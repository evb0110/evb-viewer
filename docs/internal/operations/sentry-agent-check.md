# Sentry agent check

Use this document when a request says `check Sentry`, `verify Sentry`, `look at
Sentry`, or `inspect Sentry` without naming a more specific operation.

## What the request means

The default is a read-only health and evidence check. It does not send a
canary, change a Sentry setting, rotate a credential, deploy code, resolve or
delete an issue, create or close a GitHub issue, or move a board item.

The words below select a different operation:

| User wording | Operation | External state changed |
| --- | --- | --- |
| `check`, `verify`, `look at`, `inspect` | Read current evidence and report it | No |
| `send`, `submit`, or `run a canary` | Submit the named synthetic canary, then verify it | Sentry events and a receipt |
| `triage` or `investigate` | Review issues and prepare a bounded remediation record | No |
| `file an issue` | Create the explicitly requested remediation record | GitHub issue only |
| `configure`, `enable`, `disable`, `rotate`, or `change settings` | Change account, project, alert, consent, or credential state | Yes, only in the named scope |
| `deploy`, `publish`, or `release` | Build or deploy the named release | Yes, only in the named scope |

If the wording does not select one of these operations, stay in the first row.
Read [sentry-runbook.md](./sentry-runbook.md) for policy and the
[implementation ledger](../sentry-implementation-ledger-2026-09-01.md)
for acceptance criteria. This file is the agent entry point, not a replacement
for either source of truth.

## Read-only procedure

Complete these steps in order. A check is complete only when every applicable
runtime has a result or an explicit `Unknown` with the reason it could not be
checked.

### 1. Establish the revision and preserve the workspace

1. Read this file, the operations runbook, the account-controls file, and the
   current Sentry ledger before interpreting any event or dashboard state.
2. Run `git status --short --branch`, inspect active writers and test processes,
   and preserve dirty files, worktrees, sessions, and processes.
3. Record `HEAD`, `origin/main`, and the exact release or deployment being
   checked. A stale local checkout is not release evidence.
4. If the checkout is clean, is on `main`, and no active writer owns it, it may
   fast-forward with `git fetch origin` and `git pull --ff-only origin main`.
   If it is dirty or owned by another writer, do not pull, rebase, reset, or
   clean it. Report the revision boundary instead.

### 2. Check the enabled runtimes

Check all enabled runtimes unless the user names one:

- Desktop: inspect the latest exact-SHA matrix and its artifacts for all eight
  shipping identities. Keep `win7-legacy-x64` separate as a credential-free,
  non-shipping advisory lane.
- Hosted browser: inspect the exact production deployment and preview when a
  preview is part of the current release. Check release, dist, environment,
  served-byte parity, CSP ingest-origin count, consent suppression, Error ID
  correlation, and revocation behavior.
- Nitro: treat it as disabled unless the account-controls file and the current
  ledger say that its preview and legal gates are complete.

Use the repository's current GitHub run and artifact evidence. A green local
test, a successful upload, a Sentry issue count, or a dashboard screenshot does
not prove symbolication or acceptance by itself.

The read-only GitHub inspection starts with these commands:

```sh
gh run list --repo evb0110/evb-viewer --limit 20 \
  --json databaseId,headSha,status,conclusion,workflowName
gh run view <run-id> --repo evb0110/evb-viewer \
  --json headSha,status,conclusion,jobs
gh run download <run-id> --repo evb0110/evb-viewer \
  --dir .devkit/sentry-check/<run-id>
```

Use the run whose `headSha` is the exact release or deployment SHA. If the
required artifact is absent, report that evidence as `Unknown`; do not select a
different run just to make the check green.

### 3. Verify source maps through the read-only API

The verifier is the source-map proof. It checks every event in a receipt
against Sentry's source-map-debug and processed-event APIs, including the exact
release, dist, Debug ID, original EVB source, function, line, and source
context.

Run it only when the exact build workspace contains the matching private
source-map stage and `canary-receipt.json`. Take `target`, `release`, `dist`,
`environment`, organization, and project from that exact receipt or hosted
artifact. Never guess them from a current version number.

On the operator Mac, the read-only command has this shape. The token value must
stay in Keychain and in the process environment; it must never appear in the
command text, terminal output, a receipt, or a report:

```sh
SENTRY_VERIFICATION_TOKEN="$(security find-generic-password -a "$USER" -s evb-viewer-sentry-verification-token -w)" \
EVB_SENTRY_TARGET=<desktop-or-web> \
EVB_SENTRY_RELEASE=<exact-release> \
EVB_SENTRY_DIST=<exact-dist> \
EVB_SENTRY_ENVIRONMENT=<exact-environment> \
SENTRY_ORG=<organization-slug> \
SENTRY_DESKTOP_PROJECT=<desktop-project-slug> \
node scripts/release/verify-sentry-sourcemap-canaries.mjs
```

For a web target, use `SENTRY_WEB_PROJECT=<web-project-slug>` instead of the
desktop project variable. Leave the unused project variable unset. Replace
only the remaining angle-bracket values from the exact receipt. The verifier
is read-only. It writes a credential-free `canary-verification-receipt.json`.
The sender, `scripts/release/send-sentry-sourcemap-canaries.mjs`, is not part
of a plain check. If the private stage or receipt is missing, report
`Unknown: exact verification inputs unavailable`; do not generate new events
to fill the gap.

### 4. Inspect Sentry issues only when issue health is in scope

Use Chrome for the Sentry issue feed when the user asks about current issues,
alerts, quota, or account controls. Review both viewer projects and the
`production` environment. For each relevant issue, record only:

- project, release, dist, environment, diagnostic code, and safe platform data;
- whether the Error ID maps to the application failure record;
- whether the top frame is an EVB source file, function, and line;
- event and user counts, age, alert state, and whether the issue is new or
  regressed.

Do not copy event payloads, raw messages or stacks, user content, URLs, paths,
document names, screenshots, private Sentry links, or credential material into
the repository, a GitHub issue, or a report. If a forbidden field appears,
stop normal triage and follow the privacy-incident procedure in the runbook.

### 5. Report a fixed result

Use this shape so another agent can act on the result without guessing. State
whether the result concerns the closed desktop/browser delivery scope or the
continuing Nitro and elapsed-time follow-ups. Delivery closure is not Nitro
approval and is not a four-week operating result:

```text
Sentry check
Mode: read-only
Repository: <HEAD>; origin/main: <SHA>; exact release/deployment: <value>
Desktop: <Pass | Fail | Unknown>, with all eight shipping identities accounted for
Hosted browser: <Pass | Fail | Unknown>, production and preview scope stated
Nitro: <Disabled | Pass | Fail | Unknown>, with the reason
Source maps: <verified count>/<receipt count>, exact release and dist stated
Issues and alerts: <summary or Not checked because out of scope>
Privacy: <Pass | Incident | Unknown>
Actions taken: none
Blocking evidence or next safe step: <one concrete statement>
```

Write `Fail` when a checked assertion fails. Write `Unknown` when evidence is
missing, stale, or outside the available credential scope. Never turn an
unverified claim into `Pass` because a dashboard looks healthy.

## What requires a new instruction

Stop and obtain an explicit operation before doing any of the following:

- sending synthetic events or rerunning a production canary;
- changing DSNs, consent, alerts, retention, privacy, source-map access, or
  project settings;
- uploading, deleting, resolving, archiving, or merging Sentry data;
- rotating, revoking, copying, or revealing credentials;
- deploying a release or changing Vercel or GitHub Actions state;
- creating, editing, closing, or moving GitHub issues and project items.

The user's existing permission to work autonomously does not change the
meaning of a bare read-only check. It authorizes an explicitly requested
implementation or operation, not an inferred external mutation.
