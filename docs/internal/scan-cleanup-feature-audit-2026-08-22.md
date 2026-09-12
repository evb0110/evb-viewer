# Scan Cleanup Feature Audit — 2026-08-22

Scope: end-to-end review of the scan-cleanup feature across its five layers for
bugs, inconsistencies, and architectural problems:

| Layer | Location | Size |
|---|---|---|
| Native sidecar | `native/scan-cleanup/src/**` | ~30k LOC Rust |
| Core pipeline | `scan-cleanup-core/`, `scan-cleanup-adapters/` | ~9.6k LOC TS |
| Shared contracts | `packages/contracts/scan-cleanup/` | ~2k LOC TS |
| Electron services | `electron/features/scan-cleanup/**` | ~10k LOC TS |
| UI module | `app/modules/scan-cleanup/**` | ~16.7k LOC TS/Vue |

Method: full reads of the protocol/CLI/publication paths (`manifest_v3.rs`,
`batch_cli.rs`, `nativeProtocolV3.ts`, `buildNativeScanCleanupManifest.ts`,
`runLosslessScanCleanup.ts`, `runScanCleanupSidecar.ts`,
`createScanCleanupService.ts`, `scanCleanupRunCoordinator.ts`, and the core
policy/support files), targeted sampling elsewhere (`engine/render.rs`,
`createScanCleanupPreviewService.ts`, composables were sampled, not read line
by line). Every finding below cites the code that supports it. The heavy
image-processing kernels (`bw.rs`, `content.rs`, `split.rs`, `mode_select.rs`)
were only pattern-scanned; this audit does not certify their numerics.

---

## Architecture overview

```
Renderer (app/modules/scan-cleanup)
  └─ IPC bridge → createScanCleanupService (job registry, broker lease,
                  output-access capabilities, working-copy materialization)
       └─ worker task → scan-cleanup-core (runScanCleanupConversion /
          runLosslessScanCleanup): page scope, DPI probing, canvas planning,
          provenance stamping, manifest building, progress reporting
            ├─ pdftoppm/pdfimages/qpdf/pdf-page-ops via runCommand
            ├─ evb-scan-cleanup sidecar (--manifest v3, NDJSON envelopes)
            └─ lossless path: evb-pdf-page-ops split-pages assembly
```

The design is unusually disciplined for a feature this size:

- One wire contract (`protocol v3`) generated from a single descriptor;
  `deny_unknown_fields` at every manifest level, bounded deserialization
  (256 MiB manifest, 20k page records per native batch, 4 KiB paths), and a
  strict version handshake (`lib.rs:26-31`) that fails stale parsers before
  Electron sends a request.
- Transactional publication on both sides: the native side stages same-dir
  backups and rolls back on failure or panic (`batch_cli.rs:449-620`); the
  main process deletes the generated-output directory if the job fails after
  publish (`createScanCleanupService.ts:598-603`) and resolves the
  cancel-vs-publish race through an explicit commit state.
- Bounded IO everywhere: FIFO streaming with cancellation, one-page
  acknowledgement turnstile, memory-derived worker pool sizing, scratch-space
  budgeting before choosing PPM over PNG.
- Clean dependency direction: core never imports app/electron; contracts are
  shared; the app module talks only to a typed capability.

Most real problems below are therefore not "missing safety" — they are
**duplicated policy between languages**, **ordering assumptions that are
checked nowhere**, and **drift-prone hand-maintained field lists**.

---

## Findings

### Cross-layer

#### C1 [Major] Matched-canvas margin fitting implemented twice with different units and tolerances

- Rust: `canvas_fit_for` in `native/scan-cleanup/src/adapters/batch_cli.rs:2865-2953`
  fits margins on the **pixel grid** with a 1 px tolerance
  (`fit_margin_axis`, lines 2891-2906; `CANVAS_GRID_TOLERANCE_PX = 1.0`,
  line 2778).
- TypeScript: `fitMarginAxis` inside `runLosslessScanCleanup.ts:290-304` fits
  the same requested margins in **PDF points** with a `total - 0.01` tolerance
  (line 298).

These must agree or preview/lossless and raster/final disagree about how much
margin survives on tight canvases. The two tolerances are close but not
equivalent (`0.01 pt ≈ 0.04 px @300 DPI`), and the algorithms diverge in
rounding (`Math.max(0, total - 0.01)` fractional points vs integer-pixel
`saturating_sub(1)` plus proportional rounding). Nothing pins them together:
no shared fixture asserts the two produce the same fitted margins for the same
inputs.

Fix direction: extract the fit as a pure function over rational units in one
place (contracts or a shared fixture corpus), and add a parity test that runs
both implementations against generated canvases.

#### C2 [Major] User-facing warning strings duplicated between Rust and TS

`apply_canvas_metadata` (`batch_cli.rs:3700-3750`) emits warnings such as
"Matched page size reduced requested margins…", "placed this page at X% of the
document's scale…", and "Requested margins were not applied because content
detection or cropping is unavailable". The lossless path, which never runs the
native renderer for those cases, re-authors the same sentences by hand in
`runLosslessScanCleanup.ts:352-416`. Any wording change must be made twice;
any behavioral change to when a warning fires must be reasoned about twice.
The TS copies also interpolate slightly different numbers (pt-based crop sizes
vs px-based content sizes), so users of the two quality paths see differently
worded equivalents of the same event.

Fix direction: move the warning *conditions and templates* into a shared
contract module keyed by a stable code, with each side formatting numbers in
its own unit.

#### C3 [Major] `pageSizes` indexed by position with only a length check

`runLosslessScanCleanup.ts:220` (`pageSizes[sourcePageNumber - 1]`) and
`runScanCleanupConversion.ts:694` (`pageSizes?.[pageNumber - 1]`) assume the
array is ordered by page number. The only invariant checked is
`pageSizes.length === documentPageCount` (`runScanCleanupConversion.ts:454`).
Today both producers happen to emit page-number order, and
`suppliedPageSizes` is built from `documentPageNumbers` order
(`runScanCleanupConversion.ts:394-428`), but nothing enforces it. A future
producer that filters or sorts differently would silently map every page's
geometry to the wrong page — exactly the kind of corruption this pipeline
elsewhere refuses ("cannot safely rasterize without trusted page geometry").

Fix direction: convert to a `Map<number, IPdfPageSize>` keyed by
`pageSize.pageNumber` (the objects already carry `pageNumber`), or add a
debug-mode assertion that `pageSizes[i].pageNumber === i + 1`.

#### C4 [Medium] Two competing progress models for the same sidecar stream

`runScanCleanupSidecar.ts:223-231` synthesizes a `TScanCleanupProgress` with a
raw percent (`completedPages / totalPages * 100`) and maps stage
`page-complete` → `'rendering'` unconditionally — including for **analyze**
manifests, where the second, post-reconciliation `page-complete` frame per page
(`batch_cli.rs:787-791`, `822-827`) is not rendering work. Meanwhile
`createScanCleanupProgressReporter` computes banded percent from stage weights
and callers like `runLosslessScanCleanup.ts:169-177` ignore the synthesized
progress entirely and re-derive their own. Three consumers, three semantics.
If any caller feeds the synthesized progress into UI that also uses the band
model, the meter jumps inconsistently; labeling analysis completion as
"rendering" misdescribes the work in flight.

Fix direction: have the sidecar adapter surface only raw `nativeProgress` and
let each caller own presentation, or gate the `'rendering'` mapping on the
manifest operation.

#### C5 [Medium] Path containment enforced only in one optional place, without symlink resolution

`assertScanCleanupPathWithinRoot.ts:17` normalizes with `path.resolve`, which
does **not** resolve symlinks: a symlink inside the temp root pointing outside
passes containment. The native side performs no root containment at all —
`ManifestV3::validate` checks aliasing/uniqueness/existence
(`manifest_v3.rs:279-443`) but will happily read or write any absolute path.
Containment is applied only when the manifest builder receives
`allowedPathRoot` (`buildNativeScanCleanupManifest.ts:255`), which all three
internal callers pass today (`detection.ts:605`,
`runScanCleanupConversion.ts:1018`, `runLosslessScanCleanup.ts:162`). Risk is
bounded because inputs come from the app's own temp dirs and the source is a
managed working copy, but the guard is one forgotten argument away from off.

Fix direction: make `allowedPathRoot` required in
`IBuildNativeScanCleanupManifestInput`; resolve symlinks (at least the deepest
existing ancestor, the way `resolved_manifest_path` already does on the native
side, `batch_cli.rs:1604-1630`) in the assertion.

#### C6 [Medium] Hand-maintained timing-field merge list will silently drop new stages

On a document-prior rerun, `reconcile_classification_batch` merges timings by
explicitly adding each field (`batch_cli.rs:1368-1392`). Adding a field to
`PageStageTimings` (the TS schema already accepts many optional ones,
`nativeProtocolV3.ts:672-699`, e.g. `deskewMs`, `renderMs`) requires remembering
this list or the reconciled diagnostic totals under-count. Same class of issue
as C2/C3: parallel maintenance of a shape defined once elsewhere.

Fix direction: implement the merge generically (iterate struct fields in Rust
via a small `impl AddAssign` on `PageStageTimings`) and add a test that fails
when a new timing field is not covered.

### Native Rust

#### N1 [Architecture] `adapters/batch_cli.rs` is a 4,000-line monolith behind a compatibility facade

CLI parsing, worker-pool scheduling, streamed-input turnstiles, transactional
publication, canvas placement geometry, layer materialization, ink-consistency
preflight, and progress sequencing all live in one file, with `pipeline.rs` and
`cli.rs` reduced to three-line re-export shims (`pipeline.rs:3`,
`cli.rs:3`). Placement planning alone needs a 12-parameter function
(`plan_canvas_placement_for_with_optical_center_and_fit_and_fold_trim`,
`batch_cli.rs:3445-3458`) plus four wrapper layers kept "as explicit scalar
geometry at the test seam" (lines 3364-3442). The engine split (Stage D)
extracted `engine/*` but stopped before extracting placement/materialization,
which is where the remaining mass and the trickiest invariants live.

Fix direction: extract canvas placement + materialization into a
`placement.rs` module owning `CanvasPlacement`, `CanvasFit`, fold-trim logic,
and their tests; collapse the wrapper ladder into one builder struct.

#### N2 [Minor] Expectations that depend on distant validation

462 `unwrap`/`expect`/`panic!` sites exist outside tests. Most follow local
checks, but several `expect`s are justified only by validation performed far
away: `batch_cli.rs:1886` ("cleanup input is initialized"),
`:1918` ("validated fixed analysis raster has a DPI"), `:2036`. These hold
today because `manifest_v3.rs:353-361` forces `analysisInputPath`/`analysisDpi`
to be provided together, but the link is by convention, not type. A
refactor that decouples them turns a validation error into a sidecar panic
(which the envelope machinery does catch, but as `panic`, losing diagnostics).

Fix direction: carry the DPI and plane together in one struct built at decode
time so the invariant lives in the type.

#### N3 [Minor] Path byte-ceiling check miscounts non-UTF-8 paths

`manifest_v3.rs:433` measures `path.as_os_str().to_string_lossy().len()`.
Invalid-UTF-8 bytes collapse to one U+FFFD each, undercounting the true byte
length of a hostile path by up to 3× per byte. Cosmetic given the 4096 ceiling
is an admission bound, but the check is trivially exact instead:
`path.as_os_str().len()` on Unix, or `to_raw_bytes` equivalents.

#### N4 [Minor] Stream-input detection is repeated metadata probing (TOCTOU + cost)

`manifest_has_stream_inputs` (`batch_cli.rs:991-995`) stats every input path;
it is called from `derive_page_ink_contexts`, `run_page_jobs`, and
`manifest_worker_threads` for the same manifest. Between calls a FIFO can be
replaced by a regular file or vice versa, changing which execution path runs.
Practically unreachable (paths live in the app's own scratch), but a single
classification computed once at validate time and stored on the manifest would
remove both the syscalls and the inconsistency window.

#### N5 [Minor] Materialized-stream temp names are unique only within (pid, index)

`stream_materialized_path` (`batch_cli.rs:997-1006`) produces
`.scan-cleanup-stream-{pid}-{index}.raster` next to the page metadata path.
Two concurrent manifests sharing a metadata directory from the same pid would
collide; today the admission gate and per-run scratch dirs make this
unreachable, and `MaterializedStreamPage::drop` removes them (lines 983-989),
with the 24 h scratch sweep as backstop. Worth a session nonce if the
concurrency story ever changes.

#### N6 [Positive] Manifest validation and publication are strong

Worth recording what is right so it is not "fixed" away: `deny_unknown_fields`
at every level with golden-fixture tests (`manifest_v3.rs:648-662`),
input/output alias rejection via normalization + canonicalized ancestors +
inode identity (`batch_cli.rs:1539-1661`), staged same-directory backups with
rollback-on-panic (`batch_cli.rs:449-620`), and the FIFO acknowledgement
turnstile that prevents opening an unwritten future stream after a failure
(`batch_cli.rs:1078-1145`). The comment-documented circular-wait fix at
`batch_cli.rs:1202-1215` is a good example of the reasoning quality here.

### Core TypeScript

#### T1 [Minor] Non-null assertions on externally produced progress

`runLosslessScanCleanup.ts:174` inserts
`pageNumbers[nativeProgress.pageNumber - 1]!` into a Set. If a buggy or
compromised sidecar ever reports `pageNumber > totalPages` (the TS schema only
requires `pageNumber <= totalPages` against the *sidecar's* count, which equals
the manifest's, so this is defense-in-depth), `undefined` enters the set and
`classifiedPageNumbers.size` over-reports. Cheap to clamp.

#### T2 [Cosmetic] Page-plan resolver logs a constant

`createPagePlanResolver.ts:58` logs `mismatched=0` unconditionally; mismatched
evidence throws at resolve time, so the number is always zero. Either drop the
token or count near-misses if there is a meaningful kind to report.

#### T3 [Minor] Duplicate DPI resolution in the same expression tree

`runLosslessScanCleanup.ts:88-101`: `plan.dpi` resolves
`resolveSourceDpi(detected?.dpi, documentDpi)` and then `raster.dpi` resolves
the identical call again. Harmless, but it invites the two drifting apart in
future edits; compute once and reuse.

#### T4 [Positive] Scratch sweeping and raster handoff budgeting

`sweepStaleScanCleanupScratchDirs` correctly distinguishes pid-owned retention
roots from `mkdtemp` roots, treats `EPERM` as alive, refuses symlinked entries,
and refreshes naturally because directory mtime moves when an active run writes
(`scratchCleanup.ts:62-119`). `resolveRasterHandoff` floors, reserves, and
falls back to PNG conservatively when any estimate is unknown
(`resolveRasterHandoff.ts:113-142`).

### Electron

#### E1 [Medium] Start-request dedup compares `JSON.stringify` signatures

`createScanCleanupService.ts:418` builds `signature = JSON.stringify(request)`
and treats a differing signature as grounds to cancel the previous job
(`:447-459`). Object key order determines the string, so two semantically
identical requests constructed in different order (different renderer code
paths, a future refactor of the payload builder) supersede a running job and
restart the whole document. Stable-canonicalize (sorted keys) or compare the
typed fields the service actually cares about.

#### E2 [Low] Completed jobs mark every input page processed

`completedPageNumbers = request.sourcePageNumbers ?? all pages`
(`createScanCleanupService.ts:590-591`) feeds the renderer's
"processed pages" set (`scanCleanupRunCoordinator.ts:173-193`). Pages the
engine excluded or skipped as blank are reported processed. That may be the
intended UX (nothing left to do), but it means a page whose analysis was
excluded shows identically to a page cleaned; if partiality ever matters
downstream, excluded pages need their own signal in the summary path.

#### E3 [Low] Run guard held across `openGeneratedPdf`

`handleTerminalState` intentionally keeps the run guard until the output PDF
finishes opening (`scanCleanupRunCoordinator.ts:316-325`) to avoid racing the
working-copy claim. There is no timeout on the open: a wedged viewer open
leaves `inFlight` true indefinitely, blocking all future runs until reload.
Consider releasing the guard on open failure (already handled, `:327`) plus a
generous timeout.

#### E4 [Positive] Capability and lifecycle plumbing

Output-path access grants are TTL'd, navigation-aware, and leak-free across
destroy/crash (`createScanCleanupService.ts:96-177`); owner lifecycle binds
cancel-on-crash but detach-on-navigation deliberately
(`:495-505`); the renderer's reconnect/reconcile/abandon ladder with bounded
terminal-job memory is careful about duplicate delivery
(`scanCleanupRunCoordinator.ts:40-63`, `235-279`).

---

## Suggested priority

1. C1/C2 — shared matched-canvas policy + warning codes (drift bugs waiting).
2. C3 — kill the positional `pageSizes` assumption.
3. C4 — one progress model owned by callers.
4. C6/E1 — generic timing merge; canonical start signatures.
5. C5 — require `allowedPathRoot`; resolve symlinks in containment.
6. N1 — placement module extraction when next touching that area.

## Not audited here

Numerics of the image-processing kernels (`bw.rs`, `content.rs`, `split.rs`,
`mode_select.rs`, `picture.rs`, dewarp modules), the preview service's tile
scheduling in depth, and the Vue components/composables beyond the run
coordinator. The repo's own prior audits under `docs/internal/scan-cleanup/` cover some
of that ground (notably `weight-*` root-cause notes).
