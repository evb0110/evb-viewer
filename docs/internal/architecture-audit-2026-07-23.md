# Architecture Audit — 2026-07-23 (Size, Elegance, and Consolidation)

Decision update: the dormant Python page-processor was removed after the native scan-cleanup pipeline superseded it; its implementation remains recoverable from git history.

Unlike the 2026-07-03/05 audits (correctness/fragility), this audit answers the owner's
question: *is ~678k authored LOC justified, and can substantial parts be rewritten more
logically and elegantly?* Six area auditors and one correctness auditor for the
uncommitted working tree, plus git-history mining, fallow metrics, and independent
review and synthesis. Working tree at
`c6cebbc27` plus uncommitted changes.

## Verdict

**Yes — substantial parts should be rewritten, but the target is consolidation of
ownership and ceremony, not a from-scratch rewrite.** The code is locally clean (fallow
maintainability 90/100, textual duplication 1.5%, defensive-validation density in main
only 3.5–5%) but architecturally over-fragmented: too many partial owners of the same
lifecycle, too many representations per boundary, and ceremony that multiplies every
feature. A realistic invariant-preserving program removes **~110–135k lines (16–20%)**
and — more importantly — collapses 14–22-file flows into 4–6-file flows.

| Area | Current LOC | Accidental share | Realistic target | Savings |
|---|---:|---:|---:|---:|
| app/modules/pdf-viewer | 93.5k | 16–21% | 82–86k | 7.5–11.5k |
| workspace-shell + app/utils + app/platform | 85.1k | 19–26% | 63–69k | 16–22k |
| electron/ + packages/contracts | 102.6k | 10–14% | 92–95k | 7.5–10k |
| native/ (Rust) | ~40k | 15–20% | 33–35k | 5–7k |
| tests/ | 236.5k | 24–30% | 165–180k | 56–71k |
| scripts/ | 35.2k | 32–38% | 22–24k | 11–13k |
| python/ (dormant) + its scripts support | ~5.8k | — | 0 (extract or delete) | ~5.8k |
| landing/ isolation overhead (vendor copies, lockstep checker) | ~1.8k | — | 0 | ~1.8k |

Ranges overlap; do not sum mechanically. Full per-area reports (structure maps, flow
traces, per-finding LOC estimates) are preserved in the audit transcripts.

Corrections to intuitions: tests are NOT larger than the code (236k vs 318k app+electron
= 0.74:1 — normal ratio, but low value-density); the two assistant backends are NOT
duplicated stacks (codexAssistant.ts is already the shared orchestrator); the Rust
algorithms are essential complexity.

## The measured pathologies

1. **Layer tax.** Scroll→render crosses 16 files; drawing a highlight to save crosses
   ~22; document open crosses 17. A save spans 4,138 lines across 12 files with 20+
   single-assembly "port" interfaces. Adding one trivial IPC method touches 10
   handwritten files (18 ceremony lines); a progress-bearing operation costs 280–330
   ceremony lines.
2. **Representation multiplication.** One scan-cleanup preview passes options through
   ~9 materializations / 6 schemas (reactive options → clone → bridge-safe rebuild →
   preload encode → main decode → effective options → sparse options → manifest v3 →
   Rust manifest → legacy batch model). Progress passes through 6 shapes.
3. **Parallel machinery.** Viewport and thumbnail rendering are two full schedulers
   (~7.1k). Five features (DjVu, image-export, search, OCR, scan-cleanup) each rebuild
   the missing "job" layer above the three partial job systems that exist. Annotation
   state lives in three authoritative containers synced by copying.
4. **Concept-per-file explosion.** pdf-viewer: 630 files averaging 148 lines; engine/
   has 332 files (72 LOC avg), 126 files ≤20 lines, 26 single-file directories, 6 empty
   directories. Electron: 124 files under 50 lines. app/: 253 `useX` composables; file
   names include 26 Controllers, 38 Lifecycles, 14 Leases, 11 Coordinators, 9 Chassis,
   4 Authorities.
5. **Test harness sprawl.** 41,725 lines sit before the first `describe()`; 507 local
   mock factories in 294 files; ~15 parallel platform/Electron fake worlds while the
   canonical descriptor-driven fixture is used by only 10 files. `usePdfFile.test.ts`:
   1,707 lines for a 229-line façade (7.45:1).
6. **Tooling as a second product.** scripts/ embeds four subsystems (custom-gate
   ecosystem 9.8k, release engineering 7.9k, Electron process supervisor 7.1k, PDF
   diagnostics lab 4.2k). package.json has 173 scripts (55 `check:*`); drift gates
   guard hand-committed generated files instead of generating at build. 11.7k lines of
   tests pin exact command strings/workflow topology, making tooling consolidation look
   like behavior change.
7. **Migrations that became permanent.** Legacy `documents.*` aliases are 87 of 299
   generated bindings (29%); scan-cleanup parses ManifestV3 then converts it into the
   legacy batch model it replaced; a 290-line localStorage "migration system" guards one
   schema.

## Root causes (git history + guidance analysis)

- **Growth is accelerating, not converging**: 113 source files (Jan) → 3,185 (Jul 22);
  net +235k lines in the last four weeks alone.
- **Fix-forward monoculture**: 24% of 2,128 commits are "Fix …"; ~4% are
  refactor/consolidation; 4 reverts total. Problems are patched by adding machinery.
  The July remediation added +74.5k/−15.2k in 5 days.
- **No parsimony pressure**: prior automation guidance was 100% operational
  (verification lanes, packaging) and had zero design guidance. The one
  architecture rule ("define shapes in packages/contracts") encouraged surface
  growth.
- **The wrong gate**: the only size gate is a per-file 1,200-line cap — which launders
  complexity into fragmentation (splitting satisfies the gate while multiplying
  interfaces, barrels, and mocks).

## Correctness findings (current working tree + runtime)

Found alongside the size audit; fix the first two before committing the dewarp work.

- **H — Release smoke policy expects stale protocol versions.**
  `scripts/release/native-tool-smoke-policy.mjs` expects pdf-image-combine protocol 3 /
  scan-cleanup 2; binaries now report 4 / 3. `verify-packaged-native-tools.sh` will
  deterministically fail. Fix: source expectations from
  `packages/contracts/nativeToolProtocols.ts`; add a test joining the two.
- **H — Scan-cleanup v3 drops v2 compatibility without protocol negotiation.** TS
  writes only v3, Rust accepts only v3 (+opt-in v1), and the launcher skips the cached
  `--protocol-version` handshake other tools use. Any app/sidecar version skew fails
  every operation with a generic error. Fix: preflight `verifyNativeToolProtocol` for
  scan-cleanup; decide explicitly between negotiated v2 fallback and atomic
  distribution with a typed version-mismatch error.
- **M — Placement overrides use stale cached preview geometry.** `placementOverrides`
  was removed from the preview cache key but cached metadata still supplies placement
  offsets; preview snaps back to the old position while final output uses the new
  override. The old cache-key test was weakened to match. Fix: recompute offsets
  renderer-side from the current override, or restore the key component; re-add a test
  that committing an override moves an already-cached preview.
- **H (committed) — Streaming chat deltas each enqueue a full-session fsync snapshot**
  (`assistantChatPersistence.ts`): quadratic copying + unbounded queue growth during
  long streamed responses. Coalesce to newest-state, debounce, checkpoint at turn
  boundaries.
- **M (committed)** — `codexAppServerClient.ts` stdout line buffer is unbounded (cap
  it and fail the protocol process); scan-cleanup `ownerScopedJobRegistry.ts` leaks one
  `destroyed` listener + retained job per job/subscription on long-lived windows.
- **Test deltas** — v2 golden fixtures deleted without replacement negotiation
  coverage; smoke-policy tests validate the stale literals against themselves.

## The overhaul program

Owner has approved large-scale overhauls. Sequencing is dependency-driven; each stage
must keep `pnpm validate` green and preserve every invariant from the July audits
(revision CAS, documentInstanceId, lease/settle semantics, typed errors, progress
replay, fail-closed release gates).

**Stage 0 — Correctness (days).** The findings above.

**Stage 1 — Generative foundations (the multiplier).**
1. `definePlatformFeature()` runtime spec as the single source for method name,
   channel, schemas, kind, progress semantics, handler and browser binding → generate
   invoke maps, codecs, preload clients, registrar loops, descriptor entries, fixtures,
   lazy artifacts. Migrate one capability at a time with codec-parity tests. (−3.6–4.6k
   direct; shrinks every later migration.)
2. Generic main-process job registry (owner/revision fencing, renderer-death cleanup,
   signal composition, scratch scope, progress replay, terminal expiry) extending
   `mainOperationLifecycle`; migrate DjVu → image-export → OCR → search → scan-cleanup.
   (−1.2–1.8k plus feature-side savings.)
3. Test-harness consolidation *before* the big renderer refactors: adopt the
   descriptor-driven platform fixture everywhere, build shared Nuxt-stub/pointer/mount
   harnesses, and unpin structure-pinning tests (assert plans/manifests, not command
   strings). This is what makes Stages 2–4 cheap.

**Stage 2 — Renderer ownership consolidation (the big one).**
4. workspace-shell: three explicit owners — `WorkspaceDocumentController` (open/close/
   restore/identity/transaction), `WorkspaceDocumentDriver` (per-format behavior chosen
   at open; kills the 172-site PDF/DjVu/native branching), `WorkspaceSaveService` (one
   `SavePlan` discriminated union + one executor replacing the port lattice). Giant
   SFCs become composition roots. (47.9k → 35–38k.)
5. pdf-viewer: one `PdfPageRasterScheduler` for viewport+thumbnails; `AnnotationStore`
   as sole authority (PDF.js as projection); replace the feature-controller callback
   mesh with four typed sessions (document/viewport/rendering/annotation); one
   text-markup presentation controller; single save-route classifier. (93.5k → 82–86k.)
6. utils/platform: fold `document-viewer/` machines into the surface lifecycle; merge
   agentMetadataPlans into canonical metadata helpers; privatize single-consumer
   exports; browser platform to explicit web tiers. (85.1k → 63–69k with #4.)

**Stage 3 — Vertical slice cleanup.**
7. scan-cleanup: execute ManifestV3 directly (delete the legacy batch model);
   schema-derived codecs replacing the 1,055-line handwritten codec; one
   preview/detect/final runner; one public result schema + opt-in diagnostics; shared
   progress DTO. (Vertical 31–32k → 24–26k.)
8. native: shared raster IO crate (`evb-raster-io`), atomic-output + CLI envelope in
   `evb-native-support`, single `PageSpec` API in pdf-image-combine, generated protocol
   descriptors. (40k → 33–35k.)

**Stage 4 — Tooling and tests.**
9. Gates: move filename/import/size rules into ESLint, CSS rules into Stylelint; keep
   one graph checker; generate-at-build instead of drift gates; content-addressed build
   receipts replace mtime freshness. Release: one target manifest driving
   stage/afterPack/verify. Electron runner split into dev supervisor + ephemeral E2E
   fixture + diagnostics adapter. package.json 173 → 75–95 scripts; CI 1.9k → ~1.3k
   YAML via matrix + composite actions. (35.2k → 22–24k.)
10. Tests: table-drive repeated scenario families; delete mock-echo assertions; one
    layer per scenario + one e2e proof; each deleted duplicate needs a retained test
    that fails under a representative violation. (236.5k → 165–180k.)
11. Owner decisions: dormant python/ page-processor deleted (recoverable from git
    history); landing/ into the workspace (delete vendor copies, lockstep checker, nested
    workflow); legacy `documents.*` aggregate deprecation clock.

## Process rules for the overhaul (and after)

- Every refactor PR reports net LOC and file-count delta; consolidation PRs should be
  net-negative.
- Structural changes receive an independent fresh-context review; public surfaces
  receive a product and interaction review.
- Revert is a first-class outcome — a failed approach gets rolled back, not patched
  forward.
- Fix the cause, then ask "what does this fix let us delete?"
- The review criteria that prevent regrowth live in
  [`docs/architecture/design-principles.md`](../architecture/design-principles.md);
  mechanical subsets remain in the architecture boundary and dependency checks.

## Leave alone (consensus across auditors)

Revision CAS + typed stale/missing-revision errors; documentInstanceId and command
targets; render leases and settle-before-release; operation-lifecycle shutdown
admission; trusted-sender IPC validation (generate it, don't delete it); progress
replay; fail-closed release verification; the blocking Electron smoke lane and every
invariant-violation test; OCR scheduling/resource governance; Rust algorithm crates
(dewarp, text-line tracing, jbig2, lopdf mutation logic); chunked browser storage; the
dual native/WASM capability; explicit generated proxies (no clever runtime `Proxy`).

## Remaining-program closure — 2026-07-25

This closes the bounded A–I remaining program, not every target in the larger overhaul.
The measurements below use the repository LOC calculator at committed revision
`9875e3da8`: CLOC code lines only, excluding blank/comment lines, bundled resources,
dependencies, vendor/generated output, build products, lockfiles, binaries, models,
fonts, and images. The comparison revision `c6cebbc27` is not an ancestor of this
branch, so the reported `+22,996` source LOC and `-73` source files are a symmetric
snapshot comparison, not a commit-range delta. They include substantial work outside
this bounded consolidation; the stage table below is the relevant production delta.

| Audit area | End-state authored LOC | Audit target | Closure result |
| --- | ---: | ---: | --- |
| `app/modules/pdf-viewer` | 79,818 | 82–86k | Below target after ownership consolidation |
| workspace-shell + `app/utils` + `app/platform` | 77,258 | 63–69k | Not reached; later workspace-shell overhaul remains |
| `electron` + `packages/contracts` | 100,707 | 92–95k | Not reached; contracts grew while feature specs replaced handwritten boundary ceremony |
| `native` | 47,838 | 33–35k | Not in the bounded A–I implementation |
| `tests` | 221,916 | 165–180k | Not in the bounded A–I implementation |
| `scripts` | 31,716 | 22–24k | Partially reduced; release/runner ownership landed |
| dormant `python` | 0 | 0 | Met; recoverable from Git history |
| `landing` (whole application) | 8,474 | 0 isolation overhead | Whole-app count is not comparable; workspace folding remains |

The complete snapshot contains 631,183 authored source LOC in 3,159 files, including
371,052 product/runtime, 226,845 test-purpose, and 33,286 tooling/automation LOC.

### End-state ownership inventory

- One platform-spec constructor, `definePlatformFeature()` in
  `packages/contracts/platformFeature.ts`, defines method/channel/schema/kind/progress
  metadata. Twenty-two feature specs feed the one `PLATFORM_FEATURE_REGISTRY` in
  `packages/contracts/platformApiDescriptor.ts`; generated codecs, preload clients,
  registrar loops, browser bindings, and fixtures consume those specs.
- The PDF topology has exactly four session owners under
  `app/modules/pdf-viewer/runtime/sessions/`: `pdfDocumentSession.ts`,
  `createPdfViewportSession.ts`, `createPdfRenderingSession.ts`, and
  `createPdfAnnotationSession.ts`, constructed and disposed in topological order.
- One `PdfPageRasterScheduler` in
  `engine/pdf-page-raster-scheduler/pdfPageRasterScheduler.ts` owns viewport,
  navigation, thumbnail, and prefetch work for a live PDF document.
- One `AnnotationStore` in `annotations/domain/annotationStore.ts` owns annotation
  entities, external identities, history, saved baselines, mutation epochs, and save
  frontiers. PDF.js and UI state are projections.
- One `classifyPdfSaveRoute()` in `runtime/save/classifyPdfSaveRoute.ts` classifies a
  frozen save plan once. Projectors and executors consume its discriminated decision.
- One text-markup presentation controller in
  `runtime/annotations/useTextMarkupPresentationController.ts` consumes render/store
  transitions; the DOM observer, fixed retry ladder, draw-layer token loop, and
  per-page color hook are deleted.

### Bounded flow traces

These are the topological **owner** traces used by the session design: forwarding-only
views and internal rendering helpers are not counted as additional owners. Literal
runtime stacks can enter such helpers (and disk persistence adds workspace/preload/
Electron files), but no helper becomes another state or lifecycle authority.

1. **Scroll → raster (5 authored files):**
   `components/PdfViewer.vue` (scroll input) →
   `runtime/usePdfViewerFeatureController.ts` (session composition) →
   `runtime/sessions/createPdfViewportSession.ts`
   (`handleTrustedScroll` → `publishDemand`) →
   `runtime/sessions/createPdfRenderingSession.ts`
   (`reconcileDemand` → `renderVisiblePages`) →
   `engine/pdf-page-raster-scheduler/pdfPageRasterScheduler.ts`
   (`setDemand` → scheduled raster execution).
2. **Open → first committed canvas (6 authored files):**
   `components/PdfViewer.vue` → `runtime/usePdfViewerFeatureController.ts` →
   `runtime/sessions/pdfDocumentSession.ts` (`scheduleLoad` → `ready`) →
   `runtime/sessions/createPdfViewportSession.ts` (`requestMandatoryRaster`) →
   `runtime/sessions/createPdfRenderingSession.ts` (target commit and
   `openSurface.commitCanvas`) →
   `engine/pdf-page-raster-scheduler/pdfPageRasterScheduler.ts`.
3. **Highlight → saved bytes (at most 6 authored files):**
   `annotations/bridge/pdfjs-runtime/useAnnotationHighlight.ts` →
   `runtime/sessions/createPdfAnnotationSession.ts` →
   `annotations/domain/annotationStore.ts` →
   `runtime/save/usePdfViewerSaveTransaction.ts` →
   `runtime/save/classifyPdfSaveRoute.ts` →
   `runtime/composables/pdf/usePdfSerialization.ts` on the rewrite route. PDF.js
   materialization ends in the save transaction after five owners at
   `pdfDocument.saveDocument()`; native append bypasses the rewrite serializer.

### Preserved invariants and owning tests

| Invariant | Owning test |
| --- | --- |
| Annotation save-frontier CAS permits identity reconciliation but rejects semantic mutation | `tests/unit/app/modules/pdf-viewer/annotations/annotationStoreSaveFrontierRollback.test.ts` |
| Document identity remains fenced by `documentInstanceId` and revision | `tests/unit/app/modules/workspace-shell/document-sessions/workspaceDocumentController.test.ts`; `tests/unit/electron/documentRevisionStore.test.ts` |
| A superseded/wedged open cannot commit over its successor | `tests/unit/app/modules/pdf-viewer/runtime/sessions/pdfSessionTransitions.test.ts` |
| Raster priority, cancellation, stale-generation discard, residency, and lease-exactly-once-after-settlement | `tests/unit/app/modules/pdf-viewer/engine/pdfPageRasterScheduler.test.ts` |
| A document is not destroyed until invalidation, render work, and page leases settle | `tests/unit/app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession.test.ts` |
| A frozen save plan produces exactly one deterministic route and only documented fallbacks | `tests/unit/app/services/pdf-save/classifyPdfSaveRoute.test.ts` |
| Active and terminal operation progress is replayable without duplicate live delivery | `tests/unit/electron/createIpcProgressPump.test.ts`; `tests/unit/electron/mainJobRegistry.test.ts` |
| Release resources and protocol versions fail closed at the disk boundary and remain joined to contracts | `tests/unit/scripts/nativeToolSmokePolicy.test.ts` |

### Deliberately retained deviations

- The 1,200-line default ESLint cap and explicit lower/per-file caps remain. They are
  guardrails, not completion targets; exceptions may be removed only by a real
  responsibility split or deletion, never by cosmetic file slicing.
- Eight legacy method descriptors and seven legacy capability descriptors remain in
  `platformApiDescriptor.ts`. They are isolated from the 22-spec registry. Remove each
  only after its app/Electron/browser consumers have migrated and descriptor parity
  proves no public backend path still depends on it.
- The 80 ms retry in `useAnnotationHighlight.ts` remains because it discovers a newly
  created PDF.js editor identity; it is not a visual-repair loop. Remove it only when
  PDF.js exposes a deterministic created-editor transition.
- Native algorithm consolidation, test-family table-driving, workspace-shell target
  completion, and landing workspace folding remain separate overhaul stages. None was
  disguised as completion of this bounded program.

### Production delta by remaining-program stage

| Stage | Production LOC delta | Note |
| --- | ---: | --- |
| A | +12 | Baseline product correction; the later consolidation stages more than offset it |
| B | -1,123 | Unified raster scheduler and follow-ups |
| C | -586 | Single annotation authority |
| D | -4,541 | Integrated `7ede6c9eb..b45e84bb6` app delta |
| E | -2 | Single markup presentation controller |
| F | -205 | One-shot save-route classification |
| G | -59 | Browser/DjVu responsibility splits and web tiers |
| H | -1 | Release manifest and Electron runner ownership, excluding generated artifacts |
| I | -16 | Fallow cleanup; `+7/-234` and **-227** across production plus tests |
| **A–I total** | **-6,521** | Net production deletion; all-source stage cleanup is 211 lines lower again |

Stage D's branch-local evidence was page-source `-23`, annotation `-75`, and render
`-4,944`. Those branch measurements overlap the shared session foundation and merge
resolution, so they are recorded as evidence but are not added together; `-4,541` is
the non-double-counted integrated Stage-D result.

The Stage-I cleanup commit `9875e3da8` removed 23 production lines while adding 7
(net -16) and deleted a 211-line unused test helper; its all-source textual delta is
therefore -227 without reclassifying that work into Stage D.

### Closure verification

Measured at `3ad275842`, this program merged with `origin/main` `cdc2f6848` and
published its closure as `e9cffc6c7`. The subsequent audit integrations are published
through `59abb3778`, confirmed as the remote `main` object on 2026-07-26.

The last scan-cleanup concurrency unit deliberately landed only its independently
supported half at `59abb3778`: the peak-memory model now matches the measured
resident high-water mark and a one-worker batch no longer serialises intra-page work
inside a one-thread Rayon pool. The proposed CPU-cap widening remains unmerged because
the required idle-host comparison could not be obtained; a 30-minute control saw load
2.51–5.20 and never met its quiet gate. The optional
`workingCopyMaterialization` load-sensitivity control and the raster fan-out curve are
likewise recorded as idle-host blocked rather than replaced with contaminated
measurements. These post-closure dispositions do not supersede or re-label the sparse
gate results below.

`pnpm validate` passes: 894 test files, 6,441 passed, 7 skipped, 0 failed; type
coverage 99.58% app, 99.43% electron, 99.16% tests, 99.16% scripts, all above floor;
`build:strict` green; fallow reports 0 dead-code issues across 2,394 entry points and
no new clone groups. `pnpm test:coverage` passes at 68.39% statements, 61.21%
branches, 70.32% functions, 68.73% lines with the ratchet green. `pnpm release:verify`
passes end to end, including electron-builder packaging, all 16 packaged native tool
smoke tests, and the resource-matrix and asar checks it drives. The ephemeral E2E
session-controller detection blocker fixed in `c44279007` is green in the rerun.

Five of the seven sequential isolated headless Electron lanes are green
(`blocking-smoke`, `draw-shapes`, `large`, `rapid-navigation`, `save-pipeline`). Two
scan-cleanup e2e tests and one scan-cleanup corpus size envelope fail; all three were
reproduced unchanged on a clean `origin/main` worktree with none of this program's
commits present, so they are inherited from the concurrent scan-cleanup rewrite rather
than caused here. The corpus passes 52 of 53 assertions, including every semantic and
rendered check. The clean-baseline reproductions establish that these failures
predate this program.

Two `release:verify` failures surfaced during closure and were fixed at their cause,
not waited out: an AbortSignal listener subscribed after an `await` could never
receive a cancel that had already fired (`e7f9d278a`, which also reverts an earlier
timeout extension rather than raising it again), and packaged release manifest rows
encoded with a tab lost their empty staged-root column to IFS whitespace collapsing,
so the verifier checked paths that were never in the manifest (`ec67d5c98`).

At `3ad275842` the repository holds **642,370 authored source LOC** across **3,179
source files** — 373,131 product/runtime, 235,814 test-purpose, 33,425
tooling/automation. Against the `c6cebbc27` baseline that is **+34,183 source LOC**
and **-53 source files**; the file count is the program's own consolidation result,
while the line growth is dominated by concurrent feature work merged in from
`origin/main` during the program, not by this program's stages, which total -6,521
production lines as tabulated above.
