# Scan-cleanup live-run improvement ledger (2026-08-07)

Status: implementation, local verification, and final independent review complete; remote reconciliation/publication follows this ledger commit. This ledger is based on a live 392-page development-app run and two independent read-only Claude Opus 5 passes (design and final implementation review). It supersedes guesses made from the screenshot alone and does not reopen completed stage-28 audit findings.

Update (2026-08-10): the universal 2x/600-DPI continuous-source policy recorded
below was superseded after a 300-DPI, 158-page scan demonstrated a roughly 10x
runtime regression and a 994 MiB raster window. Detected rasters now retain their
measured source grid; only binary pages without a measurable raster use the
600-DPI synthesis floor. The remainder of this ledger is retained as historical
evidence for the decisions made on 2026-08-07.

## Goal

Make a long cleanup run materially faster and smaller, make progress truthful and geometrically stable, make matched-canvas margins mean what the UI promises, and prevent stale preview/settings state from misleading the user.

The reference input is:

- `/Users/evb/Desktop/pdf/History of Ancient Rome_2005 raw.pdf`
- 392 pages, 38,272,924 bytes
- already-compact 360-DPI MRC: 392 full-page 1-bit JBIG2 selection masks plus continuous-tone JPX layers

The pre-fix reference output is:

- `History of Ancient Rome_2005 raw — cleaned.pdf`
- 59,312,694 bytes, 1.550x the source
- 331 `bw`, 57 `mixed`, 2 `grayscale`, 2 `color`
- 331 generic-region JBIG2 images and 57 JBIG2 stencils stored at 720 DPI

Evidence is preserved under `.devkit/tmp/scan-cleanup-ledger-evidence/`; the source/output `pdfimages -list` reports are the byte-accounting ground truth for this run.

## Findings, corrected against the code

### F1 — Size and most of the runtime have the same cause

`SCAN_CLEANUP_BINARY_LAYER_RENDER_SCALE = 2` currently keys off whether the *output* carries a binary layer. It therefore sends an already-bilevel 360-DPI source through a 720-DPI RGB work grid and embeds the resulting B/W masks at 720 DPI.

That is useful for a continuous-tone source being thresholded for the first time: its gray edge coverage can place a better binary transition on the finer grid. It creates no new edge information when the dominant source layer is already a 1-bit mask. Poppler only expands those samples.

Consequences in the reference run:

- about 84 MiB of temporary PPM data per page and about 32 GiB over the run;
- native `render=554.5s`, `normalization=104.6s`, `write=25.6s`;
- about 42.1 MiB of 720-DPI B/W JBIG2 images plus 6.3 MiB of 720-DPI stencils;
- total native wall 831.5s and total conversion wall 969.5s.

This is not an encoder fallback. The assembler already verifies and chooses among JBIG2, CCITT G4, and Flate. The current 2.5x compact-source byte guard deliberately permits the 1.55x result; lowering the guard would turn the symptom into a late failure.

### F2 — The streaming pipeline is presented as two sequential phases

On POSIX, Poppler writes a FIFO while native consumes it. Rasterization and native rendering are one fused throughput stage, but TypeScript reports them as separate bands and suppresses native `page-complete` reports until rasterization is declared finished. The meter therefore sits near 26% and then jumps near 84%.

Native also uses a zero-capacity turnstile with an acknowledgement after page processing. That makes the single dedicated reader wait for page N to finish before it even opens page N+1. The TypeScript side launches and budgets three producers, but two mostly block. The reference native wall exceeds the sum of native page timings by about 121s.

### F3 — Toolbar progress width is content-derived

The toolbar centre grid track is `auto`; the meter asks for `min(100%, token-width)` inside that content-derived track. Phase labels, count visibility, and changing digit widths therefore change the meter width. The count and percent slots are conditionally removed rather than reserved.

### F4 — Five millimetres is not five millimetres on a matched canvas

Margins are expanded around the detected content first, then the padded result is fitted back into the fixed document canvas. The requested 5mm is therefore multiplied by the page's fit scale. In the reference run it becomes roughly 4.4–5.0mm depending on the page.

For `matchPageSize`, margin is a property of the final physical canvas: inset that canvas by the requested millimetres and fit content into the remaining inner rectangle. For unmatched pages, expanding the crop outward remains correct.

The preview pixels do contain a pale band, but the existing orange overlay marks the page edge rather than the margin boundary, so white padding on a white viewer is nearly invisible.

### F5 — A final run can display a stale cleaned preview

Starting the final run calls `previewResult.cancel(false)`. Cancellation clears loading and supersedes requests but retains the last result. If a margin edit's debounced preview has not completed, the old raster can remain visible for the entire run without a loading/stale notice.

### F6 — One malformed legacy settings entry aborts all migration

Legacy settings migration decodes each document inside one uncaught loop. One malformed override rejects `get()`, losing otherwise-valid global settings and other documents. New writes must remain strict; legacy import should salvage valid entries and emit one aggregate warning.

### F7 — MRC extraction is serial, but its remaining value must be measured

The 105.4s MRC extraction stage processes independent chunks serially. The previously reported qpdf-object-table reparse is already fixed by a once-promise and must not be redone. Extracted masks currently protect source ink during rendering; the old source-MRC output representation is otherwise unreachable. First retain the protection and parallelize chunks through the shared bounded mapper. Deleting extraction for bilevel sources requires a controlled corpus comparison and is not assumed safe.

## Decisions and rejected shortcuts

1. Suppress supersampling only when the source has a **dominant full-page bilevel layer**, not merely any incidental 1-bit decoration. Keep the global 2x/600-DPI policy for genuine continuous-tone-to-binary conversion.
2. Keep matched-canvas DPI a document-level source fact, independent of selected run scope, so a one-page rerun and a full run cannot move the canvas.
3. Report one fused `rendering` band on FIFO transports, driven from native page completion. Preserve a separate `rasterizing` band only on non-streaming transports.
4. Use fixed progress weights. Runtime-adaptive weights introduce a second owner of displayed percent and can rewind it.
5. Do not add a user-facing DPI control. Source detection, the document canvas, and the per-page plan remain the authorities.
6. Do not lower the compact-source byte cap as a substitute for smaller output.
7. Do not globally lower the 2x rule, switch blindly to CCITT, or add lossy/symbolic JBIG2 without a separate quality and compatibility campaign.
8. Do not parallelize native page processing for FIFO inputs. The prior Rayon/FIFO deadlock guard remains. Only add bounded reader look-ahead on the dedicated reader thread.
9. Do not claim that all color-to-B/W documents must be smaller than every source PDF. The correct product expectation is representation-aware: discarding continuous-tone layers generally shrinks ordinary scans, while an already compressed bilevel source should not be inflated by redundant sampling.

## Staged implementation

Each stage is independently committable on `main`. Reconcile with `origin/main` before each native/diagnostic conflict boundary. Every stage runs its affected tests; final verification runs lint, typecheck, the unit projects, native format/clippy/tests, and a real reference conversion.

### S1 — Source-representation-aware render DPI

Files:

- `scan-cleanup-core/sourceDpiDetection.ts`
- `scan-cleanup-core/types.ts`
- `scan-cleanup-core/policy/effectiveOptions.ts`
- final and preview call sites
- effective-options, DPI-detection, document-canvas, and pipeline unit tests

Implementation:

- derive `hasDominantBilevelLayer` only when a 1-bit image/mask covers at least 95% of the dominant page raster area;
- rename the ambiguous `carriesBinaryLayer` policy input to `outputCarriesBinaryLayer`;
- return source DPI when the output is binary and the source already has a dominant bilevel layer;
- otherwise retain `max(sourceDpi * 2, 600)` and existing allocation guardrails;
- feed the same source fact to preview, final per-page plans, and document-canvas planning.

Acceptance:

- policy pins: `(360, binary output, dominant bilevel source) -> 360`; `(360, binary output, continuous source) -> 720`; `(200, binary output, continuous source) -> 600`; `(200, binary output, dominant bilevel source) -> 200`;
- incidental small 1-bit decorations do not suppress supersampling;
- partial and full runs plan the same canvas DPI;
- reference output is targeted at `<= 0.85x` source and native wall `<= 260s`; these are measured acceptance targets, not hard-coded production limits;
- corpus/paired-image audits show no new word loss or stroke fragmentation.

### S2 — Truthful progress and stable toolbar geometry

Files:

- `scan-cleanup-core/createScanCleanupProgressReporter.ts`
- `scan-cleanup-core/runScanCleanupConversion.ts`
- scan-cleanup progress contract and formatter
- `ScanCleanupToolbar.vue`, reusing `ScanCleanupStableWidthText.vue`
- core/electron/app tests and the existing layout-stability quarantine proof

Implementation:

- use weights `normalizing 1, probing 3, extracting 6, rendering 78, collecting 1, assembling 9, handoff 2`;
- on streaming transport, emit rendering progress from the first native page completion and never emit a fake sequential rasterizing band;
- keep percentage monotonic across any quality-path profile change;
- compute an optional ETA in the reporter from an exponentially weighted per-unit duration; withhold it until at least 5 units and 10 seconds in the current stage;
- give the centre toolbar track the fixed width token, make the meter fill it, and reserve stable count/percent slots using the existing stable-width component;
- map native manifest indices explicitly rather than relying on scope-array coincidence.

Acceptance:

- streaming tests report no `rasterizing` stage and report `rendering` before producers finish;
- percent never rewinds; ETA is absent while under-sampled and bounded on a synthetic fixed-rate run;
- the progress element has identical width for probing, `313/392`, and handoff states;
- reference progress advances throughout the fused pipeline with no late 26% -> 84% jump.

### S3 — Exact matched-canvas margins and honest preview state

Files:

- native content/placement code, with minimal coordinated `render.rs` hunks
- document-canvas and preview planning
- `CleanedCanvas.vue` / preview presentation styles
- native, core, app, and matched-canvas tests

Implementation:

- when page size is matched, inset the final canvas by requested physical margins, fit content into the inner rectangle, and keep the outer document rectangle unchanged;
- leave outward crop expansion unchanged for unmatched pages;
- serialize metadata that describes the delivered margin, and warn through the existing warning channel when requested margins cannot apply because cropping/content detection is unavailable;
- draw a margin-boundary ring from applied-margin metadata while the margin control is focused or being edited; do not tint the document permanently;
- bind displayed preview results to the settings/request key that produced them; clear a result when cancellation leaves it mismatched instead of showing a stale raster as current.

Acceptance:

- 5mm requested on differently sized/cropped pages produces a `5.0 +/- 0.1mm` final-grid margin-box inset while the PDF page rectangle remains unchanged; the visible soft paper band is never smaller and may be enlarged by content alignment;
- unmatched behavior retains current outward-rounded sample preservation;
- preview and final use identical geometry;
- changing margins then immediately starting a final run cannot leave `loading=false` with the previous settings' cleaned result.

### S4 — Bounded FIFO look-ahead

Files:

- `native/scan-cleanup/src/adapters/batch_cli.rs`
- manifest V3 and the TypeScript manifest builder/handoff policy
- native integration tests

Implementation:

- carry the already-owned raster concurrency/window into the manifest, defaulting conservatively for direct CLI callers;
- let the dedicated reader materialize at most that bounded window while processing stays one page at a time;
- release permits on page completion and preserve cancellation/failure cleanup;
- retain the existing FIFO deadline regression and the one-worker native deadlock guard.

Acceptance:

- a slow-task test proves bounded high-water, cancellation cleanup, and no failure hang;
- the reference run's native wall falls by at least 80s against the S1 measurement and `sum(page timings) / native wall > 0.93`;
- scratch high-water stays inside the handoff policy's declared budget.

### S5 — Bounded concurrent MRC extraction

Files:

- `scan-cleanup-adapters/extractPdfMrcLayers.ts`
- electron pipeline tests

Implementation:

- map independent extraction chunks through the existing bounded raster-page mapper at `policy.rasterConcurrency`;
- retain exactly one qpdf object-table inspection through the existing once-promise;
- aggregate completion counts so progress remains monotonic.

Acceptance:

- concurrency never exceeds policy;
- qpdf JSON inspection occurs once;
- extraction progress is monotonic and the reuse count is unchanged;
- reference extraction wall is targeted at `<= 40s`.

### S6 — Resilient legacy migration

Files:

- `electron/features/scan-cleanup/createScanCleanupSettingsStore.ts`
- settings-store tests

Implementation:

- isolate malformed legacy document entries, malformed legacy globals, and an invalid/oversized legacy envelope;
- salvage valid pieces and emit one aggregated warning with counts and the first cause;
- keep current-file decoding and every new update/write strict.

Acceptance:

- one malformed legacy document does not discard valid siblings or global settings;
- malformed global settings do not discard valid document entries;
- oversized/unparseable legacy input is skipped without damaging the current store;
- malformed new updates still reject.

### S7 — Verification, independent review, reconciliation, and publication

Verification:

- affected Vitest projects and focused regression files after every stage;
- `pnpm lint && pnpm typecheck`;
- `cargo fmt --check`, `cargo clippy --release`, and `cargo test --release` in each touched native crate;
- real reference-book conversion with preserved representation/provenance evidence;
- acceptance2/campaign corpus verification and generated-PDF compatibility/visual verification;
- do not recalibrate image-quality audits to hide a product regression.

Review and delivery:

- ask a fresh read-only Claude Opus 5 session to review the complete diff, tests, evidence, lifecycle ownership, and failure cleanup;
- apply only findings supported by current code/evidence and record disagreements;
- commit review fixes separately;
- fetch and reconcile with `origin/main`, rerun conflict-affected checks, and push `main`.

## Explicit deferrals

- Magnification-aware DPI above source DPI: revisit only if S1 visual evidence shows degradation on pages truly enlarged by the matched canvas.
- Resumable long runs: revisit after the measured S1/S4/S5 runtime; its value changes sharply if the full book falls below roughly four minutes.
- Deleting the unreachable source-MRC output path: handle with the extraction decision after corpus evidence, not inside this performance fix.
- Lossy/symbol-dictionary JBIG2: separate product-quality and licensing/compatibility decision.
- Permanently tinting margin bands: rejected because it obstructs document-quality judgment.

## Implemented outcome

### Stage commits

| Stage | Commit(s) | Outcome |
| --- | --- | --- |
| Ledger and independent design review | `756be00f8` | Reconstructed the live run from logs and PDF structure, then recorded decisions before implementation. |
| S1 source-aware render DPI | `7e2d17290`, `acbfa31ee` | Dominant full-page bilevel sources retain their source grid; continuous sources still receive the 2x/600-DPI thresholding policy. The review follow-up recognizes stencils and keeps a finer dominant mask grid instead of accidentally downgrading it to a lower-resolution tonal companion. |
| S2 progress and toolbar | `49ea68584` | Streaming conversion is one weighted `rendering` stage with ETA; the toolbar track and numeric slots have stable geometry. |
| S3 matched margins and preview truth | `c8c8c5725`, `1469e3cd3` | Final-canvas insets preserve physical margins, preview uses the same geometry, and stale results are not presented as current. |
| S4 bounded FIFO look-ahead | `01a713213`, `34adf4099`, `b8a6a23e8`, `8d3d8a844`, `7a2772799` | Reader materialization overlaps native work within the declared raster window. The review follow-up makes future FIFO opens nonblocking/cancel-aware and budgets both producer and native materialized copies. |
| S5 bounded MRC extraction | `a01216014`, `b3ffe76a9`, `7a2772799` | Independent chunks extract concurrently while qpdf inspection remains once-only and progress stays monotonic. Successful pages from a partially failed chunk survive; abort still terminates the operation. |
| S6 migration salvage | `4c6bd1182` | Valid legacy settings survive malformed siblings; current writes remain strict. |
| Cleanup and verification support | `5c6d578bc`, `647cbbbb1`, `7e61cfc25`, `b1d27d049`, `fac13f27d`, `92e8c3955` | Removed obsolete shims, kept corpus DPI planning aligned, made restricted-renderer verification and weak word-loss comparisons fail closed, added negative controls, and refreshed only shifted coordinates for already-baselined clone groups. |
| Measured outcome | `7278417a9` | Recorded the real 392-page conversion rather than extrapolating from unit timings. |

### Reference-book result

The measured 392-page parity conversion is at
`.devkit/tmp/scan-cleanup-ledger-evidence/reference-full-after/History of Ancient Rome_2005 raw — cleaned.pdf`.
Its adjacent machine summary is the authority for these figures:

- output: 34,274,282 bytes versus 38,272,924-byte source, ratio `0.895523`;
- size change: 10.5% smaller, reversing the previous 59,312,694-byte / `1.550x` inflation;
- total wall: 530.2s versus 969.5s, 45.3% faster;
- detection: 175.3s; conversion after detection: 354.9s;
- modes unchanged at 331 `bw`, 57 `mixed`, 2 `grayscale`, and 2 `color`;
- all 392 outputs in this source-specific run use the 360-DPI source grid; the policy still supersamples continuous sources that are thresholded for the first time, and the final parser recognizes both ordinary 1-bit images and PDF stencils while retaining any finer dominant mask grid.

This benchmark predates the final Opus follow-up commits `acbfa31ee`, `7a2772799`, and `fac13f27d`. It validates the primary performance implementation, not a remeasurement of the later guardrails and diagnostic semantics. Those follow-ups do not deliberately add per-page image work, but no post-review runtime or size claim is inferred without another full conversion.

The aspirational `<= 0.85x` size target and `<= 260s` conversion target were not met. They were measurement goals, not product limits, and no quality or compatibility rule was weakened to force them. The remaining bytes belong chiefly to the 57 mixed and four continuous-tone pages; deleting their retained tone would be a different product-quality decision. The implemented result satisfies the user's representation-aware expectation for this already highly compressed MRC source: the predominantly B/W conversion is smaller despite retaining necessary mixed/color content.

### Progress and margin result

- Streaming logs now advance through `rendering:0/392 ... rendering:392/392`; they no longer present rasterization and native cleanup as sequential work.
- Reporter tests pin monotonic weighted progress and the ETA warm-up rule.
- Toolbar tests pin a fixed central track with reserved count and percent widths.
- Native/core/app tests pin a requested final-grid 5mm inset to at least `5.0mm`, including rotated and differently cropped matched pages. Placement/alignment can create a larger visible paper band; it must never make the requested inset smaller.
- `appliedMargins` records the requested physical inset, while `softMarginsPixels` records the delivered final-grid paper band. Warnings now name the requested margin box and final conversion aggregates affected pages instead of emitting misleading per-page spam.
- Preview and Rust have mirrored implementations of the same geometry contract, warning semantics, and parity fixtures; they do not literally share a cross-language runtime function. Stale-result invalidation is covered at the preview ownership boundary.

### Quality and compatibility evidence

- Acceptance2 corpus: 24/24 assertions, artifact audit 6/6 pages, no page or neighbor failures; evidence at `.devkit/tmp/scan-cleanup-ledger-evidence/acceptance2-after-2/corpus-summary.json`.
- Rome regression corpus: 29/29 assertions, including the visually inspected legitimate torch/staff boundary component; evidence at `.devkit/tmp/scan-cleanup-ledger-evidence/regress-corpus-final/corpus-summary.json`.
- Word-loss audit: acceptance2 analyzes 6/6 pages with zero flags and zero suppressed comparisons at `.devkit/tmp/scan-cleanup-ledger-evidence/acceptance-word-audit-post-review.json`. Linguae page 2 is no longer called automatically clean: canonical alignment covers only `0.594426` of source ink and `0.218914` of cleaned ink, so the audit suppresses classification and `--fail-on any` exits nonzero. Crop-level inspection found no visible product regression, but automation deliberately leaves that page uncertified. Synthetic solid and sparse invented-ink controls both fail.
- Generated-PDF compatibility classification covers representative pages 1–10, 45, 120, 200, 300, 389, and 392 at `.devkit/tmp/scan-cleanup-ledger-evidence/reference-full-verification-post-review/compatibility-classification.json`. The bundled restricted renderer cannot decode two JPX-only pages, so the honest result is `requires-compatible-renderer`, not a pass or a product failure. Warning attribution and the negative classifier path are unit-pinned.
- The exact generated PDF was also opened in the EVB Viewer product renderer; pages 1 and 392 rendered successfully. Those product-renderer captures plus the visible Poppler contact sheet establish compatibility for the sampled pages; the classifier report alone does not claim full visual verification.

### Gate evidence

- The pre-review full release run at `.devkit/gates/2026-08-07T012851Z/summary.json` is retained as historical evidence only; it does not validate the Opus follow-up commits.
- Post-review validation and coverage passed at `.devkit/gates/2026-08-07T051419Z/summary.json`: lint, typecheck, strict build, Electron blocking smoke, 930 unit files / 6,940 passing tests / seven intentional skips, and the coverage ratchet. Release verification initially stopped because review edits shifted line numbers for ten already-baselined clone groups; semantic inspection found no new clone family and `92e8c3955` refreshed only those coordinates.
- The clean rerun at `.devkit/gates/2026-08-07T052136Z/summary.json` passed release verification, the entire native workspace, repeated coverage, macOS packaging/native-tool smoke tests, and release-cut preflight.
- Touched-crate `cargo fmt --check`, release clippy with warnings denied, and release tests passed after the review fixes: 345 unit tests passed, four intentionally ignored, plus 44 integration/harness/CLI tests and doc tests.
- Focused review coverage passed 14 script tests and 180 pipeline/preview/detection tests, including weak-alignment failure, sparse invention, partial MRC salvage, abort propagation, bounded FIFO success/failure/cancel, scratch fallback, and exact millimetre margin cases.

### Methodology corrections made during implementation

- The previous assumption that every binary output benefits from 2x rendering was narrowed to continuous-source thresholding; existing dominant 1-bit information is not upsampled.
- The acceptance artifact failure was fixed through matched-canvas placement/margin semantics, never by lowering image-quality thresholds.
- Word-loss comparisons now consume canonical crop, matched-canvas scale, affine transform, and placement metadata from the conversion summary. Empirical fitting remains only for old summaries and unsupported/dewarped geometry.
- One-bit tolerance keys off bit depth rather than only the PDF `stencil` spelling, because Poppler may report equivalent bilevel output as an `image`; dominant-source parsing recognizes both spellings.
- “Invented component” requires both a material unsupported area and at least 25% unsupported component ink, but no longer requires a densely filled bounding box. This preserves a resampling-fringe exemption while solid and sparse 100%-unsupported negative controls fail.
- The scanner-boundary baseline was not broadly exempted: one exact physical bbox was refreshed after source/output crop inspection showed the current component is the legitimate torch/staff drawing.
- The S4 `>=80s` stage-only wall improvement, S4 scratch high-water, and S5 `<=40s` extraction target were not independently measured after implementation. The reference timing is aggregate; bounded-window, budget-accounting, and concurrency tests prove the safety model but are not substituted for missing stage benchmarks.

## Final independent review and publication

The required fresh read-only review ran with exact model `claude-opus-5`, high effort, session `45cc2585-c021-4563-94c2-96ee838e077b`. It reviewed the complete implementation, tests, evidence, lifecycle ownership, and failure cleanup. Supported findings were applied in `acbfa31ee`, `7a2772799`, and `fac13f27d`:

- retain a finer dominant bilevel mask grid and recognize `stencil` sources;
- prevent a windowed FIFO task from hanging on an unwritten future producer, and account for both producer and native scratch copies;
- keep successful MRC pages from a partly failed chunk, propagate aborts, and use manifest source indices rather than array position;
- make margin warnings precise/aggregated and pin production millimetre conversion;
- classify restricted-renderer JPX limitations without describing an unrendered page as verified;
- make weak word-loss comparisons fail closed and remove the sparse-component blind spot;
- qualify the duplicated TypeScript/Rust geometry ownership and every unmeasured target in this ledger.

One limitation remains explicit rather than hidden: Linguae page 2 cannot currently be certified by the automated word-loss alignment, even though crop inspection is visually clean. The diagnostic now fails closed until its canonical geometry/alignment evidence becomes strong enough. No product threshold was weakened to turn that uncertainty green.

Publication procedure: commit this final ledger, fetch `origin/main`, reconcile without force, rerun conflict-sensitive checks if upstream moved, then push `main`. The definitive remote tip is reported in the delivery handoff because it cannot be known inside the commit that creates this record.

## Stop conditions

Stop and reassess instead of forcing the ledger if any of these occur:

- source-aware DPI creates measurable contour loss versus the 720-DPI output;
- the dominant-layer classifier cannot distinguish incidental bilevel art from a page selection mask;
- FIFO look-ahead reproduces a cancellation/deadline hang;
- exact margins require changing the matched PDF page rectangle;
- output size improves only by weakening image-quality checks.

## Continuation audit and corrective changes (2026-08-09)

This continuation records a second-machine audit of two independent problems discovered on a 158-page homogeneous spread book. The fixture is `.devkit/fixtures/scan-cleanup/003319_luther_syr_chronik_josua_styllites.pdf`: 158 pages, 134,054,411 bytes, SHA-256 `0530412cf665130b799960c17173c272b203f016350be66198775be3ba86857b`. Every source page is a wide two-page scan; page 1 is a sparse title spread and page 2 is the dense control. The original 2026-08-09 audit handoff is retained at `.devkit/docs/scan-cleanup-fix-ledger-2026-08-09.md`, and exact native gate evidence is retained at `.devkit/tmp/ledger-runs/bug-b/gate-diagnostics-before.txt`.

### Preview invalidation loop

The visible preview was re-cleaned after each incremental spread classification because its cache key contained the growing set of detected spread pages. On this fixture that meant up to 158 same-page cancellations and redraws even though the shared matched-canvas rectangle stayed at the provisional full-sheet size until the last unknown page settled. During each restart, the stale-result presentation also replaced the existing cleaned raster with the raw scan, producing the recorded oscillation.

The correction keys preview validity on the geometry the existing document-canvas planner actually resolved:

- `scanCleanupDocumentCanvasSignature` derives a canonical `[widthPoints, heightPoints, widthPx, heightPx]` identity from the existing plan; it does not introduce a second canvas model;
- detection publishes that identity over the existing job-state channel, normalizing a plan identical to the pre-detection canvas to the empty baseline signature;
- the renderer cache key consumes the canvas identity, whole-document canvas overrides, and the visible page's unresolved classification. Incremental results whose plan is unchanged therefore keep the same key, while a genuine full-sheet-to-half-sheet plan change and a newly reclassified visible page still revalidate it;
- the spread-set signature remains a compact planner/request input, but no longer owns renderer invalidation;
- while a same-page render is being refreshed, the previous cleaned raster remains visible. A result is presented as stale only when it belongs to a different page, so a legitimate re-render cannot flash back to the raw scan.

Unit coverage models a homogeneous four-spread sequence: the first three incremental classifications retain one provisional key, the final classification changes the resolved plan and rekeys once. Separate assertions pin canvas changes, visible-page reclassification, unmatched pages, navigation, and the same-page stale-result presentation. This proves the cache and lifecycle invariants; the headless VPS cannot supply the requested real Electron screen-recording proof.

### Sparse-spread gate audit and detector correction

Pages 1 and 2 were rendered from the real PDF at 150 DPI (`2203 x 1573`) and passed through the production split detector. The audit corrected the initial hypothesis: page 1 did not fail bilateral evidence. It failed only the two gutter gates because the best binary whitespace midpoint did not coincide with the physical low-frequency seam.

| Gate/evidence | Page 1 before recovery | Page 2 control |
| --- | ---: | ---: |
| Tier-1 classification | `single-uncut-page` | `two-page-spread` |
| Confidence | `0.000000` | `0.864128` |
| Aspect ratio / spread score | `1.400509 / 1.000000` | `1.400509 / 1.000000` |
| Whitespace score / x | `0.980511 / 1075` | `0.980651 / 1138` |
| Bilateral / left ink / right ink | `1.000000 / 31717 / 20784` | `1.000000 / 53697 / 168315` |
| Outer-margin score | `1.000000` | `0.124698` |
| Selected local fold / x | `0.086365 / 1142` | `0.581527 / 1268` |
| Dark gutter / soft gutter | `0.000000 / 0.000000` | `0.000000 / 0.000000` |
| Final gutter score | `0.086365` — fail | `0.581527` — pass |
| Standard gate result | gutter and independent-gutter fail; all other gates pass | all gates pass |

The page-1 low-frequency surface profile peaks near `x=1203` (ratio `0.546074`) with `26.525463` mean luminance depression, full sampled-row coverage, and full continuity. The new recovery path searches only a bounded central neighborhood around the already-valid whitespace evidence and requires saturated spread geometry, consistent outer margins, two independently present page bodies, a symmetric local depression, row coverage, continuity, and non-conflicting fold/prior evidence. It does not lower the ordinary dark-, soft-, or fold-gutter thresholds globally.

On the same page-1 raster, the recovery selects `x=1198` (ratio `0.543804`) at confidence `0.699298`; its low-frequency score is `1.000000`, mean depression `24.641827`, coverage `1.000000`, and continuity `1.000000`. Page 2 remains `two-page-spread` at `x=1268`, confidence `0.864128`, and does not enter the recovery path.

Document reconciliation was strengthened separately. When the existing dimension cluster yields agreement of at least `0.80`—which already incorporates dominant-layout support and cutter consistency—a low-confidence dissenter may use an observed whitespace valley within `0.10` of the median. The reconciled cutter is the stable document median, not the ambiguous local midpoint. The original narrow `0.035` path remains for ordinary agreement. A page with no plausible valley is not force-split, and manual layout/split evidence remains authoritative.

### Persistent diagnostics and confidence-label clarity

`SplitDiagnostics` is now serialized as `splitDiagnostics` in every page metadata JSON. It retains aspect evidence, whitespace and selected cutter coordinates, per-half ink/content/surface scores, bilateral and outer-margin scores, the actual selected local fold score, dark/soft/sparse gutter strength, depression, coverage and continuity, every hard-gate boolean, the recovery flag, and abstention. Existing `tier1Verdict`, final `layoutClassification`, `documentPrior`, `reconciled`, and `clusterAgreement` fields preserve the document-level decision trail. The classify-only CLI pin verifies that these fields remain observable rather than becoming temporary debug logging.

The thumbnail warning now displays the layout classification together with layout confidence and labels it explicitly as layout confidence. Output recommendations and technical details explicitly say output-mode confidence. English and Russian strings were updated together, removing the previous ambiguity in which an `83%` output-mode score appeared directly beneath a low-layout-confidence warning.

### Verification and remaining proof boundary

- 20 focused native split unit tests passed, including faint-valley recovery, landscape-single rejection, strong-consensus median recovery, and a no-valley negative control.
- The complete compact real split-fixture test passed all 33 entries: ten hard cases, nineteen spread controls, and four Luther soft-gutter pages.
- The classify-only page CLI metadata pin passed and verifies persisted gate diagnostics.
- Debug `cargo clippy -p evb-scan-cleanup --lib --tests -- -D warnings`, split-file `rustfmt --check`, and `git diff --check` passed for this change boundary.
- Four focused Vitest files passed 50 tests covering detection publication, preview cache/navigation semantics, same-page presentation, and confidence-label copy.

The VPS is headless, so no Electron E2E or replacement screen recording was produced locally. The direct real-PDF native evidence proves page 1's local verdict is now Spread and page 2 is unchanged; because the local verdict already agrees with a spread-majority prior, post-reconciliation should retain it, but a complete 158-page graphical run is still the honest final proof for both “no visible oscillation” and the final thumbnail label. This limitation is not reported as automated visual verification.

## Completion result (2026-08-09)

This section supersedes projections above with the final continuation measurements. Implementation landed incrementally on `main`; every pushed implementation boundary ran the repository's applicable lint, typecheck, native release, focused regression, and CI gates. A concurrent packaging-resource pin was also corrected after its first main run exposed the stale exact-array expectation.

### Fixture methodology

Both large documents were fully analyzed once. All subsequent implementation iteration used fixed, preselected representative subsets rather than repeatedly converting 392 and 158 pages:

- Rome: pages `16, 46, 49, 56, 57, 60, 71, 94, 96, 100, 119, 154, 300, 308, 351, 352, 361, 373, 385`;
- Luther: pages `1, 2, 3, 10, 80`.

The Rome set covers ordinary and median text, the seven mixed-photo cases, both plate controls, three OCR bbox checks, and bleak/median stroke pages. The Luther set covers the sparse title spread, dense control, adjacent and interior spreads, and the gutter/content-box regression. Only one replacement full Rome conversion was authorized after the three-page OCR-compression slice passed.

### Preview, manual reframe, split, and crop outcomes

- Preview invalidation now follows the resolved canvas plan rather than the growing spread set, and a same-page refresh keeps the last cleaned raster visible.
- Manual content boxes are render/final overrides, not detection-evidence inputs. Releasing a handle refreshes only that page; explicit Re-detect measures automatic geometry beneath the still-authoritative manual override.
- The one-time Luther detection result contains 158/158 final `two-page-spread` classifications. Page 1 recovers x=1198 (ratio `0.543804`); page 2 remains the conventional dense control at x=1268.
- The independently reported gutter/frame dirt was traced to crop authority, not semantic photo ownership. Crop-only frame-rail qualification and seed-local structural extension give page 1 a left content box `145,117,876,1407` and right-local box `212,114,607,1405`, while retaining the title, stamp, publisher, and year.

The headless VPS proves these ownership and geometry invariants through native/core/app tests and real-PDF native plans. It does not claim the unavailable graphical replacement screen recording.

### Photo fidelity

The earlier acceptance CSV rows were broad context crops containing headers and captions, not photograph rectangles. A deterministic audit derived true interiors from each source's authored MRC background using the engine-equivalent 24-pixel continuous-tone tiles, coherent-component selection, text-line veto trimming, and a fixed one-tile inset.

On all seven actual mixed-photo pages (46, 49, 56, 57, 71, 94, 96), final versus source near-white delta is exactly `0.000000`, maximum 16-pixel tile delta is `0.000000`, and zero tiles violate the `0.05` limit. Pages 49 and 56 therefore close the detector-recall gap; page 57 closes the irregular patchwork gap. The owned rectangle is copied uniformly, including its boundary, with no internal feather-to-white. Trusted-MRC ownership is always carved by real text vicinity before foreground subtraction.

Pages 308 and 351 are not mixed photographs: they are a line-art map and a grayscale plate. They retain Phase-A policy rather than source-gray paper: page 308's near-white fraction improves slightly from `0.036914` to `0.035393`, and page 351 remains `0.002758`. Their source-relative tile check is intentionally reported as an inapplicable plate guard, not relabeled as a mixed-photo pass.

### OCR, size, and encoding safety

Source-relative OCR coverage is 389/389 pages (`100%`). Aggregate non-space character retention is `99.9982%`; every source-text page retains at least `99.635%`. Sampled words on pages 49, 100, and 300 preserve bbox width and height within `0.001pt` and overlap the corresponding printed ink.

The first full output exposed 388 uncompressed appended OCR streams totaling 12,141,743 bytes. The late overlay now compresses eligible unfiltered streams before save; a three-page representative run is qpdf-clean, retains exact extracted-text lengths, and stores the OCR streams with Flate. Existing image/JBIG2/JPX streams are not recompressed.

| Layer | Pre-ledger | Phase A | Final |
| --- | ---: | ---: | ---: |
| Bilevel masks | 25.34 MiB | 25.83 MiB | 25.99 MiB |
| JPEG | 4.21 MiB | 4.18 MiB | 4.71 MiB |
| JPX | 0.85 MiB | 1.16 MiB | 1.18 MiB |
| Flate bilevel | — | — | 0.01 MiB |
| Preserved OCR page streams | effectively absent | effectively absent | 2.70 MiB |
| Whole PDF | 31.70 MiB | 32.48 MiB | 35.90 MiB (37,646,723 bytes) |

B1 always compares round-trip-verified JBIG2, G4, and Flate and retains the smallest. B3's standards-compliant shared symbol/text region path remains pixel-exact through per-instance refinement, in-house verification, and `jbig2dec` interoperability. The final 30-page substitution sample is 30/30 exact with zero differing pixels. Its exact 50-page benchmark is nevertheless 3,153,408 versus 3,542,648 generic bytes and about 80 seconds, projecting roughly 24 MiB for the book's masks. It therefore misses both the 12 MiB mask target and acceptable default latency. Shared symbols are retained behind the developer-only `--shared-jbig2-symbols` switch; production/default/WASM paths stay on the safe B1 result. No lossy classifier was enabled to force the size target.

### Stroke consistency

The C1 audit showed that complete producer-authored MRC foregrounds bypass fresh thresholding; route metadata was hypothetical and route flapping was not the fixture's cause. C2 therefore applies an additive, topology-guarded document prior only to complete trusted BW masks with zero requested thickness. Fresh grayscale binarization is deliberately unchanged.

On the fixed 208 dense-page cohort, Phase A's p10/p50/p90 erosion survival was `48.640069 / 51.448616 / 53.886249` (band `5.246180`). Final is `51.963878 / 53.211627 / 53.886249` (band `1.922371`), passing the `<=3` target. Minimum relative ink is `0.999744`; no dense page loses 5%. Pages 60–80, excluding 67 and 71, all remain within one percentage point. Eight sparse/image-heavy pages outside the dense cohort fail a literal all-positive-page relative-ink comparison; that separate limitation is retained in the acceptance CSV rather than hidden.

### Final limitations

- `<=20 MiB` whole-file and `<=12 MiB` mask targets remain unmet: the final image payload alone is 31.88 MiB. The safe exact symbol implementation cannot close that gap.
- The local generated-PDF Electron compatibility harness cannot run on this headless VPS; qpdf, Poppler, native tests, external JBIG2 decoding, and CI provide the available compatibility evidence.
- The plate controls preserve their established cleaned-paper policy and are not counted as mixed-photo source-tone matches.
