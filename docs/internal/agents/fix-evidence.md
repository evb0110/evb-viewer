# Fix evidence

Rules for fixing a defect a user could see or feel: viewer, annotations,
navigation, scroll, zoom, resize, tabs, save, search, OCR, scan cleanup, DjVu.
This protocol covers defect fixes. New behavior needs acceptance evidence in the
running app but no fabricated pre-existing failure. The reasons are in the
[methodology review](../methodology-review-2026-09-19.md).

## The standard

1. Reproduce first. Before changing code, drive the reported scenario in a
   task-owned hidden session of the real app and observe the failure. Follow
   [hidden automation](hidden-electron-automation.md) and
   [session lifecycle](electron-session-lifecycle.md).
2. The action under test uses the actual input path: trusted mouse, wheel,
   keyboard and drag through the session's CDP endpoint. Backdoors
   (`callWorkspaceCommand`, `__evbTestApi`, writing `scrollTop`, synthetic
   `dispatchEvent`, native value setters) are permitted for setup only when they
   preserve the preconditions of the report.
3. Assert what the user perceives: rendered text, real layout rectangles, painted
   pixels, saved bytes read back, diagnostics. An internal snapshot may be
   compared with the screen. It never replaces the screen.
4. Red, then green. The same script fails on the pre-fix code for the reported
   symptom, not for startup trouble, and passes after the fix. For a
   timing-dependent failure run both sides several times and report the counts;
   one pair does not establish a race is gone.
5. Record it when the change is visual. Use
   [recorded automation](recorded-automation.md) and review the frames before
   presenting them. Frame review is triage, not the oracle.
6. Keep the reproduction as a regression test in an existing real-app lane when
   the behavior can regress. This is pre-authorized: commit it with
   `Adds-Checks: real-app regression for a user-facing fix`. The authorization
   covers one focused regression in an existing lane and the local helpers it
   needs. A new runner, job, lane, framework, monitor or generalized check
   infrastructure still needs the owner's request.
7. Name the statement of the
   [behavior contract](../../architecture/behavior-contract.md) the bug violated.
   If none fits, propose one with its applicability condition. List sibling
   scenarios that share the cause and say which ones you checked.

## When reproduction fails

Attempting is mandatory. Succeeding is not. Legitimate reasons: a private
fixture is unavailable, the platform is unreachable, the failure is rare timing,
the path cannot run in a hidden session (packaging, accessibility), or a crash or
data loss needs containment now. After a bounded, documented attempt, continue
with justified diagnosis or containment and report:

- the exact scenario attempted, the environment, and what was observed,
- which conditions of the report could not be recreated,
- the alternative evidence used,
- the residual uncertainty.

Say "unconfirmed" and distinguish a candidate fix from a mitigation. Do not say
"fixed". A failed reproduction is not permission to spend days building a
harness.

## Verifier and implementer

An orchestrated task names one verifier. Only the verifier launches and controls
the task's hidden session; workers request access and may diagnose through it
under that ownership. The verifier writes the reproduction from the report, the
behavior contract and the public UI. The reproduction author must not read the
implementation or proposed changes before recording expectations, and discloses
any unavoidable exposure. Implementers receive the timeline, screenshots and
logs. Keep the verifier's remit narrow: it does not review every edit or unit
test.

Independence comes from the predeclared contract and protected expectations, not
from the agent's title or model. An implementer may challenge a reproduction or
its tolerances. It may not edit them. A second agent adjudicates a technical
dispute, so a mistaken test does not become law. Changed product semantics or
genuine ambiguity goes to the owner. Record the source of each expectation, keep
the original failing revision and the fixture hash.

Delegation prompts must permit and require the hidden session. Never write
"do not launch Electron" into a worker prompt for a user-facing change. If a
worker's environment cannot run a hidden session, the orchestrator assigns the
real-app step to a verifier that can.

## Tests

- A geometry, lifecycle or interaction fix cannot close on a mock-level test
  alone.
- Do not assert private implementation protocols: internal call sequences, call
  counts, or arguments passed to a mocked collaborator. A boundary interaction
  may be asserted when it is itself the external contract, such as an IPC
  message, a file write, or a native tool invocation.
- When you touch a test, name the external contract it protects, imagine a
  plausible wrong implementation, and check that the test rejects it. If it
  cannot, replace it with one that can, or delete it. If the value is unclear,
  keep it and say so.
- A replacement test must first fail on the original defect.
- A test that did not run reports skipped with a reason. It never reports passed.

## Red `main`

Before diagnosing a red run for your commit, run `node scripts/ci/ci-health.mjs`
and read its attribution for the SHA. An inherited failure already has an owner;
do not re-diagnose it. A failure your commit introduced in the required set is
yours: repair it promptly or revert your commit. Do not widen a tolerance, skip a
test, or mark a step allowed to fail to get green.

## Viewer-core integration

Viewer core means `app/modules/pdf-viewer`, `app/modules/document-viewer`,
`app/modules/workspace-shell`, and the annotation session and layers. At most two
viewer-core changes are active at once. Integration is exclusive from fetch
through push: fetch, rebase, run the affected real-app lane on the rebased
candidate, push. If `main` moves in between, rebase and revalidate before
retrying. Before starting viewer-core work, check open threads and branches for
another active viewer-core change and agree file ownership with its owner.
