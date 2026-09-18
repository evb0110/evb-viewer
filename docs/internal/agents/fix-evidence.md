# Fix evidence

Rules for any change a user could see or feel: viewer, annotations, navigation,
scroll, zoom, resize, tabs, save, search, OCR, scan cleanup, DjVu. The reasons are
in the [methodology review](../methodology-review-2026-09-19.md).

## The standard

1. Reproduce first. Before changing code, drive the reported scenario in a
   task-owned hidden session of the real app and observe the failure. Follow
   [hidden automation](hidden-electron-automation.md) and
   [session lifecycle](electron-session-lifecycle.md).
2. Use real input for the action under test: trusted mouse, wheel, keyboard and
   drag through the session's CDP endpoint. Backdoors (`callWorkspaceCommand`,
   `__evbTestApi`, writing `scrollTop`, synthetic `dispatchEvent`, native value
   setters) are for setup only.
3. Assert what the user perceives: rendered text, real layout rectangles, painted
   pixels, saved bytes read back, console errors. An internal snapshot may be
   compared with the screen. It never replaces the screen.
4. Red, then green. The same script fails on the pre-fix code and passes after the
   fix. For a timing-dependent failure run both sides several times and report
   the counts.
5. Record it when the change is visual. Use
   [recorded automation](recorded-automation.md) and review the frames before
   presenting them. A recording made through backdoors proves nothing.
6. Keep the reproduction as a regression test in an existing real-app lane when
   the behavior can regress. A real-app regression test for a user-facing fix
   needs no separate approval; commit it with
   `Adds-Checks: real-app regression for a user-facing fix`.
7. Name the invariant the bug violated. If the
   [behavior contract](../../architecture/behavior-contract.md) lacks it, propose
   the addition with its applicability condition. List sibling scenarios that
   share the cause and say which ones you checked.

## When reproduction fails

Attempting is mandatory. Succeeding is not. Legitimate reasons: a private
fixture is unavailable, the platform is unreachable, the failure is rare timing,
or a crash or data loss needs containment now. Then report:

- the exact scenario attempted, the environment, and what was observed,
- which conditions of the report could not be recreated,
- the alternative evidence used,
- the residual uncertainty.

Say "mitigation applied, not confirmed". Do not say "fixed". A failed
reproduction is not permission to spend days building a harness: stop and
report.

## Verifier and implementer

An orchestrated task names one verifier. The verifier holds the hidden session,
writes the reproduction from the report, the behavior contract and the public UI,
and does not read the proposed fix first. Implementers get the verifier's
timeline, screenshots and logs, and may use the session under its ownership.

An implementer may challenge a reproduction or its tolerances. It may not edit
them. A second agent adjudicates a technical dispute. Changed product semantics
or genuine ambiguity goes to the owner. Keep the original failing revision and
fixture hash.

Delegation prompts must permit and require the hidden session. Never write
"do not launch Electron" into a worker prompt for a user-facing change. If a
worker's environment cannot run a hidden session, the orchestrator assigns the
real-app step to a verifier that can.

## Tests

- A geometry, lifecycle or interaction fix cannot close on a mock-level test
  alone.
- Do not add tests that assert private call sequences, call counts, or arguments
  passed to a mocked collaborator.
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
viewer-core changes are active at once, and they integrate one at a time: fetch,
rebase, run the affected real-app lane on the rebased candidate, then push.
Before starting viewer-core work, check open threads and branches for another
active viewer-core change and coordinate file ownership with its owner.
