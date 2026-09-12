# Adversarial verdict

v2 is materially better than v1, but it is not ready to become operative. Its central defect is now sharper: it often equates “a check can validate a filed record” with “the underlying event, evidence, and conclusion are true and complete.” That leaves a missing-row attack, a wrong-ground-truth attack, and a same-actor-input attack across nearly every M-item.

Several v2 corrections also introduced factual overreach.

## A. New errors and overcorrections

1. **F1’s revised history is still false as written.** v2 says closure language “never carried” G3 scoping ([v2 lines 14–18](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:14)). The ledger explicitly says Wolf-route boldening is a distinct, out-of-scope mechanism ([ledger lines 923–925](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:923)) and later lists residual G3 cosmetics as open ([ledger lines 1050–1052](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1050)). The fair criticism is that the prominent `G3 FIX LANDED`/session-close rhetoric overwhelmed those qualifications—not that scoping never existed.

2. **F7 conflates five different e2e situations.** The lane is indeed scheduled, non-blocking, and `continue-on-error` ([CI lines 782–812](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:782)), with zero manually recorded graduation counters ([policy manifest lines 35–57](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/graduation-policy.json:35)). But:

   - `scanCleanupAppTruthProbe` is entirely variable-gated ([lines 20–32](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupAppTruthProbe.e2e.test.ts:20)).
   - `scanCleanupUniformity` is entirely variable-gated ([lines 58–69](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupUniformity.e2e.test.ts:58)).
   - Only the representative case in `scanCleanupMatchedCanvas` is variable-gated ([lines 572–576](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:572)); its synthetic one-canvas case runs without that variable ([lines 671–721](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:671)).
   - `scanCleanupJourney` and `scanCleanupLayoutStability` are unconditional synthetic-fixture specs ([journey lines 41–47](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupJourney.e2e.test.ts:41), [layout lines 83–89](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupLayoutStability.e2e.test.ts:83)).

   Also, the one-canvas test is not “the exact invariant behind the jump reports.” It asserts common frame geometry; the ledger’s remaining defect is a 2.69% content shift during provisional→settled transition inside that canvas ([ledger lines 1184–1187](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1184)).

3. **The “repo-mandated CodeRabbit path was bypassed for the entire arc” is retroactive.** The mandate currently lives in ignored, machine-local `AGENTS.md`/`CLAUDE.md` files; `.gitignore` expressly calls them developer convenience ([`.gitignore` lines 16–29](/Users/evb/WebstormProjects/evb-viewer/.gitignore:16)). The tracked CodeRabbit configuration was introduced only in commit `83b54a867` on August 13. Current CI explicitly accepts direct pushes to `main` ([CI lines 7–14](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:7)), and CodeRabbit is configured not to request changes ([`.coderabbit.yaml` lines 6–15](/Users/evb/WebstormProjects/evb-viewer/.coderabbit.yaml:6)). Thus a current PR gets auto-review, but neither “mandated throughout the arc” nor “enforced now” follows.

4. **F9 incorrectly says no process element addressed diagnostic error.** The wrong smoothing diagnosis was caught precisely because the implementation round hit a mandatory two-sided reference gate and stopped ([ledger lines 888–909](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:888)). Diagnostic discipline was inadequate and inconsistently applied; it was not absent.

5. **F10’s count of three native exact-tip omissions is unsupported by the cited ledger.** The ledger documents canceled exact-tip native runs for `adab5a4dc` and `6ff126e67` ([lines 1033–1036](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1033), [lines 1100–1103](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1100)). The other named cancellation, `5db654cb7`, was a TypeScript/viewer landing, not native ([ledger lines 927–934](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:927)). The defensible count from this evidence is two.

6. **F12 conflates distinct closure scopes.** Wolf was explicitly open at the G3 landing but was fixed before the later session close ([ledger lines 923–958](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:923)). The jump and latency residuals were disclosed only in the later REOPEN 6 resolution ([lines 1184–1193](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1184)). The concrete error is narrower and stronger: REOPEN 6 was marked “RESOLVED” while P3 still had an explicit design remainder.

7. **F13’s “every process improvement” claim is too absolute.** The enumerated model/visual/closing policies were user-mandated, but the ledger also records internally derived controls: staged-binary shadow detection ([lines 370–374](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:370)) and the switch from scoped to full unit runs after a miss ([lines 927–934](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:927)). Rewrite F13 as “the durable governance changes were user-imposed; locally discovered lessons did not reliably propagate.”

8. **F14’s “autopsy seeding was never applied” is overbroad.** An actual Luther failure page was added as a checked-in real split fixture ([fixture manifest lines 374–380](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/tests/fixtures/split/fixtures.json:374)), and the initial representative fixture/oracle was built from the reported book ([ledger lines 143–160](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:143)). What failed was systematic “every reopen enters Tier A” seeding.

9. **M7/R3 misidentify the existing nightly job.** CI invokes `scan-cleanup:regress` without `--full` ([CI lines 581–632](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:581)). That command explicitly excludes its fullbook tier unless `--full` is supplied ([regress script lines 51–65](/Users/evb/WebstormProjects/evb-viewer/scripts/scan-cleanup-regress.mjs:51), [lines 745–755](/Users/evb/WebstormProjects/evb-viewer/scripts/scan-cleanup-regress.mjs:745)). It is a Rome/acceptance/canvas/header net, not the ledger’s 250-fixture corpus ([diagnostics README lines 80–123](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/README.md:80)). Merely setting the repo variable also does not provision ignored private fixtures onto a stock GitHub runner; the workflow has no download/mount step before `test -r` ([CI lines 591–632](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:591)).

10. The external assertion `variables total_count=0` is not auditable from v2, the ledger, or tracked repo state. v2 should attach the query output/run timestamp rather than asserting it parenthetically ([v2 lines 27–31](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:27)).

## B. M1–M12: actual enforcement and surviving recurrence

1. **M1 — not real yet, and the proposed check cannot detect omitted events.** `docs/quality/` and the described architecture test do not exist. Worse, its model policy is itself manually fed: the existing graduation test only checks that counters remain below 30 ([test lines 99–123](/Users/evb/WebstormProjects/evb-viewer/tests/unit/architecture/quarantineGraduationPolicy.test.ts:99)); nothing updates those counters from CI results.  
   **Recurrence:** omit the user report row entirely, or enter a plausible check ID/hash/timestamp. The static test sees a syntactically valid universe because the actor defined the universe.

2. **M2 — partially external, but dispatch is not enforceable.** A user-authored ratification can prevent requirement drift, but M1 cannot prove that the quoted message is authentic, that all complaint dimensions were represented, or that fixing did not begin before ratification ([v2 lines 107–117](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:107)).  
   **Recurrence:** reproduce only blank panes, obtain “yes,” and omit raster mottling/jumps—the exact REOPEN 6 sequence ([ledger lines 1145–1173](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1145)). Also, user unavailability deadlocks an urgent rollback because ratification is required before any fix dispatch.

3. **M3 — useful provenance, not a cure for dismissal.** The repo already hashes the actual native binaries into output provenance ([buildManifest lines 16–58](/Users/evb/WebstormProjects/evb-viewer/scan-cleanup-core/buildManifest.ts:16)); presentation and register binding are missing. Build identity resolves stale-binary ambiguity but does not “kill F2”: the stale-instance dismissal occurred after the user had restarted and involved a current build using a divergent deferred path ([ledger lines 1105–1120](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1105)).  
   **Recurrence:** current app/binary hash, stale or divergent preview cache/path, report dismissed as stale session/cache rather than stale executable.

4. **M4 — real components exist, but closure truth remains selected by the orchestrator.** Output provenance already contains source, options, mappings, plan digests, and binary hashes ([provenance contract lines 95–119](/Users/evb/WebstormProjects/evb-viewer/scan-cleanup-core/provenanceStamp.ts:95)). The proposed closure table, retrievable pre-fix binaries, and attachment gate do not.  
   **Recurrence:** P1a-style wrong label: the oracle is red on pre-fix, green on post-fix, and perfectly reproducible while certifying destructive behavior ([ledger lines 684–703](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:684)). Machine generation cannot correct fixture selection, denominator choice, threshold choice, or ground truth.

5. **M5 — proposed census is syntactic and misses semantic routes.** The current seam map is prose and contains unresolved `?` entries ([SEAM-MAP lines 3–9](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:3)); it has no check IDs, owners, or removal conditions.  
   **Recurrence:** change a branch inside an existing deferred consumer. Consumer count and entry point remain unchanged, while deferred and in-memory behavior diverge—the mechanism behind REOPEN 5 ([ledger lines 1107–1120](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1107)). A wrapper/renamed entry point also evades a named-call-site census.

6. **M6 — partially real, materially incomplete.** The quarantined tests exist, but their graduation counters are manually maintained and the lane is non-blocking. The proposed state list omits waiting-for-detection, starting-cleanup, failed, canceled, stale-refreshing, and detail-render states that the current route map documents ([SEAM-MAP lines 15–27](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:15)).  
   **Recurrence:** provisional and settled frames retain identical canvas dimensions but shift content internally. The preview harness calculates `rasterIdentical` and `inkMarginShift` ([harness lines 992–1007](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:992)), yet context violations currently include only overlay containment; the shift is not failed ([lines 1081–1115](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:1081)).

7. **M7 — neither the tier wiring nor label governance is sufficient.** The nightly job is not the claimed full corpus, and private fixture delivery is missing. “Two-party adjudication **or written criteria**” still permits one-party self-declaration ([v2 lines 159–167](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:159)). “Native-pipeline landing” also excludes TS/Electron preview changes such as d32b06678.  
   **Recurrence:** two reviewers share the same mistaken physical-page assumption; pre/post gates pass P1a. Alternatively, a TS preview change skips Tier A because no native path changed.

8. **M8 — advisory, bypassable, and partly self-reported.** A PR receives CodeRabbit auto-review, but direct pushes remain accepted, CodeRabbit does not request changes, and no tracked check requires a review conclusion ([`.coderabbit.yaml` lines 62–75](/Users/evb/WebstormProjects/evb-viewer/.coderabbit.yaml:62), [CI lines 7–14](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:7)). M4 merely storing a run ID does not prove that it belongs to the claimed SHA or exercised the affected path.  
   **Recurrence:** direct push to `main`, or a fail-open/skipped CodeRabbit review, followed by a manually entered run ID from a newer config-only tip.

9. **M9 — enforcement depends on contested classifications.** The register must self-report severity, regression origin, clock start, and revert status ([v2 lines 176–182](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:176)).  
   **Recurrence:** call it pre-existing, S3, or “not yet traced”; the one-hour clock never starts. A recorded revert commit can also exist without proving that the delivered build actually contains it.

10. **M10 — only fragments exist.** One quarantined test gates first-visible and settled times on an operator-supplied representative PDF ([matched-canvas lines 636–655](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:636)); another measures renderer responsiveness on a synthetic 60-page run ([lines 1175–1224](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:1175)). There is no current named-hardware p95/zoom/full-book/RSS budget suite.  
    **Recurrence:** update the baseline or hardware label together with the regression; or change preview composition while the CLI/native benchmark remains green.

11. **M11 — still mostly declaration.** “Different agent,” “second reviewer,” “predicted quantity,” and “counter-evidence” are fields in dispatch templates/register rows, not independently authenticated events ([v2 lines 192–202](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:192)).  
    **Recurrence:** the orchestrator chooses the test author, prompt, fixture, reviewer, and evidence frame. Both actors independently implement the same wrong P1a label. Severity can also be demoted before the second-review requirement applies.

12. **M12 — cannot be computed from git alone.** “Same axis,” “escaped defect,” and “valid reproduction” require semantic labels. The threshold remains an example (`e.g. >=3`), not a specification ([v2 lines 204–210](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:204)). M2 and M12 both say they force “M6 spec-mode,” but M6 only specifies preview lifecycle transitions; it has no spec mode for native binarization, split, or codec defects.  
    **Recurrence:** alternate preserve/remove behavior within one commit or relabel commits as different axes. The script reports convergence while behavior oscillates.

## C. Round-close precedence and tiering

There are two concrete deadlocks.

**Emergency-revert deadlock:** M2 forbids fix dispatch before user ratification ([v2 lines 107–117](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:107)); M9 requires reverting an S1/S2 regression within one hour ([lines 176–182](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:176)); severity rules require an S1 landing—including the revert—to pass all seven gates ([lines 212–219](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:212)). With the user unavailable, no ratification; without dispatch, no revert; without the private corpus/e2e/provenance bundle, no seven-gate landing within an hour. If emergency reverts are exempt, the supposedly single precedence definition is false.

**Exact-tip CI deadlock:** CI uses `cancel-in-progress: true` ([CI lines 3–5](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:3)). `6ff126e67` had its native run canceled by a config-only push whose green run skipped native ([ledger lines 1100–1103](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1100)). Once another commit is tip, rerunning the normal workflow validates the new tip, not the old delivered SHA; adding a native-touching commit changes the tip again. M8 therefore needs a SHA-parameterized validation workflow or PR/merge queue, not “rebase + rerun.”

The tiering also reproduces the historical failure:

- S2 may land without provenance/negative control or exact-tip CI, promising them “within the day.” That is exactly when another push cancels the run and the pre-fix binary/evidence disappears.
- S3 can land with no CI, seam, corpus, lifecycle, or performance gate at all. Yet the ledger’s “cosmetic” page-type chip fed picture-protection logic ([ledger lines 39–50](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:39)). Observable severity does not bound change-surface risk.

The item most likely to be silently dropped is **M4**: v2 explicitly permits S2 landing before it, reconstructing old binaries and complete provenance gets harder after every subsequent landing, and M1 only keeps the row open—it does not undo the shipped regression.

Severity should not select gates by itself. S1 should narrowly mean silent/irreversible content loss, page loss/reordering, corrupt/unopenable output, source overwrite, wrong OCR/text binding, or security/privacy loss. Reversible output aesthetics, preview behavior, and latency belong in S2. But gate selection must be the union of severity **and affected routes/change surface**; unknown impact defaults upward.

## D. Part 3 backlog

The priorities need reordering and widening.

- **P0: R2 plus full label/oracle repair.** Do not make an invalid oracle more blocking. Re-adjudicate P1a’s 15 fixtures and quarantine any destructive labels first; the ledger explicitly requires this before rebuilding the split gate ([ledger lines 684–709](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:684)). Add mutation tests proving that each oracle fails for the intended reason.
- **P0: redesign R3.** A repo variable is not fixture provisioning and the named job is not the 250-fixture corpus. Specify a self-hosted runner or authenticated artifact download, manifest/fixture digests, Tier A versus Tier B commands, and fail-closed evidence upload.
- **P0: R1 plus the unresolved P3 jump.** Gate maximum provisional→settled shift and `rasterIdentical` policy, not merely “contextStability.” REOPEN 6 remained partially unresolved ([ledger lines 1184–1193](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1184)).
- **P0/P1: split R5.** Track the reports, round-one reviews, dispositions, fixture manifest, and evidence schemas immediately. Do not implement the architecture test until it can detect missing events and validate external evidence rather than only row syntax.
- **P1: R4 only after automatic graduation accounting.** The existing pattern has no process that consumes CI results and updates counters.
- **P1: R7 should reuse executed-binary hashes already produced by the provenance stamp**, adding app commit/renderer/main-process identity and binding the displayed value to each actual invocation.
- **Drop R8 from the immediate backlog.** The metric has no defined classifier, threshold, or demonstrated predictive value. A baseline would merely canonize a subjective count.
- **R6 is editorial, not remediation.** Fix it, but it should not occupy a ranked engineering backlog slot.

Missing entirely:

- an emergency rollback lane;
- a SHA-addressable uncancelled validation workflow or merge queue;
- branch protection/required review evidence;
- an immutable user-message/report-event source so omission is detectable;
- a waiver schema with approver, scope, expiry, and automatic failure after expiry;
- separate approval for oracle/threshold changes;
- secure corpus delivery and evidence retention;
- the unresolved preview-performance increase and session-pinned presentation-canvas work.

## E. Answers to Q1–Q5

### Q1: Which F-classes remain unprevented?

All fifteen remain at least partially recurrent:

| Class | Surviving recurrence |
|---|---|
| F1 | One broad “weight” row/check covers Otsu; Wolf, dense-page, and preview-DPI mechanisms remain outside the closure denominator. |
| F2 | Current build hash, divergent cache/route; orchestrator and selected reviewer agree it is stale state. |
| F3 | Red/green check overfits one specimen or wrong label; all recorded projections pass. |
| F4 | One-canvas dimensions stay fixed while content shifts internally; temporal shift remains measured but ungated. |
| F5 | Existing consumer gains a deferred-only branch; call-site census is unchanged. |
| F6 | S3 or misclassified S2 change touches shared processing but receives reduced gates. |
| F7 | Counters stay at zero; private corpus is absent; direct push bypasses PR review. |
| F8 | Two actors share the same wrong physical-page label; negative control reinforces the error. |
| F9 | Predicted quantity is vague or measures a correlate; wrong diagnosis still produces a red/green oracle. |
| F10 | Config-only newer tip is green while native exact-tip run was canceled; run ID is manually attached. |
| F11 | Ratification artifact shows only one symptom dimension; user confirms the incomplete reproduction. |
| F12 | S2 lands before steps 6–7; “awaiting” remains open while rhetoric and delivered build imply closure. |
| F13 | Actor modifies schema, check, evidence row, and production change together; CI certifies the new self-authored rules. |
| F14 | Nightly runs the smaller standing net while the 262-entry/437-file ignored corpus remains unused. |
| F15 | All provenance and byte-identity checks pass while the underlying fixture, expectation, or untouched route is wrong. |

### Q2

The precedence is not workable until it has an emergency lane and SHA-addressable CI. M4 is the most likely silent casualty; M7 is the most likely operationally unavailable gate.

### Q3

S1 should cover silent/irreversible content or document-integrity harm, not every visual output defect. Gate selection must also follow touched routes and uncertainty; “S3 observed symptom” cannot waive shared-pipeline tests.

### Q4

R2/R3/R1 require immediate expansion; R6/R8 are low-value. P1a ground-truth re-adjudication, P3 jump/performance, CI fixture provisioning, review enforcement, and rollback are missing.

### Q5: attack on the consensus

The consensus’s central proposition is wrong: **mechanical enforcement does not make self-authored inputs independent or true**. A static test can prove that every filed row has a check; it cannot prove that every report was filed, that the quoted report is authentic, that the fixture label is correct, or that the check covers the complaint.

The three reviews also are not independently auditable. v2 says the reports were validated but provides no report paths, message IDs, digests, claim-by-claim disposition table, or reproductions—only the author’s summary ([v2 lines 3–6](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:3)). Thus the document’s foundational “three-reviewer consensus” is itself exactly the kind of untracked self-declared evidence that Part 2 forbids.

All parties also appear to have missed the **missing-row problem** and the distinction between:

- syntactic independence: another actor/check exists;
- epistemic independence: different evidence, incentives, and failure assumptions;
- enforcement independence: the reviewed party cannot edit or bypass the gate.

M1–M12 mostly achieve, or propose, only the first.

## F. Ranked top five changes for v3

1. **Replace every M-item’s “Enforcement” sentence with an enforcement audit tuple:** current/proposed, executable path, authoritative input source, bypass path, failure injection, required CI status. Do not call anything enforced until the failure injection demonstrably blocks landing.

2. **Create an immutable event-to-evidence chain, not a hand-maintained register.** User messages, CI runs, binary/fixture hashes, review conclusions, and delivery identities need source IDs/digests fetched or generated automatically. CI must detect both invalid rows and missing required events.

3. **Add oracle assurance as a first-class mechanism.** Require base/head evaluation with the same oracle, mutation controls, held-out fixtures, reason-specific RED assertions, separately approved label/threshold changes, and blind adjudication for destructive ground truth.

4. **Replace severity-only precedence with change-surface gates plus an emergency rollback lane.** Add SHA-addressable uncancelled CI/merge queue, automatic rollback deadlines, and explicit time-limited waivers. Remove “S2 within the day” and “S3 only 1+6.”

5. **Build the two actual blocking suites before expanding governance prose:** a small, provisioned Tier A containing every reopen/autopsy route and a blocking lifecycle/preview suite with real temporal deltas; then a securely provisioned Tier B full corpus. Graduation counters and corpus membership must update from machine results, not edited numbers.
