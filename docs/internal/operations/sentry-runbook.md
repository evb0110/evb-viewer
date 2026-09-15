# Sentry operations runbook

Agents handling a bare `check Sentry` or `verify Sentry` request must start with
[sentry-agent-check.md](./sentry-agent-check.md). This runbook is the policy and
evidence reference that the agent-check procedure points to.

This runbook applies to the `evb-viewer-desktop` and `evb-viewer-web`
projects. It never authorizes a broader event payload than the closed
`DiagnosticRecord` contract. Sentry is an error lead, not proof of a defect.

Do not record credential values, event payloads, private Sentry URLs, user
content, document names, local paths, or screenshots in this file, a GitHub
issue, or a canary record.

## Production enable gate

Production reporting stays disabled until every applicable item is complete:

- the DPA and the account checklist in `sentry-account-controls.md` are complete;
- the current privacy notice and, for Nitro, the legitimate-interests review
  are approved;
- source maps for the exact release and dist were uploaded before the canary;
- the public artifact scans and served-byte parity check pass;
- the relevant client-consent or server-objection test passes;
- the privacy sentinel and no-client-report lifecycle suites pass;
- the preview canary is safe, single-event, symbolicated, and actionable;
- pay-as-you-go remains disabled and the four alert classes below exist.

If a gate fails, omit the affected DSN from the build or deployment. A missing
DSN is the safe production state.

## Alerts

Create exactly these four alert classes. The owner is the repository owner.
Automatic GitHub issue creation and automatic Sentry resolution stay off.

| Alert class | Project and filter | Trigger | Exclusions |
| --- | --- | --- | --- |
| New or regressed fatal | Both projects, `environment:production`, level `fatal`, high-priority issue | First new or regressed issue | Preview, development, test, expected teardown, recovery already in progress, and events tagged `evb_canary` |
| New diagnostic code | Both projects, `environment:production`, `diagnostic_code` present | New issue or resolved issue regression | Expected outcomes, cancellation, validation, unsupported input, ordinary offline behavior, and events tagged `evb_canary` |
| Code rate | Both projects, `environment:production`, `diagnostic_code` present | More than 20 events in one issue within five minutes | Preview, development, test, client-suppressed repeats, and events tagged `evb_canary` |
| Quota | Organization usage | Personal error-quota notification at the platform-supported 80 and 100 percent points | No pay-as-you-go continuation; Sentry exposes no custom 50, 70, 75, or 90 percent points for this account |

The three project issue alerts must apply this account-side action filter to
every notification/escalation action:

```yaml
type: tagged_event
comparison:
  key: evb_canary
  match: ns # tag is not set
```

The current release-CI source-map canary carries
`evb_canary=sourcemap-v8` and a distinct fingerprint beginning with
`evb-viewer-sourcemap-canary-v8`. The `ns` comparison deliberately excludes
all canary versions by tag key, including future value changes. This filters
alert actions; the organization quota alert has no event-level filter and
remains subject to the account's normal usage accounting. The repository has
no alert-rule declarations, so the repository owner must apply this filter in
Sentry for both projects.

Record completion without private links:

| Control | Owner | Verified date | State |
| --- | --- | --- | --- |
| Fatal alert | Repository owner | 2026-09-04 | Enabled |
| New-code alert | Repository owner | 2026-09-04 | Enabled |
| Rate alert | Repository owner | 2026-09-04 | Enabled |
| Quota alert | Repository owner | 2026-09-05 | Enabled at the stricter available `100% and 80%` setting |

### 2026-09-16 control record

A follow-up using the documented owner-browser route widened the issue search
to 16D (2026-09-01 onward), all environments, and an explicit
`lastSeen:>=2026-09-01`. In both projects, each bare query
(`has:evb_canary`, `evb_canary:*`, and
`logger:evb-viewer.sourcemap-canary`) returned `1-25 of 1000+`; the same
counts held with the explicit date term. With `environment:production`, the
direct tag query returned 17 desktop rows and 732 web rows; the `has:` form
returned 0 desktop rows and 731 web rows. The exact production query combining
the canary logger and `error.type:EVBViewerSourceMapCanary` returned 0 desktop
rows and 729 web rows. Each of `release:v0.1.454` through
`release:v0.1.456`, and the corresponding unprefixed release queries, returned
no rows in either project; the event panels for the desktop tag candidates
nevertheless exposed versions `0.1.454` through `0.1.456`.

The production tag set read back as 7 desktop unresolved rows (the same 7
were regressed), 10 resolved rows, and no escalating, ongoing, archived, or
ignored rows. All 17 desktop rows were inspected in the event panels: every
one was mixed, with at least one event group missing one or more of the
`evb_canary` tag, canary logger, and `EVBViewerSourceMapCanary` type. The mixed
desktop short IDs were `DESKTOP-213`, `DESKTOP-6H5`, `DESKTOP-6HA`,
`DESKTOP-6H8`, `DESKTOP-6HB`, `DESKTOP-6H9`, `DESKTOP-218`, `DESKTOP-6HX`,
`DESKTOP-6HV`, `DESKTOP-6HK`, `DESKTOP-6HT`, `DESKTOP-6HN`, `DESKTOP-6HM`,
`DESKTOP-6HH`, `DESKTOP-6H7`, `DESKTOP-6HW`, and `DESKTOP-6HJ`. None was
resolved. The 112 desktop canary events are therefore an event-level count
spread across mixed issue groups, not 112 pure canary issues. Symbolication
left real-fault titles/types and diagnostic logger values on those groups,
which explains why the earlier all-three-marker desktop query returned zero.

The web production tag set read back as 732 resolved rows and zero rows for
unresolved, escalating, regressed, ongoing, archived, or ignored. The
all-environment exact-marker status checks were capped at `1-25 of 1000+` for
unresolved and ongoing in both projects and returned no rows for the other
listed statuses; those non-production capped sets were not mutated because
they are outside the week-1 production-release scope and could not be proven
event-by-event from the bounded result surface.

The three project issue alerts in both projects now have the documented
`tagged_event` action filter (`evb_canary`, `ns`) on the shared notification
action block, covering Suggested Assignees and Recently Active Members. The
before/after readback preserved each rule's trigger logic and existing
conditions, actions, throttle, projects, and owner; only the canary action
filter was added. Sentry canonically displayed the two existing fatal-alert
high-priority trigger rows in the opposite order after save; no trigger was
added, removed, or changed.
The organization quota alert was not opened or changed. No event was sent and
no paid capacity was enabled.

## Weekly and post-release triage

Run this checklist once per week and after every production release that has
diagnostics enabled.

1. Confirm each issue has the expected project, `production` environment,
   immutable release, and exact dist.
2. Confirm the top in-app frame has an EVB source file, function, and line.
   Run the symbolication canary again before using an unsymbolicated stack.
3. Inspect only the allowlisted fields. If any forbidden field appears, stop
   ordinary triage and follow the privacy incident procedure below.
4. Check the diagnostic code and its burst threshold. Confirm that expected
   outcomes did not create events and that repeats were bounded.
5. Merge Sentry issues only when diagnostic code and application frames support
   one root cause. Similar UI text or timing is not enough.
6. Reproduce from repository code, tests, a public fixture, or a maintainer-made
   synthetic fixture. Do not copy event content into a fixture.
7. When actionable, create a GitHub issue manually. Include the diagnostic code,
   release, dist or platform, a safe application-frame summary, frequency,
   Error ID, and reproduction status. Apply exactly one difficulty label.
8. Link the GitHub issue in Sentry. Resolve the Sentry issue only after the fix
   ships and the affected production release stays clean through the next
   weekly review.
9. Delete resolved Sentry issues and their event data. Record only the deletion
   date and count below.
10. Check event quota and every alert. Investigate missing alerts, loops, and
    unexplained volume before enabling another release.

Weekly evidence template:

| Review date | Releases checked | Open issues reviewed | GitHub issues created | Resolved issues deleted | Forbidden fields | Symbolication | Quota | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-06 | `v0.1.453` production web and eight shipping desktop identities | Historical `v0.1.452` canary issues remain separate triage data; the new exact-release receipts are clean | 0 | 0; the historical queue was not changed by this deployment | None in the verified closed-schema canaries | Pass; 230/230 per desktop dist and 259/259 for production web | Account quota controls unchanged and pay-as-you-go remains disabled | Repository owner account |
| 2026-09-12 | Desktop `v0.1.454` to `v0.1.456` and production web through `v0.1.453` | 17 desktop and about 100 web production issues; every desktop event since 2026-09-07 fell inside a release, supplemental-release, artifact-build, or publish-chain drill run window, so no user-originated event was found | 0 | 0; the read-only verification token cannot resolve or delete issues | None; user, IP, and message fields were empty and only closed-schema tags were present | Fail for desktop renderer frames: events carried no `debug_meta` and Sentry reported missing sources for `_nuxt` chunks because main built the Debug ID map only from its own process; main frames symbolicated. Fixed by reading packaged renderer chunk trailers in the desktop adapter | Unknown; the verification token cannot read organization usage | Repository owner account |

## Privacy incident response

A raw message, raw stack string, console argument, breadcrumb, UI copy, file
path, URL, query, document content, AI text, request field, identity field,
attachment, minidump, replay, span, profile, metric, log, session item, or any
unrecognized field is a privacy incident.

1. Disable the affected runtime using the procedure below. Do not inspect more
   affected events than needed to establish the incident.
2. Preserve only the event identifier, diagnostic code, release, dist, dates,
   and control state needed for the incident record. Do not copy the forbidden
   value.
3. Delete the affected events and issues in Sentry.
4. Rotate the affected DSN client key. Rotate the upload token too if it may
   have been exposed.
5. Open a private remediation record. State the forbidden field category and
   source code path, never its value.
6. Fix the closed-contract or adapter backstop and add a sentinel regression
   test for the field category.
7. Re-run the full privacy, envelope, public-artifact, and source-map suites.
8. Re-enable preview only. Production needs a new clean canary and a fresh
   approval of every production gate.

## Disable diagnostics

Use this procedure for a privacy incident, quota loop, broken symbolication, or
unsafe account state.

1. Remove `SENTRY_DESKTOP_DSN` from every desktop build environment and GitHub
   Actions secret scope that can produce a release.
2. Remove `SENTRY_BROWSER_DSN` and `SENTRY_NITRO_DSN` from the Vercel preview
   and production environments as applicable.
3. Redeploy the viewer and rebuild affected desktop artifacts. Existing shipped
   desktop clients can also be stopped by disabling or rotating their Sentry
   client key.
4. Keep `SENTRY_AUTH_TOKEN` disabled until uploads are safe again. Removing the
   token alone does not disable an already built client.
5. Prove the resulting artifact or deployment makes zero Sentry requests under
   a synthetic error. Confirm local logging, Error IDs, red UI, recovery, save,
   print, update, relaunch, and shutdown still work.
6. Record date, affected runtimes, reason category, release, and verifier. Do
   not record secret values.

## Credential rotation

The runtime keys are separate for desktop, hosted browser, and Nitro. The
restricted upload token has only release and source-map upload scope. The
read-only verification token is a separate credential and is never used for
uploads.

1. Create one replacement credential at a time with the same origin and scope
   restrictions recorded in `sentry-account-controls.md`.
2. Store it in the same GitHub or Vercel scope as the old credential. Never pass
   a token on a command line or print it in a workflow log.
3. Build or deploy preview, upload exact private maps, and run the applicable
   zero-request, one-event, revocation or objection, CSP, and symbolication
   checks.
4. Promote the replacement to production only after preview passes.
5. Revoke the old credential and verify that it no longer accepts events or
   uploads. For the read-only verification credential, repeat the exact
   read-only API request with the old credential still held only in the
   operator process and require an HTTP 401 or 403 denial. Keep the old value
   out of the command text, logs, receipt, and report.
6. Record the credential role, rotation date, verifier, and outcome. Do not
   record the value, key identifier, DSN, or private URL.

## Canary records

Canary events use synthetic faults and contain only the closed record. Record
counts and outcomes, not payloads or private account links.

### CLI source-map proof

Run the source-map canary and its verifier from the exact build stage after the
private upload has completed:

```text
node scripts/release/send-sentry-sourcemap-canaries.mjs
node scripts/release/verify-sentry-sourcemap-canaries.mjs
```

The upload command uses `SENTRY_AUTH_TOKEN`. The verification command uses a
separate `SENTRY_VERIFICATION_TOKEN` with read-only project and event access.
Do not give the verifier the upload-only token.

For a deliberate production proof, add `EVB_SENTRY_CANARY_ALLOW_PRODUCTION=1`
for that one process only. The sender refuses production by default. The
verifier reads the separate read-only token from Keychain and makes the Sentry
API checks; it never needs the upload credential.

On the operator Mac, load the verification token from Keychain for a local
run, then remove it from the shell:

```sh
export SENTRY_VERIFICATION_TOKEN="$(security find-generic-password -a "$USER" -s evb-viewer-sentry-verification-token -w)"
node scripts/release/verify-sentry-sourcemap-canaries.mjs
unset SENTRY_VERIFICATION_TOKEN
```

The first command records one deterministic event per project-source bundle in
`canary-receipt.json`. The second command queries Sentry's source-map-debug and
processed-event APIs for every event in that receipt. It requires the exact
release, dist, uploaded Debug ID artifacts, source-file and map lookup, the
expected EVB file, function, line, the `evb_canary` marker, and source context.
The sender gives that marked event an isolated fingerprint. It also checks
that the receipt covers the complete staged manifest. It writes only a
credential-free `canary-verification-receipt.json`. A submission without a
passing verification receipt is not symbolication evidence.

### Desktop matrix

Run the consent, main, renderer, worker-parent, UI-only, direct-console,
startup-marker, symbolication, recovery, relaunch, update, shutdown, and
artifact-scan checks for every dist below.

| Dist | Release | Unknown requests | Denied requests | Granted event count | Revocation requests | Error ID matched | Symbolicated | Artifact scan | Behavior deadlines | Date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `macos-arm64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and package lifecycle checks passed | 2026-09-06 |
| `macos-x64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and package lifecycle checks passed | 2026-09-06 |
| `windows-x64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and package lifecycle checks passed | 2026-09-06 |
| `windows-arm64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and package lifecycle checks passed | 2026-09-06 |
| `linux-x64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and package lifecycle checks passed | 2026-09-06 |
| `linux-arm64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and package lifecycle checks passed | 2026-09-06 |
| `store-appx-x64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and Store installed smoke passed | 2026-09-06 |
| `store-appx-arm64` | `evb-viewer-desktop@0.1.453` | 0 | 0 | 6 one-item envelopes; 230 source-map canaries | 0, including close-time | Pass | 230/230 verified | Pass | Consent, startup-marker crash/relaunch, and Store installed smoke passed | 2026-09-06 |
| `win7-legacy-x64` | Not shipped; tracked by #335 | N/A | N/A | N/A | N/A | N/A | N/A | No public artifact | N/A | 2026-09-05 |

Every request count under unknown and denied must be zero. A granted canary must
produce one envelope with one event item. Revocation must produce no queued,
close-time, or client-report envelope.

The exact final-SHA matrix
[34006005475](https://github.com/evb0110/evb-viewer/actions/runs/34006005475)
uploaded private maps and ran the packaged consent and crash matrix for every
shipping identity. Each matrix job asserted zero delivery in unknown and
denied states, six one-item event deliveries after grant, Error ID rendering
and correlation, no revocation or close-time delivery, and the one-shot
startup-crash marker replay and cleanup. Its eight small verification artifacts
contain 230 submitted and 230 verified source-map events per identity. The two
Store installed-smoke jobs also passed.

The local packaged macOS arm64 matrix runs through
`pnpm exec tsx scripts/release/verifyPackagedDiagnosticsSmoke.ts`. It uses isolated user data and a
deliberately non-existent EU test project, so the audit records six attempted
one-event envelopes and six terminal rejections without adding account data.
The six owners are UI-only, renderer, worker-parent, direct-console, main, and
fatal UI. The same run proves the first still-live occurrence is resent only
after durable grant, Error IDs match both UI surfaces, revocation and close add
no envelopes, and a real uncaught main failure writes and replays the startup
marker. Hosted release jobs require accepted delivery and cover every shipping
identity.

Artifact workflow
[33928531296](https://github.com/evb0110/evb-viewer/actions/runs/33928531296)
completed successfully. Its two Microsoft Store installed-smoke jobs passed.
The replacement exact-SHA workflow
[34006005475](https://github.com/evb0110/evb-viewer/actions/runs/34006005475)
is the acceptance record for `0.1.453`; it passed overall, with only the
credential-free Windows 7 advisory PDF journey failing before application
startup.
The core and supplemental release workflows also completed successfully, and
the public `v0.1.452` release has every required core and supplemental asset.
`SHA256SUMS` verifies the immutable core set; supplemental assets attach later
by the repository's documented release policy and expose GitHub asset digests.

The Windows 7 lane is an unpublished experiment, not a shipping identity. Its
Electron 22 runtime cannot load the ESM main entry, so its packaged smoke fails
before the app starts. Issue #335 owns the choice to remove that lane or build a
separate CommonJS-compatible legacy application. No Windows 7 artifact, DSN, or
map proof is represented as production evidence here.

### Hosted browser

| Deployment | Served-byte parity | Unknown requests | Denied requests | Granted event count | Revocation requests | CSP origin count | Error ID matched | Symbolicated | Date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Preview | Pass, protected exact-byte deployment | Pending | Pending | 259 source-map canaries | Pending | One EU ingest origin in built CSP | Pass in the verifier | 259/259 verified | 2026-09-05 |
| Production | Pass, exact prebuilt `evb-viewer-web@0.1.453` deployment | 0 | 0 | 1 runtime event plus 259 deterministic source-map canaries | 0 | One EU ingest origin in served CSP | Pass | 259/259 verified | 2026-09-06 |

The CSP origin count must be one for the exact EU ingest origin. Electron CSP
must remain unchanged.

The historical `v0.1.452` feed contained deterministic canary issues with
`missing_source_content`. The replacement uploader now handles the hidden
Vercel output and canonical source-root paths. The final production receipt was
checked against every event through the source-map-debug and processed-event
APIs, so the current table records symbolication rather than inference from a
successful upload.

Production completed the consent behavior canary against `web.evb-viewer.com`.
Unknown and first-time denied states made no ingest request, granting the live
fault emitted one event, and immediate revocation emitted nothing later. The
served bundles matched the private manifest, and the current 259-event receipt
resolved to its expected EVB sources and functions.

### Viewer Nitro

| Environment | Uncaught 500 count | Explicit-code counts | Objecting request count | Request-derived fields | Error ID matched | Symbolicated | Review period | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Preview | Pending | Pending | Pending | None expected | Pending | Pending | Pending | Disabled |
| Production | Pending | Pending | Pending | None expected | Pending | Pending | Pending | Disabled |

Run Nitro in preview first. Production remains disabled until the preview gate
and legal approval pass. Review preview and production canary data for one full
week before completing the Nitro canary. This work remains outside the closed
desktop/browser delivery scope and is tracked by
[#222](https://github.com/evb0110/evb-viewer/issues/222) and
[#261](https://github.com/evb0110/evb-viewer/issues/261).

## Four-week production proof

The operating record has two scopes. The enabled-client baseline covers the
eight shipping desktop identities and the served production browser. The
Nitro record starts only after its legal and preview gates. A baseline or a
synthetic canary is not an elapsed week. This record continues after the
desktop/browser delivery closure. A failed measure opens a remediation issue;
it does not reopen the closed delivery project.

The first valid enabled-client production baseline is 2026-09-06 for
`v0.1.453`: eight desktop identities and production web passed the consent,
closed-event, source-map, and artifact checks recorded above. The next weekly
review is due 2026-09-13 UTC. The earliest four-week client record is
2026-10-04 UTC if each weekly review passes. Nitro has no observation start
date because its processing remains disabled. The client baseline is not a
four-week completion claim. Continue it under
[#267](https://github.com/evb0110/evb-viewer/issues/267), which remains open.

| Week | Enabled runtimes and releases | Volume within thresholds | Suppression correct | Quota healthy | Forbidden fields | Symbolication | Actionable outcomes | Remediation issue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Eight desktop identities on `v0.1.454` to `v0.1.456`; production web on `v0.1.453` | Yes; 112 desktop production events, all from release CI canaries, with no rate-alert bursts | Yes; no repeated user fault observed | Unknown; not readable with the verification token | None | Fail for desktop renderer frames, fixed 2026-09-12 in the desktop adapter and pending the next release for proof | Renderer Debug ID fix; release-CI canaries share production fingerprints with real faults and keep issues escalating, which is fixed in the release canary contract by an explicit marker and isolated fingerprint; the three issue-alert actions still require the documented `evb_canary` `ns` filter | None |
| 2 | Pending | Pending | Pending | Pending | None expected | Pending | Pending | None |
| 3 | Pending | Pending | Pending | Pending | None expected | Pending | Pending | None |
| 4 | Pending | Pending | Pending | Pending | None expected | Pending | Pending | None |

The repository has no dedicated Sentry scheduler or durable wake-up job. The
existing scheduled GitHub Actions workflows are unrelated maintenance and do
not perform this review. Until a named operator or an explicitly created
durable schedule records the next review, the due date above is a procedure,
not a claim that an idle agent will wake itself.

## Package-removal rehearsal

Run this rehearsal in a disposable worktree. Do not publish the rehearsal.

1. Remove the three Sentry runtime packages, the pinned CLI, the three adapter
   roots, and only their initialization and upload wiring.
2. Keep the diagnostic registry, reporters, receipts, consent setting, Error ID
   presentation, local logs, recovery, and typed IPC intact. Replace adapter
   construction with the existing no-op transport.
3. Run typecheck, unit tests, architecture checks, and the applicable packaged
   smoke tests.
4. Exercise startup, file open, save, export, print, update, renderer recovery,
   relaunch, shutdown, and one red UI failure. Each local behavior must remain;
   network inspection must show zero Sentry requests.
5. Remove the disposable worktree and record only the tested commit, date,
   gates, platforms, and result.

| Tested commit | Date | Gates | Platforms | Local behavior | Sentry requests | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `f39a0e2d6fcb3610f96fcde81496a9dc5108483d` | 2026-09-04 | Typecheck, 10,876 unit tests, architecture, desktop build, package, packaged core PDF smoke | macOS arm64 | Startup, PDF open, annotation save, metadata-preserving rotation, source isolation, search, and shutdown passed; print, export, updater download, recovery relaunch, and fatal dialog were not exercised | Zero structurally possible; packages, adapters, ingest endpoint, upload commands, and credentials were absent, but no packet-capture proxy was used | Partial pass; repeat the omitted behaviors before calling the full rehearsal complete |
| `ac525d5653625f1c47c40cbb1860d8190df3e762`, disposable child of `7b9ce3e379a6b66a7ad07011707dbf3617d90af3` | 2026-09-05 | Typecheck, 11,479 unit tests, architecture, strict desktop build, macOS package, packaged diagnostics removal matrix, source and ASAR scans, and differential packaged PDF and visible-window checks | macOS arm64 | Runtime and fatal Error IDs remained; direct console and main errors stayed local; startup crash marker, recovery relaunch, and shutdown passed. The full unit suite covered local logging, save, export, print, update, recovery, and shutdown behavior after package removal. The independent packaged PDF and visible-window suites reached the document but hit the same visual-settle failure on the untouched parent build, so that existing failure is not attributed to removal. | Zero delivery attempts in the packaged audit for UI, console, main, and startup-marker cases. No Sentry dependency, adapter, DSN, ingest endpoint, or Sentry module path remained in source or the packaged ASAR. | Pass. Removing Sentry leaves the local failure pipeline and covered application behavior intact. The unrelated renderer-settle test failure remains outside this rehearsal. |
| `636730a6167341a2922f4a01487c600952e8e1c2` | 2026-09-15 | Frozen install, macOS arm64 package, packaged core PDF smoke with scratch behavior extension, packaged diagnostics no-op matrix, and hidden packaged visual viewport check (`18979e7f06658a84b1f5ee2e9ecbbca6f6b26e5b` is in the tested ancestry) | macOS arm64 | PDF open, annotation save, metadata-preserving rotation, source isolation, search, shutdown, print PDF (470,039 bytes), DOCX export (1,785 bytes), updater check and download start against a local fixture followed by the expected fixture 404, fatal Error ID rendering, and startup-crash recovery relaunch with marker cleanup passed. | Diagnostics transport was disabled/no-op. Renderer CDP request observers saw 0 Sentry or ingest requests in both packaged sessions; the local updater fixture recorded 4 non-Sentry requests. | Pass for current-main settle and the omitted packaged behaviors. The prior visual-settle failure no longer reproduces; `18979e7f06658a84b1f5ee2e9ecbbca6f6b26e5b` paints fit feedback before rerender. The visible-window suite remained unrun under the all-launches-hidden constraint; successful updater installation and external packet capture were not claimed. |
