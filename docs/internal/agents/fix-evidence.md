# Fix evidence

Rules for fixing a defect a user could see or feel: viewer, annotations,
navigation, scroll, zoom, resize, tabs, save, search, OCR, scan cleanup, DjVu.
This protocol covers defect fixes. New behavior needs acceptance evidence in the
running app but no fabricated pre-existing failure.

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
   scenarios that share the cause and say which ones you checked. When the
   report came from the owner's hands-on use, record it as an issue labelled
   `owner-observed` with its `family:` label, as
   [triage labels](triage-labels.md#origin-and-defect-family) describes.

## Fix chains

When the report belongs to a defect family that was repaired before (see
[triage labels](triage-labels.md#origin-and-defect-family)), or the file you are
about to change has taken three fix commits in the last seven days, do not add
another repair first. In the failing run, trace the user's intent, the owner of
the state involved, the stale completion, and the point where the wrong value was
committed. Then delete the redundant state or lifecycle path, or revert to the
last good state. A fix that grows such a file is rejected on push and in CI by
`scripts/lib/fix-chain.mjs`. Only the owner can waive it, quoted in a
`Fix-Chain-Override:` trailer.

Do not relax a test until it accepts either side of a race. Remove the race in
the product, or leave the test red and report it.

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

## Delegation

Delegation prompts must permit and require the hidden session. Never write
"do not launch Electron" into a worker prompt for a user-facing change. The
author of a reproduction writes its expectations from the report and the
behavior contract before reading the fix; an implementer may challenge a
reproduction but not edit it.

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
- A scenario states the outcome it requires: which checks must have run and which
  things it created must still be there. A skipped check is not a passed check,
  and the positions of the elements that remain say nothing about one that
  vanished.
- A settled-state check says nothing about the transition. When the report is
  about blanking, ignored input or jerky motion, observe during the interaction.

## Red `main`

Wait for the required verdict: `ci-wait -w CI <sha>` as a background task. A
failure your commit introduced is yours: repair it promptly or revert your
commit. Do not widen a tolerance, skip a test, or mark a step allowed to fail to
get green. `node scripts/ci/ci-health.mjs` reports failure trends across recent
runs.

## Viewer-core integration

Viewer core means `app/modules/pdf-viewer`, `app/modules/document-viewer`,
`app/modules/workspace-shell`, and the annotation session and layers. One
viewer-core change is active at a time. Integration is exclusive from fetch
through push: fetch, rebase, run the affected real-app lane on the rebased
candidate, push. If `main` moves in between, rebase and revalidate.
