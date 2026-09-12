# Final verdict

No. v4 is substantially better, and the scope guard correctly trims several of my own round-3 proposals. But it is not ready to become operative: the body silently reinstates most of those cuts, several headline measurements are wrong or irreproducible, and S2 would regenerate a baseline before correcting known-invalid ground truth.

The required delta is mostly subtraction, correction, and reordering—not new machinery.

## A. Part 5: Z1–Z5

### Z1 — Independent measurement audit

I inspected HEAD `7f9af7d`, Git history, the public GitHub run history, the ledger, and the relevant scripts/configuration. I did not run Electron or mutate the tree.

For LOC, the repository’s methodology treats authored LOC as excluding blanks and comments. The supplied calculator requires temporary files and could not run under the strict no-write constraint, so figures below obtained with `wc -l` are explicitly physical lines, not authored LOC.

| v4 claim | Independent result |
|---|---|
| `>=4` distinct weight mechanisms | Supported, although the boundary should be enumerated: per-leaf route divergence, component-scoped faint rescue, separate Wolf-route behavior, and low-DPI preview binarization are distinct mechanisms. [Route divergence](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:256), [faint rescue](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:888), [Wolf route](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:923), [preview DPI](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1161). |
| Two dismissals, “provisional” and “stale instance” | Only the stale-instance dismissal is independently explicit in the ledger. I could not recover a comparably explicit “provisional” dismissal event; provisional geometry is discussed, but not documented as a dismissal. Change this to one documented dismissal unless the missing transcript evidence is supplied. [Ledger](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1105). |
| Reviewers found six seams | Not reproducible. The seam map has nine user-visible pixel-path rows, followed by separate transition and calibration tables; it never identifies a canonical set of six. Remove the number or name the six. [Seam map](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:1). |
| 33 files, `+2305/-318`, 12 hours | Confirmed by both Git and ledger. [Ledger](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:598). |
| Quarantine: 9 specs, 5 scan-cleanup | Confirmed by the manifest. [Manifest](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/graduation-policy.json:13). |
| Of those five, two fully environment-gated | Confirmed: AppTruthProbe and Uniformity. [AppTruthProbe](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupAppTruthProbe.e2e.test.ts:28), [Uniformity](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupUniformity.e2e.test.ts:179). |
| matchedCanvas has 8 tests, 7 ungated | Confirmed: one representative test is selected by an environment variable, followed by seven unconditional `it` blocks. [matchedCanvas](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:572). |
| Journey and LayoutStability are unconditional/self-fixturing | Confirmed from their unconditional test bodies. [Journey](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupJourney.e2e.test.ts:47), [LayoutStability](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupLayoutStability.e2e.test.ts:89). |
| Graduation requires 30 greens; counters hand-maintained and pinned below 30 | Confirmed. All nine counters are presently zero; the architecture test requires every counter to remain below the threshold and pins `blocking:false`. [Policy](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/graduation-policy.json:4), [architecture test](/Users/evb/WebstormProjects/evb-viewer/tests/unit/architecture/quarantineGraduationPolicy.test.ts:99). |
| Maximum green streak 5 in 45 nights | Not independently reproducible from a committed artifact. The public history can establish job outcomes, but v4 supplies neither the selected 45 run IDs nor a counting rule. Do not make it operative as an uncited number. |
| Current 14-night failure streak | Confirmed more strongly than v4 states: each of the latest 14 quarantine jobs from July 31 through August 13 failed. [Latest job](https://github.com/evb0110/evb-viewer/actions/runs/31666671838/job/94342613818), [fourteenth job](https://github.com/evb0110/evb-viewer/actions/runs/30607643064/job/91083240412). |
| Those scheduled failures were “caused by” Nightly Maintenance | Misleading. Maintenance was a sufficient red condition, but not the sole cause: the latest run also failed Quarantine, Regression, and Large PDF. [CI #803](https://github.com/evb0110/evb-viewer/actions/runs/31666671838). The `14/14` maintenance claim itself needs a run-ID receipt if retained. |
| Baseline catastrophes: content loss 2, classification 1, offcut 1, minimum IoU 0 | Confirmed. [Baseline](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/harness-baseline.json:3), [inventory and IoU](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/harness-baseline.json:28). |
| `>=4` orchestrator diagnostic errors | Confirmed: false smoothing diagnosis, harmless-clamp premise, stale-instance dismissal, and reversal of the correct overhang design. [Smoothing correction](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:888), [clamp](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:986), [stale instance](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1105), [overhang reversal](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:598). |
| “CLOSED” preceded four reopens | Confirmed: the close at line 1038 is followed by Reopens 3–6. [Closure](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1038), [Reopen 3](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1054), [Reopen 6](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1145). |
| Ledger says nine audit classes; code has eight | Confirmed. Ledger says nine and later says eight; the audit defines eight keys. [Ledger nine](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1068), [ledger eight](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1142), [audit code](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-representative-audit.mjs:1791). |
| Five of the last 40 push runs were cancelled; all lost the native job | Confirmed by an independent 40-run recount. The five are [#809](https://github.com/evb0110/evb-viewer/actions/runs/31720903629), [#801](https://github.com/evb0110/evb-viewer/actions/runs/31662409436), [#798](https://github.com/evb0110/evb-viewer/actions/runs/31657150659), [#794](https://github.com/evb0110/evb-viewer/actions/runs/31649428175), and [#778](https://github.com/evb0110/evb-viewer/actions/runs/31475351175). The workflow currently cancels all same-ref runs and gives the native job a 60-minute timeout. [Workflow concurrency](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:3), [native job](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:228). |
| 22% of native-touching landings lost their own-SHA native gate | Confirmed: 4 of 18, or 22.2%. The fifth cancelled run did not itself touch a native-classified path. |
| Quality Gates red 12/40, 30% | False. Individual job recount: 28 succeeded, 10 failed, 2 were cancelled. Red was 10/40 = 25%. The source population is [push page 1](https://github.com/evb0110/evb-viewer/actions/workflows/ci.yml?query=event%3Apush) plus [push page 2](https://github.com/evb0110/evb-viewer/actions/workflows/ci.yml?page=2&query=event%3Apush). |
| Eight-commit, 7h20 red streak, fixed by an 8-line test edit | The eight landed commits and 7h20 interval are confirmed. The repair was two test files with 8 insertions and 2 deletions—not eight total changed lines. |
| Unit tests PR-only while work landed by pushes | Confirmed. Unit tests are conditional on `pull_request`; pushes run coverage instead. [Workflow](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:60). |
| Native CI tail p90 25m, max 73m | Max is 73m16s. Across the 35 non-cancelled runs, median is 8m33s; p90 is 25m49s by linear interpolation or 26m01s by nearest-rank. “25” is not reproducible without specifying the estimator and rounding. |
| Roughly 13 landings/day | False under elapsed-time arithmetic: the 40-run window spans about 65h06m, or 14.75 pushes/day. “13” is only obtained by dividing by three touched calendar dates. G3 is trimmed anyway, so delete this number. |
| H50 is the current tracked corpus | Only the baseline is H50: 36 real + 14 synthetic. The live builder now reads 34 split fixtures, three hard-coded glyph fixtures, and 14 synthetic fixtures: H51. [Baseline](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/harness-baseline.json:28), [builder](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/corpus.rs:89), [synthetics](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/corpus.rs:217). |
| One Luther split fixture was seeded | One new Luther plate fixture was added during this arc, but five Luther fixtures exist in total. Rewrite as “one additional arc fixture.” [Current manifest](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/tests/fixtures/split/fixtures.json:322). |
| Baseline is 23 days / about 110 commits stale | At HEAD it is about 22 elapsed days. There are 116 commits touching `native/scan-cleanup` since its last change, but 601 repository commits. “~110” is reasonable only if explicitly qualified as crate-touching; “23 days” should be ~22. |
| Harness comparator has no tracked caller | Confirmed. The only tracked `scan-cleanup-harness` references are its own binary implementation. |
| Preview harness has no caller | Confirmed; it requires explicit `--source`, `--pages`, and `--out`. [Usage](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:5). |
| Representative audit has eight classes | Confirmed, but measurement-coverage modeling currently covers only four of them. [Class list](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-representative-audit.mjs:1791), [coverage subset](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-representative-audit.mjs:1821). |
| 19,881 LOC of validation tooling | The number is reproducible as 19,881 physical lines across 15 named scan-cleanup diagnostic/conversion scripts. It is not authored LOC: it includes blank/comment lines and two JSON files. Relabel it “physical lines” or calculate authored LOC in a writable verification environment. |
| Six architecture tests | Not reproducible as worded. There is no stated selector defining those six. Only two files under `tests/unit/architecture` contain scan-cleanup references, while other related checks live in non-architecture projects. Enumerate the six or remove the number. |
| Threshold constants grew 120→157 | False. A whitespace-tolerant count of named `f32`/`f64` constants produces 129 at `6c4c142dd` and 166 at HEAD: still +37, but both absolutes are wrong. The earlier regex omitted nine indented constants at both revisions. [v4 claim](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:151). |
| Codec 1,055→2,267; preview service 3,207; crate 54,123 LOC | Current physical counts of 2,267 for `ipcRequestCodecs.ts` + `ipcResultCodecs.ts`, 3,207 for the preview service, and 54,123 Rust source lines are confirmed. But the historical 1,055 is an authored-code figure from the charter while 2,267 is physical lines. At the charter’s first commit, the principal codec file alone was 1,235 physical lines. The growth comparison is apples-to-oranges and must be removed or re-derived consistently. [Charter](/Users/evb/WebstormProjects/evb-viewer/docs/internal/architecture-audit-2026-07-23.md:160). |
| Existing performance data is ready for a timing ratchet | Partly false. The harness emits timings, but deliberately labels them “Non-comparable performance” and excludes them from comparable JSON. A hard baseline is therefore not an hours-only wiring exercise. [Report code](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/report.rs:127). |
| Preview thresholds 15%/3%; remaining jump 2.69% | Confirmed. [Harness thresholds](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:15), [remaining jump](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1186). |
| `scan-cleanup-core/**` and `scan-cleanup-adapters/**` match no changed area | Confirmed. Neither path appears in electron-smoke or native/build path maps. Core is a workspace root; adapters is a tracked root directory but not a workspace package. [Policy](/Users/evb/WebstormProjects/evb-viewer/scripts/release/policy.mjs:23), [workspace](/Users/evb/WebstormProjects/evb-viewer/pnpm-workspace.yaml:1). |
| Build identity is absent | Confirmed. Dev app version is only the bundled package version; the provenance stamp includes native hashes and plan/source digests but no Git SHA or renderer identity. [appVersion](/Users/evb/WebstormProjects/evb-viewer/electron/appVersion.ts:9), [stamp](/Users/evb/WebstormProjects/evb-viewer/scan-cleanup-core/provenanceStamp.ts:95). |
| One current required check / current branch-protection details | Not independently reproducible from the tracked repository or unauthenticated public settings. Treat this as an implementation-time observation, not a durable measured fact, unless a timestamped API response is archived. |
| CodeRabbit pauses after two reviewed commits and excludes `.devkit` | Confirmed. [Configuration](/Users/evb/WebstormProjects/evb-viewer/.coderabbit.yaml:16), [pause](/Users/evb/WebstormProjects/evb-viewer/.coderabbit.yaml:62). |
| Operative documents are in a tracked home | False now. `.devkit/` is ignored; neither v4 nor the ledger is tracked, and CodeRabbit excludes that tree. [gitignore](/Users/evb/WebstormProjects/evb-viewer/.gitignore:23). |

Z1 conclusion: v4 fails its “only measured facts” promise. The largest corrections are 10/40 rather than 12/40 Quality failures; 129→166 rather than 120→157 constants; H51 live versus H50 baseline; and ~22 days/116 crate-touching commits rather than an unqualified 23/~110.

### Z2 — Failure caused by backlog order

There is first a textual defect: Part 5 asks about “S1–S10,” but the backlog has S1–S6. [Question](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:359), [backlog](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:328).

The ordering creates this concrete failure:

1. S1 changes governance but leaves the live feature’s 2.69% settle jump and unresolved word-weight work untouched.
2. S2 regenerates and blocks on the baseline.
3. S6 only later re-adjudicates the known-invalid nonzero catastrophe labels.
4. Therefore S2 can canonize incorrect ground truth and make a conservative correction fail the new gate.

That is not hypothetical. P1a passed its own gate against a mislabeled three-column dictionary page and would have destructively split a text column; the work was stopped only by later visual adjudication. [P1a recurrence](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:684).

There is also a deployment-order failure inside S1: a ruleset cannot safely require `gates_ok` until a workflow containing that check has landed and produced the check name. Workflow PR and external ruleset activation must be two ordered operations, not one atomic X2 step.

During S1–S3, the user experiences exactly the wrong priority: more process changes while the known feature defects remain visible. S4 must move immediately after the minimum CI-truth prerequisite; re-adjudication must move before baseline regeneration.

### Z3 — X2 throughput and the emergency lane

The protocol does not survive a large defect burst as written.

At the observed tail, serial required checks yield at most about 2.3 merges/hour before review, fix work, CodeRabbit, and up-to-date reruns. Under strict serial protection, each merge can invalidate a following PR’s base and force another CI pass. In practice this is roughly one substantial step every one to three hours, not burst throughput.

G2 is not a safe pressure valve:

- `gates_ok` is defined as the aggregator of all blocking jobs, but G2 reuses the same name for a “fast subset.” One required check cannot mean two different graphs safely.
- The one-hour deadline starts at the user report, so a 26-minute p90—or 73-minute maximum—can consume most or all of it before diagnosis.
- A forward fix is allowed inside the same exception that is meant to make rollback safe.
- “status: policy” is not in v4’s mandatory status vocabulary. [Vocabulary](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:33), [G2](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:205).

Minimal safe answer: delete the special fast-subset machinery. A tip-revert PR gets scheduling priority but passes normal `gates_ok`; freeze other merges until it lands. If a separate accelerated path is later proved necessary, give it a separate check identity and restrict it mechanically to reverting the current tip—never a forward fix.

### Z4 — Classifier attack and first version

The scope guard’s cut is correct. The first committed classifier should be no classifier.

Recall failures in the proposed design include:

- Attachment- or video-only reports.
- Elliptical corrections such as “still,” “same,” or only a page number.
- Corrections of an orchestrator summary.
- One message containing several defects plus an instruction.
- Non-English, ironic, or positively framed defect reports.
- Out-of-band reports unavailable to the transcript reader.

Precision failures include:

- Historical quotations.
- Hypothetical/adversarial-review examples.
- Acceptance criteria and test descriptions.
- Questions or instructions that mention defects.
- Negated statements.
- Source paths, page references, and code excerpts.

The disposition scheme is worse: a message can simultaneously be a question, instruction, and defect; a “duplicate” can be a new recurrence on a new build; and “out-of-scope” is author-controlled.

If later evidence proves manual capture insufficient, the first classifier should only nominate candidates, never disposition or close them. During an active feature session it should select every non-administrative user message, always including attachments and corrective markers. Ambiguity means “candidate,” followed by human mapping to a ledger row. No hashes, terminal digest, backdating test, or public transcript join is justified now.

### Z5 — Forced prioritization

The single item whose removal would regenerate the largest failure class is O1: wire existing oracles.

Without O1, the feature repeats F16 regardless of how elegant the other policies are: comparator, audit, preview harness, and regress job can all exist while receiving no data or having no caller. G1 cannot reject a failure that no required job measures.

O1 itself should be narrowed to:

- Wire the current H51 harness and catastrophe comparison into `test:rust`.
- Add one tracked preview/final specimen and caller.
- Delete the private-manifest nightly job unless a hosted, readable manifest genuinely exists.

Do not treat every private corpus as an O1 prerequisite.

## B. Scope-guard audit

### Every trimmed item

The cuts are sound—including cuts to my round-3 proposals. No full trimmed item needs to return.

| Trimmed item | Verdict |
|---|---|
| B1 full transcript hash chain | Endorse. No recurrence was caused by lack of cryptographic chaining; the missing-row problem is semantic and hashes cannot detect an omitted report. Estimated avoided cost: 2–5 implementation days plus permanent transcript-format/privacy maintenance. |
| B5 custom digest archive | Endorse. Git already content-addresses tracked files. Estimated avoided cost: 0.5–1 day plus duplicate provenance maintenance. The replacement must actually use a tracked path. |
| Full mutation-class/oracle formalism | Endorse. Keep red-on-pre-fix and separate label/threshold changes. A simple baseline/current inventory equality check is enough to detect H50/H51 drift; it does not require a taxonomy civilization. Estimated avoided cost: 2–4 days. |
| Tier B/C VPS runner | Endorse deferral. The documented failures came from no callers, false labels, and missing preview coverage—not from Tier A residency. Estimated avoided cost: 1–3 days plus runner/secrets/platform maintenance. |
| E1b grand redesign | Endorse deferral. Reopens 5–6 prove the need for a narrow preview/final parity oracle, not yet a `LeafPlan`/`PagePartition` redesign. Full work is plausibly weeks and is explicitly unsized. |
| Cadence caps | Endorse. A cap delays fixes and does not improve oracle validity. Delete G3, which currently reinstates it. |
| Severity state machine | Endorse. Default-S1 plus user-only downgrade would manufacture blocking user round-trips. Retain only “reproduce before dispatch; ask the user when intent is materially ambiguous.” |
| Disposition taxonomy | Endorse. Mixed messages and changed recurrences make the labels unsafe. Retain quote, observed behavior, status, and proof—no classifier-owned disposition. |

The central scope defect is that v4 declares these items trimmed at [lines 18–31](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:18), then reinstates them as operative T2, G3, B1, B2, B5, and O2 at [lines 156–168](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:156) and [205–256](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:205). The guard is currently commentary, not control.

### Every kept mechanism: minimality

| Mechanism | Minimal disposition |
|---|---|
| Status vocabulary | Keep only for executable checks. Apply the five terms consistently; `policy` is a mechanism type, not a status. Many current mechanisms have no status at all. |
| T1 | Keep the reviewed-policy/machine-execution principle. Delete commit-SHA specimen sampling, severity machinery, mutation IDs, and threshold-count tripwire. |
| T2 | Delete; it is B1-full under another name. Replace with manual quote capture and a close-time conversation scan. |
| T3 | Keep “connect existing Tier A evidence first.” Delete the inconsistent LOC rhetoric and unscheduled architectural argument. |
| G1 | Keep PR-required, push-cancellation repair, one aggregator, relevant unit/native checks, no force-push, and admin enforcement. Defer merge queue, automatic revert creation, post-landing attestation, and build-tail redesign until measured need. |
| G2 | Shrink to priority tip-revert PR through normal `gates_ok`; remove the one-hour merge guarantee and overloaded fast subset. |
| G3 | Delete; it was explicitly trimmed. |
| B1 | Manual ledger row plus close-time scan only. |
| B2 | Reproduce before dispatch and clarify genuine ambiguity. Delete severity defaults and mandatory user ratification. |
| B3 | Keep one visible Git SHA plus native binary hash in diagnostic UI/metadata. Defer renderer bundle hash, request generation, and cache identity expansion. |
| B5 | Keep one tracked Git home for final approach, new ledger, and final reviewer reports. No custom digest chain, dispositions, or retroactive reconstruction. |
| O1 | Keep; it is load-bearing. Narrow to H51 plus one tracked preview specimen first. |
| O2 | Keep only red-on-pre-fix, separate oracle-policy changes, and an inventory equality check. Delete mutation-class IDs and two-measurement formalism. |
| O3 | Extend existing “unmeasured” handling only where a real class can be unmeasured. Do not build a new shared taxonomy. |
| O4 | Keep one tracked lifecycle/parity specimen with explicitly allowed transitions. Do not require session-pinned Tier B collections. |
| O5 | Start invoked-nonblocking. Current timings are explicitly non-comparable; block only after a stable runner distribution exists. |
| O6 | Delete. It is factually miscounted, definition-sensitive, and gamable by renaming/inlining constants. It attacks syntax volume, not demonstrated defect generation. |
| O7 | Keep. Add both root paths to the relevant maps and add a workspace/root census. Calling the whole change “one-line” understates the census and the two affected mappings. |
| Q1 | Promote Journey, LayoutStability, and a minimal matchedCanvas lifecycle proof only after their present failures are understood. Delete hand counters instead of replacing them with a run-history subsystem. |
| E1a | Keep I1 and I3 assertions. Replace I2’s “single placement function” redesign with a preview/final plan-equality or raster-parity oracle. A TypeScript key map cannot enforce native/runtime placement identity. |
| E1b | Delete from mechanisms; retain only as an unscheduled appendix option. |
| X1 | Keep role ownership if desired, but remove model names, effort dials, unlimited parallelism, and VPS lifecycle prose from the operative feature plan. |
| X2 | Keep because it is user-mandated and matches project policy. Clarify “one review phase with two reviewers.” Reference the repository’s CodeRabbit rules instead of changing pause thresholds pre-emptively. |

## C. Fitness for purpose: executing S1–S6

| Step | What fails on contact |
|---|---|
| S1 | This is the first procedural failure. It combines a repository workflow change with an external GitHub ruleset that must refer to a check which does not exist until the workflow lands. Split it into workflow/O7 first, observe `gates_ok`, then enable the ruleset. B3 is also larger than “small”: current version and provenance surfaces contain no Git identity. O7 affects at least two mapping arrays and a census, not one line. |
| S2 | This is the first feature-safety failure. It regenerates the baseline before S6 corrects invalid labels. It also has no Tier A input for the preview harness: the harness requires a source PDF, pages, and output directory, while no tracked caller or specimen exists. [Harness](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:93). The native job has Poppler and can run Rust, but the backlog never supplies the source/manifest contract. [Native job](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:228). |
| S3 | “Ungated” is not “known green”: the latest 14 quarantine jobs fail. Moving those tests directly to a blocking lane without first isolating their failures can brick the new required check. The destination blocking-smoke command builds Electron only, whereas quarantine/regression builds native first. [Commands](/Users/evb/WebstormProjects/evb-viewer/package.json:68). Splitting matchedCanvas and supplying native prerequisites is not a half-day mechanical move. Nightly Maintenance is unrelated scope. |
| S4 | The actual feature work arrives after three governance/tooling steps, leaving the user with the known 2.69% jump and unresolved weight issue. O4 lacks the tracked specimen and allowed-transition specification it requires. The word-weight redo lacks a named corpus, metric, and red specimen. |
| S5 | I2 is an implementation redesign disguised as an assertion. A TypeScript exhaustive-key map cannot prove that native, deferred, final, and CSS placement use one function. The 3–5-day estimate is credible only after shrinking I2 to parity evidence; not for the mechanism currently written. |
| S6 | It is placed too late. “Higher-DPI re-check” also cannot independently decide semantic labels such as single three-column page versus spread; the P1a failure was semantic ground truth, not insufficient pixel resolution. At minimum the 15 implicated split fixtures require re-adjudication before any baseline becomes blocking. [Required re-adjudication](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:701). |

A workable order is:

1. Land workflow/O7; then enable the ruleset.
2. Fix the two remaining user-visible defects with red pre-fix evidence.
3. Re-adjudicate affected corpus labels.
4. Regenerate and wire H51 plus one tracked preview proof.
5. Promote only demonstrated-green E2E coverage.
6. Add I1/I3 assertions and the narrow I2 parity oracle.

## D. Minimal blocking delta

v4 becomes ready after these four changes—nothing broader:

1. **Make the scope guard operative.** Remove T2/B1-full, G3, the B2 severity machine, B5 digests/dispositions, O2 taxonomy machinery, O6, and operative E1b. Fix every mechanism’s status to the declared vocabulary.

2. **Correct or remove the bad measurements.** At minimum: Quality red `10/40 = 25%`; p90 approximately 26 minutes with estimator named; H50 baseline/H51 live; ~22 days and 116 crate-touching commits; 129→166 constants if the metric remains; “19,881 physical lines”; remove the mixed-method 1,055→2,267 comparison; enumerate or delete “six seams” and “six architecture tests”; qualify or remove the 5-in-45 and 14/14 claims.

3. **Repair execution order and prerequisites.** Split workflow landing from ruleset activation; move feature fixes ahead of secondary governance; move re-adjudication before baseline regeneration; name the tracked preview fixture/caller; treat performance as nonblocking; triage E2E failures before promotion.

4. **Give the new ledger a genuinely tracked home.** Put the operative final approach, new ledger, and final reviewer reports somewhere such as `docs/internal/scan-cleanup/`. Git provides content identity. `.devkit` cannot satisfy v4’s own tracked-review requirement because it is ignored and excluded from CodeRabbit.

After that minimal delta, yes: open the new ledger and execute. In its current form, no—the first ledger would inherit both a scope contradiction and an unsafe baseline order.
