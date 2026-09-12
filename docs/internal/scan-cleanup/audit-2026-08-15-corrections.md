<!-- Provenance: copied verbatim from .devkit/analysis/branch-audit-2026-08-15/CORRECTIONS.md (untracked working artifact), produced 2026-08-15. -->
<!-- Corrections to the 2026-08-15 corrective audit. Its companions are tracked beside it: REPORT.txt as audit-2026-08-15-corrective.md, VERIFICATION.md as audit-2026-08-15-verification.md, vps-verification.md as audit-2026-08-15-vps-verdicts.md. Body unmodified. -->

# Corrections and improvements to REPORT.txt (branch-audit-2026-08-15)

Verified 2026-08-15 by three independent passes, reconciled here:
(1) a 12-agent local verification workflow (207 atomic claims, read-only, exact-SHA);
(2) the VPS adversarial verification, now **complete** — `VERIFICATION.md` (reconciled
synthesis, 14 hostile reviewers + fresh corpus execution) and `vps-verification.md`
(240 atomic verdict rows: 91 VERIFIED · 83 PARTIAL · 26 FALSE · 12 STALE_NOW ·
28 UNVERIFIABLE, all 61 identifier groups covered);
(3) hand adjudication of every disagreement against primary evidence.

Snapshots: main audited at `6ce2f0b61` (`A`); rescue at `70f0c70ae` (`R`). During
verification, origin/main advanced twice: `1883e0752` (ledger reconciliation) and
`cc3748af7` (PR #18, the 1.4 reconnect fix).

**Local workflow totals:** 162 VERIFIED · 20 STALE_NOW · 21 PARTIALLY_VERIFIED ·
2 FALSE · 2 UNVERIFIABLE. The VPS pass, working at finer granularity and with fresh
execution, found materially more FALSE items — where the two disagreed, the VPS
verdicts below are adopted because they rest on execution or full data-flow traces
rather than static reads. **Bottom line (all passes agree): the report is a
high-value evidence inventory whose raw counts, SHAs, and gap findings hold, but its
S0-S8 sequence must not be executed verbatim** — several behavioral headlines exceed
their evidence and several prescribed fixes would do nothing or remove valid coverage.
Full per-claim evidence: `VERIFICATION.md` and `vps-verification.md` beside this file,
plus workflow output
`/private/tmp/claude-501/-Users-evb-WebstormProjects-evb-viewer/3a7f6165-bb63-4c4a-8211-abe6981a42ee/tasks/w2va7arba.output`.

---

## 1. Mistakes (claims falsified or materially wrong)

**M0 — 2.3's behavioral headline is FALSE: the pipeline is *currently* catastrophe-free
at the audited SHA.** The VPS ran the full harness fresh at exact `A`
(`cargo run … scan-cleanup-harness --baseline native/scan-cleanup/harness-baseline.json`):
exit 0, total 51, split 51/51, `contentLostOutsideCrop=0`, every catastrophe counter
zero (report JSON SHA-256 `3c836394…`). The governance debt is real — the H50 baseline
is stale, denominator-blind, and has no automated caller — but PR #11's zero-catastrophe
result is *true behavior*, not an artifact of a self-comparing baseline. S3's product
outcome is already done and attested; only baseline regeneration, denominator equality,
and CI wiring remain open.

**M0b — C2/3.2's headline "appended clamp instead of feeding the owners / reproduces
RC2" is FALSE.** Full data-flow tracing shows `source_exclusion` is *also* fed upstream
in `R` — into artifact subtraction, picture qualification, rescue cleaning, and the
`analysis_picture_mask` the union itself consumes (`content.rs:357`, `:377-380`,
`:385-452`). The post-union clamp (`:601-616`) is real and is an additional unrecorded
side owner that ignores accepted trims — a genuine structural concern — but it
*contracts* while RC2 *expands*, and the branch does feed owners. Call it a
multiple-ownership/diagnostic risk, not a demonstrated behavioral reproduction.

**M1 — 3.3 "a conflict is pending" is FALSE.**
`git merge-tree --write-tree 6ce2f0b61 70f0c70ae` and the same against current
`origin/main` (`1883e0752`) both exit 0 with clean trees. `render.rs` is modified on
both sides but in non-overlapping hunks; git auto-merges. The rebase remains
governance-required (pre-governance merge-base `76a4cc976`), but the stated conflict
rationale is wrong. Both verifiers agree.

**M2 — 4.2 "no CI lane can run it / every repo gate is pnpm/vitest or cargo" is FALSE.**
`ci.yml:80,:423,:480,:588` each run `python3 -m pip install Pillow==11.3.0`; tracked
Python scripts exist (`scripts/diagnostics/scan-cleanup-artifact-audit.py`,
`scan-cleanup-synthetic-audit.py`); `tests/unit/scripts/scanCleanupArtifactAudit.test.ts`
spawns python3 inside the vitest lane. The real defect is only that
`measure_components.py` is untracked and uncalled. The "do not add a Python lane"
instruction in S5(c) is a preference, not a constraint — a Pillow lane already exists.

**M3 — 1.5's prescribed fix cannot work as written.**
The tripwire's target predicate `isZeroExecutionTripwireTarget`
(`scripts/checkZeroExecutionCoverage.ts:64-81`) accepts only `electron/platform-ipc/`,
`packages/contracts/`, a `LOAD_BEARING_COVERAGE_FILES` allowlist, and worker-named
files. Adding `scan-cleanup-core`/`scan-cleanup-adapters` to `roots` (plus
`coverage.include`) collects almost nothing — the predicate rejects those paths, so the
two-edit same-commit fix silently changes nothing for the 30 files. Also "the tripwire
reads coverage.include" is misdescribed: it reads the generated coverage summary and
compares against its own independently selected target list (`:116-145`). The 10,384
figure is physical lines, not V8's executable `lines.total`, so the DONE denominator is
misstated. (VPS FALSE; confirmed by direct read here. The local workflow agent was too
lenient on this item — overridden by primary evidence.)

**M4 — 1.2 "its only unit test compares the baseline to itself" is overstated.**
`evaluate.rs:1046-1064` (full path
`native/scan-cleanup/src/bin/scan-cleanup-harness/evaluate.rs`) contains the vacuous
equality at `:1048-1051` **and** a genuine mutated-regression assertion at
`:1053-1063`. The report itself concedes this in 1.14 ("only its first assertion is
trivially true") — the 1.2 headline contradicts the report's own later text. The
ACTION (replace only the first assertion) is correct.

**M5 — 1.10's sub-claims are wrong even though the core claim stands.**
Core VERIFIED: at full-resolution 300-DPI A4/spread the gate cannot pass on any
positive measured run (min 1 × 13.7 > 8.0). But: (a) "reachable only where
sample_scale == 1.0" is false — any input where `median_run × scale ≤ 8` passes, and
`estimated_stroke_width` returns 0.0 when the 256px sample has no dark runs ≤32
(`bw.rs:1903-1905`), and 0.0 passes the gate, so degenerate pages can route Sauvola at
any size; (b) "stroke width 3.0, which no measured page produces" is false at the
capped-sample entry points (`render.rs:5810/:6020`, scale 1.0), where 3.0 is an
ordinary integer median. The ten-minute arithmetic check remains worth doing; the
"router's decision space" framing should be re-derived, not assumed.

**M6 — 3.5's citations are wrong and its conclusion is falsified in detail.**
Test callers span `bw.rs:3535-4308` (not 3928-4308); the `render_tests.rs` caller is
at `:690` (rescue also `:601,:1041`), not `:3690`. More importantly a **non-test call
chain survives**: `bw.rs:436` (`binarize_with_mode`) ← `binarize_normalized_calibrated`
← `clean_black_and_white[_with_calibration_config]` ← harness `evaluate.rs:579`. Only
the engine render/content path moved fully to `_excluding_source`. The lead was
honestly labeled "unverified", but reviewers acting on it should use these corrected
facts.

**M7 — 2.10's headline "Every cited closure number is unreproducible" is overstated
and internally inconsistent.**
The O6 count (169) and the fixture counts (34/5) reproduce from a clone. Also the
ACTION says copy "SYNTHESIS and its section 7/8 content" while 2.13 itself establishes
SYNTHESIS has only sections 1-7 and the boundary findings live in
COMPLETENESS-CRITIC.md — the two items disagree about the same file. Additionally,
LEDGER:112-115's literal scope is *speculated* artifacts; the cited closures violate
the reproducibility principle, not the rule's letter.

**M8 — 1.9's proposed partial trim CANNOT move the crop boundary, and 4.3's ordering
falls with it.** Two independent geometry reviews agree: one validated text boolean or
one picture pixel anywhere in a block's bbox protects it, and a protected block on the
side extreme vetoes the proposal — so removing only unprotected co-touching blocks
leaves the recomputed bounds unchanged and trim thickness *zero*. The remedy as stated
does nothing in exactly the text-veto cases it targets. This also invalidates S4's
strict 1.9-before-1.1 dependency (4.3 FALSE as ordered): weight and geometry are
independent, and the union-authority semantics (1.1) must be fixed/pinned first — or
one coherent atomic geometry change landed — rather than sequencing behind a
non-functional partial trim. The fix must attack false protection, split/reclassify
block geometry, or change the representation.

**M8b — 1.7's proposed version/protocol smoke cannot detect the defect it targets.**
PR #17 added optional sidecar fields without bumping either the public manifest (still
v3) or the packaged runtime compatibility protocol (still 6; release
`--protocol-version` prints 6). A same-version stale binary therefore passes any
version/protocol check. The DONE criterion needs a functional emitted-metadata smoke
or a build-identity change, not a version probe.

**M8c — S6 is UNSAFE as written.** The manual native job the report schedules for
deletion is the *only* place clippy and cargo-deny run; the quarantine tests it calls
dead are deliberate policy pins (schema/workflow), not unreachable code. Executing S6
verbatim removes unique coverage. This also colors the ledger's D3 disposition (O6
tripwire deletion in S6): the deletion must be scoped to the actually-unreachable
final-render branches, with clippy/cargo-deny relocated first and quarantine pins
retired only through a coordinated policy/schema change.

**M8d — 4.7 is FALSE as written, in the report's favor.** Lossless preview cannot
prove export placement without parity — that half stands — but the claimed evidence
gap is narrower than stated: the actual exported PDF can be rendered and inspected
*today*, satisfying the export-evidence criterion directly. Unification enables
preview-as-proxy; it is not a precondition for export-placement closure.

**M8e — the universal closure reminder is ill-typed.** "RED pre-fix / GREEN post-fix
at defect granularity ON THE EXPORT" is the right bar for user-visible output defects
only. It has no meaning for ledger edits, branch protection, hygiene, deletions,
branch cleanup, or support-policy declarations. Replace the universal rule with typed
evidence classes: export RED→GREEN (or proven-equivalent preview) for output defects;
negative probe for oracles; preservation/caller proof for refactors; consistency
checks for governance; exact postconditions for hygiene; explicit scope for policy.

**M9 — 1.1's causal headline is unproven.**
"This is RC2, the audit's explanation for twelve failed geometry landings" carries no
twelve-landing denominator, per-commit trace, or specimen demonstration. The mechanism
(monotone-outward union, last writer, blind to trim state) is fully VERIFIED; the
historical attribution is an adopted hypothesis and should be labeled as such. Same
applies to 1.9's R10/R12 linkage.

## 2. Citation and count errata (substance survives)

- 1.1: R16 step 4 is at LEDGER **:476-483**, not :427-434.
- 4.1: "wire --check into a blocking job" is SYNTHESIS.md **:158** (step 2), not :156.
- 2.1: placement.ts went **161→77** lines (12+/96-), not 185→77; the matchPageSize
  early-out is PreviewShell.vue **:772-774**.
- 1.4: the defect is a **retry/duplicate-idempotency gap, not a
  reconnect-permanently-leaks story** — ordinary navigation clears the subscriber Set
  before restored-session reconnect, and records clear at disposal; the leak needs
  duplicate/retried subscriptions outside that cleanup path. Registry path is
  `electron/operation-lifecycle/createMainJobRegistry.ts` (directory omitted in the
  report). "Permanently for the life of the job" should read "until owner-end/record
  disposal". (Now fixed on remote main anyway — see §3.)
- 1.11: only 2 of the 3 causes reach the `unwrap_or` fallback — the abstention path
  (`split.rs:327-345`) emits a single uncut page and never calls `leaf_polygons`.
  More importantly the report **reverses the safety axis**: leaves meeting at the
  cutter remove the *least* source material — the most conservative choice for
  content retention, weak only for fold suppression. The typed-outcome remedy should
  model both axes (measured band / measured-no-shadow / inconclusive-invalidated /
  not-applicable) and propagate to all consumers and codecs; a nominally destructive
  fallback needs content-loss proof before being called unsafe.
- 1.13: the prescribed fix (explicit options on the clean-OCR call) prevents
  *default drift* only — shared algorithm/constant/rescue changes still alter OCR
  input pixels, so the item's DONE claim ("OCR isolated") is not met by its own
  action. True isolation needs a versioned OCR profile/route plus golden-pixel or
  recognition-corpus tests.
- 1.14: the "~3380 tuning numbers" denominator is unreproducible (a plain float-literal
  grep over `native/scan-cleanup/src` gives 4177 incl. tests); keep the 169 numerator,
  drop or derive the denominator.
- 1.17: `verify-local-package.mjs` skip-guards the missing fixture (`:153-156`) — a
  .devkit prune would *silently skip* the packaged scan-cleanup check, not "break" the
  verifier. Sharpen the DONE wording ("no verifier silently loses coverage").
- 2.5: the "two mechanisms described as gates" both resolve to the same caller-less
  preview-harness script (LEDGER:161-162 and :360).
- 2.9: "the ledger records none of it" is off by one — a passing "[Phase-edge PR #15
  already removed the terminal rejection]" exists at LEDGER:410.
- 1.3: "guarantees nothing" → guarantees exactly one thing (Commit Attribution Policy)
  when protection applies; the substantive gap (no quality check required, force pushes
  allowed) is confirmed and current.
- 1.7: "zero execution evidence" on 4/5 platforms is correct for *execution*; those
  legs still get static/file/dependency checks — don't paraphrase as "zero
  verification".
- C2: the union's bottom-side expansion sits at :596; the C2 shorthand ":593-595"
  omits it (conclusion unchanged).
- C5: "independently re-verified at 6ce2f0b61" is a category error for the two
  machine-local items (live process, untracked file) — a commit object cannot attest
  process state. Label them "re-observed on the host at report time" instead.
- PR #17's own body understates its diff: final merge diff is 34 files `+851/-454`,
  not the body's "30 files, +613/-442" (VPS quantitative check).
- 2.4: the S2/S3 closures were authored 56s after PR #10's merge and 29m06s *before*
  PR #11's merge (G3 breach confirmed with exact clocks), but they were not the first
  ledger closures — S1 preceded them.
- 2.8: PR #12 *does* reference before/after/video eyeball directories (gitignored, so
  not durable evidence), contradicting the report's "likewise none".

## 3. What happened since the report (the running thread, and everything else)

Timeline (all 2026-08-15 +0400):

1. **01:17** — the 491 dirty lines were committed/pushed as `70f0c70ae` (already
   recorded in the report's C1). S0(a) done.
2. **01:24** — push run 31840148788 for `6ce2f0b61` completed **success** → C4/B2 are
   resolved: steps 0/1 are now attested under the exact-SHA rule.
3. By **01:24** — the electron `default` session ended and `.devkit/sessions` was
   emptied (S0(b); `.devkit` dropped 8.5G→8.2G, sessions/ was 293M); the 0-byte
   `.rows` file was deleted (S0(c); git status clean). Correction from the VPS log
   read: the session ended after a **renderer/GPU crash and wrapper exit**, not an
   evidenced prescribed `stop` — S0(b)'s postcondition holds, but not its mechanism.
4. Three worktrees/branches were dispatched, all at `6ce2f0b61`: `wt-leak`
   (`fix/subscribe-reconnect-leak` → item 1.4), `wt-oracle`
   (`chore/s3-oracle-wiring` → S3), `wt-ownership` (`fix/s4-native-ownership` → S4).
5. **01:46** — `1883e0752` "Reconcile the scan-cleanup ledger with landed audit
   evidence" landed on main (**S1 executed**): R17/R18 added; steps 0/1 marked landed;
   S2 flipped; stay-fixed retroactively annotated on R1-R15 with a 7-day re-report
   window (D5); O6 tripwire deletion disposition recorded (D3, deletion in S6 with
   same-commit approach-doc amendment); enforcement decision inverted to blocking CI
   jobs + pre-push pre-echo (D4 = the report's 4.1); X2-vs-R15 precedence recorded
   (D2 = 4.8); the S4/S5/S6 orphans and the 12/12 red nightly got owners (4.4); the
   ISOLATION rule now exempts the committed `dev:headless --session=default` (1.16's
   contradiction resolved); **D1 records the 2.6 decision**: governance-document edits
   are exempt from PR flow and commit directly to main, with the reason written down.
   Consistent with D1, `1883e0752` itself went straight to main; its CI run
   (31843913747) completed **success**.
6. **02:03** — **PR #18 "Keep scan cleanup progress singular across reconnects"
   merged** as remote main `cc3748af7` (from `wt-leak`'s
   `fix/subscribe-reconnect-leak`). Item 1.4 is therefore **fixed on remote main and
   stale as a current defect** (its truth at snapshot `A` is unchanged). The local
   main checkout was left at `1883e0752`, two commits behind remote; rescue is now
   **8 behind / 2 ahead**. CI for `cc3748af7` (run 31845042260) was still in progress
   at last check — verify it lands green.
7. **The only running local-machine-adjacent threads are on the VPS:**
   - `weight-oracle` (batch, Codex sol): its completed first run built the §5
     component-granularity stroke-weight oracle, calibrated it RED on the Vorwort
     specimen, and **adjudicated the rescue candidate as FAIL** — Luther p6-9
     offenders 277 (main) vs 281 (candidate), Vorwort final-quality offenders 23/21 →
     24/34; the fold-mask half works (raw fold RESIDUE leaves 3→0), the rescue-caps
     half is insufficient. A re-run under the same slug is currently mid-flight
     (rebuilding both refs, re-running conversions). This is the first concrete
     evidence for the report's 3.4 freeze recommendation — and it also means S5(d)
     adjudication now has a baseline: **do not land the bw.rs half of
     `fix/rescue-caps-fold-mask` as-is.** Artifacts:
     `/home/ubuntu/rescue-research/weight-oracle/` (REPORT.md, oracle script, crops).
     Caveat to re-check: one re-run command mixes `current-main` scan-cleanup with
     `candidate` pdf-page-ops/image-combine paths — harmless only if those two
     binaries are identical across refs.
   - `branch-audit-verify-20260815` (T3): **complete.** Deliverables pulled beside
     this file: `VERIFICATION.md` (reconciled synthesis) and the final
     `vps-verification.md` (240 rows, all 61 identifier groups). Its worktree was
     cleanly removed and no audit processes were left running. One hygiene note it
     discloses: a reviewer's write-form `git merge-tree` left a single unreachable
     tree object (`e247407c…`) in the shared VPS git object database — no ref, HEAD,
     index, or worktree changed; harmless, removable by any future `git gc`.

Ahead/behind is now **8 behind / 2 ahead** (`origin/main` at `cc3748af7` vs rescue
`70f0c70ae`); the report's 3.3 (5/1) and C3 (5/2) are both superseded, as is the
6/2 figure that held between the two post-report merges.

## 4. Gaps (true things the report missed)

- **G1 — the rescue branch reintroduces the fixed double-subscription.** Because its
  merge-base predates PR #17, `70f0c70ae` still contains both start()-side
  registrations that `32b50f2c7` removed on main *in addition to* the discarded
  reconnect handle — and now also lacks PR #18's idempotency fix. Rebasing (S4(d))
  silently fixes both, but neither 3.2 nor 3.3 mentions the branch is currently
  *worse* than main on item 1.4's defect.
- **G2 — the 1.4 fix had no step.** The report calls 1.4 HIGH, corrects the false
  commit-message claim (2.7), but assigns the actual fix to no S-step. Since remedied
  in practice: `wt-leak` produced PR #18, merged as `cc3748af7`.
- **G3 — degenerate Sauvola routing** (see M5): blank/large-dark-block pages measure
  stroke 0.0 and pass the ≤8.0 gate at any size — a routing mode the report's
  "unreachable" framing hides; include it in the S5(a) routing-distribution
  re-derivation.
- **G4 — required-check naming.** S2 says make "gates_ok / Quality Gates" the required
  context; the required-status-check context string must match the check-run name
  exactly (job `gates_ok` surfaces as its display name). Pin the exact string when
  executing S2, or the protection will silently require nothing.
- **G5 — the report never proposes tracking its own audit artifacts.** REPORT.txt,
  VPS-VERIFY-PROMPT.md, and vps-verification.md live in gitignored `.devkit` — the
  exact pattern 2.10 criticizes. If the corrected sequence is to be governed by this
  report, copy it (or its adopted subset) into `docs/internal/scan-cleanup/` per its own rule.

## 5. Proposed improvements to the corrected sequence (S0-S8)

The consolidated verdict on the sequence (all passes): **do not execute S0-S8
verbatim.** S4 and S6 are unsafe as written, S2 has an authorization conflict, S5 is
internally contradictory, and the universal closure rule is ill-typed. Per step:

- **S0/S1: mark done.** S0(a-c) and S1 are executed (`70f0c70ae`, swept sessions,
  deleted `.rows`, `1883e0752`), and the `1883e0752` CI run concluded green — with
  the caveat that S0(b)'s session ended by crash, not prescribed stop.
- **S2: resolve the authorization conflict first.** Ledger R5 explicitly declined
  GitHub-settings changes; the report cannot reverse that on its own authority. If
  reversed, use the exact check-run name `gates_ok` (not "Quality Gates"), stage
  proven-green checks before requiring them, and decide admin-bypass, PR-only,
  strict-base, and exact-final-SHA semantics explicitly. The pre-push hook is
  blocking-local only, never remote enforcement.
- **S3: narrower than written.** M0 shows the *behavior* is already zero-catastrophe
  at `A`; S3 reduces to regenerating the H51 baseline behavior-free (exact
  corpus/category equality), keeping the existing mutation test, and wiring an
  automated `--baseline` caller into CI with tracked fixtures.
- **S3(d): rewrite.** Same commit must widen `coverage.include`, the tripwire `roots`,
  **and** `isZeroExecutionTripwireTarget`/`LOAD_BEARING_COVERAGE_FILES` (M3), and the
  DONE denominator should be stated in executable lines, not the 10,384 physical-line
  figure.
- **S4: reorder and redesign — FALSE/UNSAFE as ordered.** The 1.9-before-1.1
  dependency is backwards (M8): define and pin the final side-authority semantics
  first (including the structured-edge write at `content.rs:357-365` and the picture
  union), then either fix false protection/geometry classification or land one
  coherent atomic geometry change. Do not delete the rescue clamp without an
  equivalence proof (M0b: it is a real side owner, but the branch also feeds owners
  upstream). Typed fold outcomes (1.11) must model both safety axes and reach all
  consumers/codecs.
- **S4(d): drop the conflict rationale** (M1); keep the rebase requirement. Also state
  G1 (the branch's reintroduced double-subscription, now two fixes behind) as a
  rebase motivation.
- **S5: use the VPS oracle output.** The oracle S5(c) demands now exists (VPS
  `weight-oracle`): calibrated RED on the specimen, and it already adjudicated the
  candidate as FAIL. Port it into the tracked runner (Rust harness or .mjs — or keep
  Python: M2 removes the "no Python lane" constraint), commit the calibration
  constants (32mm radius, 1.6× threshold, 7-component minimum, 8-connected), and
  record the FAIL verdict in an R-row so the bw.rs freeze (3.4) has cited evidence.
- **S5(a): include the 0.0-stroke degenerate route** (G3) in the routing
  distribution, and note S5's internal contradiction: the behavior-changing Sauvola
  unit fix it schedules violates its own "no bw acceptance before the oracle" rule —
  sequence the oracle first.
- **S6: do not execute as written** (M8c). Delete only proven-unreachable
  final-render branches; move clippy/cargo-deny before touching the manual native
  job; retire quarantine pins only via coordinated policy/schema change.
- **1.4 is done** (G2): PR #18 merged as `cc3748af7`; confirm its CI run lands green
  and record the closure in the ledger with the retry-idempotency framing (not the
  "permanent leak" framing the report used).
- **Replace the universal closure reminder with typed evidence classes** (M8e) —
  this also cleans up 2.9's demand that ETA/IPC/display-only fixes produce "export
  RED→GREEN" evidence that cannot exist for them.
- **4.7: close export-placement evidence directly** — render and inspect the actual
  exported PDF now (M8d); treat preview parity as an enabler, not a prerequisite.
- **S7(d)/G5: track the audit chain itself** — this report, the VPS verification, and
  the weight-oracle REPORT.md summary belong beside the ledger if they are to be
  cited by future rows.
- **Housekeeping when reading the report today:** treat every "currently/now" claim in
  sections C, 1.16-1.18, 2.9, 3.1, 3.3 as of 2026-08-15 ~00:30 +0400; the STALE_NOW
  list in section 3 above is the delta.

## 6. Assessment of the report itself

The report is unusually strong on raw counts, SHAs, line locations, PR history, and
the existence of real governance/coverage/CI gaps — the local pass verified 162 of
207 claims exactly, and the VPS reproduced essentially every quantitative and GitHub
claim. It is **not safe to adopt as a literal defect-and-execution plan**: the finer-
grained VPS pass returned 26 FALSE rows out of 240, concentrated exactly where
execution or full data-flow tracing was required. The failures cluster in four
families: (1) causal/historical attributions stated as fact (M9, the 2.3 "mechanical"
story that fresh execution refuted); (2) prescribed fixes whose mechanics were never
traced to the end (M3's inert predicate, M8's zero-thickness trim, M8b's unbumped
protocol, M8c's unique-coverage deletion); (3) rhetorical absolutes ("only unit
test", "every cited number", "guarantees nothing", "conflict pending", "test-only
callers") that a checker can falsify even when the underlying defect is real; and
(4) a one-size-fits-all closure rule applied to task types it cannot type-check
(M8e). A future report of this kind should label hypothesis vs. observation per
claim, dry-run each prescribed fix against the actual predicate/algorithm it
modifies, and — where a behavioral claim is cheap to execute — execute it rather
than infer it from artifacts.
