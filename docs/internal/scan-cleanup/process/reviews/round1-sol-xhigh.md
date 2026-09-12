# Adversarial verdict

The draft is directionally more candid than the prior story, but it still misdiagnoses the governing failure. The dominant problem was not simply “too few oracles.” It was that the same orchestrator defined the symptom, chose the ground truth, designed the fix, selected the protected examples, interpreted the evidence, and declared closure—sometimes against the wrong build and repeatedly before known gaps were resolved.

Part 2 remains mostly unenforceable prose. Applied literally, it could reproduce the same sequence with more paperwork.

## A. Part 1 honesty audit

### 1. It omits the most dangerous failure: bad ground truth

F3 says the oracles were merely too narrow. The ledger shows several stronger failures:

- The original word-loss oracle measured nothing because every alignment was unreliable, yet reported success ([ledger diagnosis](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:119)).
- A synthetic footnote test and claimed visual verification passed while the real page still lost both footnotes ([combined-tree verification](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:350)).
- P1a’s gate passed all 15 targets because the flagship “spread” had been mislabeled; it was actually a single three-column page that the proposed fix would destroy ([P1a post-mortem](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:684)).
- The large OCR experiment produced alarming numbers that its own analysis attributed largely to OCR noise, proxy language models, and mapping errors ([OCR caveats](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:736)).

This is not “confirmation-scoped verification.” It is oracle validity and label-governance failure. P1 would make it worse by turning a misunderstood report into an authoritative test.

### 2. It avoids naming premature closure as a separate failure

The ledger begins with “CLOSED” and “FINAL,” later declares the session completely closed again, and is then reopened four more times ([initial close](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1), [session closed](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1038), [REOPEN 3](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1054)).

Worse, closure occurred with known limitations:

- Shared scale still shrank some spreads below document scale.
- Wolf-route boldening was explicitly left open.
- Preview parity tested only selected fields.
- The final reopen still left the provisional-to-settled jump unresolved and preview latency unmeasured ([REOPEN 6 resolution](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1175)).

P8’s proposal to list unverified dimensions does not solve this. It can merely produce a more honestly worded premature closure.

### 3. Build and evidence provenance are missing from the analysis

Several “verification” failures were not caused by visual blind spots:

- A staged binary shadowed the newly built binary, so repros ran stale code ([stage-2 status](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:370)).
- The detection cache lacked binary identity until reviewers caught it ([adversarial findings](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:968)).
- Scoped tests let eight component failures escape; CI runs were cancelled by later pushes ([preview hotfix history](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:927)).
- Dense-rescue CI was skipped at the relevant tip because another push superseded it ([REOPEN 4 CI status](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1100)).
- A Node version/path change produced 222 phantom failures ([evening rounds](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1122)).

Naming an instrument, as P8 requires, is useless unless the claim also binds the source revision, binary hash, cache key, tool versions, fixture hash, dirty state, and final integrated tip.

### 4. Requirement capture failed, not merely report handling

REOPEN 6 initially classified blank panes as the primary complaint and dispatched against that. The user’s actual complaint was raster quality, asymmetric crop, and jumps; the first dispatch was killed and restarted ([REOPEN 6 correction](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1145)).

That is distinct from dismissing a report. The orchestrator confidently reproduced the wrong symptom. P1 still permits this because it requires a red check, not confirmation that the red check captures what the user meant.

### 5. The weight-history claim is inaccurate

F1 says weight was “declared fixed at least twice.”

- The smoothing hypothesis was disproved by its mandatory gate and stopped before landing; the ledger explicitly corrected the root cause ([G3 correction](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:888)).
- The landed rescue fix explicitly declared Wolf-route boldening out of scope ([G3 landed](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:911)).
- The later dense-page defect was missing pale structure exposed by removing accidental dilation, not another instance of the same boldening mechanism ([REOPEN 4](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1075)).

The honest criticism is that “G3 fixed” was an over-broad category covering multiple mechanisms, not that the same mechanism was knowingly declared fixed twice.

### 6. “ZERO oracles” and “no automated instrument at all” are false

The ledger records preview-parity pins and eight component tests that constrained optimistic repositioning ([preview parity history](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:927)). It later says the parity pin covered anchors and fit but omitted optical fields ([REOPEN 5](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1105)). It also records a headless blocking-smoke E2E pass.

The accurate claim is narrower: there was no pixel-level preview-quality oracle and no blocking runtime test for the reported frame transitions. Existing automation asserted incomplete or wrong contracts.

The current repository reinforces this distinction: scan-cleanup lifecycle tests exist, but the lane is nightly/manual and non-blocking ([quarantine policy](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/README.md:3)).

### 7. F5 falsely says every seam was discovered through user pain

The adversarial reviewers—not the user—identified deferred `overflow_top` source-row divergence, OCR/preview vertical-trim loss, preview-X composition, lossless shared-fit omission, codec interval gaps, and cache identity ([review findings](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:968)).

The real failure was that seam analysis occurred late and inconsistently, not that every seam required a user report.

### 8. “Symptom-sized rounds” hides the opposite failure

Some rounds were enormous: the G3/G4/G4b change touched 33 files with +2305/−318 lines and ran for 12 hours ([continuation cycle](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:598)). Stage 5 and G3/G4 reviews found broad contract, quality, and reach defects before push.

The pattern was not uniformly “one symptom, one tiny patch.” It oscillated between broad structural changes and narrow acceptance evidence, compounded by parallel worktrees, rebases, cancelled CI, and cross-fix interactions.

The claimed “oscillation from stale-display × optimistic-recompute interaction” is also not described clearly in the ledger. It should be evidenced or removed.

### 9. The “what worked” section is self-congratulatory and under-qualified

- Two-sided gates work only when the references and labels are valid; P1a passed its own gates with destructive ground truth.
- Byte identity can preserve a latent defect and encourage overfitting. Final-output byte identity did nothing to prove preview correctness.
- “Independent orchestrator re-measurement” is not independent when the orchestrator designed the mechanism, chose the specimens, interpreted the result, and controlled closure.
- Mechanism-level dispatch is only as sound as the mechanism. Several orchestrator-specified mechanisms were disproved or required large reviewer corrections.

These are useful techniques, not demonstrated structural safeguards.

### 10. The corpus framing erases evidence already in the ledger

The ledger did not merely run one book. It describes a 1,063-file census, 25,072 sampled pages, 262 exemplars from 120 files, and a 250-fixture baseline that exposed nine crashes and new failure clusters ([corpus work](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:474)).

The failure was that this corpus was not consistently authoritative or mandatory for later rounds—and some labels were wrong. “All checks run on one book” is an easier but inaccurate problem statement.

## B. Structural critique of P1–P8

| Item | Concrete recurrence it permits |
|---|---|
| P1 | The user reports “preview quality is worse.” The orchestrator encodes blank-pane presence as the red check, exactly as in REOPEN 6. The check turns green while mottling and jumps remain. Alternatively, a wrongly labeled single dictionary page becomes a red “unsplit spread” test and forces destructive splitting, as P1a demonstrated. |
| P2 | Static preview and final composites look correct after settlement, while the app shows a blank frame for 800 ms, jumps twice, or briefly displays stale geometry. Artifact paths do not prove temporal behavior, build freshness, or that the orchestrator viewed every predetermined specimen rather than a hand-picked good page. |
| P3 | A new optical-placement field is added. The implementer declares the native-placement seam touched but overlooks deferred serialization and TS composition; only declared seam checks run. This is exactly how the parity pin covered anchor/fit but omitted optical fields. A prose map cannot discover omitted paths. |
| P4 | Two narrow patches are explicitly allowed before subsystem work begins, reproducing F6 twice. “Subsystem” is undefined, so preview raster, preview placement, cache lifecycle, and viewer zoom can be classified separately to avoid the trigger. A spec written by the same mistaken designer can also pin the bug, as the optimistic-repositioning contract and P1a ground truth did. |
| P5 | Reviewers receive a polished design based on a mislabeled fixture and approve it because they never independently inspect the source page or holdout set. The ledger also contradicts the premise that reviews were simply too late: several major Opus reviews happened before push. Review timing does not repair bad premises or shared evidence. |
| P6 | A hidden-window synthetic Electron test passes because it waits for the settled state and sees nonzero ink. A visible Retina session with cache churn still flickers, aliases text, or moves the viewport. “One spec per lifecycle” cannot cover the route × state × DPI × output-mode × device matrix, and the existing scan-cleanup E2Es are currently non-blocking quarantine tests. |
| P7 | Behavior is declared verified at 150 and 300 DPI but fails at 200 DPI, on a 600-DPI source, under a different downsampler, or on mixed/JBIG2 output. “Domain” is multidimensional; stating it without a required matrix, interpolation rule, and tolerance is documentation, not prevention. |
| P8 | The claim says “verified by oracle X,” but X ran against a stale staged binary and cache. Or X used wrong labels, silently excluded 30% of pairs, or checked a selected subset. Naming blind spots improves rhetoric but does not prevent closure, threshold manipulation, stale evidence, or invalid ground truth. |

A current concrete defect in the proposed evidence model: the preview harness computes and records provisional-to-settled margin movement ([context comparison](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:775)), but its final violations contain only weight and final/preview margin checks ([violation aggregation](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:921)). Thus a known context jump can coexist with `--check` success.

### Conflicts between P-items

1. **P1 versus P4:** P1 demands a check and permits a fix for every report; P4 allows two symptom patches before requiring a subsystem spec. That institutionalizes exactly two rounds of the behavior F6 condemns.

2. **P2 versus P3:** P2 claims one acceptance surface; P3 correctly admits multiple rendering paths and lifecycle states. There is no single surface—there is a contract among several surfaces.

3. **P2 versus P6:** P2 says automation is insufficient, while P6 calls automated checks “the user’s eyes.” The document never states whether a green E2E plus failed human inspection passes, or vice versa.

4. **P3 repeats F3:** Developers declare which seams they touched, then only those checks run. That is confirmation-scoping with a new name. Impacted seams must be inferred independently.

5. **P4 versus P6:** P4 asks for transition-by-transition verification; P6 asks for one test per lifecycle. Those are incompatible granularities unless a lifecycle spec contains a complete transition table.

6. **P7 versus P3:** DPI, route, mode, source profile, state, zoom, and device multiply into a large cross-product. Neither item defines risk-based selection, pairwise coverage, or a mandatory core matrix, so teams will quietly sample happy cases.

7. **P1/P2 versus P8:** P1 says user confirmation is required and P2 says the viewed experience defines done, but P8 allows closure while listing unverified portions. The document needs one precedence rule.

## C. Answers to Q1–Q5

### Q1. What is not structurally prevented?

Part 2 does not prevent:

- A wrongly interpreted user report becoming the wrong red test.
- Invalid labels or a proxy oracle being treated as ground truth.
- Running the correct instrument against the wrong binary, cache, or revision.
- Omitted seams because the implementer controls the seam declaration.
- Static artifacts passing while temporal behavior fails.
- Overfitting the named fixture and protected references.
- Cross-fix regressions appearing only at the final integrated tip.
- Premature closure with an “unverified” appendix.
- Performance, memory, output-size, or responsiveness regressions.
- The same orchestrator rejecting inconvenient reviewer findings or weakening thresholds.

### Q2. Is P1 workable, and how should it be enforced?

Not as written. It needs a two-stage evidence contract:

1. Create an immutable report ID containing the user’s raw observation, exact source/artifact hash, code and binary identity, route/state/DPI/device, and a minimal witness. The witness should reproduce the observation without prematurely asserting its cause.

2. An independent reproducer confirms that the witness matches the report. If meaning is ambiguous, the user confirms the reproduction before design begins—not only after the fix.

3. Freeze the fixture, metric, threshold, protected references, and blind spots. Prove the check fails on the exact pre-fix revision and passes on the candidate.

4. A candidate may not change its own fixture or threshold. Any necessary oracle change is a separate reviewed change and must re-demonstrate baseline failure.

5. Run the frozen check, impacted seam matrix, protected corpus, and reviewer-owned holdout from a clean integrated tip.

6. Use explicit statuses: `reported → reproduced → internally accepted → awaiting user confirmation → confirmed`. If the user is unavailable, the item remains awaiting confirmation; it is not “closed.” Irreproducible reports may be marked mitigated or unconfirmed, never fixed.

This should be enforced by a machine-readable acceptance manifest checked by CI or the PR workflow, not by dispatch-prompt wording.

### Q3. Right granularity for P3/P4

Use two executable artifacts, not a prose map:

- A **route-contract matrix** at trust boundaries: producer, consumer, required fields, equality/invariant, source DPI, processing DPI, output mode, page topology, cache identity, and linked test IDs. Examples are native → protocol, protocol → deferred planner, planner → TS composition, and preview → final parity.
- A **user-visible state machine** whose nodes are stable presentation states and whose edges are semantic events: first result, analysis update, terminal detection, cleanup start, revalidation, page navigation, zoom, cancellation, and final handoff.

Do not map individual helper functions. Map state ownership and serialization/representation boundaries. Changed files should map automatically to affected contract IDs; a change with no mapped contract must fail or carry a reviewed “no user-visible impact” declaration. Use a mandatory high-risk core matrix plus pairwise coverage for remaining dimensions, not an exhaustive Cartesian product.

### Q4. What is missing entirely?

The critical missing systems are ground-truth governance, tiered corpus gating, performance/resource budgets, exact-build user confirmation, rollback policy, clean-tip provenance, concurrency/landing rules, and convergence metrics. Details follow in Part D.

### Q5. Where must acceptance become independent?

Separate four roles for any high-risk item:

1. **Report owner/reproducer:** defines the witness and ground truth.
2. **Designer/implementer:** owns the change but cannot alter acceptance thresholds.
3. **Acceptance owner:** chooses protected and sealed holdout cases and runs the clean-tip matrix.
4. **Closure owner:** verifies provenance, required checks, unresolved risks, and user confirmation.

For high-severity findings, the orchestrator must not be able to refute a reviewer unilaterally; rejection should require reproducible counter-evidence and concurrence from another reviewer. Code review can assess implementation hazards, but it cannot substitute for independent visual ground truth or runtime acceptance.

## D. Missing elements required for rigor

1. **Corpus governance, not merely corpus breadth.** Split fixtures into tuning, frozen validation, and reviewer-owned blind holdout sets. Cover scripts, RTL, single/spread ambiguity, sparse pages, continuous tone, MRC/JPX/JBIG2, rotation, odd MediaBoxes, source DPI, and output modes. Every escaped defect becomes an autopsy fixture; ambiguous labels require two-person adjudication or conservative “unknown” behavior.

2. **Tiered enforcement.** Run a fast representative matrix on every relevant change, a broader private corpus nightly, and full books before release. The repository already has a standing multi-corpus command ([diagnostic documentation](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/README.md:80)), but CI runs it only conditionally at night ([workflow](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:581)). The document must say which tier blocks what.

3. **Performance and resource budgets.** Record cold/warm time to first visible raster, settled preview p50/p95, setting-change refresh, zoom response, renderer stall, pages/second, peak RSS, temporary disk, output size, and full-book duration on named hardware. Require both an absolute SLA and a maximum regression from baseline. The 2×-DPI preview change explicitly increased cost without measuring it.

4. **User-confirmation design.** Present one exact build/hash, one exact page/state, before/after evidence, and one narrowly phrased acceptance question per report ID. Rejection must reopen the same ID with the new evidence. Do not ask the user to rediscover unrelated regressions or guess whether the app restarted correctly.

5. **Rollback versus fix-forward policy.** Revert immediately when a candidate introduces a higher-severity regression, breaks an unrelated surface, or invalidates evidence provenance, unless reverting risks persisted-data incompatibility. Fix-forward only when the cause is isolated and the complete acceptance matrix can pass within one bounded round; otherwise revert and re-land separated changes. Empty preview panes after `d32b06678` should have triggered this decision explicitly.

6. **Clean-tip integration policy.** Parallel changes touching the same lifecycle must be integrated serially and retested after the last rebase. Cancelled or path-skipped CI is not green evidence. Closure requires a relevant, uncancelled run against the exact tip being delivered.

7. **Evidence provenance.** Every result needs commit and dirty-tree state, binary digest, protocol revision, cache key, tool versions, source hash, options, fixture revision, artifact digest, measured/unmeasured counts, and command. Artifact paths alone are inadequate.

8. **Frozen-threshold policy.** Calibration uses the tuning set only. Thresholds cannot be adjusted after inspecting validation or holdout failures without resetting and re-reviewing the validation claim. This blocks gate-tuning around P1a-like mislabels.

9. **Convergence metrics.** Track escaped defects per accepted change, reopen rate, new regressions per fix, time to valid reproduction, unmeasured fraction, holdout pass rate, high-risk route coverage, touched-code churn, repeated mechanisms, p95 latency, and unresolved severity. “Converged” should require zero P0/P1 escapes, two clean independent full-matrix runs at the final tip, no worsening unmeasured rate, and a real-user-session confirmation window.

10. **Hypothesis and stop discipline.** Each diagnosis should record competing hypotheses, evidence that would disprove each, and a bounded investigation budget. A failed premise should return the item to diagnosis—not merely advance to another implementation round under the same “fixed subsystem” label.

## E. Ranked top-10 document changes

1. **Add four missing failure classes to Part 1:** invalid ground truth/oracles, wrong-build evidence, requirement miscapture, and premature closure. These explain P1a, stale-binary/cache verification, REOPEN 6’s mis-aimed dispatch, and the repeated “CLOSED → REOPEN” cycle better than generic oracle narrowness.

2. **Define a closure state machine and rollback policy.** Ban “closed” until clean-tip acceptance and exact-build user confirmation; known residuals must remain explicitly open. Specify when a higher-severity regression forces immediate revert rather than another fix-forward layer.

3. **Replace P1 with a frozen report-evidence contract.** Separate raw witness from causal/acceptance oracle, require independent reproduction, prove baseline-red/candidate-green, and forbid the candidate from modifying its own fixture or threshold.

4. **Remove “independent orchestrator re-measurement” as an independence claim.** Assign acceptance and closure to actors who did not design the mechanism and give them sealed holdout cases and authority over thresholds.

5. **Replace P3’s prose seam map with an executable route/state/domain matrix.** Tie every boundary and transition to contract fields, test IDs, fixture classes, ownership, and change-impact rules; checks must be selected from inferred impact, not the implementer’s declaration.

6. **Integrate the existing corpus work into mandatory tiers.** Define the fast per-change subset, nightly private matrix, and release full-book gate, plus tuning/validation/holdout separation and label-adjudication rules.

7. **Extend P8 into a provenance schema.** A verification claim must bind revision, binary/cache/tool/source hashes, measured population, exclusions, artifact digest, command, and fresh integrated-tip status—not merely name an instrument and its blind spots.

8. **Rewrite P6 around blocking temporal invariants and promotion criteria.** Existing scan-cleanup Electron tests are quarantined and non-blocking; specify stable fixtures, retry policy, visible-versus-hidden coverage, zero-tolerance frame invariants, and when tests graduate into required CI.

9. **Add explicit performance and resource acceptance budgets.** The document must prevent a visually correct fix from doubling preview latency, memory, or full-book time; record cold/warm p50/p95 measurements on named reference hardware.

10. **Correct the factual overstatements and reconcile P-item conflicts.** Replace “zero oracles,” “no automated instrument at all,” “every seam was user-found,” and “weight fixed twice” with ledger-supported language, then define precedence among user confirmation, automated checks, visual inspection, partial claims, and subsystem-spec triggers.
