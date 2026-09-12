# Scan cleanup audit verification ledger

Date: 2026-08-23

Source audit: `Scan Cleanup Feature Audit, 2026-08-22`, supplied as a
conversation attachment.

## Verification baseline

- Local checkout: `80059182353bb2af1600dd03b97393a9ddf417d2`
- Current `origin/main`: `d871f2b12feaf6f306767f557796dd94ea114ebb`
- The local checkout is 32 commits behind `origin/main`, but a path-scoped diff
  found no changes under the five audited feature areas. The current line
  references below therefore describe both revisions.
- The equivalence check was `git diff --quiet HEAD..origin/main --` over
  `native/scan-cleanup`, `scan-cleanup-core`, `scan-cleanup-adapters`,
  `packages/contracts/scan-cleanup`, `electron/features/scan-cleanup`, and
  `app/modules/scan-cleanup`; it exited 0.
- The checkout was not fast-forwarded because untracked files under
  `docs/internal/agents/` overlap tracked files added by the incoming commits. This
  ledger does not modify those files.
- This pass verified the audit's cited code, reachable callers, request and
  progress codecs, and relevant existing tests. It did not recertify the image
  processing numerics that the audit excluded.
- The audit does not state how it calculated its layer sizes. A reproducible
  physical-line count over tracked files at the baseline gives 61,201 lines in
  `native/scan-cleanup/src`, 10,607 across `scan-cleanup-core` and
  `scan-cleanup-adapters`, 5,118 in the scan-cleanup contracts, 5,269 in the
  Electron feature, and 17,526 in the UI module. These totals include comments,
  blank lines, and inline tests. They do not validate the audit's approximate
  LOC table, but they make the counting boundary explicit. Each total uses
  `git ls-files -z <scope> | xargs -0 wc -l`.

## Status and priority vocabulary

| Term | Meaning |
| --- | --- |
| Confirmed | The cited condition exists in a reachable production path. |
| Partial | Part of the claim is true, but reachability, impact, or proposed cause is overstated. |
| Refuted | The current code or contract prevents the reported behavior. |
| Positive verified | The recorded safety property is present. |
| P1 | A bounded corrective patch should be scheduled. |
| P2 | Add hardening or parity coverage before changing the area. |
| P3 | Cleanup only. Fold it into nearby work. |
| No action | Preserve the current behavior or evidence. |

Corrected ratings use the audit's severity words: Medium for a reachable issue
with bounded impact, Low for hardening or transient behavior, Cosmetic for no
behavior impact, None for a refuted behavior, and Positive for a verified
safeguard. `Refactor candidate` describes architecture debt rather than defect
severity. P0 would mean an urgent data-loss, security, or release-blocking
defect. This pass found none.

No item in this audit is a verified P0 defect. C5 and E3 are the only P1
items. The audit's suggested order put C1 and C2 first, but neither has a
reproducing fixture or evidence of a current damaged output.

## Disposition summary

| ID | Audit rating | Verified status | Corrected rating | Priority | Decision |
| --- | --- | --- | --- | --- | --- |
| C1 | Major | Confirmed | Medium | P2 | Add cross-path parity fixtures before changing matched-canvas fitting. |
| C2 | Major | Confirmed, broader than reported | Medium | P2 | Replace string parsing and free-form cross-path warnings with stable codes and preserve aggregation in tests. |
| C3 | Major | Partial | Low | P2 | Add one canonical page-number assertion at the core boundary. |
| C4 | Medium | Confirmed design duplication | Low | P3 | Remove the synthetic presentation model when changing the sidecar callback. |
| C5 | Medium | Confirmed, reachability understated | Medium | P1 | Guard every runnable production manifest and reject symlink escapes. |
| C6 | Medium | Confirmed | Low | P2 | Give timing accumulation one exhaustive Rust owner. |
| N1 | Architecture | Confirmed | Refactor candidate | P3 | Extract only when placement work resumes. Remove wrappers rather than adding another layer. |
| N2 | Minor | Partial | Low | P3 | Couple fixed analysis raster and DPI in a type. Do not launch a broad panic cleanup. |
| N3 | Minor | Refuted | None | No action | The reported undercount has the wrong direction and cannot enter through JSON. |
| N4 | Minor | Confirmed | Low | P3 | Compute stream classification once if this scheduler is edited. |
| N5 | Minor | Confirmed latent, unreachable in the product | Low | No action | Keep it deferred unless a same-process manifest API is added. |
| N6 | Positive | Positive verified | Positive | No action | Preserve validation, alias checks, transaction rollback, and FIFO ordering. |
| T1 | Minor | Confirmed defense in depth | Low | P3 | Cross-check native totals against the requested manifest before indexing. |
| T2 | Cosmetic | Confirmed | Cosmetic | P3 | Remove the constant token when editing the resolver. |
| T3 | Minor | Confirmed | Cosmetic | P3 | Reuse the already resolved DPI when editing the lossless plan. |
| T4 | Positive | Partial positive | Low | P3 | Preserve budgeting and add an explicit liveness marker if runs can outlive the sweep age. |
| E1 | Medium | Partial, blocked by the current builder | Low | No action | Keep one normalized request builder; compare typed fields if another appears. |
| E2 | Low | Partial, renderer effect refuted | None | No action | Completed-state page numbers do not feed the renderer's active processed-page set. |
| E3 | Low | Confirmed | Medium | P1 | Bound or cancel generated-document opening without allowing a second open to race it. |
| E4 | Positive | Positive verified | Positive | No action | Preserve capability and owner lifecycle behavior. |

## Cross-layer findings

### C1, matched-canvas fitting differs between raster and lossless paths

Status: Confirmed. Corrected rating: Medium. Priority: P2.

Evidence:

- `native/scan-cleanup/src/adapters/batch_cli.rs:2774-2778` defines a one-pixel
  raster-grid tolerance.
- `native/scan-cleanup/src/adapters/batch_cli.rs:2865-2953` rounds requested
  margins to integer canvas pixels and leaves one drawable pixel when the two
  margins consume an axis.
- `scan-cleanup-core/runLosslessScanCleanup.ts:290-304` performs the equivalent
  lossless calculation in PDF points and leaves `0.01` point.
- Preview has a third pixel-grid fitter at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:2207-2220`.
- Existing placement cases cover the paths separately in
  `tests/unit/electron/scanCleanupPipeline.test.ts:1629-1723` and
  `tests/unit/electron/scanCleanupPreview.test.ts:4874-4907`. They do not
  compare the same margin-boundary input across raster final, lossless final,
  and preview.
- No shared fixture compares the fitted box, scale, warning decision, and final
  placement produced by both paths for the same physical page.

The audit correctly identifies drift. It overstates the present evidence by
calling this a major bug without a failing document. The two paths work in
different output units, so byte-for-byte numeric equality is not the right
acceptance rule. Physical placement must agree within the declared raster-grid
tolerance.

Acceptance checks:

1. Generate normal, boundary, and over-constrained margin cases from one
   physical page and canvas description.
2. Compare fitted physical margins, scale, warning code, and placement across
   raster and lossless paths.
3. Set an explicit tolerance of at most one raster canvas pixel at the selected
   canvas DPI.
4. Include asymmetric margins, rotated pages, split leaves, and a canvas
   narrower than the maximum permitted margin pair.
5. Extend the existing CLI-to-app parity harness in
   `tests/e2e/electron/quarantine/scanCleanupUniformity.e2e.test.ts` rather than
   creating a second end-to-end harness.

### C2, matched-canvas warnings have several owners

Status: Confirmed and broader than reported. Corrected rating: Medium.
Priority: P2.

Evidence:

- Rust authors raster-path warnings at
  `native/scan-cleanup/src/adapters/batch_cli.rs:3700-3750`.
- The lossless path authors equivalents at
  `scan-cleanup-core/runLosslessScanCleanup.ts:350-416`.
- The preview service has a third copy at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:2411-2426`.
- Raster conversion parses the Rust-authored English at
  `scan-cleanup-core/runScanCleanupConversion.ts:1416-1419` to choose an
  aggregated warning at lines 1460-1466. A Rust wording change can therefore
  turn one summary into per-page warnings without a type or test failure.

The audit counted only Rust and lossless TypeScript. The extra preview copy
makes the maintenance risk stronger. The current numeric wording differs in
pixels and points for legitimate reasons. Sharing English templates alone
would not unify the conditions.

Acceptance checks:

1. Define stable warning codes and typed parameters in the scan-cleanup wire
   contract.
2. Keep warning conditions with the policy that decides the condition.
3. Format and localize user-facing text in one TypeScript owner.
4. Assert warning-code parity across raster final, lossless final, and preview
   fixtures. Include a raster-final aggregation test driven by a native warning.
5. Preserve bounded diagnostic detail without using free-form English as a
   programmatic key.

### C3, page geometry is consumed positionally

Status: Partial. Corrected rating: Low. Priority: P2.

Evidence:

- Positional reads exist in `scan-cleanup-core/runLosslessScanCleanup.ts:220`,
  `scan-cleanup-core/runScanCleanupConversion.ts:694`, and
  `scan-cleanup-core/policy/documentCanvas.ts:693`.
- Other positional consumers exist at
  `scan-cleanup-core/runScanCleanupConversion.ts:1334` and 1402,
  `scan-cleanup-core/detection.ts:617`, and
  `scan-cleanup-core/sourceTextLayer.ts:234`.
- The native page-size decoder rejects missing and duplicate page numbers, then
  returns canonical order at `scan-cleanup-core/pdfPageSizes.ts:41-102`.
- The Poppler fallback also builds its result by page number.
- Renderer-supplied metadata is rebuilt in document order at
  `scan-cleanup-core/runScanCleanupConversion.ts:394-428`.
- An injected `getPageSizes` dependency can still return a full-length,
  out-of-order array. The length-only check at
  `scan-cleanup-core/runScanCleanupConversion.ts:454-458` would accept it.

The audit's silent-corruption scenario is blocked for every production
producer inspected. The remaining gap is an internal boundary and test seam,
not a major live corruption path.

Acceptance checks:

1. Validate once that `pageSizes[index].pageNumber === index + 1` before any
   positional consumer runs. Apply the shared guard at every entry point that
   accepts a `pageSizes` array, not only the conversion boundary.
2. Reject a full-length shuffled array in a focused core test.
3. Keep `parsePdfPageSizesPayload` accepting out-of-order wire records and
   returning canonical order.
4. Preserve detection's full `1..N` manifest invariant. Its progress handler
   treats a native manifest index as a source page number, unlike the explicit
   manifest-index mapping in final conversion.

### C4, sidecar progress has a redundant presentation model

Status: Confirmed design duplication. Corrected rating: Low. Priority: P3.

Evidence:

- `electron/features/scan-cleanup/worker/runScanCleanupSidecar.ts:223-231`
  builds raw percent and maps every non-`page-analyzed` native event to
  `rendering`.
- Detection overwrites the stage and percent at
  `scan-cleanup-core/detection.ts:655-684`.
- Raster conversion ignores the synthetic argument at
  `scan-cleanup-core/runScanCleanupConversion.ts:1105-1135`.
- Lossless analysis ignores it at
  `scan-cleanup-core/runLosslessScanCleanup.ts:169-177`.

The adapter's model is misleading in isolation, but no current production
consumer presents its incorrect analyze label. This is a drift hazard, not a
verified UI jump.

Acceptance checks:

1. Change the adapter callback to expose native progress plus terminal timing
   aggregation only.
2. Keep stage weighting in `createScanCleanupProgressReporter` and detection's
   own publisher.
3. Test analyze and render manifests separately, including provisional and
   reconciled events.

### C5, path containment is optional and lexical

Status: Confirmed, with reachability understated. Corrected rating: Medium.
Priority: P1.

Evidence:

- `scan-cleanup-core/assertScanCleanupPathWithinRoot.ts:9-24` uses lexical
  `path.resolve` and `path.relative`. A symlink under the root can lead outside
  it.
- `allowedPathRoot` is optional at
  `scan-cleanup-core/policy/buildNativeScanCleanupManifest.ts:55-68`, and the
  builder skips containment when absent at lines 244-255.
- Detection, raster final, and lossless final supply a root.
- Detail preview omits it at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:1686-1694`.
- Ordinary preview omits it at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:2125-2145`.
- A geometry-only preflight at
  `scan-cleanup-core/runScanCleanupConversion.ts:752-770` intentionally uses
  placeholder paths and must not be mistaken for a runnable manifest.
- Native validation checks path existence, aliasing, and destination identity,
  but it has no allowed-root field in `ManifestV3`.

The audit's three named callers do pass the root. Its enumeration missed the
two preview callers, which makes the omission reachable, although their
current inputs are generated by the app in scratch storage. The audit therefore
understates reachability, not the original Medium severity.

The geometry-only preflight passes `inputPath: ''`, while
`assertScanCleanupPathWithinRoot.ts:14-16` rejects non-absolute paths. Making
the current optional argument required without separating the two builder uses
would break this preflight.

Acceptance checks:

1. Separate runnable-manifest construction from geometry-only validation so a
   runnable builder can require an allowed root.
2. Supply the root in both preview paths.
3. Resolve the root and the deepest existing candidate ancestor before the
   containment comparison.
4. Reject a symlink inside scratch that targets an external input or output.
5. Repeat containment at the native trust boundary using a trusted CLI argument
   or process-owned scratch context. Do not trust a root asserted only by the
   manifest whose paths it is meant to constrain.
6. Preserve valid not-yet-created output paths under a real existing parent.

### C6, timing accumulation is not exhaustive

Status: Confirmed. Corrected rating: Low. Priority: P2.

Evidence:

- `PageStageTimings` has 23 fields at
  `native/scan-cleanup/src/protocol/progress.rs:15-64`.
- The reconciliation merge at
  `native/scan-cleanup/src/adapters/batch_cli.rs:1368-1392` lists fields by
  hand and omits `deskew_ms`, `render_ms`, and `write_ms`.
- The affected values are diagnostics. The rerun is a classification pass, so
  `deskew_ms`, `render_ms`, and `write_ms` are zero on that path. A future
  classification timing field can still disappear silently.
- The Electron adapter intentionally groups timings into eight user-facing
  totals at `runScanCleanupSidecar.ts:54-68`. That diagnostic subset should
  stay distinct from the exhaustive Rust rerun merge.

Acceptance checks:

1. Implement `AddAssign` or an equivalent exhaustive method on
   `PageStageTimings`.
2. Use that owner for reconciliation. Keep TypeScript's grouped diagnostic
   totals explicitly typed as a subset.
3. Add a test with every field non-zero so a new field forces an explicit
   decision.

## Native findings

### N1, the batch adapter owns too many responsibilities

Status: Confirmed refactor candidate. Priority: P3.

`native/scan-cleanup/src/adapters/batch_cli.rs` is 7,715 lines including its
inline test module. Production code reaches the test module near line 4,746.
`native/scan-cleanup/src/cli.rs` and `pipeline.rs` are three-line re-export
facades. Placement, transport, scheduling, publication, and classification
reconciliation remain coupled in one adapter.

This is known debt, not a newly discovered defect. The earlier synthesis at
`docs/internal/scan-cleanup/audit-2026-08-14/SYNTHESIS.md:141` already records it.

Do not treat file length as a defect. When placement work resumes, move a
complete responsibility and its tests. Remove the wrapper ladder instead of
adding a builder beside it. Behavior, progress order, transaction rollback,
and current native test results must remain unchanged.

### N2, a few invariants live outside the type system

Status: Partial. Corrected rating: Low. Priority: P3.

A raw search finds 675 panic-style calls under `native/scan-cleanup/src`.
Excluding the two dedicated test files `engine/render_tests.rs` and
`domain/options_tests.rs` leaves 459, close to the audit's 462. A strict
production-only total depends on how inline `#[cfg(test)]` blocks are counted,
so the count is not evidence of a product defect.

Of the cited sites:

- `batch_cli.rs:1882-1886` follows a local branch that always initializes one
  of the two decoded planes.
- `batch_cli.rs:1911-1918` depends on the manifest rule that fixed analysis
  input and DPI form a pair. This is the useful type-hardening candidate.
- `batch_cli.rs:2025-2036` is local to a `map_err` closure on a transposed
  `Option` and does not depend on distant manifest validation.

Couple the fixed analysis plane and DPI when decoding. Do not start a broad
`unwrap` removal without a failure case and a narrower invariant.

### N3, non-UTF-8 path length does not undercount

Status: Refuted. Priority: No action.

`manifest_v3.rs:433` does use `to_string_lossy().len()`, but the audit has the
direction wrong on Unix. Invalid byte sequences become UTF-8 replacement
characters, so this can overcount, not undercount.

More importantly, manifest paths arrive through JSON strings and are valid
Unicode. Non-UTF-8 `PathBuf` values cannot enter this production parser. The
existing ASCII boundary test at `manifest_v3.rs:821-834` covers the reachable
admission ceiling. Using the platform-native byte length would make the label
more literal, but it does not close the reported bypass.

### N4, stream detection repeats metadata reads

Status: Confirmed. Corrected rating: Low. Priority: P3.

`manifest_has_stream_inputs` at `batch_cli.rs:991-995` is called from trusted
ink preparation at line 684, `run_page_jobs` at line 862, and
`page_worker_threads` at line 1203. `manifest_worker_threads` performs its own
per-page metadata probe at lines 1671-1689. The paths live in per-run scratch,
and `resolveRasterHandoff.ts:163-173` awaits FIFO creation before starting the
consumer, so a missing-yet-to-be-created FIFO cannot trigger the reported
misclassification in the product path. Compute the classification once and
pass it to the decisions when this scheduler is next edited. Keep a final safe
check at open time. Preserve FIFO replacement and cancellation tests.

### N5, materialized-stream names have a latent same-process collision

Status: Confirmed latent, unreachable in the product. Corrected rating: Low.
Priority: No action.

`batch_cli.rs:997-1006` names a temporary file with process ID and page index.
The public CLI accepts one manifest and exits. Concurrent manifests therefore
run in different processes and have different process IDs. No production API
runs two manifests concurrently in one process. Per-run scratch directories
also separate the Electron callers. The filename would collide if a future
library API ran two manifests in one process with the same metadata directory.
Add a nonce and exclusive file creation if that API is introduced. There is no
current reason to change the shipped CLI.

### N6, native validation and publication safeguards

Status: Positive verified. Priority: No action.

The manifest uses strict field decoding and bounded page and path admission.
The batch adapter checks normalized and inode aliases, stages same-directory
backups, rolls back failure and panic, and serializes streamed-page admission.
These are load-bearing invariants. Any N1 refactor must retain their existing
tests and failure ordering.

## Core TypeScript findings

### T1, lossless progress indexing trusts the sidecar total

Status: Confirmed defense-in-depth gap, as the audit states. Corrected rating:
Low. Priority: P3.

The non-null assertion exists at
`scan-cleanup-core/runLosslessScanCleanup.ts:173-175`. The progress codec at
`packages/contracts/scan-cleanup/nativeProtocolV3.ts:767-819` requires a
page-complete page number from 1 through the envelope's `totalPages`. The
native writer sets that total to the manifest page count, so the shipped
sidecar cannot produce the claimed `undefined` insertion. A malformed sidecar
can report a larger internally consistent total, which the TypeScript decoder
does not compare with `pageNumbers.length`.

If `undefined` nevertheless reached the public progress shape, the contract at
`packages/contracts/scan-cleanup/progress.ts:51-68` would reject it rather than
silently accepting an over-count.

Cross-check the first native total against the submitted manifest, or ignore an
out-of-range page number before indexing. Test a progress envelope whose total
is larger than the requested manifest.

### T2, the resolver logs a constant mismatch count

Status: Confirmed cosmetic issue. Priority: P3.

`scan-cleanup-core/createPagePlanResolver.ts:58` always logs `mismatched=0`
because mismatch is a hard error. Remove the token when touching this log. Do
not add a near-miss counter without a defined diagnostic use.

### T3, lossless DPI is resolved twice

Status: Confirmed cleanup. Priority: P3.

`scan-cleanup-core/runLosslessScanCleanup.ts:87-101` computes `dpi`, then
repeats the same resolution for `raster.dpi` when detection exists. Reuse
`dpi`. This has no current behavior impact.

### T4, raster budgeting is strong but scratch freshness is qualified

Status: Partial positive. Corrected rating: Low. Priority: P3.

The cited scratch ownership, `EPERM`, symlink, liveness, floor, reserve, and
unknown-estimate fallback rules are present. The audit's statement that an
active run naturally refreshes the root directory mtime needs a limit. Creating
or removing a child updates the root mtime. Writing an existing child does not.
An unusually long run with no directory-entry changes can cross the stale-age
threshold if another startup sweep runs concurrently.

The sweep age is 24 hours. PID liveness protects only
`scan-cleanup-rasters-<pid>` retention roots. Ordinary `mkdtemp` run roots rely
on mtime alone. This pass found no evidence that a normal run approaches 24
hours, so the residual stays P3 and conditional.

Preserve the raster-budget behavior. If scan cleanup can run longer than the
sweep age, add an explicit active marker or registry and test a live root whose
existing child changes without changing the root mtime.

## Electron and renderer findings

### E1, request signatures are stable for the current renderer builder

Status: Partial, blocked by the current renderer builder. Corrected rating: Low.
Priority: No action.

`electron/features/scan-cleanup/createScanCleanupService.ts:418` uses
`JSON.stringify`, but the service does not receive the renderer's original
object. `packages/contracts/scan-cleanup/ipcRequestCodecs.ts:763-903` validates
and rebuilds the start request with fixed object-key order. It does not
canonicalize optional-key presence, and it preserves `sourcePageNumbers` array
order at lines 823-838. Core later sorts the page scope in
`scan-cleanup-core/pageScope.ts:21-55`, so reordered arrays are semantically
equivalent but can still produce different service signatures. The only current
renderer builder already sorts multi-page selections at
`useScanCleanupWorkspaceSession.ts:266-274`.

Direct unit calls can bypass the codec, but that is not a production renderer
path. A future direct service caller could reproduce the key-order behavior.
A field-based signature may be clearer, but it is not needed to fix the
reported renderer restart scenario with today's single payload builder. If a
second payload builder or a direct service caller appears, compare normalized
typed fields and add equivalent-request join tests.

### E2, completed page numbers do not drive active processed-page UI

Status: Partial, renderer effect refuted. Priority: No action.

The service does assign every requested page to the completed job at
`createScanCleanupService.ts:590-596`. The renderer helper at
`app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts:173-193`
returns processed pages only for queued, running, and handoff states. It
returns an empty set for completed jobs. The service's completed list therefore
does not make an excluded page look cleaned in that UI.

Progress events may count a page as complete after analysis excludes it. During
queued, running, and handoff states that set reaches the thumbnail badge through
`useScanCleanupRunSession.ts:146` and `ScanCleanupThumbnailRail.vue:223`. That
badge means processing settled, not that the page appears in the output, and it
clears at terminal state. The audit's claimed completed-state path is still
refuted.

### E3, generated-document opening can hold the run guard forever

Status: Confirmed. Corrected rating: Medium. Priority: P1.

`scanCleanupRunCoordinator.ts:316-325` waits for `openGeneratedPdf` before it
clears the active job and run guard. The installed dependency at
`app/modules/workspace-shell/composables/useScanCleanupRunCoordinator.ts:73-79`
awaits `openDocumentDirect` and the new-tab handoff. The single-document IPC
open at `electron/features/documents/createDocumentsPreloadFileClient.ts:615-618`
is absent from the timeout map at lines 89-105, and
`electron/preload/ipcClient.ts:89-92` applies no default timeout. Broker
admission has a 15-second deadline in
`electron/features/documents/main/openInputPaths.service.ts:44` and 212-224,
but later open work remains unbounded. A promise that never settles blocks all
future runs until the renderer reloads.

Acceptance checks:

1. Add an abortable end-to-end open deadline at the document-open owner or an
   equivalent operation lifecycle.
2. Clear the scan-cleanup run guard on bounded failure.
3. Do not let the abandoned open complete later and claim a tab after another
   cleanup run begins.
4. Test success, rejection, timeout, late completion, coordinator disposal,
   and a second run after timeout.

### E4, capability and owner lifecycle safeguards

Status: Positive verified. Priority: No action.

Output access is time-bounded and released on owner lifecycle events. Active
jobs cancel on renderer failure and detach on navigation. Reconnect and
terminal replay remain bounded. Preserve these behaviors in any E3 lifecycle
change.

## Verification runs

The native verification lane ran these focused tests from `native/` against
the unchanged audited source on macOS 26.5.2 with Rust 1.89.0, Cargo 1.89.0,
Node 24.11.1, and pnpm 10.32.1. This task changed documentation only, so no
code-change CI gate applies.

| Command | Result |
| --- | --- |
| `cargo test -p evb-scan-cleanup --lib manifest -- --nocapture` | 20 passed, 0 failed |
| `cargo test -p evb-scan-cleanup --lib streamed -- --nocapture` | 3 passed, 0 failed |
| `cargo test -p evb-scan-cleanup --lib first_stream_task_failure -- --nocapture` | 1 passed, 0 failed |
| `cargo test -p evb-scan-cleanup --lib windowed_stream_task_failure -- --nocapture` | 1 passed, 0 failed |
| `cargo test -p evb-scan-cleanup --lib batch_failure_rolls_back -- --nocapture` | 1 passed, 0 failed |
| `pnpm exec vitest run tests/unit/electron/resolveRasterHandoff.test.ts tests/unit/electron/scanCleanupDurability.test.ts tests/unit/electron/scanCleanupService.test.ts tests/unit/app/modules/scan-cleanup/scanCleanupRunCoordinator.test.ts` | 4 files and 51 tests passed, 0 failed |

The rollback test prints its intentionally triggered page-worker panic before
passing. That output is the tested failure path, not a test failure.

## Implementation slices

This audit should not become one broad scan-cleanup rewrite. The safe slices
are:

1. Path-boundary hardening for C5, with preview coverage and native defense.
2. Abortable generated-document handoff for E3, owned by document opening.
3. Warning-code design and aggregation coverage for C2, followed by
   matched-canvas parity fixtures for C1. Do not change fitting until the
   fixtures expose an unacceptable delta.
4. Small contract hardening for C3 and C6.
5. Opportunistic cleanup for C4, N1, N2, N4, T1 through T4.

Each implementation slice needs its own tests, normal repository gates,
CodeRabbit CLI review, and Cubic pre-push review under the repository rules.
This verification task does not implement or publish those changes.

## Review record

Opus 5 High and Fable 5 High independently inspected the ledger and cited
source. Both returned `ACCEPT WITH CHANGES`.

Accepted advice:

- Fable corrected the C5 description, completed the C3 consumer list, narrowed
  E1's canonicalization claim, credited the audit's own T1 framing, and asked
  for consistent rating vocabulary.
- Opus found the live C2 string parser and aggregation branch, clarified the
  geometry-preflight constraint on C5, tightened N2 and N4 evidence, completed
  the C6 zero-timing rationale, corrected E3's timeout citations, and identified
  the existing parity harness for C1.
- Both agreed that C5 and E3 are the only P1 items and that the other
  dispositions remain supported.

Tie-break applied:

- Opus proposed changing E2 from None to Low because excluded pages can carry a
  transient processed badge while a run is active. Fable verified the audit's
  actual completed-state claim and accepted the refutation. Following the
  requested preference for Fable, the ledger keeps E2 at None and No action.
  The transient progress semantics remain recorded in the E2 evidence.

Advice not adopted:

- Neither review justified changing any other priority. C2 moves ahead of C1
  within the P2 implementation slice because its English string is already a
  programmatic key, but it is not promoted to P1 without a current wrong-output
  reproduction.

## Closure record requirements

For each future implementation slice, record the finding IDs, baseline SHA,
reachable path, user impact, reproduction or static-evidence class, non-goals,
test commands, closure commit, CI result, CodeRabbit disposition, and Cubic
result. A finding is not closed by a code change alone.
