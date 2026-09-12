# Sentry error telemetry implementation ledger

- Status: current implementation ledger, updated from repository and live-control evidence on 2026-09-06
- Ledger date: 2026-09-01
- Repository version at acceptance: 0.1.453
- Repository implementation SHA: `92cb7970a0f7ac5e7a966b38cff574fe3722b4c5` on `main`
- Architecture source of truth: `docs/internal/sentry-error-telemetry-ledger-2026-09-01.md`
- Legal and privacy source of truth: `docs/internal/research/sentry-opt-out-diagnostics-2026-09-01.md`
- Implementation snapshot: the source-map uploader and per-event API verifier
  repair is implemented and accepted. Exact-SHA CI run
  [34003537093](https://github.com/evb0110/evb-viewer/actions/runs/34003537093)
  passed for `92cb7970a0f7ac5e7a966b38cff574fe3722b4c5`. The canary-enabled
  replacement matrix
  [34006005475](https://github.com/evb0110/evb-viewer/actions/runs/34006005475)
  passed overall, with all eight shipping identities producing 230 submitted
  and 230 verified events. The separate Windows 7 legacy PDF journey remains
  advisory and failed before the application journey; it produced no shipping
  artifact, credential, or Sentry proof.
- Production web deployment `dpl_4eGs7Nt4nnKevc3arabqENdvNX5f` is READY at
  `web.evb-viewer.com`. Its fresh `evb-viewer-web@0.1.453` production receipt
  contains 259 events, all 259 verified, with 218 generated or vendor-only
  bundles skipped at submission. The final record is current and is not
  deferred or superseded. Nitro's separate legal and observation gates remain
  open and are not part of this client acceptance.

## Scope

This ledger turns the fixed architecture into sequenced, individually shippable
work. It answers four questions for an engineer who has only this repository:

1. Which files own which part of the failure contract.
2. In what order the work can land without a circular prerequisite.
3. What each work item must do, what proves it, and what evidence closes it.
4. Which gates are outside the repository and therefore block release rather
   than block code.

The architecture ledger already received a binding independent audit. Its
decisions are inputs here, not open questions. Where this ledger looks like it
is deciding something, it is only naming the file, the order, or the proof.

## Fixed decisions this plan implements

These are restated so a work item can cite them. They are not reopened.

1. Sentry is used for actual application errors and crashes only. No training,
   AI, analytics, replay, tracing, profiles, logs, sessions, feedback,
   attachments, minidumps, document data, or user content.
2. Every actual red UI state and every actual red console entry enters the local
   diagnostic gate. One logical fault has one owner and one `FailureReceipt`.
3. Electron and hosted-browser clients are opt-in in the first release. Viewer
   Nitro may be default-on with an opt-out only after the legal and account
   gates pass. Landing stays local-only.
4. Two Sentry projects only: `evb-viewer-desktop` and `evb-viewer-web`.
5. The renderer and preload contain no Sentry SDK. Electron main uses a
   Node-family client with every automatic ownership behavior disabled.
6. Raw development-runner output and local log files are never Sentry input.
7. A console error with no EVB-shipped application frame is counted locally and
   dropped remotely.
8. One consent-gated startup crash marker may persist until the next launch. It
   is a single marker, not a queue.
9. Source maps stay private. Debug IDs are injected before final-byte receipts,
   maps are staged before pruning, and the viewer deployment ships the exact
   built output.
10. The Sentry acknowledgement appears in both landing footer paths and in an
    in-app About and Acknowledgements page, independent of telemetry.
11. Current Sentry Business error retention is 90 days. Resolved issues are
    deleted during weekly triage.

## Non-goals

- No default-on client telemetry in any build in this release.
- No landing Sentry project, DSN, or browser SDK.
- No Sentry SDK, DSN, or envelope in the renderer, preload, workers, utility
  processes, or any `scripts/` tool.
- No breadcrumbs, console capture integration, session tracking, client reports,
  or offline event queue anywhere.
- No automatic GitHub issue creation or automatic Sentry resolution.
- No change to fail-fast behavior, shutdown deadlines, recovery, or relaunch in
  order to deliver an event.
- No new error system beside the existing logger, runtime report, and fatal
  surfaces. The failure occurrence replaces their identity, it does not sit
  beside them.
- No geographic, locale, timezone, or download-source inference of consent
  policy.

## Current implementation and external gate snapshot

This snapshot separates repository proof from account, deployment, and elapsed
time proof. A local implementation status does not authorize production
reporting and does not satisfy a live canary.

### Repository proof

- The renderer migration inventory has 77 `BrowserLogger.error` calls and zero
  receipt-free or generic-code owners.
- The Electron migration inventory has 98 statically identified logger error
  calls and zero receipt-free or generic-code owners.
- Five custom rules block raw red presentation, direct application
  `console.error`, receipt-free presentation, unclassified error logging, and
  application-owned generic diagnostic codes.
- Typecheck includes a contraction fixture proving the removed logger and
  presenter signatures no longer compile.
- The 2026-09-04 macOS arm64 diagnostics build staged 280 private maps: 196
  browser-renderer, five browser-worker-parent, 69 Electron-main, three
  Electron-utility-parent, and seven Electron-worker-parent bundles. It found
  228 project-source mappings and recorded 52 generated or vendor-only chunks
  that cannot prove an EVB source mapping. The final Nuxt and Electron public
  roots contained zero maps. The count is build-output evidence, not a fixed
  acceptance number.
- Hosted-browser reporting is enabled in the exact production viewer build and
  remains consent-gated. Desktop artifacts receive their separately scoped
  build credential, and all eight shipping identities passed the packaged
  canary matrix. Nitro production reporting remains disabled.

### Acceptance scope split

The enabled-client acceptance record covers the eight shipping desktop
identities and the served production browser. Its dated baseline is the exact
`v0.1.453` evidence recorded on 2026-09-06. This closes client implementation,
consent, source-map, alert, weekly-procedure, and removal requirements where
the issue scope names those clients.

Viewer Nitro is a separate server-side scope. Its legal review, objection
route, preview and one-week observation, and any four-week program evidence
remain tracked by #222, #261, and #267. A client baseline is not a Nitro
canary, and neither is an elapsed four-week record.

### Live control proof recorded through 2026-09-05

- The Sentry organization uses the European Union data region. DPA version
  5.1.0 and the BAA are signed. Aggregated identifying service-data use and
  minidump attachment storage are disabled.
- The organization has one owner and uses the connected Google account for
  routine sign-in. Personal Gmail cannot configure organization SSO, and the
  Sentry Security page exposes no password-removal control. Sentry-native and
  organization 2FA remain off by explicit owner decision for this route.
- Generative AI, shared issues, open membership, join requests, member
  privileges, IP storage, and JavaScript source fetching are disabled. Enhanced
  Privacy and both required scrubbers are enabled. Attachment and debug-file
  access are Owner-only. The targeted sensitive-field list preserves canonical
  frame and Debug ID fields.
- Sentry derived geography on the first closed test events despite IP storage
  prevention. Both projects now remove `$user.geo.**` in the advanced scrubber.
  Repeated desktop and browser events contained no geography.
- Exactly two projects and three purpose-specific keys exist. One source-map
  token has only `org:ci`. GitHub Actions stores the desktop and upload settings.
  Vercel stores the browser DSN in Production and keeps the separate Nitro DSN
  in Preview only. Nitro remains disabled because its legal, retention, and
  objection gates are not complete.
- A strict upload accepted the final web release with 477 mapped bundles, 15
  manifest-proved mapless generated facades, and 1,386 project sources. The
  READY production deployment ships no public maps, and served-byte parity
  matches the private manifest. The uploader stages Vercel's hidden output in a
  visible temporary tree, uploads the static and functions roots with the
  correct URL identities, then uploads each top-level source root with its
  matching URL prefix. The verifier queries Sentry's source-map-debug and
  processed-event APIs for every canary event and writes only a credential-free
  receipt.
- The hardened Electron and browser adapters each sent one closed test event,
  and post-scrubber repeats confirmed that no URL, request, raw content, user,
  or derived geography survived. The macOS arm64 private upload accepted all
  280 mapped bundles. Sentry then accepted 228 deterministic Debug ID canaries,
  and sampled Electron main, renderer, and browser-worker events resolved to
  the expected EVB TypeScript or Vue file and line with the exact release and
  dist.
- The exact-tag `v0.1.452` artifact run uploaded 280 private bundles for each
  of the eight shipping desktop identities and submitted 228 mapped canaries
  per identity. It passed its packaged-artifact scan, but it did not run the
  new per-event source-map verifier. Those submissions are historical and do
  not close the source-map rows. The unpublished Windows 7 experiment remains
  outside the shipping matrix under #335. Artifact workflow
  [33928531296](https://github.com/evb0110/evb-viewer/actions/runs/33928531296)
  completed successfully, including both Microsoft Store installed-smoke jobs.
- Release `v0.1.452` is public at commit
  `02dfb20d0a32f65ed86162283ab9231725c17bcf`. Its exact prebuilt viewer output
  is the production deployment at `web.evb-viewer.com`. The production upload
  accepted 473 mapped bundles. Sentry accepted all 256 deterministic mapped
  canaries and recorded 217 generated or vendor-only bundles as intentional
  skips. A real consent-gated runtime event resolved to the original
  `app/utils/failureReporter.ts` and
  `app/plugins/rendererErrorGuard.client.ts` lines.
- The production browser matrix proved zero ingest requests in unknown and
  denied states, one successful envelope after granting the still-live error,
  and no additional envelope after immediate revocation. The public CSP adds
  one EU Sentry ingest origin only. The landing CSP adds none.
- The landing acknowledgement is live in production deployment
  `dpl_6mz6ywiVqcCUvraULktftokjSe9W`. A fresh browser session rendered the
  bundled wordmark and OSS-program link with zero console errors and warnings,
  and made no Sentry request. The deployment check also found and fixed an
  unrelated dangling `privacy` identifier emitted by Nuxt locale compilation.
- The repository-linked public GitHub project is the live status view. Ticket
  status follows verified exit evidence rather than the original planning count.

### External and elapsed-time gates still open

- A qualified person must approve the viewer Nitro legitimate-interests
  assessment before Nitro processing starts. This is the authored release
  gate recorded above, not a legal attestation by this repository.
- The enabled-client baseline is complete for the eight shipping desktop
  identities and production browser. The one-week Nitro canary and the
  four-week elapsed production proof remain incomplete. The first weekly
  operations cycle and platform-supported quota notifications were verified
  on 2026-09-05.

## Planning baseline (historical)

Verified at `55e00c767`. These numbers and paths document the migration
planning baseline. The acceptance evidence above and the exact-SHA CI run are
the current implementation record.

| Fact | Value | Where |
| --- | --- | --- |
| Renderer error logging | 76 `BrowserLogger.error` calls in 45 files | `app/**` |
| Electron loggers | 104 `createLogger(` constructions, 115 `.error(` call sites | `electron/**` |
| Red toast presentations | 24 `color: 'error'` sites in 11 files | `app/**` |
| Runtime report calls | 8 `reportRuntimeError(` sites | `app/**` |
| Fatal state calls | 4 `setFatalRuntimeError(` sites | `app/pages/electron.vue`, `app/app.vue`, `app/composables/useFatalRuntimeError.ts` |
| Settings schema | `DEFAULT_SETTINGS.version` is 2 | `packages/contracts/settings.ts` |
| Renderer log direction | `broadcastToRenderers: false` | `electron/platform-ipc/rendererLogBridge.ts` |
| Main log broadcast | `ERROR` and `WARN` records reach every window | `electron/utils/createLogger.ts` |
| Preload red print | isolated-world `console.error` of a main `ERROR` record | `electron/preload/installDebugLogListener.ts` |
| Runtime card projection | main `ERROR` records become runtime reports | `app/plugins/runtimeErrorLogStream.client.ts` |
| Global renderer guard | Vue errors, `window.error`, rejections | `app/plugins/rendererErrorGuard.client.ts` |
| Fatal handler install | after the shutdown coordinator is constructed | `electron/main.ts` around the `process.on('unhandledRejection')` and `process.on('uncaughtException')` registrations |
| Load-failure owners | three `did-fail-load` registrations | `electron/window.ts`, `electron/window/rendererReady.ts`, `electron/window/attachShowLifecycle.ts` |
| Worker ownership | reported-error marker set, cancellation classified as info | `electron/utils/workerTask.ts` |
| Preload argument channel | encoded snapshot passed through `additionalArguments` | `electron/window.ts`, `electron/preload/readHostResourceProfileArgument.ts` |
| App locales | 9 (`en`, `ru`, `fr`, `de`, `es`, `it`, `pt`, `pt-BR`, `nl`) | `packages/i18n-core/localeCodes.ts`, `packages/i18n-app/messages/` |
| Landing locales | re-exported from the landing i18n core | `landing/app/i18n/localeCodes.ts` |
| App CSP | `connect-src 'self' blob:` in production | `nuxt.config.ts` |
| Electron CSP | `connect-src 'self' blob:` in production | `electron/security/csp.ts` |
| Electron map emission | only when `EVB_ELECTRON_SOURCEMAP=1` | `scripts/build-electron.mjs` |
| Map pruning | `pnpm run build` prunes `*.map` right after `nuxi build` | `package.json`, `scripts/prune-build-artifacts.mjs` |
| Build receipt inputs | `dist-electron`, `nuxt-output`, generated builder resources, native manifest and staging roots | `scripts/release/build-receipt.mjs` |
| Web deployment | tracked source is uploaded and Vercel builds it; `--prebuilt` is not used anywhere | `scripts/deployVercelPrivate.mjs`, `package.json` deploy scripts |
| Architecture boundaries | root and runtime-to-tool import rules | `scripts/architecture/boundary-check.mjs`, `scripts/architecture/runtimeToolBoundaryRules.mjs` |
| Custom lint rules | repository-specific ESLint rules live in one plugin | `eslint-plugin-custom.mjs`, `eslint.config.mjs` |
| Architecture tests | vitest policy suites | `tests/unit/architecture/` |

### Reconciliation with changes since the architecture inspection

The architecture inspected `e7f5606a45af2f7e78fe0ec861dacd3d07fdeb45`. Seven
commits have landed since. None of them touches renderer or Electron error
paths, so every count and topology statement above still holds. The changes do
affect implementation sequencing and validation, as follows.

| Change | Commit | Consequence for this plan |
| --- | --- | --- |
| The `push` path filter on `ci.yml` was removed, so every commit on `main` gets its own exact-SHA hosted run and `gates_ok` is the single validation authority | `9ece1ec2e` | New diagnostic files need no CI path registration. Every migration commit pays a full hosted lane, so migration work items are sized to land as a small number of coherent commits rather than one commit per call site. |
| The `ci.yml` dispatch fallback, its `release:ci` script, and its tests were removed; the cutter and the pre-push red-main check count push events only | `9ece1ec2e` | A manual workflow dispatch can never vouch for a diagnostics-enabled build. Release identity work must rely on the push run for the exact commit. |
| Microsoft Store submission automation was removed; AppX packages remain workflow artifacts for manual Partner Center upload | `55e00c767` | The Store opt-in requirement is unchanged and still binds the product. There is no submission job to gate, so the Store consent note belongs in the manual upload runbook in `docs/contributing/release-guardrails.md`. |
| A supplemental re-dispatch now reuses already attached assets instead of rebuilding, because builds are not byte reproducible | `55e00c767` | Debug ID injection, map staging, and map upload for the supplemental macOS Intel and Windows ARM64 targets must happen in the run that first attaches those assets. A later re-dispatch verifies bytes and must not rebuild or re-upload maps. If the first attach run did not upload maps, that artifact ships with diagnostics disabled for that release. |
| Builds are explicitly not byte reproducible | `55e00c767` | The private map manifest is per artifact build, not per version. Symbolication identity is pinned by injected Debug ID plus receipt hash, never by rebuilding the same version later. |
| Worktree hygiene rules and `pnpm worktrees:prune` were added | `e16df1bc0`, `0c085e1db` | Implementation happens in an isolated integration worktree. Canary and e2e work follows `docs/internal/agents/workspace-hygiene.md`, including stopping every `electron:run` session in the stage that started it. |
| The Electron launch config now shares one hidden bundle per Electron version and prunes finished session state | `e16df1bc0` | The development runner remains a local-only diagnostic channel. Its session output is owned by the launcher and stays outside every Sentry adapter. |

## File and owner map

Paths that do not exist yet are marked `new`. Every other path exists at
`55e00c767` and is modified in place.

### Shared closed contracts

| Path | Role | Work items |
| --- | --- | --- |
| `packages/contracts/diagnostics/diagnosticCodes.ts` (new) | `DIAGNOSTIC_DEFINITIONS`, code union, per-code context shape, grouping and stack policy | SEN-CORE-01 |
| `packages/contracts/diagnostics/diagnosticRecord.ts` (new) | `DiagnosticRecord`, `CanonicalAppFrame`, `FailureSeverity`, `DiagnosticRuntime`, `DiagnosticOperation`, strict decoder | SEN-CORE-02 |
| `packages/contracts/diagnostics/diagnosticEventId.ts` (new) | 128-bit occurrence ID creation and validation | SEN-CORE-02 |
| `packages/contracts/diagnostics/failureReceipt.ts` (new) | `FailureReceipt`, `ExpectedOutcome`, `CaptureFailureInput`, `LocalFailureDetail` | SEN-CORE-03 |
| `packages/contracts/diagnostics/canonicalAppFrames.ts` (new) | pure stack parser and canonical frame normalization shared by every runtime | SEN-CORE-05 |
| `packages/contracts/diagnostics/startupCrashMarker.ts` (new) | closed marker schema and strict decoder | SEN-CON-03 |
| `packages/contracts/diagnostics/diagnosticsPreference.ts` (new) | `ClientDiagnosticsPreference`, parser that maps missing, corrupt, partial, and unknown values to `unknown` | SEN-CON-01 |
| `packages/contracts/electronApiCommon.ts` | `IDebugLogEntry` gains the closed `failureRef` for `ERROR` records | SEN-MIG-06 |
| `packages/contracts/settings.ts`, `packages/contracts/shared.ts` | backward-compatible diagnostics preference field inside schema version 2 | SEN-CON-01 |

### Renderer

| Path | Role | Work items |
| --- | --- | --- |
| `app/utils/failureReporter.ts` (new) | renderer `capture`, dedupe, burst accounting, health counters, typed IPC send, local projection | SEN-CORE-04 |
| `app/utils/browserLogger.ts` | `error` returns a `FailureReceipt`, accepts an existing receipt, keeps the rich local entry | SEN-MIG-01 |
| `app/utils/runtimeErrorFilter.ts` | unchanged ignore list, extended to route a `failureRef` instead of deriving identity from text | SEN-MIG-06 |
| `app/plugins/rendererErrorGuard.client.ts` | one occurrence for Vue, `window.error`, and rejections; inherited Vue handler runs inside the suppression scope | SEN-MIG-03 |
| `app/plugins/runtimeErrorLogStream.client.ts` | presents a main-owned `failureRef`; owns only its renderer-local bridge initialization fault | SEN-MIG-06 |
| `app/utils/consoleErrorObserver.ts` (new) | main-world console observer, argument-blind, frameless drop counter, reentrancy guard | SEN-MIG-04 |
| `app/composables/useRuntimeErrorReports.ts` | receipt-aware runtime report state | SEN-CORE-06 |
| `app/composables/useFatalRuntimeError.ts` | receipt-aware fatal state | SEN-CORE-06 |
| `app/composables/useFailureToast.ts` (new) | the only red toast presenter, requires a receipt | SEN-CORE-06 |
| `app/utils/browserDiagnosticsTransport.ts` (new) | hosted-browser Sentry adapter root, deferred import, exact EU ingest origin | SEN-SDK-03 |
| `app/pages/about.vue` (new) | About and Acknowledgements page | SEN-ACK-03 |

### Electron main and preload

| Path | Role | Work items |
| --- | --- | --- |
| `electron/features/diagnostics/public.ts` (new) | the feature entrypoint main imports | SEN-CORE-07 |
| `electron/features/diagnostics/mainFailureReporter.ts` (new) | main `capture`, dedupe, burst accounting, health counters | SEN-CORE-07 |
| `electron/features/diagnostics/readDiagnosticsPreferenceSync.ts` (new) | synchronous single-field reader over the settings file, no `loadSettings()` | SEN-CON-02 |
| `electron/features/diagnostics/startupCrashMarker.ts` (new) | `uncaughtExceptionMonitor` observer, single marker write, next-launch send and unconditional delete | SEN-CON-03 |
| `electron/features/diagnostics/sentryNodeAdapter.ts` (new) | the only main-process Sentry import root | SEN-SDK-02 |
| `electron/utils/createLogger.ts` | `error` returns a `FailureReceipt`, `ERROR` broadcasts carry `failureRef` | SEN-MIG-02 |
| `electron/main.ts` | adapter initialization point, process seams, monitor install order | SEN-CORE-07, SEN-CON-03 |
| `electron/window.ts`, `electron/window/rendererReady.ts`, `electron/window/attachShowLifecycle.ts` | one consolidated window-load failure owner | SEN-MIG-07 |
| `electron/processDeathRecovery.ts`, `electron/main.ts` | child-process death, GPU recovery, and unhandled-rejection subsystem recovery | SEN-MIG-08 |
| `electron/window.ts`, `electron/window/rendererReady.ts` | renderer death, preload failure, and unresponsive recovery; load-failure regions remain SEN-MIG-07 | SEN-MIG-08 |
| `electron/utils/workerTask.ts` | worker parent seam; the reported-error `WeakSet` becomes a receipt-carrying `WeakMap` | SEN-MIG-09 |
| `electron/platform-ipc/coreContract.ts` | new renderer diagnostic send channel and its decoder | SEN-CORE-08 |
| `electron/platform-ipc/registerRendererDiagnosticBridge.ts` (new) | trusted-sender check, schema, size, rate, and frame validation | SEN-CORE-08 |
| `electron/platform-ipc/registerCoreIpcHandlers.ts` | registration of the diagnostic channel | SEN-CORE-08 |
| `electron/preload.ts`, `electron/preload/createElectronApi.ts` | immutable startup policy snapshot and typed record send only | SEN-CORE-09 |
| `electron/preload/readDiagnosticsPolicyArgument.ts` (new) | decodes the snapshot passed through `additionalArguments` | SEN-CORE-09 |
| `electron/preload/installDebugLogListener.ts`, `electron/preload/debugLogBuffer.ts` | closed debug entry decoding and buffering preserve `failureRef` | SEN-MIG-06 |
| `electron/preload.ts`, `electron/preload/installViteOutdatedOptimizeDepRecovery.ts` | development recovery output stays local and does not print red | SEN-MIG-05 |

### Server, landing, and build

| Path | Role | Work items |
| --- | --- | --- |
| `server/plugins/diagnostics.ts` (new) | viewer Nitro uncaught error owner | SEN-SRV-01 |
| `server/utils/serverFailureReporter.ts` (new) | viewer Nitro capture seam and objection check | SEN-SRV-01, SEN-SRV-02 |
| `server/utils/sentryNitroAdapter.ts` (new) | the only viewer Nitro Sentry client import root | SEN-SDK-05 |
| `landing/server/utils/landingFailureReporter.ts` (new) | `landing-nitro` seam with a no-op adapter | SEN-MIG-11 |
| `landing/server/api/releases/latest.get.ts` | exhausted upstream catalog reclassified to warning | SEN-MIG-11 |
| `landing/app/components/SentryAcknowledgement.vue` (new) | the one acknowledgement component | SEN-ACK-01 |
| `landing/app/components/SiteFooter.vue`, `landing/app/pages/index.vue` | both footer paths render the acknowledgement | SEN-ACK-02 |
| `scripts/build-electron.mjs` | release map emission for every reportable Electron bundle | SEN-MAP-01 |
| `package.json` build and deploy scripts | map staging before pruning, prebuilt viewer deployment | SEN-MAP-02, SEN-MAP-05 |
| `scripts/release/stage-private-sourcemaps.mjs` (new) | invoke Sentry CLI for Debug ID injection, stage maps and sources under ignored `.tmp/`, write the private manifest | SEN-MAP-02, SEN-MAP-03 |
| `scripts/release/upload-sentry-sourcemaps.mjs` (new) | invoke Sentry CLI for authenticated upload and verification from the private stage | SEN-MAP-04 |
| `scripts/release/build-receipt.mjs` | receipts computed from injected public bytes | SEN-MAP-03 |
| `scripts/deployVercelPrivate.mjs` | prebuilt viewer deployment of the exact injected output | SEN-MAP-05 |
| `scripts/check-web-deploy-assets.mjs`, `scripts/release/assert-packaged-app-contents.mjs`, `scripts/check-build-artifacts-hygiene.mjs` | public artifact scans for maps, sources, tokens, and wrong-runtime DSNs | SEN-MAP-06 |
| `docs/internal/operations/sentry-account-controls.md` (new) | credential-free account, project, key, token, retention, and source-fetching inventory | SEN-EXT-01, SEN-EXT-02, SEN-EXT-06, SEN-EXT-07 |
| `eslint-plugin-custom.mjs`, `eslint.config.mjs` | lint rules for raw red toasts, direct console error, and Sentry imports | SEN-GATE-01 |
| `scripts/architecture/boundary-check.mjs` | node-level source check for Sentry SDK, DSN, capture, event, and CLI use | SEN-GATE-02 |
| `tests/unit/architecture/` | blocking policy suites for the invariants above | SEN-GATE-01, SEN-GATE-02, SEN-GATE-03 |

## Dependency graph

Phases follow the architecture rollout numbering so the two ledgers stay
readable together. Every edge points from a prerequisite to a dependant. No
item depends on an item in a later phase, and no item depends on itself through
any path.

```text
Phase 0 (independent of everything else)
  SEN-ACK-01 -> SEN-ACK-02
  SEN-ACK-01 -> SEN-ACK-03 -> SEN-ACK-04
  SEN-EXT-01 -> SEN-EXT-02
  SEN-EXT-05, SEN-EXT-02 -> SEN-EXT-03 -> SEN-EXT-04

Phase 1 (independent of Phase 0)
  SEN-CORE-01 -> SEN-CORE-02
  SEN-CORE-02 -> SEN-CORE-03
  SEN-CORE-02 -> SEN-CORE-05
  SEN-CORE-03, SEN-CORE-05 -> SEN-CORE-04
  SEN-CORE-03, SEN-CORE-05 -> SEN-CORE-07
  SEN-CORE-03 -> SEN-CORE-06
  SEN-CORE-04, SEN-CORE-07 -> SEN-CORE-08 -> SEN-CORE-09
  SEN-CORE-04, SEN-CORE-07 -> SEN-CORE-10

Phase 2 (needs Phase 1 only)
  SEN-CORE-04 -> SEN-MIG-01 -> SEN-MIG-04
  SEN-CORE-04 -> SEN-MIG-13
  SEN-CORE-07 -> SEN-MIG-02, SEN-MIG-07, SEN-MIG-09
  SEN-MIG-07 -> SEN-MIG-08
  SEN-CORE-06 -> SEN-MIG-03, SEN-MIG-10
  SEN-CORE-03 -> SEN-MIG-11, SEN-MIG-12
  SEN-MIG-01, SEN-MIG-02, SEN-MIG-03 -> SEN-MIG-06 -> SEN-MIG-05
  SEN-CORE-01 -> SEN-CON-01
  SEN-CON-01 -> SEN-CON-02 -> SEN-CON-03
  SEN-CON-01 -> SEN-CON-04 -> SEN-CON-05
  SEN-CON-04 -> SEN-CON-06
  SEN-CORE-06 -> SEN-GATE-01 in warning mode
  SEN-MIG-10 -> SEN-GATE-01 in blocking mode
  SEN-CORE-02 -> SEN-GATE-02
  SEN-CORE-10 -> SEN-GATE-03

Phase 3 (needs the Phase 0 and Phase 2 exits)
  SEN-EXT-03 -> SEN-SDK-01
  SEN-EXT-03 -> SEN-EXT-06
  SEN-SDK-01, SEN-EXT-06 -> SEN-SDK-02, SEN-SDK-03, SEN-SDK-05
  SEN-SDK-01 -> SEN-SDK-04
  SEN-SDK-04 -> SEN-MAP-01 -> SEN-MAP-02 -> SEN-MAP-03
  SEN-MAP-03 -> SEN-MAP-05
  SEN-MAP-05, SEN-EXT-02, SEN-EXT-06, SEN-SDK-02, SEN-SDK-03, SEN-SDK-05 -> SEN-MAP-04
  SEN-MAP-04 -> SEN-EXT-07 -> SEN-MAP-06

Phase 4
  SEN-CORE-02, SEN-SDK-05 -> SEN-SRV-01 -> SEN-SRV-02
  SEN-SRV-02, SEN-EXT-04, SEN-EXT-07, SEN-MAP-04 -> SEN-SRV-03 -> SEN-CAN-03

Phase 5
  SEN-CON-06, SEN-SDK-02, SEN-SDK-03, SEN-SDK-05 -> SEN-CON-07
  SEN-CON-03, SEN-CON-05, SEN-CORE-09, SEN-MIG-04, SEN-MIG-07, SEN-MIG-09, SEN-MIG-13, SEN-SDK-02, SEN-MAP-04, SEN-CON-07 -> SEN-CAN-01
  SEN-CON-05, SEN-MIG-04, SEN-SDK-03, SEN-MAP-04, SEN-CON-07 -> SEN-CAN-02

Phase 6
  SEN-CAN-01, SEN-CAN-02 -> SEN-OPS-01 -> SEN-OPS-02
  SEN-OPS-02, SEN-MIG-01, SEN-MIG-02 -> SEN-OPS-03

  Nitro-specific operation remains dependent on SEN-CAN-03 and is tracked by
  #261/#267; it is not a prerequisite for enabled-client operation.
```

### Phase map

| Phase | Contents | Entry condition | Exit gate |
| --- | --- | --- | --- |
| 0 | `SEN-ACK-*`, `SEN-EXT-01` through `SEN-EXT-05` | none | Acknowledgement ships and works offline; enabled-client account and notice gates are recorded as passed. The separate Nitro legal gate remains in `SEN-EXT-04`. |
| 1 | `SEN-CORE-*` | none | Synthetic failures produce one local occurrence and one safe captured record; no production SDK or DSN exists |
| 2 | `SEN-MIG-*`, `SEN-CON-01` through `SEN-CON-06`, `SEN-GATE-*` | Phase 1 exit | Every red presentation carries a receipt, every red console path has one owner, expected cases create no record, known duplicates produce one occurrence |
| 3 | `SEN-EXT-06`, `SEN-EXT-07`, `SEN-SDK-*`, `SEN-MAP-*` | Phase 0 and Phase 2 exits | Projects, restricted credentials, private maps, source-fetching policy, capture transports, and test environments show safe, symbolicated, unique events; production reporting remains disabled |
| 4 | `SEN-SRV-*`, `SEN-CAN-03` | Phase 3 exit and `SEN-EXT-04` | One week of viewer Nitro preview and production canary data is safe, low noise, and actionable |
| 5 | `SEN-CON-07`, `SEN-CAN-01`, `SEN-CAN-02` | Phase 3 exit | Consent, privacy, dedupe, source map, update, relaunch, recovery, and shutdown canaries pass on every shipping platform |
| 6 | Enabled-client `SEN-OPS-*` | Phase 5 exit | Enabled-client operations meet the recorded alert, privacy, deletion, quota, and symbolication measures. Nitro operation remains a separate `SEN-CAN-03` path. |

Phase 0 and Phase 1 are independent and may proceed in parallel. Phase 2 needs
only Phase 1. Nothing in Phases 0 through 2 requires a Sentry project, DSN,
account change, or network call.

## Work items

Every item is written to become one GitHub issue. Status values are `not
started`, `in progress`, `blocked`, and `done`. Each item below records its
current repository or external-gate status.

### Phase 0: acknowledgement and external gates

#### SEN-ACK-01 Shared acknowledgement component and local assets

- Status: implemented and locally verified
- Depends on: none
- Difficulty: easy
- Paths: `landing/app/components/SentryAcknowledgement.vue` (new),
  `landing/public/` for the repository-owned wordmark copy,
  `landing/app/locales/*.ts`, `landing/app/i18n/enMessageSchema.ts`,
  `scripts/checkLocales.ts`
- Behavior: render the approved factual copy and a repository-owned copy of the
  official wordmark, linking to Sentry's open-source page with a normal secure
  external link. Do not hotlink the asset, load a Sentry script, add a pixel,
  recolor, distort, crop, or combine it with the EVB Viewer logo. The component
  performs no network request of its own.
- Tests: component test that renders with no outbound request; asset presence
  test that the referenced file is repository-owned and not a remote URL.
- Exit evidence: rendered component in both light and dark themes with the
  network panel empty until the link is clicked.

#### SEN-ACK-02 Acknowledgement in both landing footer paths

- Status: implemented and locally verified
- Depends on: SEN-ACK-01
- Difficulty: easy
- Paths: `landing/app/components/SiteFooter.vue`,
  `landing/app/pages/index.vue` (the compact `home-bottom` footer)
- Behavior: both footer paths render the same component. There is exactly one
  acknowledgement implementation.
- Tests: landing component tests asserting the acknowledgement is present in
  both paths and that no second implementation exists.
- Exit evidence: landing lint, typecheck, and build pass with both footers
  showing the acknowledgement.

#### SEN-ACK-03 In-app About and Acknowledgements page

- Status: implemented and locally verified
- Depends on: SEN-ACK-01
- Difficulty: medium
- Paths: `app/pages/about.vue` (new), the Help menu in `electron/menu.ts`, whose
  non-macOS About item currently calls `app.showAboutPanel()`, the Settings
  entry that links to the page, the app message files, and `public/` for the
  local asset
- Behavior: show app name and version, license and third-party notices links,
  the localized Sentry acknowledgement with the local asset, and the
  privacy-adjacent sentence stating that the acknowledgement does not contact
  Sentry and that error diagnostics are controlled separately. Keep the native
  macOS About role and add a distinct Acknowledgements menu item on every
  desktop platform that opens this page. On other platforms the existing About
  item may open the page too. Electron opens
  the external link through the existing safe shell capability. The hosted
  viewer uses a normal secure external link. The document viewer is never
  navigated to a remote origin.
- Tests: page test for content and links; Electron test that the external link
  uses the safe shell path; test that the page renders with diagnostics
  disabled and with no DSN configured.
- Exit evidence: the page opens from Acknowledgements and Settings in Electron,
  including macOS, and from Settings in the hosted runtime.

#### SEN-ACK-04 Acknowledgement localization and accessibility

- Status: implemented and locally verified
- Depends on: SEN-ACK-03
- Difficulty: medium
- Paths: `packages/i18n-app/messages/` for all 9 app locales, the landing i18n
  files under `landing/app/locales/`, `landing/app/i18n/enMessageSchema.ts`,
  `scripts/checkLocales.ts`
- Behavior: all acknowledgement and About strings come from the typed locale
  source. Key parity holds across every locale. The link has an accessible name,
  reachable keyboard focus with a visible focus ring, contrast that meets the
  design tokens in `app/assets/css/main.css`, and a layout that survives the
  narrow breakpoint.
- Tests: locale key parity check for the new keys; accessibility test for
  accessible name, focus order, and focus visibility; narrow-viewport layout
  test; offline test proving the asset and copy render with no network.
- Exit evidence: locale parity gate green, accessibility assertions green, and
  an offline render of both landing footers and the app page.

#### SEN-EXT-01 Account recovery and organization access hardening

- Status: complete; live controls and the provider limitations were verified on 2026-09-04
- Depends on: none
- Difficulty: medium
- Scope: Sentry account only. No repository change.
- Behavior: use the sole owner's connected Google account for routine sign-in.
  Record that personal Gmail cannot configure organization SSO and Sentry offers
  no password-removal control. Keep Sentry-native and organization 2FA off by
  the owner's explicit decision for this route; Google account recovery is the
  operative recovery boundary. Disable Generative AI features and leave Seer unconfigured.
  Disable shared issues, join requests, open team membership, and member
  invitations. Limit project creation, event deletion, and alert or monitor
  editing to the minimum owner or manager roles. Raise attachment and debug-file
  access to the minimum practical role.
- Evidence: a credential-free tracked inventory at
  `docs/internal/operations/sentry-account-controls.md` and an issue checklist recording
  `setting name -> target value -> verifier role -> date`. Screenshots, API
  exports, credentials, and local paths are not linked from the issue.
- Exit evidence: every listed control is in its target state and the issue
  records who verified it and when.

#### SEN-EXT-02 Privacy and scrubbing controls

- Status: complete for enabled-client operation; all privacy, scrubber, and
  quota controls are verified
- Depends on: SEN-EXT-01
- Difficulty: medium
- Scope: Sentry account only.
- Behavior: enable Enhanced Privacy, required Data Scrubber, required default
  scrubbers, and IP address storage prevention. Keep native crash-report and
  minidump storage at zero. Add targeted global scrub rules for forbidden keys
  without erasing the canonical frame fields that grouping and Debug IDs need.
  Keep pay-as-you-go disabled and add quota alerts. Record that the scrubber is
  a backstop and never permission to send a raw error.
- Evidence: the tracked credential-free settings inventory and the exact scrub
  rule list, with verifier role and date transcribed into the issue.
- Exit evidence: controls verified and the rule list recorded, with an explicit
  note that no canonical frame field is scrubbed.

#### SEN-EXT-03 Legal instruments and notice

- Status: complete for consent-gated client diagnostics; DPA, public notice,
  and locale publication are verified. The qualified-review record belongs to
  the separate default-on Nitro release gate in SEN-EXT-04.
- Depends on: SEN-EXT-02, SEN-EXT-05
- Difficulty: hard
- Scope: legal, notice, and translation publication after SEN-EXT-05 completes
  the runtime migration.
- Behavior: execute and retain Sentry's DPA. Complete the privacy notice
  requirements from the architecture ledger, including controller and processor
  identification, the single error-diagnosis purpose, the lawful basis per
  runtime, the allowed field list and excluded categories, the EU data region,
  subprocessors and transfers, the 90-day platform event retention, weekly
  deletion of resolved issues, the ingress source IP fact, and the access,
  deletion, restriction, objection, and contact routes. State that Sentry AI
  features are disabled and that diagnostics are never used for training. Do not
  call the events anonymous. Publish through the shared typed privacy source
  created by SEN-EXT-05, with key parity across every supported locale.
- Evidence: approved notice text in the tracked translation source. Record only
  the review date and qualified reviewer role in the issue, not a private file
  location.
- Exit evidence: notice published, DPA executed, locale parity gate green.

#### SEN-EXT-04 Viewer Nitro legitimate-interests assessment

- Status: blocked; qualified approval and external safeguards pending
- Depends on: SEN-EXT-03
- Difficulty: hard
- Scope: legal. No runtime code.
- Behavior: write and approve the legitimate-interests assessment covering the
  specific interest, necessity, and the balancing test, before any server
  processing begins. Provide the separate right-to-object statement at first
  communication and an online objection method. This item, not an engineering
  decision, unblocks default-on viewer Nitro reporting.
- Evidence: record the approval date, reviewer role, and completed assessment
  checklist in the issue. Do not cite an unpublished report or local path.
- Exit evidence: assessment approved and the objection route defined.

#### SEN-EXT-05 Shared typed privacy source and root-page migration

- Status: implemented and production verified
- Depends on: none
- Difficulty: hard
- Paths: `packages/i18n-core/privacyMessages.ts` (new),
  `app/pages/privacy.vue`, `landing/app/pages/privacy.vue`,
  `landing/app/locales/*.ts`, `landing/app/i18n/enMessageSchema.ts`,
  `tests/unit/i18n/privacyPageLocalization.test.ts`, `scripts/checkLocales.ts`
- Behavior: replace the root page's inline `PRIVACY_COPY` and two-locale
  fallback with one typed privacy message tree covering all 9 locales. The root
  and landing privacy pages consume that tree directly, so there is one copy of
  the notice text. Landing locale modules intentionally omit that imported
  object because the Nuxt locale compiler emitted its property shorthand as an
  unresolved browser identifier. Rewrite the existing test that currently pins
  `PRIVACY_COPY` and the English-or-Russian selector. Keep locale selection and
  page rendering behavior unchanged apart from making the other seven
  translations real.
- Tests: all 9 locale trees satisfy the English schema; both pages read the
  shared tree; no inline privacy copy remains; `scripts/checkLocales.ts` and the
  rewritten privacy localization suite pass.
- Exit evidence: both privacy pages render every supported locale from the same
  typed source, the parity gates and production landing build are green, and a
  fresh production browser session has no unresolved locale identifier.

### Phase 1: the failure core without Sentry transport

#### SEN-CORE-01 Diagnostic definition registry

- Status: implemented and locally verified
- Depends on: none
- Difficulty: medium
- Paths: `packages/contracts/diagnostics/diagnosticCodes.ts` (new)
- Behavior: one `DIAGNOSTIC_DEFINITIONS` registry is the single source for the
  code union, allowed context keys and their bounded enum, boolean, or integer
  value ranges, the operation, the grouping policy, and whether the code prefers
  a source stack or a fresh call-site stack. It includes
  `UNCLASSIFIED_RENDERER_ERROR`, `UNCLASSIFIED_MAIN_ERROR`,
  `UNCLASSIFIED_CONSOLE_ERROR`, and `MAIN_STARTUP_CRASH`. It exports no free-form
  string field and no message template that could carry a raw value.
- Tests: type tests that an unknown code and an unknown context key fail to
  compile; runtime tests that the decoder rejects unknown codes, unknown keys,
  out-of-range values, and non-finite numbers.
- Exit evidence: registry lands with the decoder tests green and no consumer yet.

#### SEN-CORE-02 Record contract, event ID, and strict decoder

- Status: implemented and locally verified
- Depends on: SEN-CORE-01
- Difficulty: medium
- Paths: `packages/contracts/diagnostics/diagnosticRecord.ts` (new),
  `packages/contracts/diagnostics/diagnosticEventId.ts` (new),
  `packages/contracts/diagnostics/startupCrashMarker.ts` (new)
- Behavior: `DiagnosticRecord` carries only `schemaVersion`, `eventId`, `code`,
  `severity`, `runtime`, optional `operation`, `occurredAt`, `frames`, and
  `context`. `StartupCrashMarkerRecord` is a separate persisted contract carrying
  only marker schema version, event ID, code, canonical frames, timestamp,
  release, and dist. The event ID is a random 128-bit value rendered as 32
  lowercase hex characters, created per occurrence, and is not a user, install,
  device, or document identifier. Both decoders validate every field exactly,
  bound the frame count and each frame string length, and reject any extra key.
- Tests: property tests that inject forbidden strings and objects at every input
  depth and assert the decoded record contains none of them; ID format and
  uniqueness tests; decoder rejection tests for a wrong schema version, extra
  keys, oversized frames, malformed IDs, and partial or corrupt markers.
- Exit evidence: decoder and property suites green.

#### SEN-CORE-03 Failure receipt and expected outcome types

- Status: implemented and locally verified
- Depends on: SEN-CORE-02
- Difficulty: easy
- Paths: `packages/contracts/diagnostics/failureReceipt.ts` (new)
- Behavior: define `FailureReceipt`, `CaptureFailureInput`, `LocalFailureDetail`,
  and `ExpectedOutcome` with the closed expected-outcome code union. `ExpectedOutcome`
  is structurally incompatible with `FailureReceipt` so red presenters cannot
  accept one and warning presenters cannot accept the other.
- Tests: type tests proving each direction of the incompatibility; a test that
  `LocalFailureDetail` is absent from the transport contract's type surface.
- Exit evidence: type tests green.

#### SEN-CORE-04 Renderer failure reporter

- Status: implemented and locally verified
- Depends on: SEN-CORE-03, SEN-CORE-05
- Difficulty: hard
- Paths: `app/utils/failureReporter.ts` (new)
- Behavior: `capture` is synchronous, never throws, and returns a receipt. It
  builds the closed record, records the local detail through the existing
  renderer log channel only, applies the process-local recent-ID rejection and
  the per-code and per-top-frame burst controller with a `suppressedCount`
  clamped at 10,000 and increments the health counters. In Electron it forwards
  the closed record over typed IPC regardless of the immutable startup hint;
  Electron main is the sole live consent and network gate. Unknown or denied
  records may cross local IPC but create zero diagnostic network activity and do
  not consume the event ID in main's remote dedupe set. The hosted-browser path
  has no IPC, reads mutable local storage in-process, and calls its transport
  only while granted.
  It exposes a synchronous suppression scope for owners that must invoke an
  inherited framework handler. A transport failure logs a bounded warning through
  an unobserved raw sink and creates no new occurrence.
- Tests: one occurrence per capture; duplicate ID rejected; burst cap and one
  summary per code and frame pair per window; suppression scope counts
  `owned-projection` and creates no occurrence; Electron unknown or denied
  performs an IPC send but no transport send; hosted-browser unknown or denied
  performs neither dynamic import nor transport send; the correct runtime and
  sink are selected per host; reentrancy creates no loop.
- Exit evidence: reporter unit suite green with a capture transport recording
  every attempted send.

#### SEN-CORE-05 Canonical application frame normalization

- Status: implemented and locally verified
- Depends on: SEN-CORE-02
- Difficulty: hard
- Paths: `packages/contracts/diagnostics/canonicalAppFrames.ts` (new)
- Behavior: one pure function parses a stack into canonical frames, keeps only
  repository-built bundles and source modules including vendored dependencies
  shipped inside those bundles, and removes drive letters, home paths, `file:`
  origins, hostnames, queries, and fragments. The same function updates frame
  paths and `debug_meta.images[].code_file` together so a later symbolication
  step cannot see two different normalizations. It accepts plain values and has
  no import from `app/**`, `electron/**`, `server/**`, or another runtime root.
- Tests: normalization tests for macOS, Windows, and Linux path shapes, packaged
  and development origins, and vendored bundle paths; a test that an entirely
  non-EVB stack yields zero frames; a test that frame paths and debug image
  paths are updated by the same call.
- Exit evidence: normalization suite green on all three path families.

#### SEN-CORE-06 Receipt-aware presentation helpers

- Status: implemented and locally verified
- Depends on: SEN-CORE-03
- Difficulty: medium
- Paths: `app/composables/useRuntimeErrorReports.ts`,
  `app/composables/useFatalRuntimeError.ts`,
  `app/composables/useFailureToast.ts` (new),
  `app/components/AppFatalRuntimeDialog.vue`
- Behavior: `presentFailureToast`, `reportRuntimeError`, and
  `setFatalRuntimeError` accept a `FailurePresentation` carrying a receipt plus
  local-only title and optional description. Each presenter exposes a short form
  of the event ID labelled `Error ID`, never `Sentry report received`, and the
  copy action includes the full ID and the local details. Presentation never
  captures. The previous receipt-free signatures have been removed, and
  contraction fixtures prove that they no longer compile.
- Tests: presenter tests that a receipt is required for red presentation; a test
  that the visible short ID matches the receipt; a test that rerendering a
  presenter creates no new occurrence.
- Exit evidence: presenter suite green and the fatal dialog showing an Error ID.

#### SEN-CORE-07 Main failure reporter and adapter seam

- Status: implemented and locally verified
- Depends on: SEN-CORE-03, SEN-CORE-05
- Difficulty: hard
- Paths: `electron/features/diagnostics/public.ts` (new),
  `electron/features/diagnostics/mainFailureReporter.ts` (new),
  `electron/main.ts`
- Behavior: main owns one reporter and one adapter seam. Initialization happens
  after the user-data path exists and the synchronous preference has been read,
  and before normal window bootstrap. The adapter is a no-op in this phase. Main
  captures its process, renderer-process, worker-parent, utility-parent,
  native-helper, update, persistence, and shutdown seams. It is the sole live
  Electron consent authority. It checks current preference before remote dedupe
  admission and transport, so an unknown record can be resent once with the same
  event ID after a live grant. Settings persistence updates the main gate in the
  same transaction. Existing expected
  teardown and cancellation classifiers stay authoritative and are not
  reclassified as faults.
- Tests: initialization order test; one occurrence per main seam; expected
  teardown and cancellation produce no occurrence; health counters increment as
  specified.
- Exit evidence: main reporter suite green with the no-op adapter.

#### SEN-CORE-08 Typed renderer diagnostic IPC

- Status: implemented and locally verified
- Depends on: SEN-CORE-04, SEN-CORE-07
- Difficulty: hard
- Paths: `electron/platform-ipc/coreContract.ts`,
  `electron/platform-ipc/registerRendererDiagnosticBridge.ts` (new),
  `electron/platform-ipc/registerCoreIpcHandlers.ts`
- Behavior: one new send channel carries a sanitized `DiagnosticRecord` from
  renderer to main. Main validates the trusted sender, the exact schema, the
  payload size, the frame paths, the rate, the event ID, the code, and the
  context, then reconstructs the event itself. A raw Sentry envelope never
  crosses IPC. The channel mirrors the existing `rendererLog` direction rule: a
  renderer record must not re-enter the main debug broadcast.
- Tests: untrusted sender rejected; oversized, malformed, unknown-code, and
  unknown-context payloads rejected and counted as `schema-dropped`; rate limit
  enforced; a renderer record never appears in `debug:log`.
- Exit evidence: bridge suite green including the rejection counters.

#### SEN-CORE-09 Preload policy snapshot and typed send

- Status: implemented and locally verified
- Depends on: SEN-CORE-08
- Difficulty: medium
- Paths: `electron/preload.ts`, `electron/preload/createElectronApi.ts`,
  `electron/preload/readDiagnosticsPolicyArgument.ts` (new), `electron/window.ts`
- Behavior: the diagnostics namespace in `electronAPI` exposes exactly three
  things: an immutable startup diagnostics-policy hint, a typed send for a
  sanitized record, and the
  existing debug-log delivery with an optional failure reference. The snapshot is
  passed through `additionalArguments` using the same encoded-argument pattern as
  the host resource profile, and a missing, duplicated, or malformed argument
  decodes to `unknown`. The hint controls initial UI copy only and is not a
  consent or network gate. Main remains authoritative after a live grant or
  revocation. Preload contains no Sentry package, DSN, queue, or generic
  envelope bridge.
- Tests: snapshot decoding tests for missing, duplicated, malformed, and valid
  arguments; a test that the diagnostics namespace has exactly the three
  members and that no diagnostics-related global is exposed; a static test that
  preload imports no Sentry package.
- Exit evidence: preload surface test green and the decoder suite green.

#### SEN-CORE-10 Capture transport and forbidden sentinels

- Status: implemented and locally verified
- Depends on: SEN-CORE-04, SEN-CORE-07
- Difficulty: medium
- Paths: `tests/unit/` diagnostics suites and a shared test capture transport
  under `tests/helpers/`
- Behavior: a capture transport records every event a runtime would have sent.
  Tests feed forbidden sentinel values through every input: exception messages,
  console arguments, UI strings, file paths, document names, URLs, query
  strings, and arbitrary objects. No captured event may contain any sentinel.
- Tests: sentinel property tests across renderer, main, worker parent, and
  server seams; a schema-marker test proving an event without the EVB marker is
  refused.
- Exit evidence: sentinel suite green with the exact sentinel list recorded in
  the test file.

### Phase 2: make red semantic

#### SEN-MIG-01 BrowserLogger.error becomes a receipt owner

- Status: implemented and locally verified; unclassified report is zero
- Depends on: SEN-CORE-04
- Difficulty: hard
- Paths: `app/utils/browserLogger.ts` and the 45 files that call
  `BrowserLogger.error`
- Behavior: `BrowserLogger.error` returns a `FailureReceipt`. Every caller must
  provide a subsystem-specific closed code and context or an existing receipt.
  A receipt records the local entry without creating a second occurrence. The
  rich local entry and renderer log IPC are unchanged. Console output uses a
  captured original sink, so the console observer cannot create a second
  `UNCLASSIFIED_CONSOLE_ERROR`.
- Tests: typed code with fresh call-site stack; provided receipt suppresses a
  second occurrence; local detail remains local; one logger call does not
  trigger the console observer; renderer log direction unchanged.
- Exit evidence: the checked-in renderer migration report is zero. The
  receipt-free overload is removed and its TypeScript contraction test passes.

#### SEN-MIG-02 Main createLogger.error becomes a receipt owner

- Status: implemented and locally verified; unclassified report is zero
- Depends on: SEN-CORE-07
- Difficulty: hard
- Paths: `electron/utils/createLogger.ts` and the Electron modules that call
  `.error(`
- Behavior: `logger.error` returns a `FailureReceipt` on the main thread. Every
  caller must provide a subsystem-specific closed code and context or an
  existing receipt. Worker-thread and utility-child uses remain local-only,
  return no remotely forwardable receipt, and cannot own an event assigned to
  their parent seam. Redacted local file logging is unchanged. Main-thread
  `ERROR` broadcasts carry the closed `failureRef`; lower levels do not.
- Tests: typed code with fresh call-site stack; provided receipt suppresses a
  second occurrence; redaction unchanged; only main-thread `ERROR` broadcasts
  carry a reference; a worker-thread `.error` call produces a local log and no
  occurrence.
- Exit evidence: the checked-in main migration report is zero. The receipt-free
  overload is removed and its TypeScript contraction test passes.

#### SEN-MIG-03 Global renderer guard owns one occurrence

- Status: implemented and locally verified
- Depends on: SEN-CORE-06
- Difficulty: medium
- Paths: `app/plugins/rendererErrorGuard.client.ts`
- Behavior: the guard creates exactly one failure for a Vue error, a
  `window.error`, or an unhandled rejection, passes the receipt to the local log
  and to the runtime card, and then invokes the previous Vue handler inside the
  synchronous suppression scope so an inherited `console.error` counts as
  `owned-projection`. Extend the existing ignorable-message filter to the Vue
  handler so it short circuits before any occurrence for all three entrypoints.
  Raw serialization stays local only.
- Tests: one occurrence per guarded error across all three sources; inherited Vue
  handler output creates no second occurrence; ignorable messages create nothing;
  the local log still contains the serialized detail.
- Exit evidence: guard suite green with the occurrence count asserted.

#### SEN-MIG-04 Renderer console observer

- Status: implemented and locally verified
- Depends on: SEN-MIG-01
- Difficulty: hard
- Paths: `app/utils/consoleErrorObserver.ts` (new), its registration in the
  renderer bootstrap
- Behavior: the observer sees that a `console.error` happened and nothing else.
  It ignores every argument, creates a fresh call-site stack, strips observer
  frames, keeps only EVB-shipped application frames, and records
  `UNCLASSIFIED_CONSOLE_ERROR`. A call with no application frame increments
  `frameless-dropped` and sends nothing. A captured raw console sink and a
  reentrancy guard prevent transport failures from reporting themselves. Calls
  inside a suppression scope count as `owned-projection`.
- Tests: arguments containing forbidden sentinels produce an event with only the
  code and safe frames; a wholly frameless stack drops and counts; reentrancy
  creates no loop; extension and DevTools stacks drop.
- Exit evidence: observer suite green including the frameless drop counter.

#### SEN-MIG-05 Preload projection stays a projection

- Status: implemented and locally verified
- Depends on: SEN-MIG-06
- Difficulty: easy
- Paths: `electron/preload/installDebugLogListener.ts`, `electron/preload.ts`,
  `electron/preload/installViteOutdatedOptimizeDepRecovery.ts`
- Behavior: the isolated-world red print of a main `ERROR` record remains a
  presentation of a failure main already owns. It carries the failure reference
  for support correlation and creates no occurrence. Preload-local red output
  that only represents Vite recovery or development control flow is removed or
  downgraded to warning.
- Tests: a preload print creates no main-world occurrence; the printed line
  includes the reference; the development-only paths no longer print at error.
- Exit evidence: preload listener suite green.

#### SEN-MIG-06 Debug log failure reference and runtime card

- Status: implemented and locally verified
- Depends on: SEN-MIG-01, SEN-MIG-02, SEN-MIG-03
- Difficulty: medium
- Paths: `packages/contracts/electronApiCommon.ts`,
  `electron/preload/installDebugLogListener.ts`,
  `electron/preload/debugLogBuffer.ts`,
  `app/plugins/runtimeErrorLogStream.client.ts`,
  `app/utils/runtimeErrorFilter.ts`
- Behavior: `IDebugLogEntry` gains a closed `failureRef` used only by `ERROR`
  records. The preload decoder and bounded buffer preserve that field while
  continuing to reject unknown extras. The runtime log stream presents a
  main-owned reference without capturing it, but owns one renderer occurrence
  for its own bridge-initialization catch branch because no main record exists.
  Typed main IPC failure responses also carry `failureRef`, and a renderer that
  shows a red toast or inline error for a main-owned failure reuses it instead of
  creating a renderer occurrence. The decoder rejects every `ERROR` record
  without a main-owned failure reference.
- Tests: one main error produces one local log and one event and may appear in
  every window without another send; a main IPC failure presented in the renderer
  creates no renderer occurrence; `failureRef` survives `decodeDebugLogEntry`
  and buffering while an unknown extra field does not; bridge initialization
  failure creates one renderer occurrence; a reference-free `ERROR` record
  fails the Phase 2 static gate.
- Exit evidence: projection suite green and the gate switched to blocking in
  SEN-GATE-01.

#### SEN-MIG-07 One window-load failure owner

- Status: implemented and locally verified
- Depends on: SEN-CORE-07
- Difficulty: hard
- Paths: `electron/window.ts`, `electron/window/rendererReady.ts`,
  `electron/window/attachShowLifecycle.ts`, plus the bootstrap rejection path in
  `app/app.vue` and `app/pages/electron.vue`
- Behavior: `did-fail-load` is registered in three places today. Consolidate the
  initial `loadURL` failure, `did-fail-load`, renderer readiness failure, and
  bootstrap rejection into one owner that carries one occurrence ID across the
  sequence, while still reporting a genuinely distinct second fault as its own
  occurrence.
- Tests: a single load failure produces one occurrence across all four paths; a
  distinct later failure produces a second occurrence; the fatal state shows the
  same Error ID as the log entry.
- Exit evidence: window lifecycle suite green with the occurrence count asserted
  per scenario.

#### SEN-MIG-08 Process death and recovery seams

- Status: implemented and locally verified
- Depends on: SEN-MIG-07
- Difficulty: medium
- Paths: `electron/processDeathRecovery.ts`, `electron/main.ts`,
  `electron/window.ts` for process-death and unresponsive regions only,
  `electron/window/rendererReady.ts` for its renderer-gone listener
- Behavior: `child-process-gone`, renderer gone, preload error, unresponsive
  recovery, safe-mode GPU recovery, and repeated-unhandled-rejection subsystem
  recovery each map to a specific code with bounded context. SEN-MIG-07 owns
  only load-failure regions in the shared window files and lands first. Recovery
  behavior, timers, and relaunch are unchanged. Expected teardown remains a
  warning.
- Tests: each seam produces one occurrence with the expected code; recovery
  timing is unchanged; expected teardown produces none.
- Exit evidence: recovery suite green with unchanged timing assertions.

#### SEN-MIG-09 Worker and utility parent ownership

- Status: implemented and locally verified
- Depends on: SEN-CORE-07
- Difficulty: hard
- Paths: `electron/utils/workerTask.ts` and the service parents that wrap it,
  including OCR, search, scan cleanup, DjVu, image export, and page operations;
  every consumer of `hasWorkerTaskErrorBeenReported`
- Behavior: the parent seam owns the remote occurrence. The existing
  `WeakSet<object>` reported-error marker becomes a
  `WeakMap<object, FailureReceipt>` with a receipt-returning lookup, so a worker
  error and its rejected wrapper do not both send. Workers and utility processes initialize no
  Sentry client and their reporters stay local. Worker cancellation stays info
  and expected utility teardown stays warning. A child bundle defaults to
  remote-disabled until its parent supplies a reportable application frame and
  the Phase 3 private-map manifest marks that exact bundle and dist reportable.
- Tests: worker error plus wrapper rejection produce one occurrence; cancellation
  produces none; a bundle marked unsupported produces no remote event.
- Exit evidence: worker task suite green with the single-occurrence assertion.

#### SEN-MIG-10 Red UI family migration

- Status: implemented and locally verified
- Depends on: SEN-CORE-06
- Difficulty: x-hard
- Paths: the eleven confirmed red families listed in the migration inventory
  below
- Behavior: apply the architecture's six-step sequence per family: add
  receipt-aware presentation, reuse an owning logger receipt, add an owner
  capture for UI-only faults, reclassify expected outcomes, replace direct
  `useToast().add({color: 'error'})` with the shared presenter, and only then let
  the static check become blocking. Components receive presentation state from
  their controller and never call the reporter in `watch`, render, mount, or an
  error boundary hook.
- Tests: per family, one fault produces exactly one occurrence and one
  presentation carrying the same ID; rerender produces no new occurrence; each
  reclassified case produces no occurrence.
- Exit evidence: the migration inventory table below has no unmigrated row, and
  `SEN-GATE-01` can move to blocking.

#### SEN-MIG-11 Landing reclassification and local seam

- Status: implemented and locally verified
- Depends on: SEN-CORE-03
- Difficulty: easy
- Paths: `landing/server/api/releases/latest.get.ts`,
  `landing/server/utils/landingFailureReporter.ts` (new)
- Behavior: exhausted upstream GitHub availability that returns a handled 503 is
  `temporarily-unavailable` and logs at warning. Best-effort landing analytics
  paths stay at warning. The `landing-nitro` reporter seam exists with a no-op
  adapter so a future actual defect has an owner, and it makes no network call.
- Tests: the exhausted-catalog path logs at warning and creates no occurrence;
  the landing reporter's adapter is a no-op; a static test that landing imports
  no Sentry package.
- Exit evidence: landing suite green with no error-level log on the handled path.

#### SEN-MIG-12 Expected-outcome reclassification

- Status: implemented and locally verified
- Depends on: SEN-CORE-03
- Difficulty: hard
- Paths: `app/modules/workspace-shell/composables/useWorkspaceExport.ts`,
  `app/composables/useRecentFiles.ts`,
  `app/components/settings/SettingsContent.vue`,
  `app/modules/workspace-shell/agent/runSettingsAssistantAction.ts`,
  `app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types.ts`,
  `app/modules/pdf-viewer/engine/annotations/annotation-rules/describeAnnotationCreationFailure.ts`,
  `app/modules/pdf-viewer/engine/annotations/annotation-rules/projectAnnotationCreationOutcome.ts`,
  `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationHighlight.ts`,
  `app/modules/workspace-shell/composables/useWorkspaceFailureSurface.ts`
- Behavior: export selection above a materialization limit, a recent file that no
  longer exists, annotation selection and readiness states that describe user
  state, and settings or assistant actions that log at warning use
  `ExpectedOutcome` with warning or neutral presentation. Red and `ERROR` stay
  reserved for reportable defects. This is a deliberate small product behavior
  change and each reclassification is listed in the issue body.
- Tests: each reclassified path produces no occurrence and no red presentation;
  the remaining genuinely faulty branch of the same function still does.
- Exit evidence: the reclassification list is complete and each entry has a test.

#### SEN-MIG-13 Browser and renderer worker parent ownership

- Status: implemented and locally verified
- Depends on: SEN-CORE-04
- Difficulty: hard
- Paths: `app/platform/browser-api/browserPageOpsWorkerClient.ts`,
  `app/platform/browser-api/browserSearchWorkerClient.ts`,
  `app/platform/browser-api/browserPdfCombineWorkerClient.ts`,
  `app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest.ts`,
  `app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient.ts`
- Behavior: each browser or renderer worker parent owns one
  `browser-worker-parent` occurrence for an unexpected worker failure, carries
  the receipt through wrapper rejection and UI presentation, and classifies
  cancellation and expected termination locally. Worker scripts import no
  Sentry package and construct no remote event.
- Tests: each parent emits once for worker failure plus wrapper rejection;
  cancellation and expected termination emit nothing; a UI projection reuses
  the same receipt.
- Exit evidence: all five worker-parent suites prove one owner and one
  occurrence per fault.

### Phase 2: consent, settings, and startup reading

#### SEN-CON-01 Diagnostics preference in settings schema version 2

- Status: implemented and locally verified
- Depends on: SEN-CORE-01
- Difficulty: medium
- Paths: `packages/contracts/shared.ts`, `packages/contracts/settings.ts`,
  `packages/contracts/diagnostics/diagnosticsPreference.ts` (new),
  `app/utils/browserSettingsPersistence.ts`, `electron/settings.ts`
- Behavior: add one optional field holding `'unknown' | 'granted' | 'denied'` as
  a backward-compatible addition inside the existing schema version 2, so an
  older build ignores it and `assertSupportedSettingsSchema` still accepts the
  file. Missing, invalid, or unrecognized values become `unknown`, which is off.
  The hosted browser reads and writes it in local storage only. It is never
  mirrored into the settings cookie, another cookie, a header, or any request.
  Add the new key to the negative `TBrowserSettingsCookiePayload` `Omit` list,
  because a new `ISettingsData` field otherwise defaults to cookie inclusion.
- Tests: sanitizer maps missing, empty, wrong-type, and unknown-string values to
  `unknown`; the settings save key list includes the field; the browser cookie
  payload does not; round-trip through Electron settings persistence keeps the
  value; an older-schema file still loads.
- Exit evidence: settings suite green including the cookie exclusion test.

#### SEN-CON-02 Synchronous startup preference reader

- Status: implemented and locally verified
- Depends on: SEN-CON-01
- Difficulty: hard
- Paths: `electron/features/diagnostics/readDiagnosticsPreferenceSync.ts` (new),
  `electron/main.ts`, `app/utils/failureReporter.ts` for the browser equivalent
- Behavior: main reads the single field synchronously from the settings file
  under the user-data path without calling the asynchronous `loadSettings()`
  path and without warming its cache. A missing file, unreadable file, corrupt
  JSON, partial object, wrong type, or newer schema yields `unknown`. The hosted
  browser reads its preference synchronously before importing any Sentry package
  or constructing a client, so `unknown` and `denied` cause zero module load and
  zero network activity.
- Tests: all six malformed-input cases yield `unknown`; the reader does not
  populate or invalidate the asynchronous settings cache; the browser path
  performs no dynamic import when the preference is not `granted`.
- Exit evidence: reader suite green and a module-load assertion for the browser
  path.

#### SEN-CON-03 Startup crash marker

- Status: implemented and locally verified
- Depends on: SEN-CON-02
- Difficulty: x-hard
- Paths: `electron/features/diagnostics/startupCrashMarker.ts` (new),
  `packages/contracts/diagnostics/startupCrashMarker.ts` (new),
  `electron/main.ts`
- Behavior: immediately after the preference is read, main installs an
  `uncaughtExceptionMonitor` observer owned by the diagnostic adapter. When the
  preference is granted, the observer synchronously replaces one fixed marker
  file with a closed `MAIN_STARTUP_CRASH` record containing event ID, code,
  canonical frames, timestamp, release, and dist, and nothing else. The marker
  is armed only during startup while live delivery is unavailable. Main removes
  or disarms the monitor as soon as the adapter is initialized and can own a
  live occurrence. A later uncaught exception follows the existing
  `requestFatalShutdown` path, produces at most one live event, and leaves no
  next-launch marker. The observer
  performs no network operation, does not call `preventDefault`, does not alter
  `process.exitCode`, does not install an `uncaughtException` recovery handler,
  and does not compete with the shutdown coordinator. Before the existing main
  handler is registered, Node's default fail-fast behavior is unchanged. After
  registration, the current coordinated fatal-shutdown behavior, exit code, and
  deadlines are unchanged. On the next launch, after normal adapter
  initialization, main sends the marker once only if the preference is still
  granted, then deletes it in every case. A crash before the reader runs, after
  denial, or during the marker write stays local by design.
- Tests: the monitor writes exactly one marker and never a queue; pre-handler
  fail-fast and post-handler coordinated shutdown are unchanged; an uncaught
  exception after adapter initialization produces one live event and no marker;
  the next launch sends at most once and always
  deletes; denial between launches deletes without sending; a corrupt or partial
  marker is deleted without sending; the marker contains no message, cause, or
  free-form context.
- Exit evidence: marker suite green including the unchanged exit-code assertion.

#### SEN-CON-04 Settings control and copy

- Status: implemented and locally verified
- Depends on: SEN-CON-01
- Difficulty: medium
- Paths: `app/components/settings/`, the privacy panel entry, and the app
  message files for all 9 locales, `docs/contributing/release-guardrails.md`
- Behavior: one positive control labelled `Send privacy-sanitized error
  diagnostics` with the approved explanatory sentence naming what is sent and
  what is never sent. The control does not mention training. It is available at
  all times, in the Electron and hosted runtimes, and links to the complete
  notice. The default is off for every client runtime. The Microsoft Store
  upload runbook records Policy 10.5.2's in-product permission requirement and
  states that every AppX ships client diagnostics off by default.
- Tests: default off; toggle persists through the normal settings path; copy
  keys exist in every locale; the control renders in both runtimes.
- Exit evidence: settings panel test green and locale parity green.

#### SEN-CON-05 First-error consent prompt

- Status: implemented and locally verified
- Depends on: SEN-CON-04
- Difficulty: hard
- Paths: `app/composables/useRuntimeErrorReports.ts`,
  `app/composables/useFailureToast.ts`, the runtime error card component
- Behavior: for an `unknown` preference, the first red failure may show a
  non-blocking choice beside the error. Affirmative action sends this occurrence
  only after Electron main has persisted `granted` and updated its live gate in
  the same settings transaction. The renderer then resends the same in-memory
  event ID, which main admits because unknown attempts did not consume it.
  `Do not send diagnostics` persists denied. Dismissal
  sends nothing and leaves the preference unknown. The live closed record may
  exist only inside that live presentation. It is never persisted, queued, or
  uploaded after a later unrelated grant, and dismissal, denial, navigation, or
  exit discards it.
- Tests: dismissal, denial, and navigation each leave zero network activity and
  discard the record; a grant while the presentation is live sends exactly one
  envelope containing exactly one event item; a grant after dismissal sends
  nothing for the earlier occurrence.
- Exit evidence: consent suite green with envelope counts asserted through the
  capture transport.

#### SEN-CON-06 Revocation path

- Status: implemented and locally verified
- Depends on: SEN-CON-04
- Difficulty: hard
- Paths: `app/utils/failureReporter.ts`,
  `electron/features/diagnostics/mainFailureReporter.ts`,
  `electron/settings.ts`, `app/utils/browserSettingsPersistence.ts`
- Behavior: revocation swaps the reporter to a no-op and the transport to a
  dropper first, then discards queued work. Electron main updates its sole live
  gate in the same persistence transaction; the immutable preload hint is not
  consulted. Hosted browser updates its in-process gate before resolving the
  settings action. This Phase 2 item proves reporter and capture-transport
  ordering only. SDK disposal, close-time envelopes, and restart fallback are
  proved later by SEN-CON-07. The notice
  states that turning reporting off stops future events and cannot recall events
  already received or in flight, and gives an access or deletion route using an
  Error ID.
- Tests: ordering test proving the live gate and dropper change before the
  settings action resolves; an in-flight or later record after revocation makes
  zero capture-transport sends in Electron and hosted browser.
- Exit evidence: reporter revocation suite green with zero transport sends.

### Phase 2: static gates and sentinels

#### SEN-GATE-01 Red presentation and console gates

- Status: implemented and blocking; both reports are zero
- Depends on: SEN-CORE-06 for warning mode, SEN-MIG-10 for blocking mode
- Difficulty: medium
- Paths: `eslint-plugin-custom.mjs`, `eslint.config.mjs`,
  `tests/unit/architecture/`
- Behavior: five rules are blocking at the Phase 2 exit. First, raw red toast or alert creation outside the shared
  presenter is rejected. Second, direct `console.error` in application code is
  rejected outside the captured raw sink in `app/utils/browserLogger.ts`, the
  observer in `app/utils/consoleErrorObserver.ts`, tests, and the main-owned
  projection in `electron/preload/installDebugLogListener.ts`. No generic
  bootstrap exemption exists. Third, a runtime or fatal presentation without a
  receipt is rejected. Fourth, error logger owners must provide a closed code
  and context or an existing receipt. Fifth, application owners cannot use the
  generic renderer or main codes. The architecture test writes two reports: the
  red-presentation migration report and the unclassified-code migration report.
  Both counts stay visible before the switch.
- Tests: fixtures prove each rule fires and each documented exemption does not.
  Both repository-wide reports are zero.
- Exit evidence: rules blocking, both reports zero, and lint green.

#### SEN-GATE-02 Sentry import boundary

- Status: implemented and locally verified
- Depends on: SEN-CORE-02
- Difficulty: hard
- Paths: `scripts/architecture/boundary-check.mjs`,
  `tests/unit/architecture/`
- Behavior: a node-level source check allows only the named runtime adapter
  roots to import a Sentry package, read a DSN, call a capture API, or construct
  a Sentry event. The runtime roots are
  `electron/features/diagnostics/sentryNodeAdapter.ts`,
  `app/utils/browserDiagnosticsTransport.ts`, and
  `server/utils/sentryNitroAdapter.ts`. Two exact release-tool roots,
  `scripts/release/stage-private-sourcemaps.mjs` and
  `scripts/release/upload-sentry-sourcemaps.mjs`, may spawn the pinned Sentry CLI
  and read the upload token. They may not import a client SDK, read a DSN, call a
  capture API, or construct an event. Every other path in `app/`, `electron/`,
  `packages/`, `server/`, `landing/`, `scripts/`, and the development runners is
  rejected. The rule names exact files rather than directory prefixes.
- Tests: fixture imports from a feature file, a script, a runner, preload, and a
  worker all fail; the three runtime roots and two limited CLI roots pass; a DSN
  literal outside a runtime adapter fails; a capture call or client import in a
  CLI root fails.
- Exit evidence: boundary check green with the fixtures in place.

#### SEN-GATE-03 Privacy sentinel suite

- Status: implemented and locally verified
- Depends on: SEN-CORE-10
- Difficulty: medium
- Paths: `tests/unit/` diagnostics privacy suites
- Behavior: one suite owns the forbidden-field list from the architecture ledger
  and asserts that no captured envelope from any runtime contains a raw message,
  raw stack string, console argument, breadcrumb, UI copy, file path, URL, query,
  document content, AI text, request or identity field, attachment, minidump,
  replay, span, profile, metric, log, or session item. It also asserts the final
  reconstruction returns null for an event without the EVB schema marker.
- Tests: the sentinel matrix across renderer, main, worker parent, hosted
  browser, and viewer Nitro.
- Exit evidence: the suite is part of the required unit gate and green.

### Phase 3: SDK adapters, projects, and build artifacts

#### SEN-EXT-06 Projects, client keys, and upload token

- Status: complete; two projects, three keys, exact browser origins, and one `org:ci` token verified 2026-09-04
- Depends on: SEN-EXT-03
- Difficulty: hard
- Scope: Sentry account and CI secrets. The only repository change is the
  credential-free inventory in `docs/internal/operations/sentry-account-controls.md`.
- Behavior: create exactly two projects, `evb-viewer-desktop` and
  `evb-viewer-web`. Create one restricted desktop client key, and separate
  restricted browser and Nitro client keys in the web project. Restrict the
  browser key to the exact production and preview viewer origins. Create a
  least-privilege source-map upload token for CI. Do not put a DSN, key, token,
  organization slug, project ID, or private endpoint in the inventory or issue.
  Record where each secret is provisioned by secret name and runtime purpose,
  without recording its value.
- Evidence: the tracked inventory and an issue checklist recording project,
  key purpose, origin restriction, token scope, verifier role, and date.
- Exit evidence: two projects only, three restricted client keys, exact browser
  origins, and one least-privilege upload token have been independently verified.

#### SEN-EXT-07 Disable Sentry source fetching after upload

- Status: complete; source fetching is disabled in both projects and post-change desktop and web Debug ID canaries resolve
- Depends on: SEN-MAP-04
- Difficulty: medium
- Scope: Sentry account only, plus the credential-free inventory.
- Behavior: after every shipping bundle has a verified Debug ID upload and
  symbolication canary, disable JavaScript source fetching in both projects.
  Private uploaded artifacts become the only source for symbolication. Keep the
  setting disabled for preview and production. A release without a verified
  upload stays diagnostics-disabled instead of re-enabling source fetching.
- Evidence: update the tracked inventory and the issue checklist with setting,
  target value, verifier role, and date. Do not attach screenshots or private
  account paths.
- Exit evidence: source fetching is off in both projects and a post-change
  canary still resolves through the uploaded Debug ID artifacts.

#### SEN-SDK-01 Pin compatible SDK and CLI versions

- Status: implemented and locally verified
- Depends on: SEN-EXT-03
- Difficulty: medium
- Paths: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` build-script
  policy if a new dependency needs an install script
- Behavior: pin exact mutually compatible Sentry browser, Node, core, and CLI
  versions against the installed Nuxt and Electron dependency graph. Record the
  chosen versions and the reason in the issue. Do not add the Electron SDK.
- Tests: production dependency audit passes; the fallow dead-code and duplicate
  gates pass; a test that the renderer bundle contains no Sentry module.
- Exit evidence: lockfile change with the audit and bundle assertions green.

#### SEN-SDK-02 Electron main Node-family adapter

- Status: implemented and locally verified
- Depends on: SEN-SDK-01
- Difficulty: x-hard
- Paths: `electron/features/diagnostics/sentryNodeAdapter.ts` (new)
- Behavior: the adapter sets `defaultIntegrations: false`,
  `skipOpenTelemetrySetup: true`, `sendClientReports: false`,
  `sendDefaultPii: false`, and a non-persisting transport, and adds only the
  minimum event transport and stack support proved by captured-envelope tests. It
  supplies the closed Electron context explicitly: app version, platform,
  architecture, and Electron, Chromium, and Node major versions. It reconstructs
  the event in `beforeSend` as a final backstop and returns null for an event
  without the EVB schema marker. If the pinned Node client still registers a
  process handler or global patch, use the core server runtime client with a
  hand-built transport instead.
- Tests: no process handler or global patch is registered by initialization; the
  transport does not persist; `beforeSend` drops an unmarked event; envelope
  inspection shows exactly one event item.
- Exit evidence: handler-registration and envelope suites green with the chosen
  client recorded.

#### SEN-SDK-03 Hosted browser adapter and CSP

- Status: complete; captured-envelope tests and production consent/CSP acceptance verified 2026-09-05
- Depends on: SEN-SDK-01
- Difficulty: hard
- Paths: `app/utils/browserDiagnosticsTransport.ts` (new), `nuxt.config.ts`,
  `electron/security/csp.ts`
- Behavior: the browser adapter is imported only after a granted preference is
  read synchronously. It sends directly to the one exact Sentry EU ingest origin
  in the DSN. The browser-only production CSP variant adds exactly that origin
  and nothing else. Generated Nuxt headers may contain that origin, but packaged
  Electron does not consume those route headers. Electron session security
  installs its existing `connect-src 'self' blob:` policy. A same-origin proxy
  is rejected. The same integration, client-report, and reconstruction rules as
  main apply.
- Tests: unknown and denied preferences perform zero module load and zero
  request; the hosted-browser CSP contains the exact single added origin; the
  packaged Electron's installed CSP remains unchanged; the built browser bundle
  contains no Electron or server DSN.
- Exit evidence: CSP test green and a module-load assertion under each preference
  value.

#### SEN-SDK-04 Release identity and environments

- Status: implemented and locally verified
- Depends on: SEN-SDK-01
- Difficulty: medium
- Paths: the adapter roots, `scripts/build-electron.mjs`, `nuxt.config.ts`,
  `scripts/release/` release identity helpers, `.github/workflows/build.yml`,
  `.github/workflows/build-mac-intel.yml`,
  `.github/workflows/build-win7-legacy.yml`,
  `.github/workflows/store-appx.yml`,
  `.github/workflows/release-artifacts.yml`, and
  `.github/workflows/release-supplemental.yml`
- Behavior: CI computes release and dist once and passes the identical values to
  the SDK, the map upload, the canary, the receipt, the package, and the
  deployment. `scripts/build-electron.mjs` injects the desktop DSN, release, and
  dist at build time. `nuxt.config.ts` exposes only the browser DSN as public
  runtime configuration and keeps the Nitro DSN private. CI provisions these
  through distinct secret paths. Desktop uses `evb-viewer-desktop@<version>`
  with these exact shipping dist values: `macos-arm64`, `macos-x64`,
  `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`,
  `store-appx-x64`, and `store-appx-arm64`. The closed identity contract also
  recognizes `win7-legacy-x64`, but that Electron 22 experiment does not start
  and is not published. Issue #335 owns its removal or separate legacy build.
  Web uses `evb-viewer-web@<version-or-deployment>` with `production` or
  `preview-<build-id>`. Environments are exactly `production`, `preview`,
  `development`, and `test`. No mutable `latest` release exists.
  A complete set of four private upload values enables map upload. An entirely
  absent set keeps diagnostics disabled in every environment, including a
  production release build. A partial set fails the lane.
- Tests: a policy test that a build cannot produce two different release or dist
  values; a test that the environment set is closed.
- Exit evidence: identity policy test green with the computed values recorded in
  the build log.

#### SEN-SDK-05 Viewer Nitro adapter

- Status: implemented and locally verified
- Depends on: SEN-SDK-01, SEN-EXT-06
- Difficulty: hard
- Paths: `server/utils/sentryNitroAdapter.ts` (new)
- Behavior: this is the only viewer Nitro Sentry import root. It sets
  `defaultIntegrations: false`, `skipOpenTelemetrySetup: true`,
  `sendClientReports: false`, and `sendDefaultPii: false`; installs no request,
  tracing, log, session, or identity integration; uses a non-persisting
  transport; and accepts only a closed `DiagnosticRecord`. Its final event
  reconstruction drops any unmarked event and adds only release, dist,
  environment, runtime, code, bounded context, and canonical application frames.
  DSN, identity, and every legal gate are baked into the Nitro server bundle.
  Runtime configuration must match the baked value exactly, so Vercel runtime
  environment overrides fail closed. The diagnostics-enabled deploy also
  requires a valid source-map upload receipt for the same build identity before
  it can submit the prebuilt output.
- Tests: initialization registers no request or process integration; envelope
  inspection contains one event item and no request-derived or client-report
  item; an unmarked event is dropped; transport state is not persisted.
- Exit evidence: Nitro adapter and envelope suites green with the pinned client
  recorded.

#### SEN-MAP-01 Emit private maps for every reportable bundle

- Status: implemented and locally verified; live web build inventory verified 2026-09-04
- Depends on: SEN-SDK-04
- Difficulty: hard
- Paths: `scripts/build-electron.mjs`, `nuxt.config.ts`, and the worker and
  utility bundle build definitions
- Behavior: diagnostics-eligible release builds set the existing
  `EVB_ELECTRON_SOURCEMAP=1` path for Electron and enable all three Nuxt map
  controls that are currently off: `sourcemap.server` and `sourcemap.client`,
  `vite.build.sourcemap`, and `nitro.sourceMap`. Release maps remain external and
  include the private source files needed for symbolication. The current public
  baseline is `sourcesContent: false`; the release path stages source files
  privately rather than embedding them into shipped maps or JavaScript. Every
  reportable main, renderer, browser-worker parent, utility-parent, and server
  bundle appears in the private manifest. Preload maps are produced only if a
  mapped owned seam requires them. No public artifact contains a `.map` or
  staged source.
- Tests: a build test that each reportable bundle has a map in the private stage;
  a test that the public output has none.
- Exit evidence: a build log listing every reportable bundle and its map.

#### SEN-MAP-02 Inject Debug IDs and stage maps before pruning

- Status: implemented and locally verified; strict web upload accepted 2026-09-04
- Depends on: SEN-MAP-01
- Difficulty: x-hard
- Paths: `scripts/release/stage-private-sourcemaps.mjs` (new), the `build` and
  `build:desktop`, `build:strict`, and release script chains in `package.json`,
  `scripts/run-build-strict.mjs`, `scripts/prune-build-artifacts.mjs`,
  `.github/workflows/build.yml`, `.github/workflows/build-mac-intel.yml`,
  `.github/workflows/build-win7-legacy.yml`,
  `.github/workflows/store-appx.yml`,
  `.github/workflows/release-artifacts.yml`, and
  `.github/workflows/release-supplemental.yml`
- Behavior: run in exactly this order: build final JavaScript with private maps,
  perform every minification and post-build transform, inject Sentry Debug IDs
  into the final JavaScript and maps, copy maps and sources to the ignored
  `.tmp/private-sourcemaps/` stage, then prune maps from the public output. The
  staging script may spawn only the pinned Sentry CLI under SEN-GATE-02. Today
  `pnpm run build` prunes maps
  immediately after `nuxi build`, so the staging step must be inserted before
  that prune call rather than after it.
- Tests: an ordering test that the stage directory is populated before the prune
  step runs; a test that injection happens after minification; a test that the
  public output is map free after pruning.
- Exit evidence: a build that produces a populated private stage and a map-free
  public output, with the order asserted by test.

#### SEN-MAP-03 Receipts computed from injected bytes

- Status: implemented and locally verified; live web local-to-served parity verified 2026-09-04
- Depends on: SEN-MAP-02
- Difficulty: hard
- Paths: `scripts/release/build-receipt.mjs`, the private manifest written by
  `SEN-MAP-02`
- Behavior: Debug ID injection mutates JavaScript, so it must complete before the
  existing desktop receipt hashes its real inputs: `dist-electron`,
  `nuxt-output`, generated Electron Builder resources, the native manifest, and
  the manifest's native staging roots. The ignored private map stage is excluded
  from the receipt inputs. Its manifest records the SHA-256 of every injected
  public JavaScript file and every private map or source. The viewer has no
  current Vercel output in `getBuildOutputs`; its proof is a separate
  private-manifest-to-served-byte hash comparison after the prebuilt deploy.
- Tests: a desktop receipt computed before injection fails; the receipt includes
  the existing input list and excludes `.tmp/private-sourcemaps/`; desktop
  injected-file hashes match the private manifest; the web parity helper compares
  the manifest to locally built and served `.vercel/output` bytes without
  claiming they are receipt inputs.
- Exit evidence: matching desktop receipt and manifest hashes for desktop, and
  matching private manifest, local output, and served hashes for the viewer.

#### SEN-MAP-04 Upload maps and verify symbolication

- Status: complete; exact-SHA desktop and production web receipts passed on 2026-09-06
- Depends on: SEN-MAP-05, SEN-EXT-02, SEN-EXT-06, SEN-SDK-02, SEN-SDK-03,
  SEN-SDK-05
- Difficulty: x-hard
- Paths: `scripts/release/upload-sentry-sourcemaps.mjs`,
  `scripts/release/send-sentry-sourcemap-canaries.mjs`,
  `scripts/release/verify-sentry-sourcemap-canaries.mjs`,
  `.github/workflows/build.yml`, `.github/workflows/build-mac-intel.yml`,
  `.github/workflows/build-win7-legacy.yml`,
  `.github/workflows/store-appx.yml`,
  `.github/workflows/release-artifacts.yml`,
  `.github/workflows/release-supplemental.yml`, and the viewer deploy workflow
- Behavior: upload the private artifacts before any canary event, because Sentry
  does not retroactively symbolicate an event it already received. Verify release
  files and run one deterministic, retry-safe canary per supported bundle with
  a project-source mapping, showing the original EVB file,
  function, line, release, and dist, and confirm Debug ID matching through
  Sentry's source-map debug endpoint and the processed-event endpoint. The
  verifier checks every event in the receipt, including source-file and map
  lookup, exact Debug ID association, original file, function, line, canary
  identity, and source context. It checks complete manifest coverage and does
  not require Sentry scraping data because source fetching is disabled. The
  upload token and separate read-only verification token are CI secrets with
  minimum scope, are never printed, and never reach a public artifact. Because
  supplemental re-dispatch reuses already attached assets and builds are not byte
  reproducible, each shipping desktop dist gets the map manifest from the build
  that produced its bytes. The upload for supplemental macOS Intel and
  Windows ARM64 targets happens in the run that first attaches those assets. A
  re-dispatch verifies bytes and does not rebuild or re-upload. If a missing or
  partial supplemental asset pair is rebuilt, that fresh build must upload its
  fresh private artifacts before attachment. Browser worker-parent bundles and
  Nitro output are included in the web manifest and symbolication canary. The
  staging and upload tools may spawn only the pinned Sentry CLI and may read
  only the upload token allowed by SEN-GATE-02. The verifier may read only the
  separate read-only verification token.
- Vercel's output directory is hidden. The uploader copies its exact bytes to a
  visible temporary tree, then uploads from `vercel/output/static` and
  `vercel/output/functions`. The static invocation must pass `--url-prefix ~/`
  so `/_nuxt/...` frames match Sentry's `~/_nuxt/...` artifact names while the
  source-map rewrite can still reach the staged project sources. Uploading the
  temporary tree's parent produces `~/vercel/output/static/...` and does not
  match deployed browser URLs.
- Tests: upload-argument coverage for the static URL prefix, a verifier suite
  covering delayed processing and missing source content, a workflow policy test
  that verification follows every canary step, a secret scan on public
  artifacts, and a test that a re-dispatch path performs no upload.
- Exit evidence: `34006005475` contains one passing
  `canary-verification-receipt.json` for each of the eight shipping desktop
  identities, with 230 submitted and 230 verified events per dist. The
  production `evb-viewer-web@0.1.453` receipt contains 259 verified events.
  Generated or vendor-only bundles without an EVB source mapping remain
  explicitly excluded from symbolication claims.

#### SEN-MAP-05 Prebuilt viewer deployment

- Status: complete; exact production deployment and source-map verification passed 2026-09-06
- Depends on: SEN-MAP-03
- Difficulty: x-hard
- Paths: `scripts/deployVercelPrivate.mjs`, the `deploy:web` and
  `deploy:web:prod` scripts in `package.json`
- Behavior: ordinary viewer deploys may still upload tracked source for a
  remote Vercel build. A diagnostics-enabled viewer builds `.vercel/output`
  locally, injects and stages maps, requires the matching private upload
  receipt, then copies `.vercel/output` separately into deployment scratch because
  the tracked-source walker excludes `.vercel`. Thread `--prebuilt` through the
  deploy argument parser and deploy that exact scratch output. Source-archive
  deployment would let Vercel rebuild different JavaScript after the maps were
  uploaded.
  Landing keeps its current flow because it has no project. Keep the existing
  local-only artifact exclusions that the tracked deploy source walker and the
  deploy asset check share. Extend the local asset checker with an explicit
  `.vercel/output` input mode rather than weakening its source-tree exclusions.
- Tests: a deploy policy test that a diagnostics-enabled viewer deployment uses
  the prebuilt path; a parity test that the deployed output hash matches the
  private manifest; a test that the exclusion behavior is unchanged; a local
  asset-checker test against `.vercel/output`.
- Exit evidence: a preview deployment whose served JavaScript hashes match the
  private manifest.

#### SEN-MAP-06 Public artifact scans

- Status: complete; exact-byte web Preview and production scans and all eight shipping desktop artifact scans pass
- Depends on: SEN-EXT-07
- Difficulty: medium
- Paths: `scripts/check-web-deploy-assets.mjs`,
  `scripts/release/assert-packaged-app-contents.mjs`,
  `scripts/check-build-artifacts-hygiene.mjs`
- Behavior: extend the existing scans so a package or deployment fails when it
  contains a `.map`, a staged source directory, an auth token, or a DSN that
  belongs to a different runtime. Add a bounded suffix or regular-expression
  matcher where the existing exact-name scanner cannot detect hashed map and
  source names. Desktop packages must contain no web DSN and no web ingest host.
- Tests: fixture artifacts containing each forbidden item fail the scan; a clean
  artifact passes.
- Exit evidence: scans green on real artifacts for every shipping platform.

### Phase 4: viewer Nitro

#### SEN-SRV-01 Viewer Nitro error owner

- Status: implemented and locally verified
- Depends on: SEN-CORE-02, SEN-SDK-05
- Difficulty: hard
- Paths: `server/plugins/diagnostics.ts` (new),
  `server/utils/serverFailureReporter.ts` (new),
  `server/utils/sentryNitroAdapter.ts` (new)
- Behavior: one EVB Nitro plugin owns uncaught server errors and explicit caught
  failures in server endpoints through SEN-SDK-05. It uses a generic code for an uncaught error and
  a specific code for known endpoint operations. It never reads a request value
  into the record. Request, transaction, route parameter, URL, header, cookie,
  body, IP, and identity integrations stay off. The plugin must register exactly
  once in normal, packaged, and prebuilt output.
- Tests: a synthetic 500 produces one event; each explicit endpoint code produces
  one event; registration count is one in all three output shapes; the captured
  event contains no request-derived field.
- Exit evidence: server diagnostics suite green including the single-registration
  assertion.

#### SEN-SRV-02 Server objection control

- Status: implemented and locally verified
- Depends on: SEN-SRV-01
- Difficulty: medium
- Paths: `packages/contracts/diagnostics/serverDiagnosticsObjection.ts` (new),
  `server/utils/diagnosticsObjection.ts` (new),
  `server/utils/serverFailureReporter.ts`, the browser privacy settings surface,
  and `packages/i18n-core/privacyMessages.ts`
- Behavior: one typed first-party `diagnosticsServerOptOut` preference is the
  shared browser and server mechanism. The browser privacy settings surface
  writes a bounded, SameSite, Secure-in-production first-party cookie, and the
  Nitro reporter reads only that boolean before admitting an associated event.
  This deliberately parallels the existing analytics path because analytics has
  no user preference that can safely be reused, and the two purposes remain
  separate in storage, notice copy, and code. Only the boolean needed to honor
  the objection is persisted. No stable diagnostic identifier is attached. A
  privacy contact route exists for server events that cannot be associated with
  a retained identity. Client consent and server objection remain separate legal
  mechanisms even though the settings page presents both controls together.
- Tests: an objecting request produces no associated event; a non-objecting
  request still produces one; the objection state is not used as an identifier.
- Exit evidence: objection suite green with both directions asserted.

#### SEN-SRV-03 Enable viewer Nitro reporting

- Status: blocked by legal, account, map, and preview gates
- Depends on: SEN-SRV-02, SEN-EXT-04, SEN-EXT-07, SEN-MAP-04
- Difficulty: medium
- Paths: deployment configuration for the viewer environment
- Behavior: enable viewer Nitro reporting only after the legitimate-interests
  assessment, the notice, the DPA, the account controls, the retention record,
  and the objection route are all in place. Preview first, then production.
- Tests: a configuration test that reporting cannot be enabled without the
  release identity and prebuilt deployment inputs.
- Exit evidence: preview enabled with a recorded date and the gate list attached.

#### SEN-CAN-03 Viewer Nitro canary

- Status: blocked by preview enablement and one-week observation
- Depends on: SEN-SRV-03
- Difficulty: hard
- Paths: preview and production viewer deployments
- Behavior: run one week of preview and production canary data. Prove one
  uncaught 500 and each explicit server code arrive once, that request, URL,
  transaction, header, cookie, body, IP, and identity data are absent, and that
  the objection path suppresses associated reports.
- Tests: the server canary checklist executed against both environments.
- Exit evidence: one week of data reviewed as safe, low noise, symbolicated, and
  actionable.

### Phase 5: consent proof and client canaries

#### SEN-CON-07 No-client-report proof

- Status: implemented and locally verified; macOS arm64 packaged proof passed
  2026-09-05, remaining shipping identities pending hosted proof
- Depends on: SEN-CON-06, SEN-SDK-02, SEN-SDK-03, SEN-SDK-05
- Difficulty: medium
- Paths: `electron/features/diagnostics/sentryNodeAdapter.ts`,
  `app/utils/browserDiagnosticsTransport.ts`,
  `server/utils/sentryNitroAdapter.ts`, and their envelope tests
- Behavior: prove for every SDK-owning runtime that `sendClientReports: false`
  results in no client-report envelope item at initialization, during normal
  operation, on visibility change, during adapter disposal after revocation, at
  process exit, and after restart in denied mode. Disposal first installs a
  dropper, and no SDK close or flush call may emit an envelope. Only one EVB
  `DiagnosticRecord` may produce one Sentry event item.
- Tests: full envelope inspection across initialization, normal operation,
  visibility change, revocation and disposal, process exit, and denied restart
  for main, hosted browser, and viewer Nitro; assert exactly one item per event
  envelope, no close-time envelope, and no `client_report` item type.
- Exit evidence: envelope inspection suite green for all three runtimes.

#### SEN-CAN-01 Desktop consent canary

- Status: complete for the eight shipping identities; the hosted matrix passed
  2026-09-06. Windows 7 remains advisory and credential-free.
- Depends on: SEN-CON-03, SEN-CON-05, SEN-CORE-09, SEN-MIG-04, SEN-MIG-07,
  SEN-MIG-09, SEN-MIG-13, SEN-SDK-02, SEN-MAP-04, SEN-CON-07
- Difficulty: x-hard
- Paths: a signed desktop preview build and the e2e suites under `tests/e2e/`
- Behavior: prove on every shipping platform that unknown and denied make zero
  diagnostic requests, that a grant emits exactly one envelope with one event
  item for the still-live occurrence and then permits future occurrences, that
  revocation sends no close-time or queued envelope, and that main, renderer,
  worker, fatal, UI-only, and direct-console canaries each produce one event
  carrying the same Error ID shown locally. Prove the startup marker path across
  a real crash and relaunch. Prove that update, relaunch, recovery, and shutdown
  behavior and deadlines are unchanged. Every automation session started for this
  work is stopped in the same stage, per `docs/internal/agents/workspace-hygiene.md`.
- Tests: the e2e canary matrix per platform, plus the packaged-artifact DSN scan.
- Exit evidence: per-platform canary results with envelope counts and Error ID
  correlation.

#### SEN-CAN-02 Hosted browser consent canary

- Status: complete for the consent, request-count, revocation, CSP, runtime
  Error ID, served-byte, and source-map checks on the production deployment
  2026-09-06
- Depends on: SEN-CON-05, SEN-MIG-04, SEN-SDK-03, SEN-MAP-04, SEN-CON-07
- Difficulty: hard
- Paths: a preview deployment and the browser integration suite
- Behavior: prove zero requests under unknown and denied, exactly one envelope
  with one event item on grant, correct symbolication from the deployed bundle,
  and that the CSP permits exactly the one ingest origin.
- Tests: browser integration canary against the preview deployment.
- Exit evidence: recorded network traces for each preference value and a
  symbolicated canary event after the fresh exact release passes SEN-MAP-04.

### Phase 6: operation

#### SEN-OPS-01 Alerts and quota

- Status: complete; three production issue alerts and the platform-supported personal error-quota notification are enabled
- Depends on: SEN-CAN-01, SEN-CAN-02
- Difficulty: medium
- Behavior: configure exactly four alert classes: a new or regressed high-priority
  fatal production issue, a new or regressed production issue with a diagnostic
  code, a production issue with a diagnostic code that exceeds 20 events in five
  minutes, and an organization quota notification. The live account UI exposes
  only `100% and 80%` or `100%`; it does not expose custom 50, 70, 75, or 90
  percent points. The stricter available `100% and 80%` option is enabled, and
  pay-as-you-go remains disabled.
  Do not alert on preview, tests, cancellation, expected teardown, validation,
  unsupported input, or ordinary offline behavior.
- Exit evidence: the four alerts exist and the excluded categories are recorded.
  Nitro operation is intentionally not a prerequisite for this enabled-client
  acceptance record.

#### SEN-OPS-02 Weekly triage procedure

- Status: complete; runbook implemented and first live weekly cycle recorded 2026-09-05
- Depends on: SEN-OPS-01
- Difficulty: medium
- Paths: `docs/contributing/releasing.md` or a dedicated operations section for the runbook
- Behavior: document and follow the weekly and post-release routine: confirm
  environment, release, code, and application frame; confirm the privacy schema
  and the symbolication canary; merge issues only when code and stack support one
  root cause; reproduce from repository evidence, treating a Sentry event as a
  lead and not proof; create a GitHub issue manually when actionable, including
  code, release, platform, safe stack, frequency, Error ID, and reproduction
  status, with exactly one difficulty label per `CLAUDE.md`; link the issue and
  resolve Sentry only after a shipped fix stays clean; delete resolved Sentry
  issues each week; treat any forbidden field as a privacy incident rather than a
  useful detail. Automatic GitHub issue creation and automatic resolution stay
  off.
- Exit evidence: the runbook is in the repository and one full weekly cycle has
  been executed.

#### SEN-OPS-03 Remove the compatibility overloads

- Status: implemented and locally verified; both reports are zero
- Depends on: SEN-OPS-02, SEN-MIG-01, SEN-MIG-02
- Difficulty: hard
- Paths: `app/utils/browserLogger.ts`, `electron/utils/createLogger.ts`, the
  presenter compatibility signatures from SEN-CORE-06
- Behavior: the unclassified logger overloads and pre-receipt presenter
  signatures are removed. Every application-owned logger call supplies a
  specific code or existing receipt, and every red presenter receives a
  receipt-bearing presentation.
- Tests: both migration reports are zero; expected TypeScript errors prove the
  removed signatures no longer compile.
- Exit evidence: both zero reports are checked in, compatibility code is
  deleted, blocking lint is green, and the operations procedure exists. The
  first live weekly cycle remains an external SEN-OPS-02 item.

## Migration inventories

These tables record the completed working state for SEN-MIG-10, SEN-MIG-12,
and the static migration reports. The `Owner after migration` column names who
creates the occurrence, so a reviewer can see that no row has two owners.

### Red toast call sites

All 24 sites currently call `useToast().add({color: 'error'})` directly.

| Path | Occurrences | Owner after migration | Classification | Status |
| --- | --- | --- | --- | --- |
| `app/modules/workspace-shell/composables/useWorkspaceExport.ts` | 7 | export service, one receipt per failed export | Mixed: materialization-limit refusal becomes `validation-rejected` | Implemented |
| `app/components/settings/SettingsContent.vue` | 5 | settings controller | Mixed: persistence failure is a fault, integration refusal is expected | Implemented |
| `app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts` | 2 | run coordinator, reusing the logged receipt | Fault | Implemented |
| `app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects.ts` | 2 | document session owner | Fault | Implemented |
| `app/composables/useRecentFiles.ts` | 1 | recent files composable | Expected: stale entry becomes `handled-absence` | Implemented |
| `app/composables/useDjvu.ts` | 1 | DjVu service, reusing the main IPC `failureRef` | Fault | Implemented |
| `app/modules/workspace-shell/agent/runSettingsAssistantAction.ts` | 2, of which one is the result type declaration | assistant action controller | Mixed: refusal is expected, action failure is a fault | Implemented |
| `app/modules/workspace-shell/composables/useWorkspaceFailureSurface.ts` | 1 | workspace failure surface | Fault | Implemented |
| `app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop.ts` | 1 | page drag and drop owner | Mixed: unsupported input becomes `unsupported-input` | Implemented |
| `app/modules/workspace-shell/composables/useWorkspacePrint.ts` | 1 | print orchestration | Fault | Implemented |
| `app/modules/workspace-shell/composables/useExternalFileDrop.ts` | 1 | external drop handler | Mixed: unsupported file type becomes `unsupported-input` | Implemented |

### Other red presentation families

| Surface | Path | Owner after migration | Status |
| --- | --- | --- | --- |
| Fatal runtime modal | `app/components/AppFatalRuntimeDialog.vue`, `app/composables/useFatalRuntimeError.ts`, `app/pages/electron.vue`, `app/app.vue` | The bootstrap or bridge owner that detected the fault, one receipt reused by the modal | Implemented |
| Top-right runtime card | `app/app.vue`, `app/composables/useRuntimeErrorReports.ts`, `app/plugins/runtimeErrorLogStream.client.ts` | Main `failureRef` for main-origin records, the renderer owner for renderer-origin ones | Implemented |
| Workspace document alerts | `app/modules/workspace-shell/components/WorkspaceDocumentAlerts.vue` | The document session controller, presentation only in the component | Implemented |
| Deferred workspace failure panel | `app/modules/workspace-shell/components/DocumentWorkspaceFailurePanel.vue` | The workspace failure surface | Implemented |
| Per-page source error | `app/modules/workspace-shell/components/DocumentPageSourcePageVisual.vue` | The page source loader | Implemented |
| Combine PDF alerts | `app/components/combine/CombinePdfPage.vue` | The combine service, reusing its logged receipt | Implemented |
| Scan cleanup error state | `app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts` | The run coordinator, one receipt for the stored state and the toast | Implemented |
| Assistant runtime error state | `app/modules/agent-panel/components/AgentAssistantPanel.vue`, `app/modules/agent-panel/composables/useAgentAssistantPanelController.ts` | The controller, one receipt for the log, the state, and the runtime report | Implemented |
| Optimize dialog | `app/modules/pdf-viewer/components/PdfOptimizeDialog.vue`, `app/modules/workspace-shell/components/WorkspaceSaveDialogHost.vue`, `app/modules/workspace-shell/composables/useDocumentWorkspaceOptimizeDialog.ts` | The workspace optimize controller | Implemented |
| Print dialog | `app/modules/pdf-viewer/components/PdfPrintDialog.vue`, `app/modules/workspace-shell/components/WorkspaceSaveDialogHost.vue`, `app/modules/workspace-shell/composables/useWorkspacePrint.ts` | Print orchestration | Implemented |
| DjVu conversion dialog | `app/modules/djvu-viewer/components/DjvuConvertDialog.vue`, `app/composables/useDjvu.ts` | The DjVu service; warning-only policy and estimate failures remain expected | Implemented |

### Renderer and main logger families

| Family | Scale | Migration | Status |
| --- | --- | --- | --- |
| `BrowserLogger.error` | 77 calls | Every owner supplies a subsystem-specific code or existing receipt. The receipt-free overload is removed. | Implemented, zero unclassified |
| Electron logger errors | 98 statically identified owner calls | Every owner supplies a subsystem-specific code or existing receipt. The receipt-free overload is removed. | Implemented, zero unclassified |
| Global renderer guard | `app/plugins/rendererErrorGuard.client.ts` | One occurrence, inherited handler inside the suppression scope | Implemented |
| Renderer console observer | new observer plus the existing console adapter | `UNCLASSIFIED_CONSOLE_ERROR`, frameless drops counted | Implemented |
| Preload projection | `electron/preload/installDebugLogListener.ts` | Presentation only, no occurrence | Implemented |
| Typed IPC failures | `electron/platform-ipc/` handlers and their contracts | `failureRef` on the response, renderer reuses it | Implemented |
| Electron worker and utility parents | `electron/utils/workerTask.ts` and its service parents | Parent owns the occurrence, child reporters stay local | Implemented |
| Browser and renderer worker parents | the five exact SEN-MIG-13 parent paths | Parent owns the occurrence, child reporters stay local | Implemented |
| Viewer Nitro | `server/` endpoints and the new plugin | Server reporter, no request data | Implemented, disabled pending gates |
| Landing Nitro | `landing/server/` | Warning for handled upstream unavailability, no-op adapter seam | Implemented |
| Development runners | `scripts/electron-run/`, the development log tooling | Local only, never a Sentry input, covered by SEN-GATE-02 | Implemented |

## Test matrix

Each row names where the proof lives. Rows marked `existing` extend a suite that
already exists at `55e00c767`.

| Area | Proof | Location |
| --- | --- | --- |
| Closed builder | Forbidden sentinels at every input depth never reach a captured envelope | `tests/unit/` diagnostics suites |
| Code registry | Type tests and runtime decoders reject unknown codes, keys, values, frames, IDs, and schema versions | `tests/unit/contracts/` |
| Static boundary | Only the three named runtime adapter roots import a Sentry SDK; only two exact release tools may invoke the CLI, and only the exact verification tool may read the separate read-only verification token | `tests/unit/architecture/`, `scripts/architecture/boundary-check.mjs` (existing) |
| Red invariant | Raw red presentation, direct `console.error`, and receipt-free runtime or fatal reports fail | `tests/unit/architecture/`, `eslint-plugin-custom.mjs` (existing) |
| Renderer ownership | One guarded Vue error yields one local log, one IPC record, one UI report, one event | `tests/unit/app/` |
| Main ownership | One main `ERROR` yields one local log and one event, then appears in every window without another send | `tests/unit/electron/` |
| Main IPC receipt | A main-owned IPC failure returns `failureRef` and the renderer creates no occurrence | `tests/unit/electron/`, `tests/unit/app/` |
| Renderer log direction | A renderer error reaches main file logging and never echoes into the debug stream | `tests/unit/electron/` (existing bridge tests) |
| Preload projection | The isolated-world print creates no main-world occurrence | `tests/unit/electron/` |
| Fatal paths | Bootstrap and bridge-missing fatal states show an Error ID and create one event when policy allows | `tests/unit/app/`, `tests/e2e/electron/` |
| UI-only paths | Every inline, toast, panel, and page error has an owner receipt and rerender does not resend | `tests/unit/app/` |
| Expected paths | Cancellation, expected teardown, unsupported input, selection limits, stale recent files, and offline states send nothing | `tests/unit/app/`, `tests/unit/electron/` |
| Console fallback | Sentinel-bearing arguments yield code and safe frames only; frameless calls drop and count | `tests/unit/app/` |
| Burst control | Every attempt counted, cap respected, one summary per code and frame pair per window, count clamped at 10,000 | `tests/unit/` diagnostics suites |
| Client consent | Unknown and denied cause zero import, client, queue, and network activity | `tests/unit/app/`, `tests/integration/` browser suite |
| Revocation | Dropper installed before disposal and disable; no close-time, visibility-change, or client-report envelope | `tests/unit/` diagnostics suites |
| Startup marker | One marker, unchanged exit code and fail-fast timing, send at most once, always delete | `tests/unit/electron/`, `tests/e2e/electron/` |
| Nitro | Synthetic 500 and explicit codes arrive once with no request-derived data | `tests/unit/server/` |
| Source maps | Debug endpoint and canaries show original file, function, line, release, and dist | release workflow canary step |
| Build identity | Desktop receipt inputs match injected package bytes; the viewer's private manifest matches local and served prebuilt bytes | `tests/unit/scripts/`, release workflow |
| Public artifacts | No map, source, staging directory, token, or wrong-runtime DSN ships | `scripts/check-web-deploy-assets.mjs`, `scripts/release/assert-packaged-app-contents.mjs` (existing) |
| Account | Evidence of AI off, the Google-login decision and provider limitations, restricted roles, enhanced privacy, scrubbing, IP prevention, source fetching off, retention, no pay-as-you-go | SEN-EXT issues |
| Shutdown | Preservation and log flush deadlines unchanged; Sentry never delays recovery relaunch or system shutdown | `tests/unit/electron/`, `tests/e2e/electron/` |
| Acknowledgement | Both landing footers and the app page render localized local assets offline with no Sentry request before a click | `tests/unit/landing/`, `tests/unit/app/` |
| Deletion | Removing the Sentry packages and adapters leaves local logs, error UI, recovery, save, print, and update intact | a documented removal rehearsal recorded in SEN-OPS-02 |

### Platform acceptance

The desktop canary covers all eight shipping artifact identities:
`macos-arm64`, `macos-x64`, `windows-x64`, `windows-arm64`, `linux-x64`,
`linux-arm64`, `store-appx-x64`, and `store-appx-arm64`. For each artifact the
acceptance set is zero requests under
unknown and denied; exactly one envelope with one event item on grant;
symbolicated main, renderer, and worker canaries; the startup marker path across
a real crash and relaunch; unchanged update, relaunch, recovery, and shutdown
behavior; and a packaged-artifact scan with no web DSN, no web ingest host, and
no map. A platform that cannot safely initialize the selected client ships with
diagnostics disabled and a credential-free exception recorded for that dist.

`win7-legacy-x64` is a recognized experimental identity, not a shipping
artifact. Electron 22 cannot load the current ESM main entry, its packaged
smoke fails before startup, and publication workflows do not attach it. The
runbook records this as a non-shipping exception while #335 remains open.

Windows arm64 and macOS x64 arrive through the supplemental workflow, which
reuses already attached assets on a no-change re-dispatch. Their acceptance is
recorded against the run that first attached the asset. If a missing or partial
asset pair is rebuilt, that new build gets a fresh manifest, upload, and canary.
The Store x64 and arm64 packages are separate builds and never inherit the map
proof of the ordinary Windows packages.

### Observability health counters

Each runtime writes a local health snapshot containing only: mode,
initialization count, attempted, accepted, duplicate, burst-suppressed,
policy-dropped, schema-dropped, frameless-dropped, owned-projection,
transport-failed, and last drop reason. It contains no event values and never
goes to Sentry. Tests assert that every drop path increments exactly one counter
and that the snapshot serializer cannot emit any other key.

## Implementation boundaries

These are the rules that keep the design from eroding during implementation.
Each has an enforcing gate.

| Boundary | Rule | Enforced by |
| --- | --- | --- |
| No broad SDK import | Only `electron/features/diagnostics/sentryNodeAdapter.ts`, `app/utils/browserDiagnosticsTransport.ts`, and `server/utils/sentryNitroAdapter.ts` may import a Sentry SDK, read a DSN, call a capture API, or construct a Sentry event | SEN-GATE-02 |
| No raw payload capture | The remote plane is built from a closed record; no code path may pass a raw `Error`, console argument, log line, UI string, or arbitrary object toward a transport | SEN-GATE-03, SEN-CORE-02 |
| No duplicate ownership | A presenter accepts a receipt and never captures; a logger call that receives a receipt creates no second occurrence; a main-owned failure presented in a renderer reuses `failureRef` | SEN-GATE-01, SEN-MIG-06 |
| No runner-to-Sentry path | Development runner stdout, stderr, page diagnostics, session records, and local log files are never read by an adapter; scripts cannot import a client SDK, while only the two exact release tools may invoke the pinned CLI for injection or upload and the exact verifier may query the read-only API | SEN-GATE-02 |
| No child SDK | Workers, utility processes, preload, and the renderer initialize no Sentry client | SEN-GATE-02, SEN-CORE-09 |
| No persistence | No offline queue, no persisted event, no transport-level retry store; the single startup marker is the only persisted record and is deleted unconditionally | SEN-CON-03, SEN-SDK-02 |
| No behavior change | Sentry never alters startup, editing, save, print, update, recovery, relaunch, or shutdown behavior or deadlines | SEN-CAN-01 |
| No second error system | New surfaces extend the failure occurrence rather than adding a parallel reporting path | Review of each work item against the design rules in `CLAUDE.md` |

## Issue-ready acceptance criteria

The first GitHub issue was the self-contained delivery umbrella for the 64 work
items. Its approved delivery scope is now closed for the consent-gated desktop
and hosted-browser diagnostics. Nitro approval and activation remain in
[#222](https://github.com/evb0110/evb-viewer/issues/222) and
[#261](https://github.com/evb0110/evb-viewer/issues/261). Real dated observation
and the four-week record remain in
[#267](https://github.com/evb0110/evb-viewer/issues/267). Those follow-ups are
not delivery criteria and remain open.

A work item may later become a child issue when it is scheduled. The umbrella
and every child issue must state:

1. The problem in observable terms, including the current behavior at the named
   paths.
2. The required behavior, quoting the fixed decision it implements.
3. The exact paths it may touch and the paths it must not touch.
4. The tests it must add or extend, by suite location.
5. The exit evidence that closes it, in a form a reader can verify from the
   repository and from CI.
6. Its dependencies by work item ID, and the phase it belongs to.
7. Exactly one difficulty label from `easy`, `medium`, `hard`, or `x-hard`, per
   the estimate recorded in this ledger.

An issue is not ready while it still contains an unresolved design question, a
reference to a file a GitHub reader cannot open, or an exit criterion that
depends on a Sentry project that does not exist yet.

## Definition of done

The closed delivery program is done when the consent-gated desktop and
hosted-browser requirements below hold. This definition does not include Nitro
activation or elapsed operating proof. Those continuing requirements remain in
[#222](https://github.com/evb0110/evb-viewer/issues/222),
[#261](https://github.com/evb0110/evb-viewer/issues/261), and
[#267](https://github.com/evb0110/evb-viewer/issues/267).

- Every red UI state and every red console entry in shipping code enters the
  local failure gate, and both the red-presentation and unclassified-code
  migration reports are zero.
- Every reportable occurrence has one Error ID and one owner, and one logical
  failure creates at most one Sentry event with bounded repeat accounting.
- Every accepted event has a known code and schema, and no accepted event
  contains a forbidden sentinel.
- Every event with application frames is symbolicated against privately uploaded
  maps, with matching Debug IDs.
- Expected outcomes create no red UI, no red console entry, and no event.
- Unknown and denied client preferences produce zero diagnostic network
  activity, and revocation produces no close-time or client-report envelope.
- The acknowledgement renders in both landing footer paths and the app page, in
  every supported locale, offline, with no Sentry request before a click.
- Account hardening, the DPA, and the consent notice are complete and
  recorded. The viewer Nitro assessment is a retained follow-up, not a client
  delivery criterion.
- Public packages and deployments contain no maps, sources, staging directories,
  tokens, or wrong-runtime DSNs, and receipts match the shipped bytes.
- Removing the Sentry packages and adapters leaves local logs, error UI,
  recovery, save, print, update, and product behavior intact.

The continuing Nitro and observation definitions remain in the runbook and in
[#222](https://github.com/evb0110/evb-viewer/issues/222),
[#261](https://github.com/evb0110/evb-viewer/issues/261), and
[#267](https://github.com/evb0110/evb-viewer/issues/267). Their elapsed-time
requirements are not claimed by this delivery definition.

## Decision register

Fixed decisions are recorded so an implementer can cite them and so a later
reviewer can see they were not reopened here. The binding-audit column marks the
decisions the architecture audit fixed before this implementation pass.

| ID | Decision | Binding audit | Consequence in this plan |
| --- | --- | --- | --- |
| D-01 | Errors and crashes only, no analytics, AI, replay, tracing, profiles, logs, sessions, feedback, attachments, or minidumps | yes | SEN-SDK-02, SEN-SDK-03, SEN-GATE-03 |
| D-02 | Typed failure occurrence is the target model, logger edge is temporary, red-requires-receipt is the final invariant | yes | SEN-CORE-*, SEN-MIG-*, SEN-OPS-03 |
| D-03 | Electron and hosted-browser clients are opt-in in the first release | yes | SEN-CON-04, SEN-CON-05 |
| D-04 | Viewer Nitro may be default-on with opt-out only after the legal and account gates | yes | SEN-EXT-04, SEN-SRV-03 |
| D-05 | Two projects only, landing stays local-only | yes | SEN-MIG-11, SEN-SDK-04 |
| D-06 | Electron main uses a Node-family client with no default integrations, no OpenTelemetry setup, no client reports, and no persistent transport | yes | SEN-SDK-02 |
| D-07 | Renderer and preload contain no Sentry SDK; records cross a typed IPC channel | yes | SEN-CORE-08, SEN-CORE-09 |
| D-08 | A frameless console error is counted locally and dropped remotely | yes | SEN-MIG-04 |
| D-09 | Burst aggregation only after every occurrence enters the local gate, with preserved code and frame identity and a clamped count | yes | SEN-CORE-04 |
| D-10 | Hosted browser sends directly to the exact Sentry EU ingest origin, no same-origin proxy | yes | SEN-SDK-03 |
| D-11 | One consent-gated startup crash marker, no queue, no weakening of fail-fast | yes | SEN-CON-03 |
| D-12 | Development and automation logs stay local; static boundaries cover scripts and runners | yes | SEN-GATE-02 |
| D-13 | Main IPC responses carry failure references; child reporters stay local; inherited console output uses a suppression scope | yes | SEN-MIG-06, SEN-MIG-09, SEN-MIG-03 |
| D-14 | Every Sentry-owning runtime disables client-report envelopes | yes | SEN-CON-07 |
| D-15 | 90-day platform retention with weekly deletion of resolved issues | yes | SEN-EXT-03, SEN-OPS-02 |
| D-16 | Private source maps with Debug IDs injected before receipts, staged before pruning, and deployed as exact built output | yes | SEN-MAP-01 through SEN-MAP-06 |
| D-17 | Acknowledgement is independent of telemetry and bundled locally | yes | SEN-ACK-01 through SEN-ACK-04 |

Decisions this ledger makes, which are sequencing choices rather than
architecture changes:

| ID | Choice | Reason |
| --- | --- | --- |
| S-01 | The diagnostics contracts and canonical frame parser live in a new `packages/contracts/diagnostics/` directory rather than in `app/` or `electron/` | Every runtime needs the same closed, pure implementation without importing another runtime root |
| S-02 | The main diagnostics code lives in `electron/features/diagnostics/` with a public entrypoint | It matches the existing Electron feature boundary that the architecture check enforces |
| S-03 | A startup policy hint reaches preload through `additionalArguments`, but Electron main remains the sole live consent gate | The existing encoded-argument mechanism is suitable for UI state, while mutable grant and revocation cannot depend on an immutable preload snapshot |
| S-04 | Private map injection and staging run after final transforms and before the existing prune and receipt steps | `pnpm run build` prunes maps immediately after `nuxi build`, and Debug ID injection changes public JavaScript bytes |
| S-05 | Acknowledgement work is a parallel Phase 0 track | It has no dependency on the failure core and no dependency on a Sentry project |
| S-06 | Migration work lands as a few coherent commits per family rather than per call site | Every push to `main` now runs a full hosted CI lane |

## Risk register

| Risk | Impact | Mitigation | Owning item |
| --- | --- | --- | --- |
| A pinned Node client still registers process handlers or global patches despite the disabled defaults | Sentry would silently own process seams the architecture assigns to main | Prove it at pin time; fall back to the core server runtime client with a hand-built transport | SEN-SDK-02 |
| A shared frame parser or reporter imports a runtime logger and creates a cycle | Initialization can observe a partial logger or recurse before the raw sink exists | Keep contracts and frame parsing pure under `packages/contracts/diagnostics/`; inject local sinks into reporters and add import-cycle fixtures | SEN-CORE-04, SEN-CORE-05, SEN-CORE-07 |
| The renderer has no Sentry SDK, so browser Debug ID metadata may be unreadable at capture time | Renderer frames could arrive unsymbolicated | Resolve during the spike; if metadata cannot be read safely, main supplies the mapping from the release manifest | SEN-MAP-04 |
| Debug ID injection changes bytes after the current receipt point | Receipts and shipped bytes would diverge and the release gate would fail late | Order enforced by test in SEN-MAP-03 | SEN-MAP-03 |
| The viewer deploy currently uploads source and lets Vercel build | Vercel could build different JavaScript after maps were uploaded, breaking symbolication silently | Move the diagnostics-enabled viewer to a prebuilt deployment with a hash parity test | SEN-MAP-05 |
| Supplemental assets are reused on re-dispatch and builds are not byte reproducible | A supplemental artifact could ship with no uploaded maps and no way to add them later | Upload in the first attaching run; otherwise ship that artifact with diagnostics disabled and record it | SEN-MAP-04 |
| The logger fallback makes existing severity misuse into telemetry | Noise and possible expected-outcome events | Reclassification lands in the same phase as the fallback, and the migration report tracks the remaining sites | SEN-MIG-12, SEN-OPS-03 |
| Three `did-fail-load` registrations plus bootstrap rejection can produce several occurrences for one fault | Duplicate events for the most common startup failure | One consolidated owner with an occurrence-count test per scenario | SEN-MIG-07 |
| The console observer could capture an EVB-shipped vendored bundle frame and mistake a third-party fault for an EVB one | Misattributed grouping | Frame policy is explicit: EVB-shipped bundles count, everything else drops and increments the counter | SEN-MIG-04 |
| Consent prompt could be perceived as a dark pattern if it interrupts work | Product and legal risk | Non-blocking, positive control, dismissal is a real option that leaves the preference unknown | SEN-CON-05 |
| Store distribution requires express in-product permission before publishing personal information | Policy violation if a Store build ever defaults on | Client default is off in every build, and the Store upload runbook records the requirement | SEN-CON-04, SEN-EXT-03 |
| Weekly deletion of resolved issues is a manual step | Retention promise in the notice could drift from practice | The weekly runbook includes the deletion step and records the date | SEN-OPS-02 |
| A privacy incident could be treated as a useful detail | Erosion of the whole contract | Any forbidden field is an incident with a defined response and a sentinel regression | SEN-GATE-03, SEN-OPS-02 |

### Package-specific proof disposition

The implementation spike resolved the package and lifecycle questions without
changing the architecture.

1. Compatible browser, Node, core, and CLI versions are pinned in the lockfile.
2. Node-client construction disables default integrations, process ownership,
   client reports, and persistence; lifecycle tests cover the resulting client.
3. Canonical frame parsing lives in shared contracts and emits only closed
   frame values.
4. Browser Debug ID metadata comes from the injected build identity and private
   manifest rather than a renderer SDK.
5. Consent and revocation tests prove no pre-consent queue, one event item for
   the live granted occurrence, and no client-report or close-time flush.
6. Nitro registration tests prove one owner in normal and prebuilt output.
7. Platform retention and the first weekly deletion remain live-control proof
   for SEN-EXT-03 and SEN-OPS-02.
8. Preference-reader and startup-marker tests cover missing, corrupt, partial,
   and newer settings, marker deletion, and unchanged fatal timing.
9. Window-load ownership tests carry one receipt through the competing failure
   seams without hiding a distinct second failure.
10. Debug ID injection and private staging run after transforms and before public
    map pruning and final-byte receipts; build tests verify the order.
11. The exact prebuilt viewer path and local parity checks are implemented. Live
    served-byte parity remains part of the hosted-browser canary.

## Review ledger

Two independent read-only architecture audits reviewed the completed draft on
2026-09-01. Both returned `APPROVE WITH REQUIRED CHANGES`. The author session
did not audit its own work. This revision applies every required change that
survived repository verification.

| Audit | Date | Verdict | Required changes | Applied |
| --- | --- | --- | --- | --- |
| Independent audit A | 2026-09-01 | Approve with required changes | Make Electron main the mutable gate; disarm the startup marker after adapter initialization; limit CLI exceptions; move the frame parser into shared contracts; cover preload references, main-thread logger ownership, Nitro, five browser worker parents, shared privacy copy, all artifact identities, and phase-consistent canaries | Yes |
| Independent audit B | 2026-09-01 | Approve with required changes | Add account project and credential ownership; correct receipt inputs and Vercel parity; deploy prebuilt output before upload; keep external evidence credential-free and tracked; protect Electron CSP; name map flags and workflows; cover Store and supplemental builds; add objection and no-client-report proofs | Yes |
| Final Fable implementation audit | 2026-09-03 | Approve with required changes | Preserve worker-parent records over IPC; consume startup markers at next-launch install; allow zero-credential production builds; trust the actual hosted viewer and Nitro bundle paths; reconcile durable settings into main; remove ref-free main ERROR projection; make Electron main the sole mutable gate; bake Nitro configuration and require an upload receipt; close build and worker initialization fallbacks; correct stale ledger claims | Yes |

Audit scope for both passes:

- Whether any work item reopens or contradicts a fixed architecture decision.
- Whether the dependency graph is acyclic and whether any item depends on a
  later phase.
- Whether the file and owner map matches the repository at the inspected commit.
- Whether any migration family is missing an owner or has two owners.
- Whether the boundaries and gates would actually catch a broad SDK import, a raw
  payload capture, a duplicate occurrence, or a runner-to-Sentry path.
- Whether the source-map, receipt, deployment, and supplemental-asset sequencing
  is correct given that builds are not byte reproducible.
- Whether the consent, revocation, and startup-marker items are provable as
  written.

### Maintainer verification

The integrated ledger has 64 unique work item IDs. Each appears once, every
dependency names an existing item, no dependency points to a later phase, and
the graph is acyclic. Repository checks confirmed the current receipt inputs,
all three disabled Nuxt source-map controls, the lack of `--prebuilt`, the nine
shipping artifact identities, the two privacy page implementations, the five
browser worker parents, the three load-failure registrations, and every exact
path added by the audits. The final issue links only tracked repository files
and contains no credential, private account path, local filesystem path, or
model attribution.

### Current implementation review

The integration worktree was re-audited after the settings merge. Every
renderer and Electron error logger owner is classified, expected working-copy
refusals are warnings, both unclassified migration reports are zero, and the
temporary logger and presenter overloads are removed. The one authorized final
Fable pass returned `APPROVE WITH REQUIRED CHANGES`. All four high, five medium,
and four low findings were checked against the repository and applied before
publication. The corrections cover IPC runtime admission, startup-marker disk
lifetime, zero-credential release behavior, hosted and Nitro frame recognition,
settings reconciliation, mandatory main ERROR receipts, Electron gate ownership,
immutable Nitro configuration, upload-receipt admission, non-diagnostics build
defines, BrowserLogger fallback ownership, singleton worker reporters, completed
identity-lock rollover, and the stale text corrected in this ledger.
