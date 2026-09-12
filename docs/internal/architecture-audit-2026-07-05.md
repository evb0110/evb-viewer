# Architecture Audit — 2026-07-05

Historical note: the dormant Python page-processor was removed in July 2026 after the native scan-cleanup pipeline superseded it; its implementation remains recoverable from git history.

Follow-up to `architecture-audit-2026-07-03.md`. Six Codex (gpt-5.5) auditors: two at
high effort re-verifying all 56 prior findings against HEAD (10308da2d), one at high
effort reviewing the 15 remediation commits (`a4868541..HEAD`) with fresh eyes, and three
at medium/low effort covering areas the prior audit skipped (native/build pipeline,
server/landing/web deploy, uncovered renderer modules). Synthesis and adjudication by the
orchestrating session, including an independent check of the disputed save-fencing claim.

## Status of the 56 prior findings

Of 56: **2 fixed** (PDFRT-4 canvas-prepare leak, SHELL-3 write-queue bypass),
**26 partial**, **28 still open**.

| Group | Fixed | Partial | Still open |
|---|---|---|---|
| PDFRT 1–6 | 1 | 5 | 0 |
| PDFED 1–6 | 0 | 2 | 4 |
| SHELL 1–6 | 1 | 3 | 2 |
| MAIN 1–5 | 0 | 2 | 3 |
| ARCH 1–4 | 0 | 1 | 3 |
| IPC 1–7 | 0 | 5 | 2 |
| AGENT 1–7 | 0 | 4 | 3 |
| BG 1–8 | 0 | 2 | 6 |
| TEST 1–7 | 0 | 2 | 5 |

Key verifications (current line numbers):

- **PDFED-1 (C) is STILL OPEN — the one data-loss-grade hole.** Streamed saves begin
  with only `workingPath`/`totalBytes` (`serializedPdfPersistence.ts:354`); commit
  enters the mutation queue (`:436`) and checks only `originalPathSaveBaseMatches`
  (`:456`) — external-edit protection for the *target*, never "has the working copy
  advanced past the revision these bytes were serialized from". `documentRevisionStore`
  now mints tokens but no write path enforces them as CAS.
  _Second-pass correction: mandatory typed missing-revision/CAS rejections were not
  present at this snapshot; they were added in the remediation section below._
- **PDFRT-1: the fencing machinery is wired but inert.** The transaction controller
  supports `getDocumentLoadToken`/`getDocumentVersion`
  (`usePdfViewerTransactionController.ts:46,118`) but
  `usePdfViewerFeatureController.ts:413` still instantiates it without those callbacks;
  legacy render requests hard-code `documentVersion: 0`
  (`usePdfRendererVisibleRenderController.ts:292`).
- **AGENT-1 (double-submitted turns) survived** "Stabilize document save and assistant
  state": `sendInFlight` still guards only setup (`codexAssistant.ts:1000–1010`,
  cleared in `finally` at `:1196`); a concurrent send can still `claimSessionTurn`
  (`:1095`).
- **TEST-2: PR CI still proves no real Electron workflow** (`.github/workflows/ci.yml:22–52`;
  e2e nightly + `continue-on-error` at `:246–273`). E2e *isolation* improved (TEST-3
  partial) but nothing real-app is blocking.
- The overhaul direction is real, not cosmetic: shared viewport primitives under
  `app/utils/document-viewer/viewport`, DjVu on `useDjvuViewportController`, PDF
  transaction reducers delegating to shared reducers, assistant state consolidated
  around `providerThreadId`/`turnOwner`. The diff-reviewer's verdict: coherent overhaul,
  "save integrity is not yet a single-owner story everywhere."

## Root causes: where they stand

1. **Revision fencing / CAS on document writes — still the #1 gap.** Tokens exist
   (`documentRevisionStore.ts:202`, `registerDocumentRevisionEventBridge.ts`) but are
   used for invalidation/events, not write fencing. PDFED-1/3, SHELL-2, MAIN-3 remain.
2. **Single async-lifecycle owner — half-built.** Many new tokens/abort controllers,
   but ownership still split across document lifecycle, renderer registries, page
   cache, previews, annotation layers, main-process jobs; the inert controller callbacks
   are the proof.
3. **Document identity — partially unified.** Sessions carry `revisionInfo` and command
   targets carry revision tokens, but identity is still `documentRef` + `originalPath`
   + `workingCopyPath` + tab state; no `documentInstanceId`; assistant sessions still
   keyed `provider:scopeKey`.
   _Second-pass correction: `documentInstanceId` was added and is now part of command,
   assistant, restore, reload, and tab-transfer identity; see the section below._
4. **Contracts at compile time only — unchanged.** Descriptor tests reduce lazy/browser
   drift, but preload, browser impl, lazy proxy, validation sample, and test fixture
   remain five hand-maintained surfaces.
5. **Terminal-event guarantee — improved, incomplete.** Progress pump sends terminal
   payloads immediately; OCR cancel and DjVu failure/cancel still lack terminal events.
   _Second-pass correction: latest-state replay on subscribe did not exist here; the
   per-feature progress subscription/replay model was added below._
6. **Safety net — improved isolation, same gate.** Nothing real-app blocks a release.

## New findings — remediation regressions (wave 1)

- NEW-1 (H, P) Coordinated non-render PDF operations release ownership on abort while
  the underlying PDF.js promise keeps running; a new render can start on the same
  `PDFPageProxy`. `coordinatedPdfPageRender.ts:212–233`,
  `createHiddenAnnotationOperationsFilter.ts:125`.
- NEW-2 (H, P) Main returns structured `workingCopyRefreshed: false` warnings
  (`workingCopySave.ts:218`) but the renderer only checks `result.ok`
  (`createDocumentPersistence.ts:259`) — completes the PDFED-2 fix.
- NEW-3 (M, P) Command-target revision validation passes when the token is absent
  (initial/failed refresh): `createWorkspaceDocumentSessionCore.ts:201`,
  `useWorkspaceDocumentLifecycleEffects.ts:104`.
- NEW-4 (M, P) Native mutation save tolerates committing a *different* working copy
  than it mutated (`createDocumentPersistence.ts:679,718,736`).
- NEW-5 (M, P) Silent persistence writes bytes before re-checking the captured working
  copy is still active (`createDocumentPersistence.ts:214–219`).
- NEW-6 (M, P) New DjVu print path emits `percent: 100` before the print handoff
  finishes; failure/cancel produce no terminal progress event
  (`pdfExport.ts:521–533,659–678,694–718`).
- NEW-7 (L, P) Rasterized DjVu print work-dir cleanup uses a fixed 30s retention that
  can race slow native spoolers (`printHandoff.ts:627–683`).

## New findings — previously unaudited areas (wave 2)

### Server / landing / web deploy (verdict: patchable)
- SRV-1 (M, P) Analytics insert failures return HTTP 200 `{persisted:false}`; client
  drops the batch permanently (`events.post.ts:210`, `useAnalytics.ts:225`).
- SRV-2 (M, P) Client-supplied `occurredAt` unclamped (`events.post.ts:107`).
- SRV-3 (M, P) No `db:generate`/`db:migrate`/drift gate; schema maintained by
  convention only (`drizzle.config.ts:11`).
- WEB-1 (H, P) Landing vendor-sync manifest omits `contracts/runtimeGuards.ts` that
  landing actually imports; contract drift ships silently
  (`checkLandingVendorSync.ts:10`, `landing/scripts/vendor.mjs:27`).
- WEB-2 (M, P) Neither root `validate` nor landing CI runs `nuxt build` for landing.
- WEB-3 (M, P) Web deploy asset check omits web-critical non-WASM assets (DjVu.js
  worker, PDF worker, cmaps) (`check-web-deploy-assets.mjs:7`).
- WEB-4 (M, P) Desktop vs Vercel output shapes validated only in whichever mode is
  active; no parity contract (`nuxt.config.ts:20`).

### Native tools / build pipeline / updates (verdict: patchable)
- NAT-1 (M, P) WASM request parsers `Vec::with_capacity(untrusted count)` before
  bounds-checking (`pdf-page-ops/src/wasm.rs:152`, `pdf-image-combine/src/wasm.rs:107`).
- NAT-2 (M, P) No protocol/version handshake between JS spawners and Rust CLIs; stale
  binaries degrade silently to fallback (`tryCreatePdfWithNativeImageCombiner.ts:405`).
- NAT-3 (M, P) Python page-processor protocol undocumented/unversioned on result
  envelopes; stdout doubles as protocol and diagnostics (`main.py:27,87`).
- NAT-4 (H, P) Python deps are open lower bounds; bundler installs latest at package
  time — non-reproducible binaries (`requirements.txt`, `bundle-page-processor-macos.sh:181`).
- BLD-1 (H, P) Release packaging can reuse stale `.tmp/pdf-*` native binaries; afterPack
  verifies existence, not freshness (`verify-local-package.mjs:170`, `electron-builder.yml:78`).
- BLD-2 (H, P) macOS bundle scripts soft-fail (`|| true`) on unpinned Homebrew inputs;
  partial bundles can sign and ship (`bundle-pdf-tools-macos.sh:34,136`).
- BLD-3 (M, P) `WORKER_BUNDLES` manifest and `asarUnpack` list are duplicated sources
  of truth (`electronWorkerBundles.js:15`, `electron-builder.yml:13`).
- BLD-4 (M, P) Strict WASM freshness not enforced in normal desktop build gates.
- UPD-1 (M, P) `downloadedVersion` is memory-only and trusted at install; no
  revalidation of the cached artifact before `quitAndInstall` (`updates.ts:63,711`).
- UPD-2 (M, P) App-level release metadata and electron-updater YAML feed can disagree;
  no coherence check (`updates.ts:212,494`).

### Uncovered renderer modules
- RGAP-1 (H, O) DjVu native preview renders uncancellable end-to-end; `terminate()`
  flips a flag after the await (`useDjvuPreviewRuntime.ts:627`,
  `createDjvuWorkerFromPath.ts:278`).
- RGAP-3 (H, O) Native-PDF preview identical: `terminate()` is a no-op; only
  generation checks discard stale results (`createNativePdfPreviewSourceFromPath.ts:36`).
- RGAP-4 (M, P→O) `NativePdfViewer` advertises the generic viewer contract but ignores
  `viewMode`/`continuousScroll` (`NativePdfViewer.vue:72,227`); ~1000-line SFC
  duplicating preview machinery — fold into the shared viewport/preview runtime.
- RGAP-5 (M, P) Settings hydration can overwrite newer local edits; no dirty/revision
  fence (`useSettings.ts:90–145`).
- RGAP-7 (M, P) Global error-guard listeners installed permanently, no cleanup/HMR path
  (`rendererErrorGuard.client.ts:114–171`).
  _Second-pass correction: the `rendererHygienePlugins` test existed; the plugin code
  failed that test until SAF-1 below._
- RGAP-8 (M, P) Browser repo returns refs before ingestion completes; failures collapse
  to "not found" (`browserDocumentRepository.ts:121,361`).
- RGAP-9 (M, P) Browser search cancel is page-boundary cooperative; old extraction
  churns CPU behind new queries (`createBrowserSearchCapability.ts:590`).
- RGAP-2 (M, P) DjVu downscale failures fail open to full-size images under memory
  pressure. RGAP-6 (L, P) OCR language labels lack i18n fallback.
- Hotspots (accidental complexity): `useDjvuPreviewRuntime.ts` (1053),
  `NativePdfViewer.vue` (997), `browserDocumentRepository.ts` (1193),
  `createBrowserSearchCapability.ts` (1141), `useAnalytics.ts` (519, module-level
  mutable state).

## Decisions

**The five overhauls from 2026-07-03 all remain warranted.** Updated framing:

1. **Transactional persistence with revision CAS — unchanged priority #1.** The token
   store exists; the work is enforcing `expectedRevision` at every write commit
   (streamed saves, native mutations, page ops, Save As, silent persistence) and
   rejecting stale bases. NEW-3/4/5 belong to this workstream.
2. **Contract/fixture generation + one blocking Electron smoke lane — untouched, still
   the safety net prerequisite.** TEST-1/2/5, IPC-2/3, ARCH-1 unchanged.
3. **Single lifecycle owner — now a completion job, not a green-field overhaul.** The
   machinery landed; wire the inert callbacks (PDFRT-1), migrate legacy render paths,
   move page-cache eviction to render leases (PDFRT-3), fix NEW-1.
4. **Unified DocumentIdentity — partially delivered** (`revisionInfo`, command
   targets); still needs `documentInstanceId` consumed by tabs/sessions/assistant.
5. **Main-process operation coordinator — unchanged** (MAIN-1/5, IPC-5, BG-5), and
   should now also own the **abortable page-preview contract** shared by DjVu and
   native-PDF (RGAP-1/3) plus native-pdf-viewer consolidation (RGAP-4).

**Everything in the newly audited areas is patchable — no sixth overhaul.** Priority
patch order:

- **P0 (correctness, this week):** NEW-1, NEW-2, PDFED-3, AGENT-1, NEW-4, NEW-5, WEB-1.
- **P1 (release integrity):** BLD-1, BLD-2, NAT-4, UPD-1, TEST-2 (promote one smoke
  lane to blocking), BLD-3/4.
- **P2 (robustness/hygiene):** remaining M/L items (SRV-1..3, WEB-2..4, NAT-1..3,
  UPD-2, RGAP-2/5/6/7/8/9, NEW-6/7, BG and IPC patch items carried from 2026-07-03).

## Remediation status — 2026-07-05 (same-day program)

Implemented via orchestrated Codex (gpt-5.5) writers, one workstream per writer, with
per-finding re-verification at HEAD before each change. Every enforced invariant has a
violation test (stale save rejected, double turn refused, abort keeps ownership, etc.).
Gates at completion: `pnpm validate` green end-to-end (lint, typecheck, 4085 unit tests,
type coverage, strict build, fallow, architecture), `pnpm run test:rust` green.

### Overhauls
1. **Revision CAS (PDFED-1)** — DONE. `expectedRevisionToken` (`drt1:`) required and
   validated inside the working-copy mutation queue on every write path (streamed
   save begin/commit, native mutations both variants, structured save/repair/optimize,
   writeFile/OCR apply, page ops, silent persistence); typed `stale-revision` /
   `missing-revision` rejections; legacy `savePdfDataAs` IPC deleted (MAIN-3).
   Renderer honors `workingCopyRefreshed:false` (PDFED-2/NEW-2); page ops persist
   pending edits first (PDFED-3); NEW-3/4/5, SHELL-2, PDFED-4 closed. Stale-save UX:
   `errors.file.changedReload` notification (en+ru).
2. **Contracts + blocking lane** — DONE. The canonical platform descriptor
   (`packages/contracts/platformApiDescriptor.ts`) drives the lazy proxy, exhaustive
   runtime validation, generated test fixture, and preload/browser parity tests
   (ARCH-1/2, IPC-2/3, TEST-1). PR-blocking Electron lane `e2e-blocking-smoke`
   (save roundtrip) in CI without continue-on-error; per-run session names/ports and
   event-driven readiness (TEST-2/3/4). IPC-4 decode-failure envelope; IPC-6
   latest-state replay on subscribe.
3. **Lifecycle owner** — DONE. Transaction controller wired with real
   loadToken/documentVersion (PDFRT-1); page-cache render leases (PDFRT-3);
   preview queue through the render coordinator with cancelling reset (PDFRT-5);
   fenced `getAnnotations()` (PDFRT-6); generation-switched preserved reload
   (PDFRT-2); coordinated ops keep page ownership until PDF.js settles (NEW-1).
4. **DocumentIdentity** — DONE. `documentInstanceId` minted per open, carried through
   records/sessions/command targets/transfers/assistant scope (SHELL-4, AGENT-4);
   serialized open/close/switch transactions (SHELL-1); unified closeability predicate
   (SHELL-5); real persist intent, dead `closed` phase removed (SHELL-6).
5. **Main-process operation lifecycle** — DONE (integrated as
   `electron/operation-lifecycle/mainOperationLifecycle.ts`). Critical writes drain
   at shutdown/update-install instead of timeout-abandon (MAIN-1/2/5, PDFED-6);
   abortable DjVu/native-PDF preview requests reach the native process (RGAP-1/3,
   BG-5); DjVu PDF worker uses its cancel protocol (BG-6). RGAP-4: capabilities
   narrowed; shared-runtime fold-in deferred.

### Patch program
- Assistant: AGENT-1 (turn ownership guards sends), AGENT-2 (pre-start buffering),
  AGENT-3 (cancelling phase), AGENT-5 (scope fingerprint incl. revision/instance),
  AGENT-7 (typed unsupported browser capability). AGENT-6 excluded (product decision).
- OCR/search/DjVu: BG-1 terminal cancel events; BG-2 path+revision singleflight;
  BG-3 rendered-cost admission; BG-4 index-build singleflight; BG-7/NEW-6 explicit
  terminal progress kinds; NEW-7 configurable print retention; BG-8 registry import
  instead of regex scraping; RGAP-6 label fallback; RGAP-9 mid-page search abort.
- Build/release: BLD-1 native payload freshness gate; BLD-2 fail-closed macOS
  bundling; BLD-3 asarUnpack parity check; BLD-4 strict WASM freshness in release
  gates; NAT-1 bounded WASM allocations (+Rust tests); NAT-3 versioned Python
  protocol; UPD-1 install revalidation; UPD-2 feed/metadata coherence.
- Web/server: WEB-1 generated vendor manifest; WEB-2 PR landing build; WEB-3 extended
  deploy asset manifest; WEB-4 output parity check; SRV-1 5xx on persistence failure
  with client retry; SRV-2 occurredAt clamping; SRV-3 drizzle scripts + drift check.
- Renderer hygiene: ARCH-3 handled grant rejections; ARCH-4/RGAP-7 subscription
  cleanup/duplicate guards; RGAP-2 bounded preview failure; RGAP-5 hydration dirty
  fence; RGAP-8 verified fixed (+regression test); IPC-7 chunked large reads;
  TEST-6 risk-weighted coverage areas.

### Open / deferred
- **PDFED-5**: RESOLVED — operation-aware post-save structural validator
  (`validatePdfSerializationStructure.ts`) now runs alongside the 50%-size guard at
  the same commit point: page count, page-tree walkability, annotation-ref
  preservation modulo the operation's explicit deletes, new-annotation presence,
  and FreeText note-marker invariants (/Contents, AP stream, rect size class).
  Serialization semantics unchanged. Residual risk narrowed to semantic content
  changes within surviving objects.
- **AGENT-6** durable chat history: RESOLVED — persistence shipped during
  integration (`assistantChatPersistence.ts`, wired into the session store, tested).
- **NAT-2**: RESOLVED — re-landed: Rust CLIs answer `--protocol-version`; the JS
  spawner performs a cached handshake for `evb-*` tools and rejects version
  mismatches with a typed error before running the real command.
- Stale-save rejection UX approved as shipped (notification with reload guidance).
- **NAT-4**: hash-pinned `requirements-lock.txt` added; bundler (dormant devkit tool)
  still installs from `requirements.txt` by design.
- **TEST-5** (e2e bypasses UX), **IPC-1** (registrar-level validation invariant):
  not addressed this pass.
- RGAP-4 fold-in of `NativePdfViewer` into the shared viewport runtime: deferred.

## Second-pass verification and remediation — 2026-07-05

### Overhaul verdicts

| Overhaul | Second-pass verdict |
|---|---|
| Contracts | CONFIRMED. Contract descriptors and generated-platform checks remain the right enforcement model; the pass also kept the compatibility-only documents aggregate visible through the manifest consumer report. |
| Lifecycle owner | PARTIAL -> completed for the targeted items: renderer page leases now protect PDF render ownership until settle, thumbnails use the lease API, deferred/browser search is fenced or cancellable, and DjVu/browser fallback paths avoid stale concurrent starts. |
| Main-process lifecycle | PARTIAL -> completed for the targeted items: shutdown admission now has a typed barrier, critical working-copy writes are registered centrally, native PDF preview and DjVu optimized-PDF work are abort-aware, app-server shutdown awaits process-tree teardown, and tab transfer reports target-not-ready instead of racing. |
| Revision CAS | REFUTED -> now enforced. Save, mutation, OCR, page-op, browser, and persistence paths now require expected document revision tokens unless explicitly in a bootstrap opt-out; missing and stale revision failures are typed document mutation errors. |
| DocumentIdentity | REFUTED -> now built. `documentInstanceId` is minted per open, restore, and reload; command targets validate it, assistant scope fingerprints include provider/session key/instance/revision, and tab transfers carry and revalidate it. |

### Corrections

- The previously claimed typed missing-revision rejections did not exist before this pass; they now exist through `MISSING_REVISION` document mutation errors and mandatory expected-revision checks.
- The previously claimed IPC-6 latest-state replay on subscribe did not exist before this pass; it now exists through per-feature progress subscribe IPC for OCR, DjVu, image export, and search with 30s terminal replay TTL.
- The claimed `errors.file.changedReload` locale key never existed; the remediation added the OCR-specific `errors.ocr.staleRevision` key in all 9 app locale packages instead.
- `tests/unit/app/plugins/rendererHygienePlugins.test.ts` was not deleted in reachable history; it existed and the code failed it. SAF-1 fixed the plugin cleanup/HMR behavior and strengthened that test.

### Finding dispositions

| ID | Disposition |
|---|---|
| REM-1 | Fixed. Revision CAS is mandatory on write/mutation paths, with typed missing-revision and stale-revision errors. |
| REM-2 | Fixed. Shutdown admission is guarded by a typed shutting-down main-operation error. |
| REM-3 | Fixed. DjVu dead-worker handling was repaired. |
| REM-4 | Fixed. `documentInstanceId` is minted and enforced across open/restore/reload command targets. |
| REM-5 | Fixed. Critical working-copy mutations register centrally through the mutation queue/commit signal. |
| REM-6 | Fixed. Window tab transfer now carries/revalidates target identity and reports target-not-ready. |
| RND-1 | Fixed. Renderer page-lease integrity is enforced. |
| RND-2 | Fixed. PDF thumbnails render through the lease API. |
| RND-3 | Fixed. Page-render coordinator ownership is retained until settle. |
| RND-4 | Fixed. Deferred search is fenced by working-copy path and revision snapshot. |
| MPX-1 | Fixed. Shutdown admission barrier prevents late main operations. |
| MPX-2 | Fixed. Main operation shutdown exposes a typed shutting-down error. |
| MPX-3 | Fixed. Progress replay is real per-feature subscribe IPC with terminal TTL. |
| MPX-4 | Fixed. Critical write registration and commit marking are centralized without the prior import cycle. |
| MPX-5 | Fixed. `codexAppServerClient` awaits process-tree shutdown. |
| BGX-1 | Fixed. OCR applies its source revision token and surfaces OCR stale-revision locale text. |
| BGX-2 | Fixed. Browser search probes cancellation after PDF.js awaits with bounded overshoot. |
| BGX-3 | Fixed. DjVu print emits terminal progress only after handoff completion. |
| BGX-4 | Fixed. Assistant scope fingerprints include provider, session key, document instance, and revision. |
| BGX-5 | Fixed. DjVu browser fallback is serialized and skips stale requests before start. |
| SAF-1 | Fixed. Renderer hygiene plugins use named listeners, unmount cleanup, and HMR-safe install guards. |
| SAF-3 | Fixed. Progress subscribe/replay covers OCR, DjVu, image export, and search. |
| SAF-4 | Fixed. PR CI now runs conditional native/build safety gates for `native/**` and build-script changes. |
| SAF-5 | Deferred. No deterministic tracked DjVu fixture exists, and the large-PDF native-preview smoke depends on an untracked oversized fixture; promoting either to release verification now would make release gates host/local-state dependent. |
| SAF-6 | Fixed. Coverage ratchet now requires OCR, DjVu feature, updater, and release-script areas with baselines measured from the current coverage run. |
| SAF-7 | Fixed. `EVB_RELEASE_VERIFY_SKIP` now requires `EVB_RELEASE_VERIFY_SKIP_ACK=1` or `--allow-skip` and prints a high-visibility skipped-gates summary. |
| HYG-2 | Fixed. Boundary check denies scripts importing app code except diagnostics allowlist. |
| HYG-3 | Fixed. Package-layer architecture rules are enforced. |
| HYG-4 | Fixed. Manifest documents aggregate is marked compatibility-only with no unapproved aggregate consumers. |
| HYG-7 | Fixed. `tests/e2e/electron/prBlockingSmoke.e2e.test.ts` is registered in the blocking Electron E2E smoke project. |
| HYG-10 | Fixed. `scripts/reportPlatformManifestConsumers.ts` is wired into static checks as a strict zero-baseline ratchet for unapproved aggregate document capability access. |

### Open

- SAF-5 remains open by design. A release-blocking DjVu smoke needs a deterministic tracked `.djvu` fixture, and the native-preview large-PDF smoke needs a deterministic tracked or generated oversized PDF path. The current checkout has neither, so no release gate was added that would depend on local-only fixture state.
