# EVB Viewer reliability and release-readiness audit

**Audit date:** 2026-08-19

**Audited commit:** `88fab5309fa815e8e89df61a89c909737cea39cb` (`main`)

**Current public release checked:** `v0.1.426` (`b8b7ec73c772490a91903d44975a4897c79ab9cb`, published 2026-08-18)

**Scope:** browser app, Electron main/preload/runtime, PDF/DjVu/OCR/image workflows, persistence and shutdown, landing/download services, security/privacy, tests, CI, packaging, installers, update/release process, and the actual public release artifacts.

## Bottom line

**Recommendation: do not begin broad paid acquisition yet.** The ordinary happy path is substantially tested and passes, but the app is not yet resilient enough for an influx of unfamiliar users and diverse machines. This audit confirmed multiple ways to lose unsaved work, boot-loop the desktop app, publish incompatible installers, exhaust native resources, or show the wrong/unavailable download. Several of these defects are present in the current public release.

The minimum launch bar is to close the P0 list below, rebuild the Linux and Windows artifacts, and make the core Electron journeys release-blocking. The P1 transactional and resource-control work should follow before increasing acquisition materially.

This is a broad, evidence-driven audit, not a proof that no other defect exists. Findings marked **confirmed** follow directly from reachable code, an actual released artifact, live production behavior, or a focused reproduction. Findings marked **risk/gap** describe missing safety controls or coverage where the failure was not reproduced end to end.

## Executive risk register

| ID | Severity | Status | Finding | Shipped in v0.1.426? |
|---|---|---|---|---|
| R-01 | Critical | Confirmed artifact defect | Linux native tools require glibc up to 2.38; common supported-looking distributions cannot run core features | Yes |
| R-02 | High | Confirmed | Browser reload/close/navigation can silently discard dirty edits | Yes |
| R-03 | High | Confirmed | Forced annotation-note save acknowledges failure as success and clears the draft dirty state | Yes |
| R-04 | High | Confirmed | The 20 s global shutdown cap preempts the configured 30 s critical-write drain | Yes |
| R-05 | High | Confirmed | A saved MCP enablement plus port/token failure can boot-loop the Electron app | Yes |
| R-06 | High | Confirmed | A second GPU-process crash calls `app.exit(0)` and bypasses coordinated save/cleanup | Yes |
| R-07 | High | Confirmed/live | ISR/CDN caching defeats release cohorts and can serve one visitor's selected release to others | Yes |
| R-08 | High | Confirmed/live | Arbitrary User-Agent cache variants can amplify GitHub API calls and remove downloads during outage | Yes |
| R-09 | High | Confirmed artifact defect | Public Windows v0.1.426 installers are unsigned and have no normal updater metadata | Yes |
| R-10 | High | Confirmed process defect | Major Electron nightly failures are advisory, so Actions can be green while user journeys are red | Yes |
| R-11 | High | Confirmed | Concurrent identical DjVu jobs share and delete each other's checkpoint artifacts | Yes |
| R-12 | High | Confirmed | DjVu resume can silently reuse pages from a different same-size/same-mtime source revision | Yes |
| R-13 | High | Confirmed gap | DjVu conversion has no aggregate scratch/output disk ceiling | Yes |
| R-14 | High | Confirmed gap | Native image combine can retain roughly several GiB in one default batch | Yes |
| R-15 | High | Confirmed | GitHub release API failure removes every useful download/browse route from the landing page | Yes |
| R-16 | High | Risk/gap | Release can target a matching-version SHA that never passed protected-main exact-SHA CI | Yes |
| R-17 | High | Risk/gap | Final installers are inspected unpacked but never installed, upgraded, launched, or uninstalled | Yes |
| R-18 | High | Risk/gap | Published architecture/legacy packages lack a real application journey | Yes |
| R-19 | High | Risk/gap | Public release promotion happens before optional channels finish, allowing split releases | Yes |
| R-20 | Medium-high | Confirmed race | Disabling the assistant can race startup and still spawn/send after opt-out | Yes |
| R-21 | Medium | Confirmed | A malformed PDF replaces the active valid document before PDF.js accepts it | Yes |
| R-22 | Medium | Confirmed | Failed DjVu activation closes the active PDF before the candidate is validated | Yes |
| R-23 | Medium-high | Confirmed transmission | Browser recent-file names/refs are placed in a 180-day site-wide request cookie | Yes |
| R-24 | Medium | Confirmed | Shared temp/checkpoint namespace permits cross-profile deletion of live, old scratch work | Yes |
| R-25 | Medium | Confirmed race | Image/TIFF export is outside the document lease and lacks cancellation/identity fencing | Yes |
| R-26 | Medium | Confirmed race | Concurrent print runs share global frame/URL state; an old abort can tear down a new run | Yes |
| R-27 | Medium | Confirmed | A transient DjVu.js script failure makes retries hang until the page is reloaded | Yes |
| R-28 | Medium | Confirmed/live | Mobile, ChromeOS, and privacy-redacted UAs can be recommended incompatible installers | Yes |
| R-29 | Medium | Confirmed/live | Public pages lack CSP/frame protection; route overrides also drop other security headers | Yes |
| R-30 | Medium | Confirmed | Multi-file image-export rollback deletes the only backup even if restoration failed | Yes |
| R-31 | Medium | Confirmed | The fifth persistent native search can block the cancel/control plane | Yes |
| R-32 | Medium | Confirmed gap | OCR reads and duplicates an unbounded TSV result | Yes |
| R-33 | Medium | Risk/gap | PDF object/page limits apply only after `lopdf` has materialized the document | Yes |
| R-34 | Medium | Confirmed quality behavior | Low-confidence recognized words are deliberately omitted from searchable OCR text | Yes |
| R-35 | Medium | Confirmed accessibility defect | Annotation-note focus guard temporarily traps focus for about 1.2 s | Yes |
| R-36 | Medium | Risk/gap | Native preview/handoff can wait forever on a wedged page-size request | Yes |
| R-37 | Medium | Confirmed | Renderer crash recovery is a one-shot flag for the lifetime of the window | Yes |
| R-38 | Medium | Confirmed platform defect | Windows `.cmd` Codex discovery is later spawned directly and can fail `CreateProcess` | Yes |
| R-39 | Medium | Confirmed gap | Helper timeouts can settle before the descendant process tree is dead | Yes |
| R-40 | Medium | Confirmed | Ordinary local Linux packaging can omit required `djvudump` | Current source/build path |
| R-41 | Medium | Confirmed/live | Analytics accepts cross-site, non-JSON event submissions and uses spoofable visitor IDs | Yes |
| R-42 | Medium | Risk/gap | No analytics event-retention purge exists in the repository; external operational deletion was not verified | Yes |
| R-43 | Medium | Confirmed | Configured rollback tags outside the first 30 GitHub releases disappear | Yes |
| R-44 | Medium | Risk/gap | Release provenance is incomplete/unsigned and Linux/macOS native inputs float | Yes |
| R-45 | Medium | Confirmed process defect | Packaged smoke records renderer/page errors as warnings instead of failing | Yes |
| R-46 | Medium | Confirmed process defect | Fresh standard lint OOMs on an allowed Node 24 patch at default concurrency | Current source |
| R-47 | Medium | Risk/gap | Vue logic and many changed files can retain zero execution while coverage passes | Current source |
| R-48 | Medium | Risk/gap | Privileged release jobs use mutable action major tags | Yes |
| R-49 | Medium | Risk/gap | Browser end-to-end document lifecycle coverage consists of only two narrow tests | Current source |
| R-50 | Medium | Test gap | OCR has narrow clean-text sentinels but no representative degraded/multilingual CER/WER regression corpus | Current source |

## P0: release blockers before acquisition

### R-01 — Linux release is not portable to common distributions

**Severity:** Critical

**Status:** Confirmed against the actual public `EVB-Viewer-0.1.426-x86_64.AppImage`.

The Linux x64 release builds on floating `ubuntu-latest`, the arm64 release builds on Ubuntu 24.04, and native PDF/OCR/DjVu tools come from the runner's current apt repository (`.github/workflows/build.yml:31-37,126-130`; `scripts/bundle-tools-linux.sh:41-60`). The bundler deliberately excludes libc and related system runtimes (`scripts/bundle-tools-linux.sh:81-103,124-157`).

Dynamic symbol inspection of the downloaded public AppImage found:

- `GLIBC_2.38`: `ddjvu`, `djvused`, `pdfimages`, `pdfinfo`, `pdftoppm`, `pdftotext`, `tesseract`
- `GLIBC_2.35`: `evb-pdf-page-ops`, `evb-scan-cleanup`
- `GLIBC_2.34`: `evb-pdf-image-combine`, `evb-pdf-search`, `qpdf`, `unpaper`

Ubuntu 22.04 has glibc 2.35, so the app can launch but OCR, Poppler, and DjVu workflows can fail when their helper is spawned. Ubuntu 20.04 has glibc 2.31 and is incompatible with nearly all bundled native tools. The download page and README present generic AppImage/DEB choices without a minimum distribution (`README.md:107-114`).

**Fix:** define the oldest supported glibc baseline; build every Linux executable in a pinned image at that baseline; reject imported GLIBC symbols newer than it; run extracted AppImage and installed DEB journeys on that oldest x64 and arm64 distro.

**Regression gate:** execute every bundled helper plus open/search/OCR/DjVu/page-edit/save in clean baseline VMs. A file-presence or `ldd` closure check alone is insufficient.

### R-02 — Browser unload silently loses dirty edits

**Severity:** High

**Status:** Confirmed, independently re-reviewed.

Aggregate dirty state exists (`app/modules/workspace-shell/useWorkspaceOrchestration.ts:397-406`), but browser crash checkpointing is explicitly disabled (`app/modules/workspace-shell/components/AppShellRoot.vue:729-733`) and its browser implementation is a no-op (`app/platform/browserWindowTabs.ts:740-744`). The only general `beforeunload` handler unregisters tab/window state and never calls `preventDefault` or sets `returnValue` (`app/platform/browserWindowTabs.ts:635-647`). In-app switching has a save gate, but reload, tab close, window close, and cross-origin navigation bypass it.

**Impact:** PDF.js annotations, note/metadata/page-label changes, and other renderer-only state can disappear without warning. IndexedDB retaining the last opened or explicitly written bytes does not preserve live edits that were never serialized.

**Fix:** maintain an all-tabs dirty registry; install a browser unload prompt whenever any document is dirty; eagerly write a durable recovery checkpoint for state that unload cannot asynchronously flush; restore/reconcile it next launch.

**Regression gate:** real-browser tests for every dirty class across reload, close, and navigation, plus forced reload/crash recovery.

### R-03 — Forced note persistence reports a failed update as saved

**Severity:** High

**Status:** Confirmed; existing tests encode the unsafe behavior.

When the viewer update returns `false`, `persistAnnotationNote` takes the safe branch only if `!force`; with `force=true` it advances `canonicalText`, clears dirty, and returns success (`app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts:375-424`). Ordinary Save and note close force this path (`:426-455`; `app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts:1026-1043`). A false result is reachable when the viewer/ref/comment/canonical identity cannot be resolved (`useWorkspaceAnnotationSession.ts:151-185`; `app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationService.ts:98-113`). The pending-embedded flag is not consumed by the normal save plan, and editor-only notes do not receive that fallback.

`tests/unit/app/modules/workspace-shell/composables/useAnnotationNoteWindows.test.ts:295-324` explicitly expects `false + force => true`, so a green unit suite currently certifies the bug.

**Impact:** Ctrl+S or close can clear the only dirty draft even though its text never entered the serialized PDF.

**Fix/test:** `updated=false` must block Save/close and retain the dirty draft, unless the save transaction explicitly embeds that exact draft and confirms durable publication. Reopen the output file in the regression test and assert the new text exists.

### R-04 — Shutdown deadline can cut off critical writes

**Severity:** High

**Status:** Confirmed, independently re-reviewed.

The shutdown coordinator wraps the entire sequential cleanup list in a 20,000 ms cap (`electron/bootstrap/shutdown.ts:7-9,30-55`). Main configures critical-write drain for 30,000 ms and schedules it only after renderer flush and earlier cleanup work (`electron/main.ts:293-295,327-397`). When the outer cap fires, it is treated as completed cleanup and quit/exit continues (`shutdown.ts:73-82,100-105,128-146`). The pending-path preservation code cannot execute if its drain never gets its promised window.

**Impact:** quit and update installation can terminate a committed save/native write before completion or before recovery paths are preserved.

**Fix/test:** remove the contradictory outer deadline or make it longer than the sum of bounded phases; give critical committed writes a hard invariant that quit cannot cross. Add fake-timer integration tests with a write completing at 25 s and a never-ending write that reaches the 30 s preservation path.

### R-05 — Persisted local MCP enablement can boot-loop Electron

**Severity:** High

**Status:** Confirmed.

Saved `agentMcpEnabled=true` causes startup to await local MCP initialization (`electron/features/agent/codexMcpIntegration.ts:312-318`). Token creation can throw (`localMcpTokenStore.ts:212-249`), and the fixed port 38671 can reject on bind (`mcpServer.ts:53-58,538-619`). Main chains this optional feature into fatal bootstrap (`electron/main.ts:472-540`). Because the setting remains enabled, every restart repeats before the UI can let the user disable it.

**Fix/test:** degrade the optional MCP subsystem, record a typed status, keep the app alive, and expose disable/retry. Boot with persisted enablement plus `EADDRINUSE`, token corruption, and permission failures.

### R-06 — Second GPU crash bypasses coordinated shutdown

**Severity:** High

**Status:** Confirmed; the current test expects the unsafe exit.

After two GPU losses in five minutes, `electron/processDeathRecovery.ts:38-65` calls `app.relaunch()` followed by direct `app.exit(0)`. Main installs this handler directly (`electron/main.ts:135-143`). Direct exit bypasses the `before-quit` coordinator (`electron/bootstrap/runInitSequence.ts:460-478`), renderer save flush, checkpoints, and critical-write drain. `tests/unit/electron/processDeathRecovery.test.ts:46-67` explicitly expects `app.exit(0)`.

**Fix/test:** route relaunch through the fatal/coordinated shutdown path and only exit after flush/drain or durable recovery preservation. Exercise two GPU-gone events with dirty annotation state and a committed native write.

### R-07 — Release cohorts are defeated by CDN/ISR caching

**Severity:** High

**Status:** Confirmed statically and against live cache behavior.

The release endpoint chooses a cohort from forwarded IP/User-Agent (`landing/server/api/releases/latest.get.ts:82-88`) but marks the result public-cacheable and varies only on UA/platform (`:125-133`). The landing page server-renders that selected response (`landing/app/pages/index.vue:296-310`) while `/` and locale roots are ISR-cached for 600 seconds (`landing/nuxt.config.ts:74-100`). A first request can therefore seed a release/recommendation for unrelated later users.

**Impact:** canary percentages, rollback isolation, and platform-specific recommendations are unreliable exactly when a bad release must be contained.

**Fix/test:** cache the GitHub release catalog globally, not the personalized decision. Select the cohort client-side or in uncached request middleware using a stable opaque cohort cookie. Test two cohort identities with the same UA through the real caching layer.

### R-08 and R-15 — Release API cache amplification and total download outage

**Severity:** High

**Status:** Confirmed; live requests showed fixed-UA hits and random-UA misses.

Every cold UA/platform variant fetches GitHub releases (`landing/server/api/releases/latest.get.ts:58-81,100-108`), with up to two retries (`packages/release-selection/latestReleaseRetry.ts:10-12,75-108`). There is no shared application catalog cache, request coalescing across variants, last-known-good data, or application rate limit. Arbitrary UAs create arbitrary CDN variants.

On upstream error, the landing page shows only Retry (`landing/app/pages/index.vue:87-98`); browse and mirror links exist only in the success branch (`:192-220`). A GitHub quota/network incident therefore removes every useful download route.

**Fix/test:** cache and coalesce the upstream catalog independently of UA, admit/rate-limit requests, serve stale-known-good signed metadata, and keep direct release/mirror/browse fallbacks visible during errors. Assert N unique UAs cause one upstream refresh rather than N.

### R-09 — Windows installers are unsigned

**Severity:** High

**Status:** Confirmed in the v0.1.426 release log and assets.

The workflow accepts missing signing secrets (`.github/workflows/build.yml:270-293`), verifies only when `WIN_EXPECT_SIGNATURE=true` (`:309-330`), removes updater metadata, and still publishes the EXEs (`:401-437`). Release run `32084269181` logged `No Windows signing certificate configured` and `Authenticode status: NotSigned` for x64 and arm64. Public installers exist but `latest.yml` does not.

**Impact:** unknown-publisher/SmartScreen friction at the top of the acquisition funnel, no publisher identity, and no normal Windows update lane.

**Fix/test:** fail closed for public releases without valid Authenticode; install and launch the signed artifact in a clean VM; verify publisher, update, downgrade rejection, uninstall, and user-data policy.

### R-10 — CI can be green while Electron journeys fail

**Severity:** High

**Status:** Confirmed from workflow source and Actions history.

Regression, save, rapid-navigation, large-PDF, quarantine, visible-window, and diagnostics jobs all use job-level `continue-on-error: true` (`.github/workflows/ci.yml:702-920`). The release policy omits these suites (`scripts/release/policy.mjs:209-267`). Examples:

- Run `32094336320` concluded success while Electron regression failed.
- Run `31990366977` concluded success while regression, quarantine, and large-PDF jobs failed.
- Run `32211149910` had 4/66 regression failures, including DjVu viewer/search timeouts; the workflow was red only because an unrelated required job failed.

**Fix/test:** make stable open/edit/save/reopen, DjVu, navigation, and large-document journeys blocking; quarantine named flaky cases rather than entire jobs; require an exact-SHA green aggregate before release.

The audit also attempted this omitted suite locally on the audited SHA. Before the run was stopped, it had produced **14 failures**. Nine distinct viewer/DjVu tests failed before the later PR-smoke setup entered a repeated hook-timeout cascade:

- Scan Cleanup skeleton/detection/overflow entry timed out.
- Native cleanup detail tiles timed out.
- Thumbnail first-presentation contract produced `firstPresented: null`.
- Rapidly scrolled large-scan pages/thumbnails hit the 180 s deadline.
- Shared PDF/DjVu late-page thumbnail activation observed no presented thumbnails.
- DjVu split-divider anchoring moved from expected page 18 to page 32.
- DjVu continuous wheel geometry hit the 120 s deadline.
- Projected-trackpad render-window coverage hit the 180 s deadline.
- High-zoom DjVu pressure expected more than 30 samples but collected only 5, followed by cleanup timeout.

The nine pre-cascade failures were not isolated and rerun individually, so some may share a cause or be influenced by accumulated session state. The subsequent Recent/large-PDF cases repeatedly spent 90 s in setup hooks and then 15 s in teardown hooks. The run was manually stopped after the 14th failure because the remaining cases would not add trustworthy independent evidence; the audit explicitly does not claim all 14 are separate product defects. The suite did cleanly pass several neighboring rotation, fit, viewport, toolbar, PDF navigation, DjVu search, and next-page cases. This mixed result reinforces the specific conclusion: the broader reliability signal is red and currently non-blocking.

## P1: transactional integrity and native resource safety

### R-11 — Identical concurrent DjVu jobs share mutable artifacts

`electron/features/djvu/main/djvuArtifactManifest.ts:113-119` keys the directory only by source stat/options/ranges, not job identity; all writers use `manifest.json.tmp` (`:45-49`), have independent in-object write chains (`:150-168`), and either job can recursively delete the shared directory (`:155-160`). Conversion output paths are also shared and one successful job cleans immediately (`ddjvuConversion.ts:143-149,280-287`).

**Impact:** intermittent `ENOENT`, cross-job output reuse, or deletion while the other job merges. **Fix:** isolated per-job directories, or a true process-wide single-flight/content-addressed cache with locking and reference counts. Add barrier-controlled concurrent tests.

### R-12 — DjVu resume accepts the wrong source/artifact revision

Checkpoint identity uses only path, size, mtime, options, and ranges (`djvuArtifactManifest.ts:113-117`). Reuse verifies only file existence, recorded size, and nonzero length (`:140-145`); `ddjvuConversion.ts:161-169` then skips conversion. There is no source digest, artifact digest, file identity, structural PDF check, or expected page count.

**Impact:** same-path/same-size/same-mtime replacement or same-length cache tampering can silently mix old pages into a new/private document. **Fix:** streamed source and artifact digests plus PDF/page-count validation. Test replacement and same-size tampering.

### R-13 — DjVu conversion has no aggregate disk ceiling

Up to 12 range workers run (`ddjvuConversion.ts:50-52`), but its range admission accounts for CPU/process/memory rather than an aggregate disk reservation (`:173-182`). The explicit export route does perform a one-time free-space heuristic—at least 128 MiB or four times source size—before conversion (`electron/features/djvu/main/pdfExport.ts:311-326,949-951`), but this is not a continuously enforced scratch/output ceiling and is not shared by all print/range paths. Any nonempty artifact is accepted regardless of size (`ddjvuConversion.ts:219-231,306-374`), and failed verified ranges intentionally survive for resume (`:301-303`). A four-minute process timeout is not a byte limit.

**Impact:** large/adversarial files can fill temporary storage and destabilize saves or the host. **Fix:** reserve a per-job free-space budget, monitor aggregate growth, abort and clean on overflow, and enforce startup quota as well as age/count retention.

### R-14 — Native image combine lacks aggregate memory admission

The native combiner permits 512 MiB per image (`native/pdf-image-combine/src/image.rs:33-47`), reads admitted JPEG/JP2 data fully (`:296-298`), defaults to eight workers, and collects a complete prepared batch (`native/pdf-image-combine/src/lib.rs:276-326,589-606`). Electron invokes native before the JavaScript fallback's aggregate checks (`electron/image/pdfConversion.ts:629-634`; fallback checks at `:409-420`). Eight near-limit passthrough pages can retain about 4 GiB before overhead.

**Fix/test:** enforce aggregate bytes before spawn, derive worker count/in-flight bytes from a declared memory budget, and stream or single-page-batch passthrough data. Measure subprocess RSS with several large valid images.

### R-20 — Assistant disable can race startup

Settings disable invokes runtime shutdown (`electron/features/settings/createSettingsMainBindings.ts:34-49`), but runtime lifecycle startup is tracked separately and shutdown can null the promise/stop only an already-existing runtime (`electron/features/agent/assistantRuntimeLifecycle.ts:127-170`). The pending startup later continues spawning without a generation fence (`:225-310`). Send checks enabled state once and can proceed after it changes (`codexAssistant.ts:941-952,1050-1128`).

**Impact:** a provider process or request may start/send after the user disabled the assistant. **Fix:** generation-token every start/send, await/cancel pending startup in shutdown, and recheck enablement immediately before spawn/write.

### R-21 — Corrupt PDF candidate commits before parser acceptance

Desktop open verifies extension/existence/copy, not PDF structure (`electron/features/documents/main/openInputPaths.service.ts:183-237`). The renderer checks only nonzero size, clears the current source, commits the candidate, cleans the old working copy, and reports opened (`app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.ts:346-393,684-740,772-915`). PDF.js acceptance happens later/reactively (`app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession.ts:855-907`) with no rollback.

Dirty work is normally save-gated, so this is disruptive session/undo/position loss rather than loss of the original saved file. **Fix:** stage and parse the candidate before atomic swap; retain the prior renderer/source/working copy until visual acceptance. Test corrupt, truncated, encrypted, and large path-backed candidates over a valid document.

### R-22 — Failed DjVu candidate evicts the current PDF

`app/composables/useDjvu.ts:383-455` closes the active document before starting/awaiting the native viewing job. The workspace supplies `closeFile` (`useWorkspaceFileLifecycleController.ts:182-246`), which clears PDF state and asynchronously deletes its working copy (`usePdfFile.ts:154-180`). Failure never restores it.

**Fix:** preflight/open an isolated DjVu handle first and commit the source switch only after success; release only the candidate on failure/staleness.

### R-24 — Temp storage is not isolated by user/profile/instance

The root is fixed at the OS-temp child `evb-viewer` (`electron/utils/appTempDir.ts:15-43`). Scratch cleanup checks marker existence and directory age but does not verify owner PID/liveness/profile before recursive removal (`managedScratchTemp.ts:53-60,78-117`); working-copy cleanup is likewise age based (`workingCopyCleanup.ts:69-130`). Parent directory mtime need not change while file contents are actively written.

**Impact:** a second OS user can hit 0700 ownership denial; a dev/automation/alternate-userData instance can delete another live operation older than 24 hours. **Fix:** namespace by OS user plus canonical userData/profile/instance, verify a lease/PID start identity, and never age-delete a live owner.

### R-25 — Image/TIFF export has no document-operation lease

Export snapshots no document revision/identity, uses a local busy flag, and has no cancellation (`app/modules/workspace-shell/composables/useWorkspaceExport.ts:247-393`). It is constructed without `runWithDocumentOperationLease` (`useWorkspaceOrchestration.ts:492-500`) and is absent from the close/open idle gate (`app/modules/workspace-shell/composables/usePageFileOperations.ts:94-126`). Source path is captured separately while `sourceKind` is read after awaits, allowing mixed old/new identity.

**Fix:** lease the document, atomically snapshot ref/revision/path/kind/pages, cancel or await before cleanup, and generation-fence UI/progress/results.

### R-26 — Reentrant print can tear down the newer run

Every print aborts the prior controller but immediately replaces it; there is no strict single-flight guard (`useWorkspacePrint.ts:579-599`). Frame, URL, listeners, and timer are singleton globals (`:87-151`), and both new setup and old catches invoke global cleanup (`:290-313,398-455,487-536`). The exposed quick-print command is fire-and-forget without a busy guard (`createWorkspaceExpose.ts:510-515`).

**Fix:** queue/reject while preparing or give each generation its own resources; cleanup only what that generation owns.

### R-30 — Image-export rollback can destroy its only recovery copy

Multi-file export backs up targets and promotes outputs sequentially (`electron/features/image-export/main/export.ts:418-430`). If a later promotion fails, restore errors are ignored (`:434-440`) and every backup is then unconditionally deleted (`:442`).

**Fix/test:** retain and report any backup whose restore failed, preferably with a durable transaction journal. Inject second-promotion and first-restore failure, including Windows locked files.

### R-31 — Persistent search saturation blocks cancellation

The native search service reads and dispatches frames on one stdin loop (`native/pdf-search/src/main.rs:1087-1092`). At the fifth worker it removes and synchronously joins the oldest on that same loop (`:1128-1131`), so later cancel frames (`:1109-1117`) cannot be consumed. Electron timeouts merely enqueue cancel (`electron/search/tryRunPersistentNativeSearch.ts:216-232`).

**Fix:** nonblocking control loop, bounded queue/fixed pool, reap only completed handles, and deterministic busy replies. Test four blocked workers, a fifth request, then cancels/shutdown.

### R-32 and R-33 — Native parsers enforce important limits too late

OCR reads the complete TSV as UTF-8 and then duplicates it into line/field/word structures without a size/row/text cap (`electron/ocr/worker/tesseractRunner.ts:224-228,370-425,473-497`). The worker heap limit helps isolate failure but does not bound buffer/external/transient allocations.

PDF page-ops declares encoded, stream, object, and page limits, but calls `Document::load_mem_with_options` before whole-document object/page validation (`native/pdf-page-ops/src/load_policy.rs:8-11,85-120`). A crafted compact PDF can consume substantial memory/CPU before rejection.

**Fix:** stat/cap and stream-parse TSV with row/text ceilings; count objects during load and add aggregate decompression/allocation budget. Fault tests must assert bounded RSS/time, not merely a typed eventual error.

## P2: web, privacy, UX, and operational hardening

### R-23 — Recent filenames travel in a site-wide cookie

Recent persistence serializes `originalPath`/browser ref, filename, size, and timestamps (`app/utils/recentFilesPersistence.ts:94-106,247-282`) and writes a 180-day `Path=/` cookie without `Secure` (`app/platform/browser/browserRecentFilesStore.ts:30-47`). Browser refs themselves include the encoded filename (`browserDocumentRefs.ts:4-16`). The cookie therefore accompanies same-origin requests and is exposed to origin/CDN/proxies even though no server code intentionally consumes it. The privacy page describes recent refs/local app data as remaining on-device (`app/pages/privacy.vue:49-64`); that policy contradiction is interpretive, but transmission is not.

**Fix:** store recent entries only in IndexedDB/localStorage and hydrate client-side; never put document identifiers/names in a request cookie. Add a network-capture regression with `sensitive-name.pdf`.

### R-27 — DjVu.js retry hangs after one load error

On script failure, the singleton promise resets but the failed `<script>` remains (`app/platform/browser-api/djvujsLoader.ts:83-131`). Retry finds the existing element and waits for load/error events that already fired; there is no timeout.

**Fix:** remove/replace failed elements, attach state before insertion, and enforce a timeout plus typed retryable error.

### R-28 — Unsupported UAs receive unusable installer recommendations

Generic Mac/Linux checks and fallback ranking (`packages/release-selection/releaseSelection.ts:205-227,243-272,337-362`) reproduced iPhone/iPad → macOS arm DMG, Android → Linux amd64 DEB, ChromeOS → Windows EXE, and a redacted Windows Firefox UA → Windows arm64.

**Fix:** explicitly classify mobile/ChromeOS/unknown architecture as unsupported/choose-manually; never infer CPU architecture from privacy-redacted tokens without a safe fallback.

### R-29 — Public web pages are frameable and inconsistently hardened

The landing configuration has no security route headers (`landing/nuxt.config.ts:74-102`). In the app, specific `/`, `/electron`, and mobile rules override the generic header rule (`nuxt.config.ts:200-258`). Live responses confirmed no CSP or frame protection on either public app; app root routes also lack generic `nosniff`, referrer, and permissions headers. Electron itself has a comparatively strong CSP (`electron/security/csp.ts:65-105`).

**Fix:** merge headers rather than replace them; set CSP with `frame-ancestors 'none'` (or a deliberate allowlist), nosniff, strict referrer and permissions policies on every HTML route; add deployed-header tests.

### R-34 — OCR drops low-confidence words from search

Words below confidence 20 are discarded before text construction (`electron/ocr/worker/tesseractRunner.ts:397-425`). The unit test explicitly omits confidence-18 `faint` (`tests/unit/electron/tesseract.test.ts:189-218`), and the index prefers that filtered text (`electron/ocr/worker/indexWriter.ts:208-214`).

**Impact:** faint/historical/unusual-font tokens can exist in Tesseract's PDF text but not EVB search. **Fix:** retain structurally valid text with confidence metadata; use confidence to flag geometry, not erase recognition.

### R-35 — Annotation note temporarily traps keyboard focus

The note considers nearly any focus outside it reclaimable and polls/refocuses for roughly 1.2 seconds (`app/modules/pdf-viewer/components/annotations/PdfAnnotationNoteWindow.vue:230-296,503-509`). An immediate Tab, Shift-Tab, or click can snap back repeatedly.

**Fix:** repair focus only when `activeElement` is body/a known transient PDF.js target, never after explicit focus reaches another control; use one bounded post-mount retry.

### R-36 — Native viewer handoff has no deadline

`NativePdfViewer.loadSource` awaits `getPageSizes()` without signal/timeout (`app/modules/native-pdf-viewer/components/NativePdfViewer.vue:916-944`); watchers and `waitForViewerLoadSettled` can remain pending (`:424-433,1143-1261`), while chassis handoff awaits them without a deadline (`DocumentViewerChassis.vue:603-635`).

**Fix:** abortable deadline, typed retryable error, and generation fence. Test a never-resolving IPC/WASM decoder.

### R-37 to R-40 — Desktop recovery and process-launch defects

- **One-shot renderer recovery (R-37):** `electron/window.ts:172-215` never resets `recoveryAttempted`; after one recovered crash, the next crash in that window lifetime is not recovered. Related wait-prompt state may also never rearm (`:225-249`).
- **Windows `.cmd` direct spawn (R-38):** CLI discovery accepts `.cmd` (`electron/features/agent/codexCli.ts:63-75,239-249`) but app-server launch spawns the path directly (`codexAppServerClient.ts:102-120`), which can fail on Windows without `cmd.exe /d /s /c` or a resolved executable shim.
- **Process-tree timeout (R-39):** helper termination settles after best effort without proving descendants died (`codexCli.ts:137-215`; `electron/utils/processTree.ts:187-193`). Admission accounting can then undercount a live orphan.
- **Local Linux package omission (R-40):** ordinary `pnpm dist` does not bundle all external tools, while the manifest/runtime require `djvudump` (`scripts/nativeResourceManifest.ts:228-240`; `electron/djvu/nativeToolPaths.ts:104-125`). `check:dev-env` reproduced the missing resource. Official release CI has a separate bundling step, so this principally affects local/reproducibility builds.

### R-41 and R-42 — Analytics abuse and retention gaps

Analytics validates the destination host but not request Origin/Referer/fetch metadata and accepts non-JSON simple content types (`server/utils/analytics.ts:45-67,78-97`; landing counterpart `:81-115`). A third-party page can therefore submit forged events without a CORS preflight. Visitor IDs are unkeyed hashes of spoofable forwarding/UA/date inputs rather than secret HMACs (`server/utils/analytics.ts:82-89`; landing `:209-216`). No repository migration or job purges analytics events; an external operational/admin purge was not verified, and the privacy wording is purpose-based rather than a concrete duration.

**Fix:** require same-origin fetch metadata and JSON content type, rate-limit, use server-secret keyed pseudonyms or authenticated session IDs, and implement/test scheduled retention deletion.

### R-43 — Old rollback tags disappear

The release endpoint fetches only the first 30 GitHub releases and requires the configured rollout tag to appear there (`landing/server/api/releases/latest.get.ts:76-95`). A deliberately retained older rollback disappears as newer releases accumulate.

**Fix:** fetch the configured tag directly or paginate until found; validate rollout config at deployment and alarm before it becomes unresolvable.

## Release engineering and coverage gaps

### R-16 — Release target is not tied to protected-main exact-SHA CI

Manual release accepts arbitrary `target_ref` (`.github/workflows/release.yml:8-27`) and validates resolution/version/tag consistency, not ancestry or authoritative CI (`:51-124`). The narrower release policy omits Electron E2E, dependency audit, Rust fmt/clippy/deny (`scripts/release/policy.mjs:209-267`).

**Fix:** require the exact target SHA to be reachable from protected `main` and have successful required jobs for that SHA before creating the tag.

### R-17 and R-18 — Final installed packages/architectures are not exercised

Build verification operates on unpacked trees (`.github/workflows/build.yml:332-366`); packaged startup is macOS-only (`scripts/verify-packaged-startup.sh:19-29`); Store AppX is unpacked rather than installed/launched (`.github/workflows/store-appx.yml:116-212`). There is no NSIS install/upgrade/uninstall, DEB dependency/desktop/MIME, AppImage FUSE/no-FUSE, installed DMG quarantine, or installed Store smoke.

The core packaged PDF journey runs only Linux x64, Windows x64, and macOS arm64 (`build.yml:353-366`). Linux arm64, Windows arm64, and Intel macOS lack it. Win7 swaps Electron 43 to 22 after strict validation, packages advisory, never starts the result, and publishes any artifact (`build-win7-legacy.yml:73-119`).

**Fix:** clean-VM install, first launch, association launch, open/search/edit/save, previous-version upgrade, uninstall, and data-retention checks on every published format/architecture. Validate Win7 in a real VM or stop publishing it.

### R-19 — Distribution publication is non-atomic

GitHub becomes public before optional Intel Mac, Win7, mirror, and Store phases (`.github/workflows/release.yml:423-585`); Intel/Win7 are advisory. A later failure leaves a visible partial/split release.

**Fix:** stage all mandatory channels as draft/prerelease, validate, then promote atomically; define automated yank/rollback behavior.

### R-44 and R-48 — Provenance and workflow supply-chain gaps

Only Windows receives provenance (`.github/workflows/build.yml:340-351`). It covers `app.asar` and the lockfile, not final installer/native hashes, signing identity, toolchain, image, or workflow, and is unsigned (`scripts/release/build-provenance.mjs:17-39`). Linux apt, macOS Homebrew, and runner images float. Privileged release jobs with `contents: write` still use mutable action major tags (`.github/workflows/release.yml:28-29,47,133,316,334`). Existing public assets are checked for presence/metadata, not compared cryptographically with rebuilt artifacts (`release.yml:370-421`).

**Fix:** pin actions/images/packages; publish signed final-asset manifests and OIDC attestations for every platform; include every bundled native hash and signing identity; verify existing assets against original immutable attestations.

### R-45 — Packaged smoke ignores renderer failures

`scripts/release/verifyPackagedCorePdfSmoke.ts:179-184` logs renderer console errors and `pageerror` as warnings. The verifier can pass if later assertions complete.

**Fix/test:** fail at completion on collected errors, with only a narrow reviewed allowlist; inject a page error to prove nonzero exit.

### R-46 — Declared local lint path can OOM

Fresh-cache `pnpm lint` failed twice under allowed Node 24.18.0 with `ERR_WORKER_OUT_OF_MEMORY` at the default four workers and about 9.5 GiB RSS. `.nvmrc`/CI pin 24.11.1, while `package.json` and `check:dev-env` accept any 24.x (`package.json:14-16`; `scripts/check-dev-environment.mjs:76-78,134-140`). A rerun with `EVB_ESLINT_WORKERS=1` and a 12 GiB heap passed.

**Fix:** enforce the exact supported Node version or continuously test latest 24.x; adapt worker count to memory; give the launcher a bounded, documented heap policy.

### R-47 and R-49 — Coverage is broad but misses browser lifecycle and Vue behavior

Coverage includes TypeScript but not `.vue` script blocks (`vitest.config.ts:12-22`); zero-execution enforcement targets selected areas, and the ratchet permits small aggregate decline (`scripts/checkZeroExecutionCoverage.ts:64-84`; `checkCoverageRatchet.ts:224-299`). Browser integration currently contains only two tests, neither a full open/edit/save/reload/unload journey.

**Fix:** changed-production-file nonzero coverage, Vue SFC coverage, critical per-file floors, and browser E2E for open/edit/save/reload, quota/permission denial, worker crash/restart, export/print/OCR, and multi-tab transfer.

### R-50 — OCR quality lacks a representative regression corpus

There are narrow semantic sentinels: `scripts/test-ocr-native-smoke.mjs:20-68` runs real Tesseract and requires a known clean-text phrase in required CI (`.github/workflows/ci.yml:698-700`), while the advisory OCR Electron journey checks recognized text and the output PDF (`tests/e2e/electron/quarantine/ocrJourney.e2e.test.ts:23-64`). Native OCR-mode tests also protect atomicity, dimensions, and metadata (`native/scan-cleanup/tests/page_cli.rs:3209-3248`). What is missing is a representative degraded/multilingual corpus and character/word-error regression threshold. A preprocessing change can preserve protocol, dimensions, and the one clean sentinel while materially degrading real recognition quality.

**Fix:** maintain a small multilingual/degraded ground-truth corpus; gate normalized CER/WER, critical-token retention, and raw-vs-preprocessed deltas by profile.

## Additional lower-severity findings

These should be fixed, but they are not acquisition blockers by themselves:

1. Managed temp-handle cleanup deletes its lease before a fire-and-forget `rm`; a rejection can become unhandled and loses the retry record (`electron/features/documents/main/managedTempFileHandles.ts:109-128,248-262`).
2. Store/AppX builds appear able to enter desktop updater paths because support checks lack an explicit Windows Store guard (`electron-builder.yml:83-101`; updater support/quit paths in `electron/updates.ts:39-48,170-178,980-1018`). Treat as a risk until installed Store validation proves otherwise.
3. Renderer shutdown-flush IPC trusts a raw reply shape more than the standard request/reply path and preload can report success when no callbacks exist (`electron/bootstrap/requestShutdownSaveFlush.ts:98-139`; `electron/preload.ts:298-334`). Strengthen schemas and require a registered handler count.
4. An active updater download is not explicitly cancelled during shutdown (`electron/updates.ts:1060-1097`).
5. Native incremental append writes directly and cannot truncate on mid-write failure (`native/pdf-page-ops/src/incremental.rs:163-185`). Current callers substantially mitigate this with unpublished sibling files or working-copy journals, so app severity is low.
6. Native command output callbacks are invoked from EventEmitter handlers without a guard; a future throwing internal callback could become an uncaught main-process exception (`electron/native-tools/runNativeCommand.ts:493-508`).
7. PNG passthrough does not verify chunk CRCs (`native/evb-raster-io/src/lib.rs:747-752`); decompression/length checks reduce current risk.
8. `clearSearch` does not reset `wasSearchCanceled`, leaving stale cancelled status until the next search (`app/modules/pdf-viewer/runtime/composables/usePdfSearch.ts:624-637`).
9. Native PDF raster pages have hard-coded English error/alt strings and generic page semantics (`app/modules/native-pdf-viewer/components/NativePdfPageContent.vue:7-34`).
10. Landing environment examples omit analytics-write/host flags required by the server, allowing successful-looking non-persistence.
11. Landing geo headers are not normalized before storage and can exceed database assumptions.
12. Configurable GitHub API base/token origin and returned download URL schemes are not constrained strongly enough (`landing/nuxt.config.ts:58-67`; `latest.get.ts:38-80`; landing link rendering `index.vue:192-198,478-499`).
13. Any generic ZIP can be ranked as a macOS asset (`packages/release-selection/releaseSelection.ts:103-115,283-297`).
14. Browser IndexedDB blocked-open handling has neither timeout nor cleanup for a late successful connection (`app/platform/browser/browserDocumentIdb.ts:15-37`).
15. First browser file-picker denial is intentionally collapsed to cancel, hiding a permission/setup failure (`browserFilePickerAdapter.ts:171-193`).
16. Upstream 503 responses are remapped to a generic 502, reducing diagnosis quality.
17. The root site URL normalizer is weaker than the landing equivalent.
18. Mirrors are advertised without automated health or integrity verification.

## Verification performed

### Source and release comparison

- Reviewed commit `88fab530...` and the v0.1.426 release target.
- Verified the highest-risk source files are unchanged between the public release and audited `main`; the report therefore marks those findings as shipped rather than merely present on a later branch.
- Inspected live production cache/security headers and release-selection behavior.
- Downloaded and extracted the public Linux x64 AppImage and inspected imported GLIBC symbols.
- Inspected GitHub Actions release/nightly history and the v0.1.426 Windows signing log/assets.

### Local validation result

| Check | Result |
|---|---|
| Production dependency audit | Passed; 0 vulnerabilities |
| Project dependency audit | Passed; 0 vulnerabilities |
| Lint | Passed with one worker/explicit heap; default fresh-cache path OOMed twice as documented in R-46 |
| Typecheck | Passed |
| Full unit suite | Passed: 964 files, 7,390 tests |
| Fallow/dead-code gate | Passed |
| Strict Nuxt/Electron/native production build | Passed |
| Blocking headless Electron open → visible annotation → save smoke | Passed: 1/1 |
| Browser integration suite | Passed: 2/2; scope is too narrow (R-49) |
| Attempted full headless Electron regression run | Failed/terminated after 14 failures; 9 distinct pre-cascade viewer/DjVu tests failed, but were not individually isolated/rerun (details under R-10) |
| Focused adversarial verifier suites | Passed: 60 tests; several pin unsafe behavior |
| Focused UI/open/note/print/export suites | Passed: 76 tests |
| Focused Electron shutdown/MCP/process/temp suites | Passed: 73 tests |
| Release-selection/landing targeted suites | Passed: 41 tests |
| Native protocol generation check | Passed |

The green tests establish a healthy happy-path baseline. They do **not** refute findings whose failure requires unload, injected native faults, multiple processes, cache behavior, released binary ABI, or concurrency barriers. In multiple cases noted above, the test expectation itself codifies the unsafe outcome.

## Verified strengths

The audit also found meaningful safeguards worth preserving:

- Desktop dirty-document switching normally passes through a save-before-switch gate.
- Electron navigation/window creation and CSP controls are substantially stronger than the public web headers.
- Native tools are subprocess-isolated, use typed error envelopes and panic catching, and usually publish output through durable sibling `AtomicOutput` paths.
- Scan-cleanup's recent 47-item hardening is present: staged inputs, full-resolution routing, bounded PNG paths/scheduler behavior, panic rollback, provenance hashing, and worker cleanup. This report does not reopen those resolved items.
- Native tool protocol constants are synchronized and the generation check passes.
- Production dependency audits currently report zero known vulnerabilities.
- macOS v0.1.426 artifacts were signed and notarized successfully.
- The blocking desktop open/annotate/save journey and all 7,390 unit tests pass on the audit host.

## Recommended remediation sequence

### P0 — before paid/broad acquisition

1. Rebuild Linux on a declared old-glibc baseline and add ABI plus oldest-distro execution gates.
2. Make Windows signing mandatory and republish signed, update-capable installers.
3. Fix browser unload recovery, forced note-save acknowledgement, shutdown deadlines, MCP degraded startup, and GPU relaunch shutdown.
4. Separate cached release catalog from cohort selection; add stale-known-good download fallback and abuse controls.
5. Make exact-SHA open/edit/save/reopen and DjVu Electron journeys blocking for release.

### P1 — before scaling beyond an initial controlled cohort

1. Transactionally stage PDF/DjVu candidates and protect export/print with leases and generation ownership.
2. Isolate and authenticate scratch/checkpoint ownership; fix DjVu concurrency and resume validation.
3. Add aggregate disk/RAM/output limits to DjVu, image combine, OCR, and PDF parsing.
4. Remove filename cookies and deploy consistent CSP/frame/security headers.
5. Install and exercise every final package/architecture in clean VMs, including upgrade/uninstall.

### P2 — sustained hardening

1. Close analytics, provenance, immutable-action, release-atomicity, and retention gaps.
2. Add full browser lifecycle E2E, Vue/changed-file coverage, adversarial concurrency/fault tests, and an OCR quality corpus.
3. Repair the remaining desktop recovery/process-launch and accessibility/localization issues.
4. Instrument production for startup failure reason, native-helper exit/ABI error, save/flush timeout, renderer/GPU crash, upstream release latency/quota, and recovery success. Alert on rates, not only raw logs.

## Launch decision checklist

Do not switch the recommendation to “ready” until all of the following are true:

- [ ] Linux x64/arm64 artifacts pass the declared oldest supported distro and GLIBC import gate.
- [ ] Windows public installers are Authenticode-signed and updater metadata is restored.
- [ ] Browser dirty reload/close has prompt plus durable recovery.
- [ ] Failed note viewer update cannot be acknowledged as saved.
- [ ] Quit/update/relaunch cannot overtake a committed critical write.
- [ ] Optional MCP failure cannot prevent the main UI from opening.
- [ ] GPU relaunch uses coordinated shutdown.
- [ ] Cohort selection remains isolated through production caching.
- [ ] Upstream release outage retains a safe download/browse path.
- [ ] Core Electron regression/save/DjVu tests are required and green for the exact release SHA.
- [ ] Concurrent DjVu jobs are isolated and resume artifacts are content-verified.
- [ ] Native conversion paths enforce aggregate disk and memory ceilings.
- [ ] Final installers are installed, upgraded, launched, and uninstalled on every published platform/architecture.

---

**Audit team:** multiple independent GPT-5.6-sol reviewers covering UI/session state, Electron lifecycle/security, native processing, server/web/privacy, CI/release/artifacts, followed by an adversarial verifier that re-checked the highest-impact claims against the audited commit. No application code was changed during the audit.

## Remediation status — 2026-08-20

This appendix records the follow-up implementation campaign. The report above is
preserved as the historical audit of the shipped v0.1.426 release; statuses here
describe the current working tree, not that public release. At the time of this
update the remediation diff has completed its final local gates and two bounded
CodeRabbit CLI passes. Production-impact findings from both passes were assessed
and the valid findings were fixed. The main remediation was pushed to `main` as
`072406368baded0218e2a65c94c5ddff475c1d2c`; the CI follow-up described below was
validated locally before publication.

Status meanings:

- **Code-complete** — the identified code defect has an implementation and focused
  regression coverage in the current tree.
- **Mitigated** — the highest-risk path is closed, but broader coverage or an
  operational proof remains.
- **External** — completion depends on credentials, protected-environment setup,
  clean platform runners, production deployment, or publishing a new release.

### Finding disposition

| Findings | Status | Current-tree resolution or remaining proof |
|---|---|---|
| R-01 | Code-complete; external release proof | Release jobs now gate Linux artifacts against the declared glibc baseline. The already-public v0.1.426 AppImage is unchanged; corrected artifacts require a new release and oldest-supported-distribution execution proof. |
| R-02 | Code-complete | Browser recovery is durable in IndexedDB, uses versioned/CAS ownership and multi-window fencing, retains partial restores, prompts on dirty unload, and refreshes mutated dirty state through debounced lifecycle capture with bounded retry. |
| R-03 | Code-complete | Forced note persistence now propagates viewer-update failure instead of acknowledging a false save; note persistence has regression coverage. |
| R-04 | Code-complete | Electron shutdown is a two-phase flush with critical-write preservation and explicit OS-shutdown handling; shutdown no longer discards document topology merely because a deadline expires. |
| R-05 | Code-complete | MCP startup failure degrades the optional integration instead of preventing the main UI from opening; startup/disable races are serialized. |
| R-06 | Code-complete | GPU recovery/relaunch now uses the coordinated shutdown path rather than bypassing pending saves. |
| R-07 | Code-complete | Release metadata selection is separated from cacheable catalog data, so cached responses cannot collapse cohorts. |
| R-08, R-15 | Code-complete | Release lookup has stale-known-good fallback, bounded upstream work, safer status propagation, and abuse controls instead of amplifying misses or turning an upstream outage into a total download outage. |
| R-09 | Code-complete; external credentials/release | Windows publication fails closed when signing material is unavailable and signed metadata is required. Authenticode credentials and a newly published installer are still operational dependencies. |
| R-10 | Code-complete; external release proof | Exact-release-SHA Electron lanes and real packaged-installer smokes are blocking in the release graph, renderer/page errors fail the packaged smoke, and the final local headless Electron gate passed 10/10. Published-artifact proof still requires a new release on the protected runners. |
| R-11–R-14 | Code-complete | DjVu scratch state is isolated and content-bound, resume manifests verify source/artifact identity, and DjVu/image-combine paths enforce aggregate disk, output, and memory budgets. |
| R-16 | Code-complete | Release preparation verifies protected `main`, the workflow SHA, and successful CI for that exact SHA before publication. |
| R-17, R-18 | Mitigated; external platform proof | CI now builds and smoke-checks the required Windows and macOS architectures, including the Intel mac artifact. Clean-machine AppX/Store install, upgrade, association/data-retention journeys, and installed Intel DMG execution still require the corresponding signed packages and platform runners. |
| R-19 | Code-complete | Publication is staged: immutable assets/checksums and mirror state are verified before Store reconciliation and final promotion. Retry-safe Store submission and mirror race handling prevent partial retries from silently clobbering artifacts. |
| R-20–R-22 | Code-complete | Assistant lifecycle ownership is serialized; PDF and DjVu candidates are validated before the live document is replaced, so corrupt/failed candidates do not evict the working document. |
| R-23 | Code-complete | Recent filenames no longer travel in a site-wide cookie; recent-file state has a direct local owner. |
| R-24–R-26 | Code-complete | Temporary storage is namespaced by user/profile/instance with live-owner markers; export holds a document-operation lease; print is single-flight and older cleanup cannot tear down the newer job. |
| R-27–R-29 | Code-complete | DjVu retry state resets correctly, unsupported UAs no longer receive fabricated installer matches, and the public web surface applies consistent CSP/frame/security headers. |
| R-30–R-33 | Code-complete | Export publication and native PDF append are transactional with rollback; search work is bounded and cancellation remains responsive; PDF/TIFF/native parsers apply admission limits before expensive allocation or decode. |
| R-34–R-36 | Code-complete | OCR preserves useful low-confidence text for search, note focus restoration is bounded, and native-viewer handoff has a deadline/failure path. |
| R-37–R-40 | Code-complete | Desktop recovery, working-copy cleanup, recent-file validation, Windows helper launch, and process-tree completion now use explicit ownership and lifecycle contracts without shell execution. |
| R-41, R-42 | Code-complete; production deployment pending | Analytics writes are host/abuse constrained and retention cleanup is implemented. Production migration, cron secret/environment configuration, and deployment remain separate operational work if not already performed. |
| R-43 | Code-complete | Mirror/tag retention preserves stable rollback tags and performs semver-aware pruning with rollback behavior. |
| R-44, R-48 | Mitigated | GitHub Actions and OCI references are immutable, final assets have strict SHA-256 manifests and OIDC attestations, and mirror uploads are create-only plus read-back verified. Homebrew/apt ecosystem snapshots and third-party package indexes remain external moving inputs. |
| R-45 | Code-complete | Packaged smoke fails on collected renderer console/page errors outside a narrow allowlist, with failure-path coverage. |
| R-46 | Code-complete | Validation launchers use an explicit bounded heap policy; the full lint path now completes under the supported environment. |
| R-47 | Code-complete | Unit coverage now instruments Vue SFCs as well as TypeScript, and CI fails when a changed covered production file has no executed lines. Nine explicitly enumerated integration-only entrypoints remain assigned to their stronger Electron/browser/packaged/OCR gates instead of being misrepresented by unit coverage. |
| R-49 | Mitigated | Browser integration increased from 2 to 4 passing journeys and exercises durable recovery/multi-window behavior. A complete rendered open/edit/save/reload/unload, quota denial, worker restart, export/print/OCR matrix remains future coverage. |
| R-50 | Code-complete | Required OCR quality testing now uses a representative multilingual/degraded corpus and gates normalized recognition quality and critical-token retention. |

All additional lower-severity findings 1–17 have code fixes and focused tests in
the current tree, including retryable managed-temp cleanup, Store-updater guards,
shutdown reply validation, updater cancellation, native rollback/callback/PNG-CRC
hardening, search reset, localization/accessibility, landing configuration and geo
normalization, release URL constraints, generic-ZIP platform selection, IndexedDB
timeouts, file-picker denial handling, upstream status preservation, and strict site
URL normalization. Additional finding 18 is **mitigated** by immutable mirror writes,
checksum verification, and read-back verification; an independent periodic public
mirror health probe is still outstanding.

### Verification of the remediation tree

| Check | Remediation result |
|---|---|
| Full unit/coverage suite | Passed: 7,639 tests; coverage ratchet and 164-file zero-execution tripwire passed |
| TypeScript typecheck | Passed |
| Full lint and architecture/import policy | Passed |
| Browser integration | Passed: 4/4 |
| Electron, root production, and landing builds | Passed |
| Rust formatting and workspace clippy with warnings denied | Passed |
| Full Rust workspace tests, including the long real fixture | Passed |
| Required native OCR smoke and OCR quality corpus | Passed |
| Final headless Electron gate | Latest whole-suite run: 10/11. The artificially CPU-throttled viewport stress case hit its unchanged 180-second bound; bounded cleanup replaced the wedged renderer and all ten downstream journeys passed. A clean viewport-to-sentinel isolation proof passed 2/2. |
| Large-PDF warm-reopen stress regression | Passed 3/3 final-tree isolated Electron runs in 73.815, 74.285, and 73.904 seconds |
| CodeRabbit review | Passed: two bounded local CLI passes; production-impact findings assessed and valid findings fixed |

### Operational work that code changes cannot complete

The following items must not be confused with defects left silently unfixed:

1. Provision Windows/macOS signing credentials and protected GitHub release
   environments/secrets, then validate their policy on the real release runners.
2. Install, launch, upgrade, exercise associations/data retention, and uninstall the
   final Store/AppX and macOS Intel packages on clean supported machines/VMs.
3. Publish a new release. The existing public v0.1.426 Linux and Windows artifacts
   retain the ABI/signing defects documented by the original audit.
4. Apply and verify the landing/root production retention migrations, cron secrets,
   and Vercel deployments if those operations have not been performed separately.
5. Add independent scheduled public-mirror health monitoring and extend the browser
   and coverage matrices described under R-47/R-49.

Accordingly, the implementation campaign has closed the known code-level P0/P1
failure paths, but the acquisition recommendation remains conditional until the
newly signed/portable artifacts have passed the external installation matrix.
