# Methodology review, 2026-09-19

## Question

The project has about 11,000 tests and eight completed audit projects. Hands-on
use of the dev build still finds serious bugs in basic flows: annotations,
navigation, scrolling, resizing. Verification also takes a long time. Must the
owner test every feature by hand on many files, or can scenario validation be
done programmatically?

## Answer

Programmatic validation can work here, and the owner should not become the QA
department. It failed for reasons that can be named and fixed. Until they are
fixed the owner is the only bug detector: every owner-observed product bug in
the last 60 days of agent histories came from hands-on use, and none came from a
test, a gate, an audit, or CI.

## Method

Nine independent read-only investigations on 2026-09-19: forensics on 35 recent
user-facing viewer fixes, a test inventory, an assertion-quality audit, process
and audit history, a survey of real-app automation, measured CI and gate time,
and a classification of 60 days of agent session histories from three tools with
one shared taxonomy. A second model reviewed the diagnosis and plan in three
rounds and corrected both. Raw reports stay in the ignored `.devkit/methodology/`
directory because they quote private sessions.

## Findings

### 1. Tests run where these bugs cannot occur

| Measure | Value |
| --- | --- |
| Test cases | 11,034, about 463k lines, 1:1 with product code |
| Cases that launch the real app | 172 (1.6%) |
| Cases in bare Node with no DOM | about 88% |
| Cases in happy-dom, which has no layout engine | about 10% |
| Assertions that check a mock was called | 21% |
| Policy and source-text cases | 939, 5.5 times the real-app suite |
| Test files added in 60 days | 611, of which 20 are real-app specs |

Root causes of 35 recent user-facing viewer fixes: geometry or layout over time
14, async or lifecycle race 11, interaction of two features 7, real-data variety
2, CSS only 1, single-unit logic error 0. In 26 of the 35 a test already existed
at the exact seam and missed the bug. Reasons: harness has no real layout 11,
action sequence never performed 8, only the settled state asserted while the bug
is in the transition 5, fixture too uniform 5, the prior test asserted the buggy
behavior 1. Of 26 fixes that added a test, 5 assert something a user could
observe and 14 assert internal call counts or store fields.

The unit layer is not worthless. It may be the reason single-unit logic errors
are absent from the sample. The finding is narrower: the next unit test adds
almost nothing, and the seams where features compose are nearly unprotected.

### 2. The real-app layer checks the app's self-model, not the screen

About half of real-app assertions are user-observable. The rest go through
backdoors that skip the path where the bugs live:

- The default scroll helper writes `scrollTop` and dispatches a synthetic scroll
  event. No gesture runs.
- 80 assertions have the form `callWorkspaceCommand(...).called === true`, which
  proves that a command exists.
- The current page is read from an internal test API snapshot, never from the
  rendered indicator.
- No real-app spec resizes the real window. Two cases drag a split divider.
- Annotation plus scroll has 3 cases, annotation plus resize has 4.
- 112 `if (!session) return;` sites let a test that never started pass.

Good patterns exist and are rare: a real-Chromium test that measures painted row
geometry across widths and UI scales, a real-wheel navigation spec with per-step
violation lists, painted-annotation pixel checks with a saved-bytes re-read.

### 3. Correlated judgment

The same agent derives the implementation and the expected result from the same
assumptions, so the test inherits the code's misunderstanding. One pre-existing
test asserted the buggy rejection as correct; the fix had to invert it.

### 4. Done means a green command, and workers may not open the app

| Measure | Value |
| --- | --- |
| Sessions in one tool written by another agent, not the owner | 94% of 845 |
| Sessions that edited product code and never launched the app | 84% |
| Unit-test runs per real-app launch | 6.5 |
| Owner-observed fixes with a real-app reproduction first | 11% to 38% by tool |
| Owner-observed fixes verified by unit tests only | 42% to 57% by tool |

Delegation prompts often forbade launching Electron. That rule protected the
owner's desktop and predates the hidden no-focus session runner. A provider
agnostic recorder for hidden sessions shipped on 2026-09-18; a bug-fix thread that
started eight hours later fixed a scroll crash twice on unit tests and reported
that it had not reproduced the bug in the running app. The capability existed.
No rule required it.

Reproduction first and outcome, small samples: 9 of 9 resolved against 6 of 12
without it in one tool; 4 of 4 in another, where every multi-round defect family
lacked a reproduction; a third contradicts at three cases, which were the hardest
ones. Reproduction first is an evidence standard, not a proven treatment.

### 5. The work supply is static reading

71% of 701 issues carry an audit prefix and 10 of 14 audits are pure code
reading. Six issues (0.9%) came from hands-on use. In a 59-issue sample 22% were
user-perceivable. The one audit that ran the app on real documents had 6
user-visible findings out of 7. 80% of delegated worker sessions served programs,
audits and boards; 4% served a bug the owner saw. Viewer-area fix commits per
week, oldest to newest: 15, 5, 19, 3, 1, 6, 52, 146, 75, 78.

### 6. Verification is slow and its verdict carries little signal

| Measure | Value |
| --- | --- |
| `main` runs that ended red | 152 of 232 (66%) |
| Hours without a green `main` | 46%, longest stretch 33.9 h |
| Longest red streaks | 36, 26, 25 consecutive commits |
| Reruns that changed a verdict | 0 of 232 |
| Sampled `main` failures that were a user-visible regression | 0 of 21 |
| Median push to verdict | 30 to 34 min, p90 41 to 44 |
| Commits that touch only tests, CI or scripts | 26% |
| Median wall-clock of a small owner-reported fix | 11 min in May, 52 min in September |

The checks are deterministic and measure things no user would notice. A recent
ten-run red streak came from one stylelint blank-line rule and one 0.2 px scale
assertion. About 28 pushes a day land on `main` from concurrent agents, so a
failure cannot be pinned on one change and every agent pays a turn to prove a red
was inherited.

### Not the problem

Try/catch density is ordinary. The written rules already forbid coverage and
test-count quotas. The cross-worktree heavy-build lock recorded zero waits. CI is
not flaky.

## Decisions

Stage 0, rules only:

1. Evidence standard for a user-facing fix: attempt a real-app reproduction with
   real input in a hidden session. The same script fails before the fix and
   passes after it. Otherwise the report says "mitigation applied, not
   confirmed". See [fix evidence](agents/fix-evidence.md).
2. The standard lives in delegation prompts, not only in `AGENTS.md`. One
   verifier per task holds the hidden session and owns the reproduction. The
   implementer may challenge its expectations but may not edit them.
3. The required CI set is cut to about 12 minutes: publication policy, typecheck,
   lint, unit tests, one Electron smoke. Other lanes still run but are not part
   of the verdict. Packaging and heavy native checks remain release
   requirements. A red required set has one owner and is reverted first.
4. Viewer-core integration is serialized, with at most two active viewer-core
   changes.
5. Stopped: broad static audit programs, mandatory review passes on small
   changes, new tests that assert mock call sequences.

Stage 1, pilot: independent verification of the click-during-fling navigation
bug with a real wheel burst and a real click, failing on the pre-fix commit and
passing on the fix.

Stage 2: repair the real-app channel (real-wheel scroll helper, outcome
assertions, the rendered page indicator, fail-closed sessions, real window
resize), a shared set of user-level invariants with applicability conditions
(see the [behavior contract](../architecture/behavior-contract.md)), a dev-build
invariant monitor and a local bug-report capture.

Stage 3: a nightly lane on the owner's Mac capped at 30 minutes with a rotating
private corpus and a bounded explorer, and an automated merge queue once the
required set has a green baseline.

## Owner role

Approve the behavior contract once. Use the app 30 to 60 minutes a week on
varied documents with capture on; this is a planning budget, not a guarantee.
Judge feel and rule on changed product semantics. Stop commissioning audits and
stop supervising CI, reviewer and release progress. Backlog order: owner-blocking
failures, recurring defect families, failures from a fixed set of ordinary tasks
on varied documents.

## Metrics for three weeks

1. Reappearance rate of owner-reported defect families within 14 days, with
   stable family identifiers.
2. Median and p90 time from a fix-ready candidate to a trustworthy verdict,
   timestamps derived automatically.
3. Detection on a fixed panel of known-bad revisions plus one held-out case.

## Corrections from the second opinion

- "Unit tests target a bug class that no longer exists" was overstated. Recent
  fixes are a selected sample.
- The link between audit refactors and the rising fix rate is a hypothesis. Fix
  counts confound regressions, discovery, change volume and commit size.
- Concentrated churn does not prove competing owners of viewport state. Trace
  one failing interaction first.
- Start with one owner-visible failure through real input. Do not build a
  framework first.
- Invariants need applicability conditions and a known-bad replay the checker
  must reject.
- A shared seed replays actions, not scheduling.
- Do not run every checker after every action. Keep the submission corpus tiny
  and rotate breadth nightly.
- Growing invariants only from owner-found bugs keeps the owner as the discovery
  bottleneck. The behavior contract and robot finds feed them too.
- Testing cannot compensate for unlimited concurrent behavioral change.
- More machinery will not fix a workflow that permits unsupported closure.

## Uncertainty

The reproduction-first evidence is small and mixed. The audit-to-regression link
and the viewport-ownership hypothesis are unverified. None of this guarantees
that hands-on use stops finding serious bugs.
