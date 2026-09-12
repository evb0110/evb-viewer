# Development & Validation Approach — FINAL (operative)

Status: FINAL, 2026-08-14, after four adversarial review rounds
(r1: fable/opus/sol-xhigh; r2: same; r3: opus+sol-xhigh exhaustive;
r4: opus+sol-xhigh exhaustive, both verdicts "not ready — minimal
delta"). This version applies the combined round-4 minimal delta:
figure corrections, scope-guard enforcement in the body, backlog
reordering (feature fixes forward; re-adjudication before baseline
regeneration; e2e triage before graduation; ruleset activation split
from workflow landing), emergency-lane simplification, B1 reduced to
blocking-local candidate nomination. Round-4 delta log at end of file.
HOME: this file is canonical at docs/internal/scan-cleanup/process/ (tracked and
reviewable); any .devkit copy is a non-canonical pointer. Governance-doc
edits are the single-author orchestration record and commit directly to
main; CodeRabbit PR review applies to code rather than process prose.
Review reports for rounds 1-4 live in ./reviews/.
NUMBERS POLICY (round-4 lesson, both reviewers): the two reviewers'
independent counts of the same quantity differed (166 vs 167 threshold
consts); every version of this document carried transcription errors.
Therefore: NO transcribed measurement in this document is authoritative;
every gate computes its own number and diffs against a committed
machine-written baseline. Figures cited below are illustrative history,
marked (~).

SCOPE GUARD (user-mandated): the goal is a WORKING SCAN-CLEANUP FEATURE,
not a governance civilization. Sol's proposals are valuable but tend to
overengineer; every mechanism below must justify itself against "does
this get the feature correct and keep it correct, at solo-maintainer
cost?" Items failing that test are TRIMMED (marked below) — kept in an
appendix as future options, not scheduled work. Round-4 reviewers must
treat overengineering as a defect equal to under-enforcement.

Trimmed by scope guard (recorded, not scheduled):
- Hash-chained transcript receipt system (B1-full): replaced by a
  lightweight rule — every user report gets a ledger row at receipt
  with a private transcript reference plus an approved redacted
  excerpt (raw message text stays out of the tracked repo, per T2);
  session close includes a check of the conversation for unfiled
  reports. Honest residue accepted.
- Digest-archived review provenance (B5-full): replaced by copying
  reviewer reports into the tracked docs dir. Done, not chained.
- Full oracle-assurance formalism (mutation-class taxonomy): kept only
  red-on-pre-fix for closing checks + never bundling threshold/label
  changes with the fix they enable.
- Tier B/C VPS self-hosted runner: deferred until local-run honesty
  (labeled "local-only" evidence) actually fails us.
- E1b grand redesign, cadence caps, severity state machines,
  disposition taxonomies: future options.

Vocabulary (mandatory for every mechanism/status claim):
  absent | manual (invocable, no caller) | invoked-nonblocking |
  blocking-local | required-prelanding.
"Exists" and "enforced" may never be used interchangeably.
Mechanism classification (T1): mechanical | user-adjudicated |
acknowledged-judgment. No mechanism may claim "judgment-free" status.

## Part 1 — Failure classes F1-F18 (complete, self-contained)

F1  Over-broad closure categories: "G3 fixed" spanned >=4 distinct
    weight mechanisms; scoped residuals WERE recorded in the ledger but
    headline rhetoric ("FIX LANDED", "CLOSED") overwhelmed them; REOPEN
    6 was marked RESOLVED with the P3 settle-jump remainder open.
F2  Dismiss-instead-of-measure: two user reports explained away
    ("provisional", "stale instance"); both later proved real defects;
    the prior did not update after the first disproof. Build identity
    (B3) removes only the stale-executable variant; the second dismissal
    happened on a current build via a divergent code path.
F3  Confirmation-scoped verification: every oracle certified the
    previous fix's dimension; all projections can pass while the
    integrated result is wrong. Includes specimen selection: gates run
    on the pages the fix targeted.
F4  Unmeasured surfaces treated as second-class: the preview raster had
    zero oracles while serving as the user's closure-confirmation
    surface; preview divergences were leading indicators.
F5  Late, inconsistent seam analysis: divergent render paths (final vs
    preview DPI, in-memory vs deferred placement, native metadata vs TS
    composition, fresh vs stale frames) were mapped only after failures;
    adversarial reviewers (not only the user) found six seams.
F6  Change-size vs evidence-size mismatch: rounds oscillated between
    33-file 12-hour changes and one-line patches; acceptance evidence
    was consistently narrower than the change surface.
F7  Decommissioned/never-wired instruments (see F16 for the general
    pattern): quarantined e2e lane (nightly, continue-on-error,
    --passWithNoTests makes an empty lane green); 9 specs quarantined,
    of the 5 scan-cleanup specs 2 are fully env-gated, matchedCanvas
    has 8 tests of which 7 ungated, journey + layoutStability are
    unconditional self-fixturing; graduation demands 30 consecutive
    green scheduled runs while the max observed streak is 5 in 45
    nights (current: 14 consecutive failures, caused by the
    non-continue-on-error Nightly Maintenance Gates job); counters are
    hand-typed and the architecture test pins blocking:false.
F8  Invalid ground truth: P1a's flagship fixture was mislabeled by the
    orchestrator's own visual adjudication (single 3-column page
    labeled a spread; the fix built on it would have split a text
    column); the original word-loss oracle reported success with zero
    reliable measurements; the harness baseline ratchet block tolerates
    contentLostOutsideCrop:2, split classificationErrors:1,
    offcutMisclassifications:1 (metrics block: minimumIou:0.0 from
    fixture synthetic-page-number-only).
F9  Orchestrator diagnostic error (>=4 documented): wrong smoothing
    root cause (caught by the mandatory two-sided gate — the discipline
    existed and worked there); wrong "harmless clamp" assumption;
    wrong stale-instance explanation; reversing a subagent's correct
    overhang design to honor a pin (became cause #2 of a reopen).
    Absent: falsifiable predictions before dispatch; any check on the
    orchestrator's fixture adjudications.
F10 CI truth failures, measured (~figures; recompute at gate time):
    over the last ~40 push runs, FIVE were cancelled by ref-grouped
    cancel-in-progress, and in all five the cancelled set included the
    long native job — the long job is systematically the one that
    never finishes; a substantial share (~1 in 5) of native-touching
    landings lost their own-SHA native gate; Quality Gates red roughly
    a quarter to a third of recent runs (reviewers' independent counts
    differed — hence the numbers policy), including an 8-commit ~7h
    red streak closed by an 8-line test edit; unit tests run ONLY on
    pull_request while the workflow pushed directly to main, making
    unit failures post-hoc by construction on the path actually used.
F11 Requirement miscapture: the orchestrator's model of a report
    overrode the report (blank-panes dispatched when the complaint was
    raster quality); distinct from dismissal.
F12 Premature closure + record hygiene: "CLOSED" preceded five reopens;
    the ledger itself contains a class-count error (claims nine audit
    classes; code defines eight).
F13 Correction asymmetry: durable governance changes were user-imposed;
    locally discovered lessons (staged-binary shadow, scoped->full test
    runs) did not propagate into standing controls.
F14 Existing assets unused: the tracked 50-fixture baselined harness
    corpus (H50) was never run in any arc round; systematic
    every-reopen-becomes-fixture seeding did not happen (one Luther
    split fixture was seeded); four distinct corpora must not be
    conflated: H50 (tracked, baselined, runner-buildable), private
    standing regression fixtures (absolute-path manifests), the
    Linguae discovery corpus (triage labels, no oracle), full books.
F15 "What worked" over-claims: two-sided gates depend on valid labels;
    byte identity can preserve latent defects; orchestrator
    re-measurement is not independent.
F16 Enforcement-rot pattern: the repo has dense mechanical enforcement
    (six architecture tests, tiered validation gates, graduation
    policy, catastrophe ratchet, unmeasured-fraction gate, one required
    check) and the failing instances failed one of three ways: FED NO
    DATA (regress net gated on a never-set variable — never executed
    since 2026-08-05; ratchet comparator has zero tracked callers;
    audit oracle and preview harness: ~19k LOC (glob-dependent count)
    of validation tooling
    with no script entry or CI wiring for the key pieces), NON-BLOCKING
    (quarantine lane), or HAND-MAINTAINED (graduation counters).
    Corollary discovered in round 3: v3 itself asserted absence where
    the repo had an unwired presence — the rot pattern operates on
    documents too. Every new mechanism must name which of the three
    modes it is immune to, and every claim of absence must be checked
    against "present but unwired".
F17 Missing-row problem: no mechanism detects that a user report never
    entered the record. See B1 for the transcript-join design and its
    honestly-stated residue.
F18 Unchained review evidence: reviewer reports and dispositions are
    the author's prose in /tmp; the validation trail must live in a
    tracked repo location (B5) — including THIS document's own review
    history.

## Part 2 — Theses (round-3-corrected)

T1 POLICY-BOUND JUDGMENT, mechanized execution. Human judgment defines
   a versioned, reviewed policy/oracle boundary; machines execute it
   deterministically, expose coverage and applicability, and reject
   unreviewed boundary changes. Judgment-leak inventory is mandatory:
   specimen selection (fix: seed corpus draws from the commit SHA),
   severity (fix: only a USER reply downgrades; otherwise S1 stands),
   fixture labels (fix: re-derive by independent MEASUREMENT — e.g.
   higher-DPI geometric re-check — not a second opinion), mutation
   intent (fix: assert violation-class ids derived from code),
   threshold growth (historical O6 proposal, retired in S6: a syntax
   count of named f32/f64 consts was not retained as a quality gate;
   no transcribed or committed threshold is authoritative),
   report classification (B1), touched-surface maps (fix: R11 +
   census).
T2 EVENT-CHAINED EVIDENCE. The immutable substrate the orchestrator
   does not author is the session transcript JSONL (append-only, per
   session, contains every user message verbatim). Ledger rows cite it
   by (sessionId, approximate position); v1 capture is MANUAL (B1) —
   the automated join test with a committed classifier is the
   appendix-deferred target form, adopted only if manual capture
   demonstrably misses reports. Row commit timestamps must postdate
   referenced messages. Raw message text stays out of the public repo
   (citations + approved excerpts only). CI run ids bind to SHAs; the
   provenance stamp already carries native binary SHAs + plan digests
   (extend with git SHA + renderer identity, currently absent).
T3 CONNECT-THEN-BUILD; ARCHITECTURE CAPS GENERATION. The binding
   constraint is NOT residency for Tier A: H50 is tracked and
   hosted-runner buildable today. Residency binds only Tier B/C
   (private corpora, full books; note the nightly job runs macos-14
   while the VPS is Ubuntu — retarget required if VPS-hosted).
   The deeper cap on defect generation is architectural (E1): the
   codec, preview service, and crate have all grown substantially
   since the July charter (~54k crate LOC; exact deltas to be computed
   with a single consistent method if ever load-bearing — the v4
   figures mixed counting methods and are struck). "Why didn't the
   architectural work land": process rounds always outranked it —
   which is exactly the prioritization error the backlog corrects.

## Part 3 — Mechanisms (status-tagged; enforcement tuple per item)

GOVERNANCE
G1 CI truth (replaces v3 A1/C2; status: absent->required-prelanding).
   (a) concurrency: cancel-in-progress only for pull_request events
   (preserves PR iteration, ends the cancelled-native class);
   (b) gates_ok aggregator job (if always(), needs all blocking jobs,
   fails unless each is success or intentionally skipped) — the ONLY
   required check (conditional jobs cannot be required directly);
   (c) ruleset on main: require PR (0 approvals), require gates_ok,
   enforce_admins, block force-push; current protection (verified
   live) requires only the attribution check with enforce_admins off
   and force-push allowed — G1 REPLACES it;
   (d) merge queue: repo metadata says available (public repo) —
   enable if the ruleset accepts it; fallback: strict up-to-date PR
   protection serializes concurrent sessions;
   (e) unit tests must run on the pre-landing path (today they are
   PR-only while landings were pushes — F10); the native job tail
   (p90 ~25 min measured; the earlier "max 73 min" was an updatedAt
   artifact, struck) is split so the required path stays fast
   (build:strict moves nightly/cached);
   (f) exact-SHA post-landing attestation; red main freezes merges;
   revert PR auto-created (B4). Failure injection: a deliberately
   failing PR must be blocked; a push bypass must be impossible.
G2 Emergency lane (status: manual — an orchestrator-executed policy;
   the one deadline anchored to an external event): user-visible
   regression traced to a same-session landing -> revert PR goes
   through the NORMAL gates_ok (no fast-subset variant — the required
   check must keep exactly one meaning) with scheduling priority and
   a freeze on merging other PRs until it lands; target 1h from the
   USER REPORT timestamp; forward fix only if verified within the
   window; reverts of merge conflicts / non-tip SHAs go through
   normal PR (no history mutation).
G3 Closure soak (status: manual): no closure declaration within 1h of
   the step's last landing. (The daily landing cap from earlier drafts
   is DELETED per scope guard — measured basis ~13 landings/day at
   high red rate is recorded as context, not a mechanism.)

EVIDENCE
Closure evidence classes (amended by ledger R19): the universal
"RED pre-fix / GREEN post-fix ON THE EXPORT" rule applies only to
OUTPUT DEFECTS. Use export RED -> GREEN for output defects; a negative
probe in which a deliberate regression goes red for oracles/gates;
preservation proof for refactors; consistency-of-record for governance;
exact postconditions for hygiene; and an explicit scope statement for
policy.

B1 Report capture (T2; status: absent -> blocking-local). v1 is
   MANUAL: every user message carrying a report is entered as a ledger
   row at receipt, with disposition defect | instruction | question |
   duplicate | out-of-scope(reason), before any dispatch responding to
   it. The first committed classifier is NO classifier (round-4 sol);
   automation is adopted only if manual capture measurably misses
   rows. Closure shows the user the row list; user confirmation
   closes sessions.
B2 Ratification before dispatch (user-adjudicated): reproduced artifact
   confirmed by the user BEFORE fix rounds for S1/S2; emergency lane
   exempt. Severity: S1 = irreversible/silent content or document
   harm, preview divergence capable of falsifying closure confirmation,
   invalid ground truth; DEFAULT S1; only a user reply downgrades.
B3 Build identity (mechanical; cheap; NARROWED in S1 review): dev
   builds surface the BUILD-TIME embedded commit SHA (esbuild define;
   dirty tree embeds nothing; shipped runtime code never invokes git)
   alongside the staged-binary hashes the provenance stamp already
   carries. Extending the document-embedded stamp itself (gitSha,
   renderer bundle hash, request generation) is DEFERRED to S4 and
   requires schema versioning (v2 with v1-on-read): an unversioned
   field addition makes already-installed builds hard-reject stamps
   from newer builds. Scope honesty: kills only the stale-executable
   ambiguity.
B5 Closure/review archive (mechanical): machine-emitted gate tables
   (harness/audit/gates JSON) + reviewer reports + dispositions stored
   under a SINGLE tracked home (docs/internal/scan-cleanup/) that REPLACES
   prior record locations (charter: new layers replace old ones).
   Applies retroactively to rounds 1-4 of this document. Digest
   chains stay in the appendix per scope guard — tracked git history
   is the integrity mechanism.

ORACLES
O1 Wire what exists FIRST (F16's prescription; status transitions):
   - scan-cleanup-harness + catastrophe ratchet: manual -> blocking
     (package script + test:rust hook; baseline REGENERATED first —
     it is ~3 weeks / >100 crate commits stale (compute exact
     staleness at implementation) and misses the flagship
     conservative-degradation fixture spread-luther-plate-p00126;
     regeneration happens ONLY AFTER S3 re-adjudication;
     drift guard extends the existing assertStagedCargoArtifactFresh
     pattern);
   - representative audit + preview harness: no caller today ->
     package scripts + Tier A/B wiring;
   - regress net: set the variable with a real manifest or DELETE the
     job (never executed since creation).
O2 Oracle assurance (extends existing scanCleanup*.test.ts mutation
   suites — they already inject synthetic violations): red-on-pre-fix
   + mutation asserting violation-class id + two-MEASUREMENT label
   adjudication for destructive ground truth; threshold/label changes
   are separate reviewed diffs; corpus-removal/denominator mutation
   added (the ratchet ignores inventory shrinkage today).
O3 Audit applicability model (replaces v3 R7): per-class result
   measured | inapplicable(reason) | missing(reason); collapse gate
   extended semantically (page-count has no unmeasured state); class
   list derived from code and REUSED as E1's invariant taxonomy.
O4 Preview/lifecycle gating: inkMarginShift + rasterIdentical gated
   with transition semantics defined first (which transitions may
   legitimately change layout); session-pinned canvas parity specimens
   tracked; harness needs a caller (O1) and machine-resident sources
   (Tier B) — status honesty: blocking-local until residency.
O5 Perf: harness already emits wall_time_ms / mean_wall_time_ms_per_
   page, but labels them NON-COMPARABLE (uncontrolled machine/load
   conditions) — they must not be ratcheted as-is. O5 stays
   invoked-nonblocking until workload, runner, warm/cold policy,
   variance rule, and a comparable baseline representation are
   defined; Electron-side budgets exist in matchedCanvas (one spec).
O6 Threshold-count tripwire (RETIRED in S6): the syntax-count tripwire,
   generator, baseline, and Rust-script pin were deleted. The project
   does not treat the number of named f32/f64 declarations as a proxy for
   defect generation; behavior and native validation remain covered by
   the substantive Rust and export gates below.
O7 Changed-area repair (R11) — LANDED in S1: `scan-cleanup-core/**`
   and `scan-cleanup-adapters/**` matched NO area (the blocking smoke lane
   silently skipped the package owning the preview/final seam). The
   executable contract is scripts/release/policy.mjs, which
   derives top-level directories from TRACKED content (git ls-files —
   not workspace packages, since adapters has no package.json, and not
   the filesystem, which false-positives on gitignored dirs) and fails
   on any unmapped dir. Landing it surfaced and mapped drizzle/,
   patches/, build/, .husky/, and .github/actions/ as well. Scope:
   directories only; top-level files are not censused.

E2E
Q1 Graduate the unblocked specs to the DESTINATION lane directly:
   journey, layoutStability, and matchedCanvas's 7 ungated tests need
   no fixtures/env but DO need native build prerequisites the blocking
   smoke command lacks (compare package.json commands) and a
   matchedCanvas split (1 gated test stays). The intended retirement
   has NOT landed: the 30-green bar remains pinned at
   tests/unit/architecture/quarantineGraduationPolicy.test.ts:115 and
   the counters remain hand-maintained. Retirement and machine-derived
   destination-lane history are still open; a skip is never a green.
   Nightly Maintenance
   Gates' 14/14 failure streak is triaged as its own item (it reddens
   every nightly).

ARCHITECTURE
E1a Invariant ASSERTIONS (detect-only; 3-5 days credible):
   I1 ink conservation under destructive ops (monotone non-shrinking
      protected mask, validated at FINAL stage — a partial guard
      already exists in render.rs and is bypassed when maskless and
      undermined by post-guard fold-edge filtering);
   I2 single placement function: final = f(plan), preview =
      downscale(f(plan)) — the invariant form of preview-equals-
      downscaled-final; enforced via A3-style field-complete parity
      over the placement fields (compile-time exhaustive
      satisfies Record<keyof INativeScanCleanupOutputMetadataV3, ...>
      key map — an existing repo idiom; runtime types are erased so
      the codec cannot supply the roster);
   I3 canvas/leaf identity: one canvas per spread, equal leaf scale
      within epsilon, content boxes within canvas.
   I1-I3 map onto seven of the audit's eight classes: O3's derived
   class list and E1's taxonomy are ONE artifact.
E1b Conservation-preserving REDESIGN: unsized; requires the census/
   mutation spike first; addresses the architectural-consolidation
   direction of the July charter (codec consolidation, single plan
   consumed by every path — charter attribution of specific type
   names struck per round 4: the charter does not name them).

EXECUTION MODEL (user-mandated)
X1 Orchestrator decides (diagnosis, design, dispatch, adjudication);
   Sol implements at low/medium/high effort scaled to complexity;
   unlimited parallel sols; reviewers receive verbatim evidence (not
   orchestrator summaries). Parallelizable experiments (corpus sweeps,
   conversion matrices, benchmarks — anything repo-clean and not
   macOS-bound) may offload to the VPS via the vps-agent skill with
   sol low-high; no stale remote processes left behind.
X2 Step flow: substantial step -> ONE adversarial review (opus-medium
   + sol-high) -> ONE fix round -> PR -> sol-high babysits CodeRabbit
   (fail-open; note .coderabbit.yaml sets
   `auto_pause_after_reviewed_commits: 10` and excludes .devkit/** from
   its view; keep operative artifacts in tracked paths)
   -> joint adjudication of claims, reply/resolve threads -> merge ->
   next. Steps sized substantially.

## Part 4 — Ordered backlog FINAL (round-4 reordered; lands via X2)

Ordering rationale (round-4, both reviewers): CI truth first because
every later step's evidence flows through it; feature fixes second
because they are the user's actual goal and defer to no governance
item; ground-truth re-adjudication BEFORE any baseline regeneration
(else the regenerated ratchet canonizes invalid labels — the P1a
recurrence, mechanized); e2e triage before graduation (the target
spec failed every one of the last 14 nightly runs — promoting it
as-is would freeze main); invariants last, written against the
corrected baseline so I1 does not contradict blessed state.

S1 CI truth + hygiene — TWO ORDERED OPERATIONS. Op 1 (workflow PR):
   concurrency cancel-in-progress only for pull_request events;
   gates_ok aggregator job; unit tests on the PR path; O7 changed-area
   repair (`scan-cleanup-core/**` and `scan-cleanup-adapters/**` into the
   blocking smoke area; census enumerates top-level source DIRS, not
   workspace packages — adapters has no package.json); native build
   prereq in the blocking smoke lane (without it O7 routes the seam
   into a lane that cannot exercise native — false green); B3 build
   identity surfacing. Op 2 (after gates_ok exists on main): ruleset
   requiring PR + gates_ok, enforce_admins, force-push blocked.
   A ruleset cannot require a check name that has never reported.
S2 Remaining user-visible defects (the actual feature goal, moved
   forward): settle-jump / session-pinned canvas with transition
   semantics defined before code; word-weight amplification
   measurement redo (prior round hung and was killed). X2 flow with
   red-on-pre-fix closing checks.
S3 Ground-truth re-adjudication (R2) with measurement-based labels
   for the nonzero catastrophe entries and the 100%-ink-loss
   (minimumIou 0.0) fixture — a live I1 violation currently blessed
   as accepted state. Must precede any baseline regeneration.
S4 Wire what exists (O1 narrowed + O5-lite): ratchet
   baseline REGENERATED FROM RE-ADJUDICATED LABELS and hooked into
   test:rust; audit + preview-harness package scripts run in the
   native validation stage with one tracked specimen caller; the
   never-executed regress-net job DELETED (its gating variable was
   never set and its manifest path is private) unless a hosted
   manifest exists by then. No timing ratchet here: the harness's timings are
   non-comparable (O5) and a ratchet waits on defined benchmark
   conditions.
S5 e2e: TRIAGE FIRST — root-cause the destination lane's measured
   red streak (14/14 recent nightlies, rotating flaky tests plus the
   Nightly Maintenance "Fallow duplicates" failure) — then graduate
   only specs measured green under the destination lane's own
   configuration; retire the 30-consecutive-green bar in favor of
   machine-derived streak counters.
S6 E1a invariant assertions (I1-I3) guarding content loss and
   preview/final parity — after S3 so the invariants are not written
   against a baseline that contradicts them.
S6 deletion disposition (landed with this amendment): remove only the
   final-render-only deferred raster and layer rewrites after re-verifying
   that matched-page-size preview manifests reach the retained placement
   path; keep clippy and cargo-deny in the retained PR/push native lane
   before deleting the workflow-dispatch-only duplicate native job; retire
   O6's generator, baseline, and package-script pin. Quarantine graduation
   pins remain policy-owned and are not deleted by this item.
Later (appendix, unscheduled): Tier B/C residency, E1b redesign,
   full oracle-assurance formalism, transcript receipts/hash chains,
   landing-rate caps, review classifier (see B1: v1 is no classifier).

## Part 5 — Round-4 disposition (closes the review series)

Round 4 (opus-xhigh + sol-xhigh, exhaustive) both returned "not
ready" with convergent MINIMAL deltas; this FINAL version applies
them. Dispositions of their headline items:
- Figures: both reviewers' independent counts of the same constant
  population differed (166 vs 167). The proposed syntax-count gate was
  retired in S6; no transcribed measurement or committed threshold is
  authoritative.
- Scope guard made operative: digest references struck from F18/B5;
  G3 daily landing cap deleted (1h closure soak kept); T2/B1
  automated join test and classifier moved to appendix-deferred
  target form; hash chains, digest archives, and full oracle
  formalism stay out of the body.
- B1 re-scoped: blocking-local manual capture; the first committed
  classifier is NO classifier (sol Z4); candidate nomination only if
  volume later demands it.
- G2 emergency lane simplified (sol): a revert PR passes the NORMAL
  gates_ok with scheduling priority and a merge freeze on other PRs —
  no fast-subset variant, so the required check keeps one meaning.
- Backlog reordered as above (both reviewers, independently aligned).
- Z5 (forced prioritization) split: opus named O7, sol named O1; both
  are scheduled (S1 and S4) — recorded, no further action.
- Tracked home: this document, the new execution ledger, and the
  round 1-4 reviewer reports migrated to docs/internal/scan-cleanup/ in S1
  because .devkit is gitignored and unavailable to a fresh clone.
  Tracking preserves review visibility; under ledger R18 D1, later
  governance-prose edits commit directly to main rather than requiring
  CodeRabbit PR flow.
