<!-- Provenance: copied verbatim from .devkit/analysis/scan-cleanup-audit-2026-08-14/SYNTHESIS.md (untracked working artifact), produced 2026-08-14. -->
<!-- Tracked here so the closure numbers this audit reports can be recomputed and re-read from a clone; the body below is unmodified. -->

# Scan cleanup: final audit synthesis

## 1. Verdict

The current approach is **not converging, and the reason is not that the imaging is hard**. Three defect families have absorbed ~19 corrective landings and at least 9 formal closure declarations with a measured stay-fixed rate of 0/3, and the audit found the structural reason: the fixes were aimed at stages that are architecturally incapable of controlling the defect. Twelve landings targeted the content-box trimmer, but `content.rs:392-408` unions qualified picture bounds outward **after** all trimming, so no trimmer change can ever pull a fold side back in. Four landings targeted stroke weight, but the statistic that accepted them (`scan-cleanup-preview-harness.mjs:390-436`) reduces each word to one mean run length before thresholding, so a single bold letter inside a word is arithmetically erased from the measurement. Meanwhile the artifact the user judges is a different program from the one that ships — different planner call, different canvas, different raster treatment, a renderer that discards the native offset, and a display layer that terminally rejects the corrected frame — so the screenshots the ledger closed on were never evidence about the export. The governance apparatus added on 2026-08-14 regulates *when* a claim may be closed; it does not touch any of this, and the one mechanism it wired blocking measures 169 of ~3380 tuning numbers. The encouraging half: most of what is broken is a wiring choice or a duplicated formula, and the highest-value fixes in this report are **deletions**. If the ownership consolidation lands, the residual genuinely-hard tuning surface is probably much smaller than the ledger's despair implies.

## 2. Root causes

### RC1 — Duplicate-and-wire-the-worse-one

The codebase reliably grows a second implementation beside a correct one and wires the second. This is the single most cross-cutting mechanism in the audit:

| correct thing that exists | worse thing that is wired |
| --- | --- |
| native `placement_offset_x/y` (`batch_cli.rs:3374-3537`) | renderer re-derivation (`placement.ts:128-148`), taken on **every** render because `alignment` is a required prop (`PreviewShell.vue:486`) |
| monotone whole-run `etaSeconds` on the progress contract (`createScanCleanupProgressReporter.ts:232-259`, `progress.ts:46`) — **zero consumers**, verified | renderer estimator fed by 2 of 11 stages and reset at every stage boundary (`useScanCleanupRunSession.ts:162-179`) |
| catastrophe ratchet + corpus + baseline, all tracked in-repo | threshold-count tripwire, the only scan-cleanup-specific gate actually wired |
| component-granularity weight study (`.devkit/analysis/weight-letters/REPORT.md`) that *measures* the defect | word-mean weight proxy that cannot |
| `match_primary_raster_in_memory` materialization | preview path that skips it (`batch_cli.rs:4021`) |

**Symptoms:** seam findings 1 and 2, R14/R15, harness-has-no-caller, unwired-oracles, `placeUniformBox` and the main-process lossless placement block, the four detection state projections.
**Why it recurs:** at the moment of the defect, adding a local formula is one file and no cross-boundary negotiation; consuming the existing one requires a contract field, a currency notion, and a stale state. The cheap move is always the divergent one, and nothing fails when you take it.

### RC2 — Geometry is a monotone append pipeline, and the last stage wins

The content box is decided in four sequential stages where each can move the box in only one direction: trimming can only shrink, the qualified-picture union can only grow (`content.rs:402-405`, `min`/`max`), and the union runs last. `build_trim_geometry` compounds this by aborting an entire side (`content.rs:2062-2068`) when any removable block is `protected()`, and `protected()` is true on a **single** text-mask pixel (`content.rs:1511-1531`) inside a block merged by a ~3.0 × 1.4 mm dilation. Fold geometry has the same shape one level up: `gutter_left_x`/`gutter_right_x` is one Option from one fragile measurement, consumed independently by region excision (`render_plan.rs:157-161`) and rail filtering (`render.rs:1651-1668`), both degrading to no-op on `None`, with no diagnostic distinguishing "no fold" from "fold unmeasurable" (`SplitDiagnostics`, `split.rs:141-190`).

**Symptoms:** R10, R12, R12a, and the twelve failed geometry landings.
**Why it recurs:** every new defect is answered by appending a corrective stage at the end. Because the last stage is monotone-outward, the new stage looks like it fixed the specimen while permanently masking the earlier stages — so the next defect in the same family is guaranteed to be diagnosed at the wrong stage.

### RC3 — Acceptance is measured on a support coarser than the defect, and on a sample that is not the deployment distribution

Two axes of the same failure. **Granularity:** the optimizer (`ink_consistency.rs`) halts on a page-level scalar mid-list; the acceptance statistic (`wordWeights`) averages within a word; the Rust harness has no weight metric at all. The user perceives a letter. Every wired measurement aggregates the defect away before the threshold is applied. **Population:** fixes are accepted on a specimen, so a change that improves 23 lines and worsens 15 (the measured result of forcing Wolf) is landed on the 23 and reopens from the 15. A third symptom sits underneath both: `compareMetrics` (`preview-harness.mjs:493-512`) computes preview-vs-final **agreement**, not correctness — both sides can be equally wrong and the gate is green.

**Symptoms:** R11, R13, S2's "measurement-negative, closed with no code change", the 23/15 non-separability result, and the R13 adjudication failure (the "unrelated" reading was *invited* by an agreement statistic).
**Why it recurs:** the statistic is chosen for what is cheap to compute from a render that already exists, never derived backwards from the complaint.

### RC4 — The artifact the user judges is not the artifact that ships

Four independent divergences, each verified: the matched-canvas planner is invoked only when `final_render` (`batch_cli.rs:2022`); preview and final are planned against different canvases by design (provisional vs full); preview leaves its raster unclipped while final materializes with fold-clip source offsets (`batch_cli.rs:4021` vs `3604-3652`), and **no fold-clip term crosses the contract** (verified — no `foldClip*` field exists in `nativeArtifactCodecs.ts`); and the renderer discards the native offset. On top of that the display layer terminally rejects corrected frames after the 2 s settle window, so even a correct preview can be suppressed. The only seam oracle composes through the renderer's own re-derivation (`preview-harness.mjs:637`), making it structurally blind to the divergence it exists to detect.

**Symptoms:** every closure in the ledger that leaned on a user screenshot (R9→R10 explicitly), R12's own display-layer hypothesis, the seam lens in full.
**Why it recurs:** the divergence is invisible by construction — the tool built to see it was built on the wrong side of it.

### RC5 — Nothing that can see pixels is enforced, and nothing at all is required

Every oracle that can observe output quality is `manual` with zero callers (Rust harness, preview harness, corpus verify, regress). Everything blocking observes code shape or synthetic micro-images (`page_cli.rs`: 4,982 lines, 43 tests, zero `include_bytes!`). Coverage `include` omits `scan-cleanup-core/**` and `scan-cleanup-adapters/**` entirely (~10.4k lines invisible to the ratchet and the zero-execution tripwire). The blocking Electron e2e lane is one file containing no scan-cleanup content while `policy.mjs` routes scan-cleanup packages into it — worse than an absent gate, because the census reports the path as covered. And 30/30 recent commits are direct pushes to `main`, so the maximum achievable enforcement is "the author reads the run". A test now pins `blocking:false` and `continue-on-error:true` as invariants.

**Why it recurs:** wiring an oracle requires a tracked fixture and a stable expectation, and risks turning a gate red on known-broken state. Adding a mechanism costs a doc section. The process therefore reliably produces mechanisms and reliably fails to produce data.

## 3. What to change in the code

Ordered by user-visible consequence per unit of effort. **DELETION** is marked.

**1. DELETE the renderer's placement re-derivation.**
`app/modules/scan-cleanup/geometry/placement.ts:64-148` and its pinning tests. Consume `placementOffsetXPx/YPx` unconditionally; express optimistic repositioning as an explicit `stale` presentation state using the `resultCurrent`/`nativeVerticalCurrent` machinery that already exists. Ship `foldClipLeftPx`/`foldClipRightPx` on the artifact contract so the renderer can crop the source rect (the columns are provably near-paper, so this is a positioning fix, not a loss fix).
*Invariant:* exactly one formula produces the on-screen origin.
*Makes impossible:* preview and export disagreeing on placement for any reason other than a declared stale result — including the fold-clip term, the optical clamp, the overflow slide-back and `intrinsicOverflowTop`, none of which the renderer can currently see.

**2. DELETE the terminal frame rejection in the preview images composable.**
Pin the provisional composition only until a frame carrying a current result arrives; never permanently. Also surface the pinned-vs-live divergence unconditionally — `PreviewShell.vue:745-746` currently gates the only on-screen disclosure on the unrelated `matchPageSize` setting.
*Makes impossible:* the user judging settings from a composition Run will not reproduce. This is the fix that makes every future closure judgement admissible, and it independently tests R12's own display-layer hypothesis for free.

**3. Fix the content-box ownership (R10/R12a).**
`content.rs`: the qualified-picture union at `:392-408` must not re-expand a side the trimmer deliberately retracted; `build_trim_geometry`'s whole-side abort at `:2062-2068` becomes a partial trim to the outer bound of the protected blocks; `text_evidence` requires a minimum pixel count/density instead of one pixel (`:1511-1531`). Also resolve the two-owner problem in the picture qualification itself (early call with `crop_artifact_sides=0` drives the analysis mask, late call re-qualifies the raw mask with clustered sides).
*Invariant:* each side of the published box is decided by exactly one stage.
*Makes impossible:* a fold-side band surviving because a downstream monotone union re-expanded a retracted side — which is precisely why twelve landings aimed at the trimmer could not work.

**4. Give the fold band one owner with a defined degraded mode (R12).**
Replace the bare `Option<f64>` pair with `FoldBand::{Measured{left,right}, Unmeasured{reason}}`; on `Unmeasured`, apply a conservative default derived from cutter position and calibration, and keep the component-level rail filter active. Record the band, its width, and the `None` reason in `SplitDiagnostics`.
*Makes impossible:* two pages of one book receiving different fold treatment because one measurement silently returned `None`, and "no fold present" being indistinguishable from "fold too wide to measure" in every log and every metric.

**5. Await `close`, not `exit`, in the sidecar adapter.**
`runScanCleanupSidecar.ts:231-237`, plus a wall-clock timeout. Every other stdout-consuming child in the repo already settles on `close` (`runNativeCommand.ts:581`, `runOcr.ts:158`, `tesseractRunner.ts:305`, and two more).
*Makes impossible:* a completed, correct run being reported to the user as `native-failure` because the terminal envelope was still in the kernel buffer. Do this first — it is a one-line fix that cleans the observation channel you will be using for everything else.

**6. DELETE the renderer's run-meter feed; consume the contract `etaSeconds`.**
Remove `useScanCleanupRunSession.ts:162-179`; read `state.progress.etaSeconds`. The producer already sees the whole run and is already monotone-clamped and unit-tested. Keep `useScanCleanupPageEta` for detection, where it works.
*Makes impossible:* the meter starving on stage transitions (R14/R15) — because the estimate is no longer derived from a stage-filtered sample at all.

**7. Make transport stop changing output.**
`batch_cli.rs:1148` disables the prior-informed reconciliation rerun whenever *any* input is a FIFO, and FIFO-vs-file is chosen upstream from free scratch space. Either make the rerun replayable for stream inputs or force retained-file transport when reconciliation is needed. Related: `manifest_has_stream_inputs` is any-page, so one FIFO also forces single-threaded page work for the file-backed pages.
*Invariant:* output is a function of (input bytes, options).
*Makes impossible:* the same book classified differently on a full disk than an empty one.

**8. DELETIONS with no behavioural dependency** — do these in one sitting:
- the unreachable `!preview_mode` half of `match_page_sizes` (`batch_cli.rs:~3946-4110`; `eligible` filters `!matched_in_memory`, which is `Some` exactly when `final_render && match_page_size && !ocr_mode`, so a final run always yields an empty set — stranded by `bac8ceab0`, and the charter requires temporary compatibility code to state its removal condition);
- `placeUniformBox` and the main-process lossless placement block in `createScanCleanupPreviewService.ts` (the 3rd and 4th placement implementations);
- the O6 threshold tripwire, its baseline, and its pinning test (see §4);
- `evaluate.rs:1046-1063`, which deserializes the baseline twice and compares it to itself;
- the duplicate `jobs.subscribe` registrations (`scanCleanupMainBindings.ts:37` / `createScanCleanupService.ts:586,628-636`), which leak a listener per reconnect and double every progress push.

**One unverified lead worth an hour before any binarization work:** `bw.rs:895` multiplies an integer median run length by `sample_scale = longer_edge/256`, while `choose_mode`'s uneven-text branch requires `estimated_stroke_width_px <= 8.0` (`bw.rs:1290`) — unsatisfiable once the working raster's longer edge exceeds 2048 px. If that holds, the Sauvola route is dead at every production DPI and one third of the binarization design is unreachable. That changes the size of the tuning problem materially.

## 4. What to change in the process

**Delete first.**

- **DELETE the O6 threshold-count tripwire** (`generate-scan-cleanup-threshold-baseline.mjs`, `named-float-const-baseline.json`, `scanCleanupThresholdCountPolicy.test.ts`). It counts 169 typed float consts against ~3380 inline float literals plus every `u8`/`u16` tuning constant (`RESCUE_SOLID_CAPTURED_MEDIAN: u8 = 96`, `WOLF_SOLID_STROKE_CEILING: u8 = 128`, `BLEED_CRISPNESS_FLOOR: u16`). It operates exactly as specified — the objection is that the specification measures ~5% of its stated target while the approach doc calls it "the one mechanism attacking defect GENERATION". *Anchored to:* a fix that adds three inline literals and one `u8` constant passes it unchanged, which is how constants are actually added in this codebase.
- **DELETE `quarantineGraduationPolicy.test.ts`'s invariants.** It asserts `blocking:false`, `continue-on-error: true` and `consecutiveGreenScheduledRuns < 30` as things that must remain true. A test that turns red when someone strengthens a gate is enforcement rot with a lock on it. *Anchored to:* all 13 scan-cleanup e2e specs being nightly and continue-on-error.
- **DELETE the ledger's closure vocabulary that "closed" can be entered on.** Closure means: the pre-fix specimen was RED on the acceptance statistic and is now GREEN, at the defect's granularity, measured on the export. Nothing else. *Anchored to:* R9 declaring R8 "fixed and attested" the same day R10 records the asymmetry still present.

**Then wire, in this order.**

- **Regenerate `harness-baseline.json` before wiring it.** It records `corpus.realCategories` split=33 / luther=4 / total=50, while `fixtures.json` now holds 34 split fixtures with 5 luther (pinned at `split_real_fixtures.rs:44-49`). The floor was computed against a corpus that no longer exists, and its last change was 38f908f8a on 2026-07-22. Drive the catastrophe entries to zero — `contentLostOutsideCrop: 2`, `classificationErrors: 1`, `offcutMisclassifications: 1`, and the `synthetic-page-number-only` fixture at `iou 0.0 / lostInkFraction 1.0` — and move any genuine exception into a named file with a reason string per entry. *Anchored to:* a 100%-ink-loss fixture recorded as the blessed state.
- **Then add `--baseline` to `pr_native_build_safety`** and a corpus-inventory assertion that fails when the fixture count drifts from the pinned inventory. *Anchored to:* the 33-vs-34 drift nobody noticed; and to the fact that `compare_catastrophes` never reads a denominator, so shrinking the corpus lowers the numbers and passes.
- **Fix the preview harness before wiring it.** `preview-harness.mjs:637` composes each leaf through `resolvePreviewMetadataPlacement`, i.e. the renderer's own re-derivation. Once §3.1 lands there is only one formula and this is automatically correct; wiring it before §3.1 would pin the divergence into a gate. Then track one real spread and add `--check` to a blocking job.
- **Add `scan-cleanup-core/**` and `scan-cleanup-adapters/**` to the coverage `include` and to `checkZeroExecutionCoverage`'s hard-coded roots, and drop the `github.event_name == 'push'` guard.** *Anchored to:* ~10.4k lines where a file can go to 0% executed with no tripwire.
- **One rule, no mechanism:** a red gate on the specimen blocks closure and may only be discharged by a *measurement* — the same gate at the same value on the parent commit — never by a written judgement. And no single-screenshot closure. *Anchored to:* R13's "the gate worked, the adjudication (me) failed" and R10's "I read the user's 20:27 screenshot as proof of fix". Note that R13's adjudication error was *invited*: the gate that was red measures preview-vs-final agreement on word means, so "pre-existing, unrelated" was a genuinely available reading. Fix the statistic (§5) and most of the adjudication load disappears.
- **Decide enforcement once, before wiring anything else:** either a ruleset with `gates_ok` as the single required check and landing through PRs, or an explicit convention plus a pre-push hook running the blocking set. Do not add another advisory gate until one of these holds. *Anchored to:* 30/30 direct pushes, and commit e4c87b401's own post-mortem.
- **Track one process metric: stay-fixed rate, currently 0/3.** It is a measurement, not a mechanism, and it costs nothing. Any governance mechanism that does not move it after two months should be deleted. *Speculative:* that this specific number will change behaviour — but it is the only number in the process layer that is about the user.
- Revisit the rejected docs-only CI fast path. 17 of 34 commits on 2026-08-14 were doc-only at full unconditional CI. That is a measured cost against a decision made without one.

## 5. The measurement problem

**The general rule, as a derivation procedure. An acceptance statistic is valid only if all five hold:**

1. **Support.** Write the complaint as a predicate over the smallest object the user's eye lands on — a letter, a leaf edge, a fold band. That object is the support, and the statistic is computed per-support-instance.
2. **No lossy aggregation before the threshold.** Aggregate across instances only by extremum or high quantile, never by mean. `wordWeights` (`preview-harness.mjs:390-436`) returns one mean run length per word; the R13 defect is one letter inside a word; the mean is unchanged and only the within-word variance grows. That single averaging step is why four landings were accepted on a page the user could see was wrong.
3. **Red on the known-bad input, or the statistic is disqualified.** Calibrate the threshold so the pre-fix specimen fails. This is the highest-leverage rule in this document: it converts "measurement-negative" from a valid closure into a disqualification of the measurement.
4. **Measured on the artifact that ships**, not a proxy render — the export, or a preview proven to be a downscale of it.
5. **Agreement is not correctness.** Preview-vs-final agreement statistics belong in a separate class and can never discharge a user complaint; both sides can be equally wrong.

**Concrete gates for each open class:**

- **R11/R13, stroke weight.** Support: connected component, grouped by text line. Statistic: per-component median ridge width from a distance transform (not horizontal-run means), then per line the count of components exceeding 1.6× the median of their own line's components within a local horizontal window, plus the line-wise p95/p50 ratio. Gate: offending-component count = 0 per page; corpus max on the ratio. **Promote `.devkit/analysis/weight-letters/REPORT.md`'s script to a tracked oracle** — it already measures at this granularity and already sees the defect (+40% ridge width, 88.1% of touched components wider). Do not write a new one.
- **R10/R12a, fold-side box asymmetry.** Support: each side of the published content box per leaf, in mm, relative to the detected text block. Statistic: facing-pair margin asymmetry after fold normalization, and the width of the near-paper run between the box edge and the outermost ink component on the fold side. Gate both in mm on the **exported** page. `scan-cleanup-representative-audit.mjs:344-441` already implements facing-margin asymmetry and leaf-scale mismatch, with pure functions unit-tested at `scanCleanupRepresentativeAudit.test.ts:314-340` — it needs a fixture and a caller, not an implementation.
- **R12, gutter inconsistency.** Support: the page, within a document. Statistic: count of pages where the fold band is `Unmeasured` while a neighbour in the same document is `Measured`, plus per-page residual fold-side dark-column count after render. Gate: fold treatment identical in kind across a document; residual count 0. This gate is only expressible after §3.4 introduces the enum — the measurement and the fix are the same change, which is the point.
- **R14/R15, ETA.** Support: the run. Statistic: fraction of run wall-clock showing a resolved ETA, and |predicted − actual| at 50% completion. Gate: resolved for ≥80% of runs over 10 s, asserted in the unit lane against a driven multi-stage progress sequence. That this is trivially satisfiable by consuming the existing contract field is the tell that R14 is a wiring choice, not a hard problem.
- **Content loss — the class with no user report yet, because nothing looks.** Support: the ink pixel. Statistic: `contentLostOutsideCrop` and per-fixture `lostInkFraction`. Gate: hard zero. A destruction metric must never be a comparison floor; "do not get worse than already-broken" is not an assertion about correctness.

## 6. Forward approach

**Recommendation: (b) consolidate around a single geometry/plan owner and shrink the surface — first and decisively — with (d) narrow the supported document classes as an explicit declaration layered on top. Not (a). Not (c) yet.**

**Against (a), continue hardening.** 19 landings, 0 stay-fixed, 43/70 flagged lines unattributable to the leading suspect, and the obvious global knob trades 23 improvements for 15 regressions. But the honest reading is more useful than "hardening failed": at least three of the four open user-visible rows are **not tuning problems at all**. R10/R12a is a pipeline-order bug, R12 is a double-gated Option, R14 is an unwired field, and the seam is a duplicated formula. Twelve of those landings were aimed at a stage that `content.rs:392` proves cannot control the outcome. So the ledger's evidence is consistent with "the fixes were aimed at the wrong stage" as much as with "the parameter space is non-separable" — and the two are distinguishable by doing (b) and re-measuring.

**For (b).** It is the only option that makes the acceptance statistic *constructible*: you cannot write "preview equals downscaled final" as a gate while four placement formulas exist. It is the only option that is pure deletion, so it shrinks the surface that (c) or (d) would later have to re-validate rather than growing it. And it directly attacks four of the five root causes. The concrete targets are §3.1–3.4 and §3.8. The cost is real — `batch_cli.rs` at ~7,000 lines is simultaneously CLI adapter, scheduler, cache-policy owner, memory estimator, classification reconciler and canvas rewriter, and splitting *that* is a genuinely large piece of work. Do not attempt it as part of this; the geometry consolidation does not require it.

**For (d), as a declaration.** Define the supported class (dense-text book scans, ~300 DPI, two-page spreads — the cohort that produced the current specimens), make the acceptance corpus that class, and give everything else a conservative fallback rather than simultaneous tuning. This is a routing default plus a corpus definition, not new algorithms. Trade-off: users with other scan types get plainer output. Benefit: the acceptance distribution becomes the deployment distribution, which is the precondition for *any* threshold to carry meaning. Do this second, not first, because narrowing the corpus before fixing the seam would just pin the divergence to a smaller set.

**Against (c), for now.** ScanTailor Advanced, Shafait page-frame detection and `archive-pdf-tools` were surveyed on 2026-08-01 and re-implementation was chosen. That decision is defensible for the pipeline as a whole, and MRC composition remains the most self-contained genuinely swappable stage — it is where the weight artifacts appear and it is the one place adoption would delete a large share of the crate. But a small learned model is premature for a specific, checkable reason: **with no component-granularity acceptance statistic there is no label and no validation set.** The labelling problem *is* the measurement problem in §5. (c) is gated on §5 landing, and it should be revisited then rather than dismissed.

**What would change my mind, concretely:**
- If, after the geometry consolidation and with a letter-granularity gate calibrated red on the R13 specimen, the weight family still needs more than three landings without going green corpus-wide — that is direct evidence the binarization/rescue stage is intrinsically non-separable, and swapping composition for a mature engine becomes the right answer immediately.
- If the fold-side overhang survives the `content.rs` ownership fix, the defect is in the picture qualifier's evidence rather than the pipeline order, and the qualifier — not the trimmer, and not the whole crate — is the thing to replace.
- If narrowing to book scans still leaves a global knob trading roughly even wins for losses, non-separability is intrinsic to the target class and (c) is unavoidable.
- If the Sauvola-dead lead (`bw.rs:895` / `:1290`) confirms, one of three routes is unreachable at production DPI and the effective tuning surface is smaller than everyone has been assuming — which strengthens (b) further.

## 7. Sequenced plan

Ordered so that each step makes the *evidence* for the next step trustworthy. Solo maintainer; each step is one to two days.

**0. Clean the observation channel (hours).** `exit` → `close` plus a wall-clock timeout in the sidecar adapter. Independent of everything, fixes a wrong user-visible outcome, and removes a class of spurious `native-failure` reports that would otherwise contaminate every run you observe from here on.

**1. Stop the preview from lying (one day).** Delete the renderer re-derivation, ship the fold-clip terms across the contract, delete the terminal frame rejection, and make the pinned-vs-live disclosure unconditional. *Why first:* until the preview equals the export, every closure judgement in this project is inadmissible and every screenshot is unusable as evidence. It is also mostly deletion, and it independently tests R12's own display-layer hypothesis at no extra cost.

**2. Wire the two oracles you already own (one day).** Regenerate the catastrophe baseline against the current corpus, drive the entries to zero with an explicit exceptions file, add the inventory assertion, add `--baseline` to `pr_native_build_safety`. Fix `preview-harness.mjs:637` to compose through the native placement, track one real spread, wire `--check` into a blocking job. Decide the enforcement question (ruleset or pre-push hook) in the same sitting. *Why here:* after step 1 there is exactly one placement formula, so the harness's containment metrics finally measure something real; wiring before step 1 pins the divergence into a gate.

**3. Rebuild the weight statistic before touching `bw.rs` (one day).** Promote the component-granularity script to a tracked oracle, calibrate the threshold so the R13 specimen is RED, and wire it. *Why before the fix:* the last four weight landings failed because they were accepted on a statistic that was green on the known-bad page. Do not attempt a fifth until the measurement fails on the input you already know is wrong. Check the Sauvola-dead lead in the same sitting — it may shrink the problem.

**4. The two native ownership fixes (two days).** `content.rs` union/trim ownership (R10/R12a) and the `FoldBand` enum with a defined degraded mode (R12). *Why after 1–3:* twelve previous landings on this exact family failed for lack of a gate that could see the result, and step 1 is what makes "measured on the export" possible.

**5. Dependency-free deletions, one sitting (half a day).** The unreachable `!preview_mode` half of `match_page_sizes`, `placeUniformBox`, the main-process lossless placement block, the O6 tripwire and its baseline and pinning test, the self-comparing baseline test, the quarantine-graduation invariants, the duplicate IPC subscriptions. Also the ETA rewire and the coverage `include` widening. *Why last:* safe once 1–4 are in, and they should not compete for attention with user-visible fixes — but they are what shrinks the surface that any later architectural move must re-validate.

**6. Ongoing.** Declare the supported document class in the corpus, route everything else conservatively, and track stay-fixed rate as the only process metric. Revisit external adoption at the first family that needs a fourth landing *after* its gate is red-calibrated — that is the moment the evidence distinguishes "wrong stage" from "non-separable", and it is the only moment at which (c) can be argued honestly.

