# Corrective audit — scan-cleanup governance and code (2026-08-15)

Provenance: copied verbatim from `.devkit/analysis/branch-audit-2026-08-15/REPORT.txt` (untracked working artifact), audited 2026-08-15 at main HEAD 6ce2f0b61.
The report is plain text; its body is reproduced unmodified inside the fenced block below so the original column layout survives Markdown rendering.

```text
POST-AUDIT CORRECTIONS (verified by the orchestrator after the workflow returned)
  C1. 3.1 is RESOLVED. The 491 dirty lines were committed as 70f0c70ae "Harden the rescue caps
      and fold mask against their own reviewed failure modes" and pushed; origin tip == local tip
      == 70f0c70ae, worktree clean. S0(a) below is DONE.
  C2. 3.2 SURVIVES the commit and gains a sharper citation: on 70f0c70ae the union is at
      content.rs:593-595 and the post-union clamp at content.rs:609-612. Still an appended stage.
  C3. 3.3 counts update: origin/main...origin/fix/rescue-caps-fold-mask = 5 behind / 2 ahead.
  C4. Push run 31840148788 for 6ce2f0b61 was still in_progress at report time -> steps 0 and 1
      remain unattested under the ledger's exact-SHA rule.
  C5. Independently re-verified at 6ce2f0b61: content.rs:392-408 monotone union (1.1);
      harness-baseline.json contentLostOutsideCrop=2, split=33, total=50 (1.2); branch protection
      required=["Commit Attribution Policy"], force_pushes=true, conversation_resolution=false
      (1.3); `git ls-files | grep -i weight` empty (3.4/4.2); electron session 'default' still
      running (1.16); the 0-byte .rows file still untracked, 16 remote heads (1.18).

CORRECTIVE AUDIT REPORT — evb-viewer scan-cleanup governance and code
Audited at: main HEAD 6ce2f0b619cd4cc35931f2e220585a7a9f2af1a1 (NOT the briefed 5dd17ff9e)
Date: 2026-08-15

BASELINE CORRECTION (applies to every prior plan built on the scouted facts)
  - main HEAD is 6ce2f0b61, four commits past 5dd17ff9e: 32b50f2c7, 5bb06b395, 77095bead,
    6ce2f0b61.
  - PR #17 is MERGED (2026-08-14T20:55:41Z, mergeCommit 6ce2f0b61), not OPEN. Its push run
    31840148788 was still in_progress at audit time — the landing is not yet attested under the
    ledger's own exact-SHA rule.
  - Worktree /Users/evb/WebstormProjects/evb-viewer-wt-truth no longer exists. Only
    /Users/evb/WebstormProjects/evb-viewer-wt-rescue (branch fix/rescue-caps-fold-mask) remains.
  - R16 steps 0 and 1 have LANDED. Steps 2, 3, 4, 5, 6 are ABSENT on main.
  - Tooling note: rg produced corrupted output in this environment on several runs (matched
    substrings elided). Cross-check every rg result with grep before citing it.


==============================================================================
1. STILL-BROKEN IN THE BRANCH  (code and repo state on main at 6ce2f0b61)
==============================================================================

1.1  BLOCKER — content.rs unions qualified-picture bounds outward as the last write to the
     content box, so any side the trimmer retracted can be re-expanded. This is RC2, the
     audit's explanation for twelve failed geometry landings.
     Evidence: native/scan-cleanup/src/content.rs:392-408 (`left.min(picture_bounds.left)` …
     `right.max(picture_bounds.right)`), the last statement to assign side coordinates before
     the edge-sliver discard at :410-414. The picture side is derived without trim state:
     crop_qualified_picture_bounds_with_authority at content.rs:958-973 never reads `blocks`,
     `active`, or `accepted_trims` (trim loop content.rs:1871-1981). Untouched by PR #17;
     last content.rs commit on main is b3e8e627f. R16 step 4 (LEDGER:427-434) not started.
     ACTION: Give each box side exactly one owner. Either feed the qualified-picture mask into
     the trim loop's evidence so a protected picture blocks the trim at proposal time and the
     union disappears, or clamp picture_bounds to the pre-trim bound on any side that produced
     an entry in accepted_trims. Pin with a test where a side is trimmed and a picture
     component sits outside the trimmed edge.
     DONE = pre-fix R10/R12 specimen renders RED and the fixed build renders GREEN at box-edge
     granularity ON THE EXPORT, plus the pinning test.

1.2  BLOCKER — The catastrophe oracle cannot observe the pipeline: its baseline blesses four
     known-invalid entries, its corpus counts are one page stale, its only unit test compares
     the baseline to itself, and nothing calls it.
     Evidence: native/scan-cleanup/harness-baseline.json still has contentLostOutsideCrop=2
     (:9), classificationErrors=1 (:24), offcutMisclassifications=1 (:25), lostInkFraction=1.0
     (:147), corpus split=33 / luther-soft-gutter=4 / total=50 (:30-38). Last write 38f908f8a,
     2026-07-22; 140802859 (2026-08-11) added a fifth luther fixture without regenerating it.
     Tracked corpus is 34 entries with 5 luther (native/scan-cleanup/tests/fixtures/split/
     fixtures.json; native/scan-cleanup/tests/split_real_fixtures.rs:43-51). compare_catastrophes
     (evaluate.rs:401-441) compares raw counts with no denominator, so a shrinking corpus passes.
     Its only test, evaluate.rs:1046-1064, deserializes the same JSON twice and asserts equality.
     `grep -n baseline .github/workflows/ci.yml` is empty; `--baseline` (main.rs:87) has no
     package script and no workflow caller.
     ACTION: Regenerate harness-baseline.json against the 34/5 corpus in a commit carrying no
     behaviour change; drive the three catastrophe counters to 0 with any genuine exception moved
     to a named-exceptions file carrying a reason string; add a fixture-count/denominator
     assertion to compare_catastrophes; replace the self-comparison assertion at :1046-1051 with
     a comparison of a freshly produced report (keep the regression assertion at :1053-1063);
     invoke `scan-cleanup-harness --baseline` from pr_native_build_safety (ci.yml:235-279).
     DONE = a deliberately regressed build fails the job in CI on an exact SHA.

1.3  BLOCKER — main has no meaningful required check and accepts force pushes, so PR-based
     landing currently guarantees nothing.
     Evidence: `gh api repos/:owner/:repo/rulesets` -> []. branches/main/protection ->
     required_status_checks.contexts = ["Commit Attribution Policy"]; enforce_admins false;
     allow_force_pushes true; required_conversation_resolution false. Quality Gates, Native And
     Build Safety etc. run on 6ce2f0b61 but none is required. .husky/pre-push is one line:
     `node scripts/check-commit-attribution.mjs --pre-push "$1" "$2"`.
     ACTION: Make the aggregate gate (gates_ok / "Quality Gates") the single required status
     check on main, disable allow_force_pushes, enable required_conversation_resolution. If
     GitHub-settings changes remain declined (R5), state that explicitly in the ledger and accept
     that every gate below is visible-red only, never merge-blocking.
     DONE = a PR with a red gates_ok is not mergeable.

1.4  HIGH — createScanCleanupService.subscribe discards its unsubscribe handle, so every
     reconnect permanently adds a progress listener for the life of the job. Commit 32b50f2c7's
     message claims this defect is gone.
     Evidence: electron/features/scan-cleanup/createScanCleanupService.ts:622-632 —
     `const unsubscribe = jobs.subscribe(...)` is truth-tested at :628 and never stored or
     invoked, including on the `return null` path. Both entry points route here:
     scanCleanupMainBindings.ts:36 (subscribeJob) and :37 (reconnectJob).
     createMainJobRegistry.ts:447-448 adds a fresh closure into a Set (declared :177, init :363),
     so no dedupe; cleared only at record disposal (:251, :304). The renderer loops reconnect up
     to RUN_SUBSCRIPTION_RECONCILIATION_ATTEMPTS = 3
     (app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts:17, :227-243). 32b50f2c7
     removed only the two start()-side registrations (old :419 and :583).
     ACTION: Retain the unsubscribe keyed by (sender, jobId), release the previous one before
     registering, and call it on the `!state` early return. Correct the record: 32b50f2c7 fixed
     the start()-side double-push only.
     DONE = a test asserting one sendScanCleanupState per progress tick after N reconnects.

1.5  HIGH — The whole TypeScript half of the export pipeline is invisible to both the coverage
     ratchet and the zero-execution tripwire.
     Evidence: vitest.config.ts:14-18 coverage.include = app/**, electron/**, packages/**,
     scripts/**, server/** — no scan-cleanup-core, no scan-cleanup-adapters.
     scripts/checkZeroExecutionCoverage.ts:100-104 roots = ['app','electron','packages'].
     Those two directories hold 30 production .ts files (runScanCleanupConversion.ts,
     runLosslessScanCleanup.ts, detection.ts, assembleCompactScanCleanupPages.ts,
     policy/documentCanvas.ts), 10,384 lines.
     ACTION: Add scan-cleanup-core/**/*.ts and scan-cleanup-adapters/**/*.ts to vitest.config.ts
     AND 'scan-cleanup-core'/'scan-cleanup-adapters' to checkZeroExecutionCoverage roots in the
     SAME commit (the tripwire reads coverage.include; widening one alone yields a wall of false
     missingFiles). Re-baseline with --update-baseline and treat the first tripwire run as a real
     inventory of untested export code.
     DONE = the ratchet's denominator includes those 10,384 lines and the tripwire lists real
     zero-execution files.

1.6  HIGH — The cleaned document, the feature's only deliverable, is written to OS temp, hidden
     from Recent Files, and deleted by a 7-day mtime prune that continued use does not refresh.
     Evidence: electron/features/scan-cleanup/public/generatedOutputs.ts:27
     (SCAN_CLEANUP_OUTPUT_MAX_AGE_MS = 7d), :31-33 (root under app.getPath('temp'), see
     electron/utils/appTempDir.ts:21), :95 (randomUUID dir), :133 (`nowMs - metadata.mtimeMs`,
     mtime of the directory — reading a file does not touch it). Excluded from Recent Files at
     electron/features/documents/main/openInputPaths.service.ts:206 and :235. Success toast shows
     summaryText, failure toast shows the path (scanCleanupRunCoordinator.ts:320). Mitigations
     that narrow but do not close the hole: the prune skips live outputs (:131, :137) and the
     toast already offers Save As (:321-326).
     ACTION: Prune on last access, or touch the output directory whenever the output document is
     opened; and either write outputs under app-data instead of temp, or register generated
     outputs in Recent Files under a distinguishable label. The toast-path change is optional
     given the existing Save As action.
     DONE = a document opened on day 6 and reopened on day 9 still exists.

1.7  HIGH — The packaged evb-scan-cleanup binary is executed by release verification on macOS
     only; four of five shipped platform-arches ship with zero execution evidence — and PR #17
     just changed the sidecar protocol.
     Evidence: scripts/verify-packaged-native-tools.sh:525-526 run --version and
     --protocol-version inside the mac branch only. Linux host_can_execute_target runs tesseract
     (:559) and unpaper (:560); Windows runs tesseract (:586). Policy entries already exist at
     scripts/release/native-tool-smoke-policy.mjs:43-50 but are consumed only by the macOS helper
     (run_host_packaged_tool_smoke at :432 greps its own regex; the mac helper at :317 routes
     through assert-packaged-tool-smoke.mjs). build.yml matrix is five legs (:28-46), verifier
     runs for all (:288-292). PR #17 added foldClipLeftPx/foldClipRightPx to
     packages/contracts/scan-cleanup/nativeProtocolV3.ts:170-171.
     ACTION: Add evb-scan-cleanup --version and --protocol-version to the Linux (:558-560) and
     Windows (:584-586) blocks; route the host helper through assert-packaged-tool-smoke.mjs so
     the existing policy is actually used; record win-arm64 (host cannot execute target) as a
     named gap.
     DONE = a deliberately stale sidecar fails the packaging verifier on linux-x64 and win-x64.

1.8  HIGH — Rust validation runs on exactly one target triple, which is neither the development
     platform nor four of five shipped ones.
     Evidence: .github/workflows/ci.yml:239 pr_native_build_safety `runs-on: ubuntu-latest`, sole
     PR/push home of test:rust (:268), lint:rust (:271), cargo-deny (:274-277), build:strict
     (:279). ci.yml:489/:492 (manual_native, workflow_dispatch) and ci.yml:627
     (nightly_maintenance) are also ubuntu-latest and never run on PR/push.
     ACTION: Run test:rust on ubuntu-24.04-arm (already in build.yml's matrix) under the same
     native_or_build change filter, or record the single-target limitation explicitly in
     DEV-VALIDATION-APPROACH's gate vocabulary before step 3/step 4 adjudication starts.
     DONE = imaging-kernel tests execute on aarch64 in a PR-triggered job, or the limitation is
     written down as a known blind spot.

1.9  MEDIUM-HIGH — A block containing one validated text line, or overlapping the picture mask by
     one pixel, vetoes trimming of its ENTIRE side for the rest of the run.
     Evidence: content.rs:1517-1531 annotate_text_evidence sets the flag with no count threshold;
     content.rs:699-704 `protected()` returns true on picture_mask_overlap_pixels != 0;
     content.rs:2061-2068 returns None for the whole side if any removed block is protected;
     the caller treats None as untrimmable this iteration (content.rs:1898-1923) and the touching
     block set does not change unless another side trims. (Fill-ratio/peak gates at :1607-1619
     mean it is not literally one ink pixel, but it is one line or one overlap pixel.)
     ACTION: Give text_evidence and picture_mask_overlap_pixels a calibration-scaled minimum
     count, and change build_trim_geometry to remove only the unprotected touching blocks
     (partial trim, remaining_bounds recomputed from survivors). Land this BEFORE 1.1 or the
     union will absorb the difference.
     DONE = the R10/R12 gutter-residue specimen trims its side, verified on the export.

1.10 MEDIUM — The bw.rs Sauvola route is unreachable at production DPI from three of four entry
     points, so the router's decision space is smaller than everyone reasoning about it believes.
     Evidence: bw.rs:874 downscales to a 256px sample; :893-895 multiplies the sample-space
     median run length by sample_scale = max(W,H)/256; :1288-1291 gates `uneven_text` on
     `estimated_stroke_width_px <= 8.0`. At 300 DPI A4 (3508px) sample_scale ~13.7; a two-page
     spread (~4960px) ~19.4 — the gate can never pass. Reachable only where sample_scale == 1.0
     (render.rs:5810/:6020 -> bw.rs:255-257); unreachable at bw.rs:219, :339-341, :931-933,
     including the spread-plan route installed at render.rs:2698. The only test pinning the
     Sauvola arm, bw.rs:3706-3709, hand-feeds stroke width 3.0, which no measured page produces.
     ACTION: Make the units agree — feed all four sites the same pre-capped routing sample, or
     drop the `* sample_scale` at bw.rs:895 (do NOT merely DPI-scale the 8.0 threshold without
     deciding which space is authoritative). Then re-derive the routing distribution over the real
     corpus. This is a ten-minute arithmetic check that may shrink the step-3 tuning surface.
     DONE = a recorded routing distribution over the corpus, and a test whose stroke input is a
     value production can actually produce.

1.11 MEDIUM — The fold band is a bare Option<f64> pair; three unmeasured causes collapse into the
     least conservative fallback, and nothing downstream can tell them apart.
     Evidence: split.rs:215-216 `gutter_left_x/gutter_right_x: Option<f64>`; consumer
     split.rs:2616-2628 does `gutter_left_x.unwrap_or(x).min(x)` / `gutter_right_x.unwrap_or(x)
     .max(x)`, so unmeasured == leaves meeting exactly at the cutter, giving up no fold material.
     Causes: never measured (:226-240), invalidated by a moved cutter (:282-287), abstention to a
     single page (:330-331). SplitDiagnostics carries no measured-vs-unmeasured field.
     ACTION: Replace with FoldBand::{Measured{left,right}, Unmeasured{reason}}, take the enum in
     leaf_polygons, choose a conservative degraded rule (calibration-derived nominal band) for
     Unmeasured, and surface the reason in SplitDiagnostics.
     DONE = a fold report can distinguish "measured as nothing" from "could not measure", and the
     fold-mask work is adjudicable against it.

1.12 MEDIUM — R16 step 1's claim "the preview is the same program as the export" holds for the
     raster path only; the lossless path still has two independent placement implementations.
     Evidence: lossless preview computes placement in pixels at
     electron/features/scan-cleanup/createScanCleanupPreviewService.ts:2203 (`if (lossless)`),
     :2367-2381 (resolveScanCleanupPlacementOffset), publishing placementOffsetXPx at :2398-2399.
     Lossless export computes it independently in PDF points via placeUniformBox at
     scan-cleanup-core/runLosslessScanCleanup.ts:422/:436 (defined
     scan-cleanup-core/policy/documentCanvas.ts:733). `git show --stat 32b50f2c7` touches neither
     file.
     ACTION: One owner produces the lossless placement and the other consumes it; add a
     preview-vs-export placement-identity case with preserveOriginalQuality: true to the harness
     table 32b50f2c7 introduced.
     DONE = the identity table is green for lossless, making screenshot evidence admissible for
     lossless documents.

1.13 MEDIUM — OCR preprocessing inherits CleanupOptions::default() from the same binary that
     R11/R13 binarization tuning is actively changing, with no OCR-side oracle.
     Evidence: electron/ocr/worker/tryPreprocessOcrImage.ts:85-97 passes only
     `--ocr-mode --options {"dpi":…}`; native/scan-cleanup/src/adapters/batch_cli.rs:419-426
     defaults everything else; domain/options.rs:500-505 (binarization Auto,
     normalize_illumination true, despeckle true, output Bw). ocr_mode gates only page-size and
     crop concerns (render.rs:3766, :5364; batch_cli.rs:1955/:2022/:2353/:2379/:3964), never
     binarization or the rescue path. Tests mock the command
     (tests/unit/electron/ocrWorkerPreprocessOcrImage.test.ts:16).
     ACTION: Pin the OCR preprocessing options explicitly at tryPreprocessOcrImage.ts:85-97 (send
     the full options object OCR wants). Do this BEFORE fix/rescue-caps-fold-mask lands, or that
     branch changes OCR input pixels as an unmeasured side effect.
     DONE = viewer-facing binarization changes provably cannot alter OCR input.

1.14 MEDIUM — Step-5 dead and self-blessing code is all still standing, and one item is an
     actively harmful blocking gate.
     Evidence: unreachable `!preview_mode` half of match_page_sizes —
     native/scan-cleanup/src/adapters/batch_cli.rs:825-829 passes preview_mode from a two-variant
     enum (protocol/manifest_v3.rs:122-127); the eligibility filter at :3963-3969 empties on final
     render, returning before the branches at :4030, :4100, :4107. Quarantine invariants pinning
     non-blocking: tests/unit/architecture/quarantineGraduationPolicy.test.ts:113
     (`blocking: false`), :115 (minimumConsecutiveGreenScheduledRuns: 30), :157
     (continue-on-error: true). O6 tripwire: package.json:68 test:rust runs
     generate-scan-cleanup-threshold-baseline.mjs --check against
     native/scan-cleanup/named-float-const-baseline.json {"count":169} — 169 of ~3380 tuning
     numbers, blessed by editing the number (90bf08248 did exactly that, 168->169).
     ACTION: One commit: drop the preview_mode parameter and its three branches plus the argument
     at :828; delete the quarantine blocking/continue-on-error pins; and act on the O6 disposition
     once 4.5 below is decided. Do NOT delete evaluate.rs:1044-1064 wholesale — only its first
     assertion is trivially true (see 1.2).
     DONE = the deletions land with no gate turning red and the O6 decision is recorded in a row.

1.15 MEDIUM — The strongest end-to-end gate in the repo (packaged app driven over CDP through a
     real conversion) has no CI caller.
     Evidence: scripts/release/verify-local-package.mjs:144-146 is mac-only and :152-160 requires
     .devkit/scan-cleanup-release-fixture.json (.gitignore:29). Entry point
     `release:verify:package:local` (package.json:101) appears in no workflow; release.yml:151 and
     release-artifacts.yml:117 run only `release:verify:checks` (package.json:100). The fixture
     gate is honestly documented (:148-151) and prints SKIPPED (:154-157) — this is a wiring gap,
     not a dishonest claim.
     ACTION: Either commit a small synthetic scan PDF under tests/fixtures and wire
     release:verify:package:local into release.yml, or record the gate in the approach doc's
     vocabulary as `local-only (invocable, fixture-gated, no CI caller)`.
     DONE = a post-packaging regression (asar path, resource-manifest rename, stripped
     entitlement) fails a release job, or the blind spot is written down.

1.16 MEDIUM — Working state violates the project's own hygiene and isolation rules right now.
     Evidence: `pgrep -fl automation-electron-app-entry` -> pid 75330 with
     --user-data-dir=/Users/evb/WebstormProjects/evb-viewer/.devkit/sessions/default/…, started
     2026-08-14 20:26, 4 processes, ~750-840 MB RSS; PR #17 merged 4h29m into that session (a
     stage boundary). LEDGER:104-105 forbids the name 'default'; package.json:21 `dev:headless`
     hardcodes `--session=default`, so the rule contradicts a committed script. 12
     Electron-*.ips crash reports Aug 11-14, latest two EXC_CRASH/SIGABRT responsibleProc=claude
     — a closed burst, not a live loop.
     ACTION: `pnpm electron:run -s default stop`, then confirm `ls .devkit/sessions` and the
     pgrep are empty. Then reconcile rule and script: either exempt single-track dev:headless in
     the ISOLATION text or rename the session in package.json:21.
     DONE = both checks empty at every stage boundary, and no standing rule contradicts a script.

1.17 LOW-MEDIUM — .devkit has reached 8.5G of unrecoverable working material, while one boundary
     finding records that a verifier depends on an untracked .devkit fixture.
     Evidence: `du -sh .devkit` = 8.5G; analysis/ 2.7G, tmp/ 2.5G, zaliznyak-linearized.pdf 689M
     (loose file at .devkit root), large-pdf-fixtures/ 344M, sessions/ 293M. Largest leaves:
     tmp/electron-e2e-hidden-app 2.4G, analysis/scan-cleanup-placement-2026-08-10 1.2G,
     analysis/leaf-alignment 487M, analysis/gutter-residue 239M. The audit evidence that must
     survive is only 288K (analysis/scan-cleanup-audit-2026-08-14). .gitignore:29.
     ACTION: Prune tmp/electron-e2e-hidden-app and the superseded analysis runs; decide whether
     zaliznyak-linearized.pdf is a reusable fixture or a regenerable derivative. Preserve
     scan-cleanup-audit-2026-08-14, docs, scripts, intentional fixtures. Resolve the
     verify-local-package fixture dependency (1.15) BEFORE touching fixtures/ or
     large-pdf-fixtures/.
     DONE = .devkit bounded and no verifier broken by the prune.

1.18 LOW — Branch and file debt makes "what is in flight" unanswerable from git.
     Evidence: PRs #6-#17 all merged 2026-08-14, yet all twelve head branches remain on origin
     (chore/s1-ci-truth, chore/s4-independent-wiring, feat/s2-settle-pinning,
     feat/s4-stamp-schema-v2, fix/offcut-populated-ipc, fix/p1-left-crop, fix/preview-truth,
     fix/run-meter-eta, fix/s3-catastrophe-defects, fix/s5-regression-timeout,
     fix/settle-phase-edge, test/deflake-detection-fifo). They were rebase-merged, so
     `merge-base --is-ancestor` will NOT find them — use the gh merged-PR list as the authority.
     `git diff --name-only origin/main origin/fix/preview-truth` = 0 files. Also stale:
     origin/agent/fix-pdf-fit-mode-scroll (2026-08-07), origin/mobile-rn-experiment (2026-04-28),
     local p1a-parked (2cd4ec7b9). Stray untracked 0-byte file in the governance directory:
     docs/internal/scan-cleanup/process/LEDGER-2026-08-14-process-v2.md.rows (sole entry in git status).
     ACTION: Delete the twelve merged head branches and the .rows file; record p1a-parked,
     agent/fix-pdf-fit-mode-scroll and mobile-rn-experiment as parked-on-purpose (with a row) or
     delete them. Worktree cleanup for PR #17 was done correctly — no action.
     DONE = `git branch -a` shows only main and genuinely in-flight branches.


==============================================================================
2. FALSE OR STALE CLAIMS  (evidence debt in the ledger, PRs, and commit messages)
==============================================================================

2.1  BLOCKER — The governing ledger is four merged commits behind main and states its own first
     two steps as pending after they landed.
     Evidence: `git log -1 -- docs/internal/scan-cleanup/process/LEDGER-2026-08-14-process-v2.md` =
     5dd17ff9e (2026-08-14 22:19:57 +0400); last row is R16 at :390, no R17. LEDGER:403-404 still
     reads "0. Sidecar exit->close … IMMEDIATE next fix" and :405-411 lists step 1 as to-do,
     including a citation to "PreviewShell.vue:745-746 currently gates it on matchPageSize" that
     no longer exists. Landed: step 0 in 32b50f2c7 (runScanCleanupSidecar.ts +87, close-settling
     at :279, wall-clock timeout :44/:285-293) hardened by 77095bead (+17, bounded
     fatalSettlement); step 1 in 32b50f2c7 (placement.ts 185->77 lines, consumes
     metadata.placementOffsetXPx at :46 and Y at :48; foldClipLeftPx/RightPx cross
     nativeProtocolV3.ts:170-171, nativeArtifactCodecs.ts, ipc.ts:280-281, ipcResultCodecs.ts,
     scan-cleanup-core/types.ts; PreviewShell.vue returns 'provisional' :757 and 'updating' :770
     BEFORE the matchPageSize early-out at :771-772). Step 2's "fix preview-harness:637 to
     compose through native placement" also landed in 32b50f2c7 (+234) and is still written as
     pending. `rg -n 'PR #' <ledger>` has no row for PR #13, #14, #16 or #17.
     ACTION: Add R17 recording PRs #13/#14/#16/#17 with landed SHAs; annotate LEDGER:403-411 as
     LANDED with 32b50f2c7 / 77095bead; re-anchor the step-1 line references; cite the push run
     for 6ce2f0b61 as the exact-SHA attestation; re-point "IMMEDIATE next fix" at the corrected
     next step; state which parts of step 1 did NOT ship (lossless, see 1.12).

2.2  BLOCKER — S2 is marked [x] DONE on a word-weight closure that rows R11, R13 and R16 all
     repudiate, while the actual fix is uncommitted WIP.
     Evidence: LEDGER:156 `- [x] S2 Feature fixes — DONE 2026-08-14`; :161-165 close word-weight
     as "resolved by measurement (R7 area) — not reproduced". Contradicted in the same file at
     :320-334 (R11 REOPENS word-weight, task #27), :352-368 (R13 pervasive sub-word artifacts,
     "the adjudication (me) failed"), :419-426 (R16 step 3 still schedules the weight statistic
     and its RED calibration), :457-460 (R16 CORRECTIONS: "R13 post-mortem cited a Rust harness
     weight gate that does not exist"). The carried-item list at :262 still routes task #27 to S2.
     The fix exists only at 8a3e5e5c0 on fix/rescue-caps-fold-mask plus five dirty files.
     ACTION: Flip :156 to `[~]` with "word-weight REOPENED by R11/R13; closure bar invalidated —
     see R16 step 3", and strike or requalify :161-165. Re-close only under R16's vocabulary:
     pre-fix specimen RED -> GREEN at defect granularity ON THE EXPORT.

2.3  BLOCKER — S3 [x] and S4's "mechanical once #11 merges" are both false, and S3's own PR
     reference is stale.
     Evidence: LEDGER:166-173 claims the tolerated entries were driven to "real zeros on all six"
     and LEDGER:178 calls the remainder mechanical; the baseline at HEAD still carries the four
     entries (see 1.2) and was last written 38f908f8a (2026-07-22). LEDGER:169 still says PR #11
     is "in merge tail"; it merged 2026-08-14T09:42:28Z. b3e8e627f (PR #11) claims "real zeros"
     and "split accuracy 51/51" against a baseline recording 49/50 on a 33-fixture corpus.
     ACTION: Downgrade :166 to `[~]`, correct :169, and replace :178's "mechanical" with the real
     remaining work (regenerate baseline, denominator assertion, wire the ratchet). If the
     regenerated counters are not actually zero, reopen S3 explicitly.

2.4  HIGH — The first two closures under the new ledger both breached G3's closure soak, one of
     them closing a step 29 minutes before the PR that carries its fixes existed on main; no row
     acknowledges it.
     Evidence: `git show 3861c35f1 -- <ledger>` flips `- [ ] S2` -> `- [x] S2 … DONE` and
     `- [ ] S3` -> `- [x] S3 … verdicts DONE`. Author date 2026-08-14T13:13:22+04:00 = 09:13:22Z.
     PR #10 mergedAt 09:12:26Z (56 s earlier). PR #11 — named on the S3 line as carrying the S3
     fixes — mergedAt 09:42:28Z (29m06s later). G3 is LEDGER:37 and DEV-VALIDATION-APPROACH:235-238.
     `grep -n 'G3' <ledger>` returns only the rule at :37 and an unrelated fix name at :163.
     ACTION: Add a row recording the breach for both S2 and S3 with these timestamps. Then either
     enforce it mechanically (reject a `[ ]`->`[x]` diff on a backlog line committed <1h after the
     referenced PR's mergedAt) or delete G3 rather than carry an unfollowed rule.

2.5  HIGH — Two mechanisms are described with the word "gates" while having no executing caller,
     and the single adopted process metric is a transcribed number no mechanism computes.
     Evidence: LEDGER:161-162 asserts "harness now GATES presentation stability"; the preview
     harness is package.json:93 `diag:scan-cleanup-preview-harness`. CI wiring is deferred, and
     there is no executing caller in .github/, scripts/release/, or any test,
     even after 32b50f2c7 rewrote it (+234) to measure placement identity. LEDGER:400-401 adopts
     "stay-fixed rate 0/3 … as the ONLY process metric"; it appears twice in the tracked repo,
     both in the ledger (:400, :446). The approach doc's own vocabulary rule (:48-51) forbids
     using "exists" and "enforced" interchangeably.
     ACTION: Restate :161-162 as `manual` per the vocabulary. Either compute the stay-fixed
     counter or label :400-401 explicitly as a hand-maintained observation. See 4.6 for the
     instrumentation.

2.6  HIGH — Every ledger amendment since PR #6 was pushed straight to main, defeating the stated
     purpose of the docs/ migration.
     Evidence: `gh api repos/:owner/:repo/commits/<sha>/pulls` returns [] for 5dd17ff9e,
     46a4bccee, 3861c35f1, a98e95cc2. LEDGER:6-8 and DEV-VALIDATION-APPROACH:12-14, :453-456
     state the point of the migration was "tracked, CodeRabbit-visible".
     ACTION: Pick one and record it: route ledger/approach edits through PRs like code, or state
     in the ledger that governance docs are exempt and why. Do not leave the stated rationale
     standing unfollowed.

2.7  HIGH — 32b50f2c7's commit message asserts "the duplicated progress subscription that leaked a
     listener per reconnect is gone". The reconnect path is exactly the path that still leaks.
     Evidence: see 1.4. The commit removed both start()-side registrations (old :419, :583) and
     left service.subscribe() — the path reconnectJob and subscribeJob route through — untouched.
     ACTION: Record the correction in the ledger row for PR #17: the start()-side double-push was
     removed; the reconnect leak was not.

2.8  MEDIUM — PR #17 merged with no eyeball pack referenced, on the one step where a visual
     before/after is the primary evidence.
     Evidence: LEDGER:43-50 — "every step closes with a 2-minute user-reviewable artifact set …
     delivered in chat and referenced in the PR. Closure claims without an eyeball pack are
     invalid" (with a NON-BLOCKING clause at :47-50). `gh pr view 17 --json body,comments`: 4010-
     char body, no before/after, image, or recording reference; one comment, from coderabbitai.
     PRs #11, #12, #15 and #16 bodies likewise carry none; only PR #10's mentions composites.
     Chat delivery could not be verified from the repo.
     ACTION: Retro-deliver the before/after pack for the preview-truth change measured ON THE
     EXPORT, reference it from the R17 row and a PR #17 follow-up comment. Per :47-50 this does
     not reopen the merged step unless the user objects. Do not mark step 1 closed until it exists.

2.9  MEDIUM — The BATCH CLOSURE "current open batch" is stale: three of five items landed, two
     are stranded, and the ledger records none of it.
     Evidence: LEDGER:66-69 lists stuck-conversion IPC drop, pinned-provisional display,
     fold-side box overhang + gutter residue, sub-word weight artifacts, run-meter ETA. Landed:
     PR #14 (17:42:30Z), PR #15 (17:56:43Z), PR #16 (18:11:21Z). Not landed: fold-side overhang
     and sub-word weight, both only on fix/rescue-caps-fold-mask. Per BATCH CLOSURE (:60-66) the
     batch is formally OPEN, so nothing in it may be reported fixed. Note also that none of the
     three landed items carries export-granularity RED->GREEN evidence in the ledger; that is
     defensible for the ETA and IPC items, not asserted anywhere for the phase-edge display item.
     ACTION: Annotate :66-69 per item with landed-PR or still-open status, and state the
     phase-edge item's evidence basis explicitly.

2.10 MEDIUM — Every cited closure number is unreproducible from the repository.
     Evidence: .gitignore:29 ignores .devkit/. The ledger cites
     .devkit/analysis/scan-cleanup-audit-2026-08-14/ as the source of the adopted sequence
     (LEDGER:390-391), .devkit/analysis/s3-readjudication/ for S3 verdicts (:167-168),
     .devkit/analysis/s5-triage-20260814 for S5 (:180-181); the word-weight closure's script is
     .devkit/analysis/s2-wordweight-20260814/analyze-word-weight.mjs and its replacement is
     .devkit/analysis/weight-letters. `git ls-files | grep -i weight` is empty. LEDGER:112-116
     forbids exactly this citation pattern. (The plan itself IS tracked — the ledger is canonical
     per its line 6 and reproduces the sequence at :402-455.)
     ACTION: Copy the audit SYNTHESIS and its section 7/8 content into docs/internal/scan-cleanup/ beside
     the ledger, and track the measurement scripts (not their large outputs) under
     scripts/diagnostics/, so "1,691 matched words" and "ALL five tolerated entries invalid" can
     be recomputed from a clone.

2.11 MEDIUM — The ledger's remedy for the CodeRabbit-charter boundary finding does not address
     the defect it names.
     Evidence: LEDGER:455-456 records that .coderabbit.yaml path_instructions "should point at
     tracked docs/internal/architecture-audit-2026-07-23.md". That file IS tracked, but the binding Design/
     OCR/UI/Native-CI rules live in CLAUDE.md, which .gitignore:23-24 excludes
     (`git check-ignore -v CLAUDE.md` -> .gitignore:24). .coderabbit.yaml's six path_instructions
     blocks reference no document at all. Executing the row as written closes it without fixing it
     — while the rescue branch is exactly the shape those rules forbid.
     ACTION: Move the durable rules into a tracked docs/architecture/design-charter.md and point
     path_instructions at THAT; rewrite LEDGER:455-456 accordingly.

2.12 MEDIUM — Two approach-doc statements are stale at HEAD.
     Evidence: X2 (:371-372) says .coderabbit.yaml "pauses incremental review after 2 reviewed
     commits"; .coderabbit.yaml:66 sets auto_pause_after_reviewed_commits: 10. Q1 (:325-335)
     declares "The 30-green bar is retired as unreachable" and that counters "become
     machine-derived"; tests/unit/architecture/quarantineGraduationPolicy.test.ts:113 still pins
     `blocking: false` and :115 pins minimumConsecutiveGreenScheduledRuns: 30.
     ACTION: Correct both lines. For Q1, either implement the retirement or say the bar is still
     pinned at quarantineGraduationPolicy.test.ts:115.

2.13 LOW — LEDGER:449's "audit §8" pointer is dangling, which is probably how 2.11 got misstated.
     Evidence: SYNTHESIS.md is 167 lines with sections 1-7; its only "8." is a numbered item
     inside section 3 (SYNTHESIS.md:86, the deletions item = step 5). The six boundary findings
     live in COMPLETENESS-CRITIC.md.
     ACTION: Re-point the citation at COMPLETENESS-CRITIC.md with its line ranges.


==============================================================================
3. IN-FLIGHT / UNFINISHED WORK AT RISK  (fix/rescue-caps-fold-mask)
==============================================================================

3.1  BLOCKER — 491 lines of native Rust exist only in a dirty working tree: no commit, no stash,
     no remote copy.
     Evidence: `git -C /Users/evb/WebstormProjects/evb-viewer-wt-rescue status --porcelain` = five
     ` M` entries (bw.rs, content.rs, engine/render.rs, engine/render_tests.rs, split.rs), none
     staged; `git diff --stat` = 385/164/12/25/25, "491 insertions(+), 120 deletions(-)".
     `stash list` holds only lint-staged backups and an unrelated CLAUDE.md stash; no untracked
     files. Local tip == origin tip == 8a3e5e5c0 ("10 files changed, 873 insertions(+)"). The
     substance — component-local minimum_structural_rescue, ComponentRepair, the clipping repair
     replacing the boolean stroke-cap veto, source_exclusion threading — is in the unsaved half.
     The same machine carries an 8.5G .devkit that invites exactly the cleanup that would lose it.
     ACTION: Commit the working tree to fix/rescue-caps-fold-mask as a second WIP commit and push
     it, today, before any restructuring. Durability first.

3.2  BLOCKER — The in-flight fold fix reproduces RC2 inside the fix for RC2: it appends a clamp
     AFTER the monotone-outward union instead of feeding the box owners.
     Evidence: on fix/rescue-caps-fold-mask, content.rs gains a 148-line (167 in the dirty tree)
     `fold_side_source_exclusion` stage threaded as `source_exclusion: Option<&BinaryImage>`
     through content.rs:275/:284/:317/:391/:447, AND a 16-line post-union clamp (working tree
     :601-616; committed at 8a3e5e5c0 :575-590) doing
     `content_bounds.left = content_bounds.left.max(excluded_left)` after the union at :591-599
     has already expanded them. The union itself (main content.rs:392-408) and the whole-side
     abort (main :2061-2068; rescue :2270) are unchanged on both sides — the only edit inside the
     union block is a rename picture_mask -> analysis_picture_mask. LEDGER:432-434 states the rule
     verbatim: the fold-mask fix "must feed BEFORE/INTO the union ownership or it is another
     appended stage (RC2)".
     ACTION: Do not land this shape. Land 1.9 then 1.1 first, delete the post-union clamp, and let
     the existing pre-union source_exclusion consumers own the left/right sides. Then re-judge
     whether fold_side_source_exclusion is needed at all — if overhang survives the ownership fix,
     the audit says the defect is in the picture qualifier's evidence, not in a new mask.

3.3  HIGH — The branch is based on pre-governance main and cannot legitimately merge, and its
     "blockers open" are recorded nowhere.
     Evidence: merge-base with origin/main = 76a4cc976 — the commit BEFORE 5dd17ff9e adopted the
     audit sequence; `rev-list --left-right --count origin/main...fix/rescue-caps-fold-mask` =
     5 behind / 1 ahead. main has since changed native/scan-cleanup/src/engine/render.rs and
     adapters/batch_cli.rs (`git diff --name-only 76a4cc976..6ce2f0b61`), and render.rs is one of
     the branch's dirty files — a conflict is pending. LEDGER:423-424 states the branch "is
     adjudicated against THIS gate, not the word-mean proxy", and that gate does not exist. The
     commit message says only "blockers open", enumerating none.
     ACTION: After 3.1, rebase onto 6ce2f0b61 and resolve render.rs. Write the open blockers into
     the commit message or an R-row. Do not open a PR until the step-3 weight oracle and the
     step-4 ownership fix exist.

3.4  HIGH — bw.rs carries 874 lines of change (489 committed + 385 dirty) ahead of the oracle that
     is supposed to be able to disqualify it, and it is the fifth landing in this family.
     Evidence: prior landings 1378b3faf, 792ec945f, 5f2337c30, 6ff126e67 (all 2026-08-13) closed
     under R7/S2 and repudiated by R11 (3252eb0a5) and R13 (e4c87b401). The accepting statistic is
     unchanged: scripts/diagnostics/scan-cleanup-preview-harness.mjs:400 wordWeights collapses each
     word to one mean run length (:428), and :1254-1259 raises 'weight-uniformity' only when
     preview and final disagree by more than WEIGHT_DEVIATION_LIMIT (:100, 0.15) — it can never
     fire on absolute output evenness. No tracked weight oracle exists
     (`git ls-files | grep -i weight` empty).
     ACTION: Freeze bw.rs acceptance until 4.2's oracle exists and is RED on the R13 specimen.
     Stop citing preview-harness weight-uniformity as evidence about output evenness; rename it to
     what it measures (preview/final agreement).

3.5  LEAD (unverified) — `rescue_component_scoped_faint_strokes` survives on the branch only as a
     delegating wrapper whose remaining callers are tests (bw.rs:3928-4308 test module,
     engine/render_tests.rs:3690); production moved to the `_excluding_source` variant. Also, the
     dirty tree was never compiled during this audit (no builds run). Check both at review time
     under the project's "inline one-consumer abstractions" rule.


==============================================================================
4. DEFECTS IN THE FORWARD PLAN ITSELF  (R16 steps 0-6)
==============================================================================

4.1  BLOCKER — Step 2's headline enforcement decision (a pre-push hook) cannot enforce anything on
     the remote, which makes the plan's answer to root cause RC5 a mechanism with no power.
     Evidence: LEDGER:417-418 queues "enforcement decision (pre-push hook, since ruleset was
     declined R5)". .husky/pre-push runs only check-commit-attribution.mjs; `git config
     core.hooksPath` = .husky/_ (per-clone, though package.json:121's `prepare` does install
     husky), bypassable with `git push --no-verify`, absent on every CI runner. The only binding
     clause is step 2's sub-clause "wire --check into a blocking job" (SYNTHESIS.md:156).
     ACTION: Invert the step: the enforcement decision IS the blocking CI job. Add the oracle
     --check invocations to ci.yml and to the gates_ok needs list (ci.yml:356-362); keep the hook
     only as a fast local pre-echo. Note explicitly that adding a job to ci.yml is a repo-file
     change, not a GitHub settings change, so R5 does not block it — but without a ruleset (1.3)
     the gate is visible-red, not merge-blocking, and the ledger must say so.

4.2  BLOCKER — Step 3's acceptance criterion is unmeasurable as written: the oracle it names is a
     Python/PIL script in gitignored .devkit, and no CI lane can run it.
     Evidence: LEDGER:419-426 requires the weight-letters script promoted to a tracked oracle
     "calibrated RED on the R13 specimen" and states "Weight statistic BEFORE any bw.rs
     acceptance". The script is .devkit/analysis/weight-letters/measure_components.py (PIL
     import); .gitignore:29; `git ls-files | grep -i weight` empty. Every repo gate is
     pnpm/vitest or cargo.
     ACTION: Amend step 3 to name a runner: port the component measurement into the Rust harness
     under native/scan-cleanup/src/bin/scan-cleanup-harness/ or into a tracked .mjs beside
     scan-cleanup-word-loss-audit.mjs — do not add a Python lane. Commit the R13 specimen as a
     fixture (8a3e5e5c0 already committed specimens under native/scan-cleanup/tests/fixtures/
     rescue/). Add the Sauvola arithmetic check (1.10) as a PRECONDITION of step 3, not a
     same-sitting companion: if the route is dead, part of the 874-line diff is tuning a dead
     branch.

4.3  HIGH — Steps 3 and 4 are in the wrong order relative to their own dependency.
     Evidence: LEDGER:432-434 makes the fold work conditional on the union ownership (step 4),
     and the rescue branch bundles the fold change with the bw.rs change (3.2, 3.4). Step 4 has no
     dependency on step 3; step 3's subject matter (binarization) is independent of geometry.
     ACTION: Run step 4 (ownership) before step 3 (weight), so the fold half of the rescue branch
     can be re-adjudicated as soon as the ownership invariant exists, while the bw.rs half waits
     on the oracle. Within step 4, fix evidence granularity (1.9) BEFORE the union invariant (1.1)
     — otherwise the union absorbs the difference and the partial-trim change looks inert.

4.4  HIGH — R16 drops an entire acceptance class the audit itself named, and orphans three backlog
     items.
     Evidence: SYNTHESIS §5's last acceptance class is "Content loss — the class with no user
     report yet, because nothing looks", with a hard-zero gate on contentLostOutsideCrop /
     lostInkFraction. No step 0-6 covers it, although both measurements exist and are unwired
     (evaluate.rs:919 emits contentLostOutsideCrop;
     scripts/diagnostics/scan-cleanup-word-loss-audit.mjs:1975/:2723/:2893 computes
     lostInkFraction against 0.01; neither has a workflow caller). Separately, LEDGER:392-393
     supersedes the backlog ordering, yet S6 (LEDGER:187, E1a invariant assertions I1-I3) and
     S5-remaining (LEDGER:185-186: matchedCanvas rotation, Fallow duplicates,
     nativePdfSplitPaneLifecycle, graduation) appear in no step, and the nightly lane S5 depends
     on is `gh run list --event schedule --limit 12` -> 12 consecutive failures (latest
     2026-08-14T04:17:12Z) with no owning row.
     ACTION: Add the content-loss gate to step 2 (it is wiring, not new machinery). Add a
     disposition line under R16 mapping each surviving S4/S5/S6 item to a step number or to
     "descoped, reason". Give the 12/12 nightly failure streak an owning row.

4.5  MEDIUM — Two governing documents disagree on whether the O6 threshold tripwire lives or dies,
     with no disposition either way.
     Evidence: LEDGER:437-439 (R16 step 5) schedules deleting the O6 tripwire, its baseline and
     its pinning test, on the evidence that it measures 169 of ~3380 tuning numbers and is blessed
     by editing a number (90bf08248 bumped 168->169 immediately after b3e8e627f introduced the
     constant). DEV-VALIDATION-APPROACH:168-176 and :308-311 still call the same mechanism the T1
     flagship and "the one mechanism attacking defect GENERATION"; package.json:68 still enforces
     it inside test:rust. The rescue WIP already bumps the baseline to 172.
     ACTION: Decide once and record a disposition row. If deleted, amend the approach doc in the
     same commit. If kept, state what it is claimed to measure and stop calling it a defect-
     generation control.

4.6  MEDIUM — The single adopted process metric is defined in prose and recorded nowhere, so the
     audit's own deletion rule for unproductive governance can never fire.
     Evidence: LEDGER:400-401 declares stay-fixed rate the ONLY process metric; it appears only at
     :400 and :446. Its numerator/denominator ARE stated in the adopted audit (SYNTHESIS.md:5:
     3 defect families, ~19 landings, >=9 closure declarations, 0 held), but no row R1-R15 carries
     a stay-fixed outcome and no re-scoring cadence exists. SYNTHESIS.md:111 says a governance
     mechanism that has not moved this number in two months should be deleted. Git history shows
     the denominator is understated: at least five repeat-fix families (crop/content-box,
     fold/gutter, word-weight, ETA, settle/pin), two of them with zero landings since reopening.
     ACTION: Add a `stay-fixed: pending|held|broke` field to every closed row, retroactively for
     R1-R15, cite SYNTHESIS.md:5 for the definition rather than re-deriving it, name the
     re-report window in days, and re-score at each closure.

4.7  MEDIUM — The closure vocabulary "on the EXPORT" is not yet satisfiable for lossless documents,
     and step 1 was declared as if it were.
     Evidence: 1.12 — the lossless preview and export compute placement independently. R16's
     tightened bar (LEDGER:459-460) is "at defect granularity on the EXPORT"; R13:366-367 words it
     as letter granularity for the weight family. Screenshot-based closure on lossless documents
     remains inadmissible.
     ACTION: Extend step 1 with the lossless unification and add the lossless case to the
     placement-identity table before any closure cites a lossless screenshot. Keep the R16 wording
     ("defect granularity on the EXPORT") as canonical and note R13's letter-granularity phrasing
     is the weight-family instance of it.

4.8  MEDIUM — X2's one-step-one-PR rule was violated by the plan's own first execution, without a
     recorded decision.
     Evidence: PR #17 carried step 0 AND step 1 (file list includes runScanCleanupSidecar.ts;
     5bb06b395 and 77095bead are step-0 work). The audit's rationale for step 0 being first and
     separate is that it cleans the observation channel BEFORE anything is observed through it.
     R15's BATCH CLOSURE arguably licenses the bundling.
     ACTION: Record which rule governs when they conflict (X2 sequencing vs R15 batching), in one
     line, so the next step does not have to re-litigate it.

4.9  MEDIUM — Step 6 (declare the supported document class) is absent and under-specified.
     Evidence: `grep -rln "supported document class\|dense-text" docs/ native/scan-cleanup/`
     matches only R16's own text and an unrelated comment in ink_consistency.rs.
     ACTION: Keep step 6 last, and add to it the routing-distribution re-derivation from 1.10 —
     the declared class is only meaningful once the router's reachable modes over the real corpus
     are known.


==============================================================================
CORRECTED NEXT SEQUENCE  (replaces/amends R16 steps 0-6)
==============================================================================

DISPOSITION OF R16'S STEPS
  step 0  LANDED (32b50f2c7 + 77095bead). Close with a row; no further work.
  step 1  LANDED for the raster path. REOPEN scoped to lossless (1.12) and to the eyeball pack
          (2.8). Keep as step S7 below, not as a blocker.
  step 2  STAYS, but SPLITS and its enforcement clause is INVERTED: the decision is a blocking
          CI job, not a pre-push hook (4.1). Gains the content-loss gate (4.4) and the coverage
          roots pulled forward out of step 5 (1.5).
  step 3  REORDERS after step 4 (4.3). Gains a precondition (the Sauvola arithmetic check, 1.10)
          and a named runner (4.2). Gains a landing precondition: OCR options pinning (1.13).
  step 4  REORDERS before step 3, and gains an internal ordering: evidence granularity BEFORE the
          union invariant (4.3).
  step 5  STAYS, after 3 and 4. AMENDED: do not delete evaluate.rs:1044-1064 wholesale; add the
          O6 disposition decision (4.5).
  step 6  STAYS last. Gains the routing-distribution requirement (4.9).
  NEW     S0 (durability/hygiene) and S1 (ledger reconciliation) are inserted before everything,
          because the plan is read from a document that currently misstates its own status.

ORDERED SEQUENCE

  S0. DURABILITY AND HYGIENE — minutes, no dependencies, do first.
      a) Commit and push the 491 dirty lines on fix/rescue-caps-fold-mask (3.1).
      b) `pnpm electron:run -s default stop`; verify `ls .devkit/sessions` and
         `pgrep -fl automation-electron-app-entry` are empty (1.16).
      c) Delete docs/internal/scan-cleanup/process/LEDGER-2026-08-14-process-v2.md.rows (1.18).
      DONE = nothing load-bearing exists only in a working tree or a live process.

  S1. LEDGER RECONCILIATION — precondition for dispatching any step, because every later
      dispatch is read from this document.
      Add R17: PRs #13/#14/#16/#17 with SHAs; steps 0 and 1 marked LANDED (32b50f2c7,
      77095bead) with re-anchored line references; the push-run conclusion for 6ce2f0b61 as the
      exact-SHA attestation (2.1). Flip S2 to [~] (2.2); downgrade S3 and rewrite S4's
      "mechanical" (2.3); record the G3 breach with timestamps (2.4); annotate the batch list
      per item (2.9); correct "harness now GATES" to `manual` and label the stay-fixed number
      (2.5); record the PR #17 subscription-claim correction (2.7); re-point the §8 citation
      (2.13); fix the approach doc's two stale statements (2.12); add the S4/S5/S6 disposition
      lines and an owner for the 12/12 red nightly (4.4); add the stay-fixed field to R1-R15
      (4.6); record the X2-vs-R15 precedence (4.8).
      DONE = a reader who knows nothing can derive, from the ledger alone, exactly what landed,
      what is open, and what is next — and every number in it is either recomputable or labelled
      as an observation.

  S2. ENFORCEMENT DECISION — precondition for wiring any oracle (4.1, 1.3).
      Add gates_ok/"Quality Gates" as the single required status check on main; disable
      allow_force_pushes; enable required_conversation_resolution. If GitHub-settings changes are
      still declined, record that decision explicitly and state that all gates below are
      visible-red only. Extend .husky/pre-push with the blocking set as a local pre-echo only.
      DONE = a PR with a red aggregate gate is not mergeable, or the ledger states in one line why
      it is.

  S3. WIRE THE ORACLES YOU ALREADY OWN (was step 2, expanded).
      a) Regenerate harness-baseline.json against the 34/5 corpus in a behaviour-free commit;
         drive contentLostOutsideCrop / classificationErrors / offcutMisclassifications to 0 or
         move genuine exceptions to a named file with reason strings; add the fixture-count
         denominator assertion to compare_catastrophes; replace the self-comparison assertion
         (1.2).
      b) Wire `scan-cleanup-harness --baseline` into pr_native_build_safety and
         `scan-cleanup-preview-harness.mjs --check` into a job listed in gates_ok's needs (1.2,
         2.5).
      c) Add the content-loss gate — contentLostOutsideCrop hard zero and
         scan-cleanup-word-loss-audit lostInkFraction against its 0.01 threshold (4.4).
      d) Add scan-cleanup-core/** and scan-cleanup-adapters/** to vitest coverage include AND to
         checkZeroExecutionCoverage roots in one commit; re-baseline; drop the
         `github.event_name == 'push'` guard at ci.yml:116-118 so PRs run the coverage gate (1.5).
      e) Decide Rust CI arch coverage: add ubuntu-24.04-arm or write the limitation down (1.8).
      DONE = a deliberately regressed build fails each newly wired gate in CI on an exact SHA, and
      the first zero-execution report is treated as an inventory, not noise.

  S4. NATIVE OWNERSHIP (was step 4; now before the weight work). Strict internal order:
      a) text_evidence and picture_mask_overlap_pixels gain calibration-scaled minimum counts;
         build_trim_geometry does a partial trim instead of aborting the side (1.9).
      b) The qualified-picture union may not move a side outward past a bound the trim loop
         accepted — one owner per side; pin with a test (1.1).
      c) FoldBand::{Measured, Unmeasured{reason}} replaces the bare Option pair; leaf_polygons
         takes the enum; Unmeasured degrades conservatively; the reason reaches SplitDiagnostics
         (1.11).
      d) Rebase fix/rescue-caps-fold-mask onto the result, delete its post-union clamp, and
         re-judge whether fold_side_source_exclusion is still needed (3.2, 3.3).
      DONE = the R10/R12/R12a specimens are RED pre-fix and GREEN post-fix at box-edge granularity
      ON THE EXPORT, with the ownership test pinning it, and accepted_trims in diagnostics is
      guaranteed to describe the shipped box.

  S5. WEIGHT ORACLE AND bw.rs (was step 3). Preconditions: 1.10 and 1.13.
      a) Resolve the Sauvola stroke-width unit mismatch and record the router's reachable modes
         over the real corpus BEFORE tuning anything (1.10).
      b) Pin OCR preprocessing options at tryPreprocessOcrImage.ts so viewer tuning cannot reach
         OCR input (1.13).
      c) Land the component-granularity weight oracle in a tracked runner (Rust harness or tracked
         .mjs — no Python lane), commit the R13 specimen as a fixture, and prove in a committed run
         that the threshold is RED on the pre-fix specimen (4.2).
      d) Only then adjudicate the bw.rs half of fix/rescue-caps-fold-mask against that gate
         (3.4).
      DONE = the R13 specimen is RED pre-fix and GREEN post-fix at letter granularity ON THE
      EXPORT, with both runs committed; the preview-harness weight-uniformity check is renamed to
      preview/final agreement and no longer cited as evidence about evenness.

  S6. DELETIONS (was step 5, amended).
      Drop the preview_mode parameter and its three unreachable branches in batch_cli.rs; delete
      the quarantine blocking/continue-on-error pins; delete the workflow_dispatch-only duplicate
      "Native Rust Tests" job; act on the recorded O6 disposition (1.14, 4.5). Do NOT delete the
      whole evaluate.rs test — S3(a) already replaced its trivial assertion.
      DONE = every deletion lands with no gate turning red, and no document still describes a
      deleted mechanism as a control.

  S7. BOUNDARY FINDINGS (audit §8 / COMPLETENESS-CRITIC), user-visible first.
      a) Output lifecycle: prune on last access or touch on open; move outputs out of OS temp or
         register them in Recent Files (1.6).
      b) Packaged smoke on Linux and Windows via the existing policy entries; name the win-arm64
         gap (1.7) — before the next release.
      c) Track the design charter as docs/architecture/design-charter.md and point .coderabbit.yaml
         path_instructions at it (2.11).
      d) Copy the audit SYNTHESIS and section 7/8 into docs/internal/scan-cleanup/ and track the
         measurement scripts under scripts/diagnostics/ (2.10).
      e) Wire release:verify:package:local with a committed synthetic fixture, or reclassify it
         honestly in the gate vocabulary (1.15).
      f) Lossless placement unification plus its identity-table case, and the retro eyeball pack
         for step 1 (1.12, 2.8, 4.7).
      g) Prune .devkit to a bounded size, after (e) resolves the fixture dependency (1.17); clean
         the twelve merged head branches and decide the three parked branches (1.18).
      DONE = each item either has an executing caller and a red-on-regression proof, or an explicit
      written statement of what it does not cover.

  S8. DECLARE THE SUPPORTED DOCUMENT CLASS (was step 6), informed by S5(a)'s routing distribution
      (4.9).
      DONE = a tracked document naming the class, the routes reachable on it, and the defect
      classes that are out of scope.

CLOSURE VOCABULARY REMINDER FOR EVERY ITEM ABOVE
  A step is closed only when: a pre-fix specimen is demonstrated RED and the post-fix build GREEN,
  at the granularity of the defect, measured ON THE EXPORT (not the preview), by an oracle that has
  an executing caller, with the run recorded against an exact SHA and an eyeball pack referenced in
  the PR. Any closure that cites a number reproducible only from .devkit does not meet this bar.
```
