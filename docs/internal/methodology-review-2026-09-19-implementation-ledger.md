# Methodology review, implementation ledger

Companion to the [methodology review](methodology-review-2026-09-19.md). Status
as of 2026-09-19. Each row says what landed, the evidence, and what it does not
prove. Counts of tests or rules are not results; see the review's closing
measures.

## Landed on `main`

| Item | Commits | Evidence | Limit |
| --- | --- | --- | --- |
| Evidence standard, behavior contract, rule changes | `197b67269`, `c5aa26e1d`, `60c8d8bc6`, `0870b853c` | Reviewed twice by a second model; overclaims corrected after an independent review | The contract is a draft until the owner approves it; five questions are open |
| CI tiers: required, extended, nightly | `b95900ff8`, `ae9e77f21` | First required verdict 11 min 46 s against a 30 to 34 min median before | Total machine time is about the same; lanes moved, they did not disappear |
| Repair of the red `main` | `e79539e5c` | The failing scale assertion was a real fixed-padding defect; the padding was made to scale and the tolerance left alone | The repair kept a wrong design and made its visible symptom larger; see "A repair from this work that asserted the wrong thing" |
| Failure attribution and verdict-time metric | `460769519`, `40978e199`, `47d9ab52a` | `ci-health.mjs --sha` and `--verdict-times`; baseline 5 to 12 Sep: 86% red, longest streak 238 commits | Reads the Actions API; re-reads a dropped request, reports one line when unreachable |
| Release needs both tiers green on one commit | `ae9e77f21` | Unit tests on recorded API shapes | Not exercised by a real release yet |
| Pilot: click during a fling | `41bf5fb6b` to `d17f7a27d` | Independent verifier, trusted decaying wheel burst plus trusted click: 0 of 3 before the fix, 3 of 3 after; counter desync reproduced; passes on hosted macOS against two later iterations of the same code | Wheel input through the debugging protocol has no native momentum phase. Close-during-fling never reproduced. The claimed next-gesture regression was not distinguishable |
| Fail-closed real-app sessions | `551ff1a0a` | 185 dead guards deleted, 25 made to throw; no test newly failed or skipped | None found |
| Real-app channel repair | `e20ca34ce` to `8d4a43b21`, `ee765089b` | Page wait now requires the rendered indicator and the internal page to agree; real window resize command; one resize case in the smoke spec; 88 command-exists assertions replaced by a helper that throws on a missing command | All 88 were setup in tests with a separate outcome check, so the review's claim about them was overstated. The new resize case found no defect |
| Viewer invariants, dev monitor, bug-report capture, first journey | `34005280a` and its 21 parents | Known-bad real-Chromium fixtures; journey green twice on the final tip with a real window resize; production build contains none of the module; monitor adds no long task and leaves frame gap p95 at 17.5 ms; checker 0.20 ms median | See "What the journey found" and "Capture" below |

## What the journey found

One defect, filed as issue 819, in a family repaired the day before and found
before the owner met it. Its first write-up was half wrong. It claimed the note
window was drawn over the toolbar and sidebar after a zoom; the calibration
showed that the window clips itself to its pane and paints nothing over the
chrome. The checker had compared layout boxes, the worker reported exact
coordinates, and the orchestrator filed the issue from the write-up without
opening the screenshot. The state is still defective for another reason: the
clip removes the title bar, so the window cannot be closed, deleted or dragged.
The second face stands as reported: a sideways pane relayout moves the anchor
page 140 px and the window not at all.

Two false alarms were found and fixed: a fixed-size note icon reported as drift
on zoom, and the over-chrome check firing on a window that is only clipped. The
lesson is the review's own: a rectangle says nothing about what is painted or
reachable.

One case is deliberately not a finding: what a note window should do when its
anchor page leaves the viewport is an open product question, so the checker
reports it as unresolved and no test fails on it.

## Capture

The bug-report bundle is a diagnostic snapshot, not a replayable checkpoint. It
keeps pointer, key and coalesced wheel-gesture summaries in separate bounded
queues, a content hash of the source file, the build commit and the rendered
zoom, and no file name, path or typed text. A replay from the bundle alone did
not reproduce its session: it reached page 3 at 138% against page 1 at 163%.
Named causes: toolbar controls have only a generic identity in the log, tool
state is missing, and no scroll offset is captured.

## Calibration through the real app

Three historical fixes were reverted one at a time and driven with trusted
input, each side at least twice.

| Case | Role | Result |
| --- | --- | --- |
| `069a25668` note window follows its page | designed-for | Detected end to end. Reverted: the window moved 0 px while its page moved -240 px, and the checker named exactly that. Current: passes |
| `12647dbc9` zoomed page jumps on resize | held out | Not reproduced under three real-window resize shapes, so it establishes nothing. The missing check is contract R3, whose anchor is still an open question |
| `ccd6c1c3e` later saves fail after a shape past the page edge | held out, task outcome | Detected only by the scenario's own outcome assertion: both saves refused, nothing on disk. The screen-level checker saw nothing, and the diagnostics check missed two `Workspace save failed` console errors because it listens to the renderer error guard, not the product's logger |

A harness defect nearly faked the third result: the new lane was missing from
the native page-ops list, so the first run refused saves on the fixed revision
too. It was caught because both sides were run, and the bad run is kept.

Gaps this names: no check for R3, no screen-level statement for A4, and C2 does
not see errors the product logs itself.

## What the extended tier caught on the same day

The extended tier went red on three lanes. A bisect put the break at `db0444657`
(a sidebar layout change from another thread): a control in the annotation
inspector is no longer hit-testable after a tool is selected, filed as issue 820.

This ledger first called that a regression a user would meet. It was not. The
change made the properties a bounded, scrollable footer on purpose. Measured in
the hidden app at the 900x668 test window, the footer shows 139 px of a 184 to
212 px editor, the colour swatches stayed clickable, and the draw presets and
the fill colour sit below the fold, one wheel notch away. The click helper never
scrolled, so it timed out on controls a user can reach. `2e780e0cd` makes the
helper wheel to a control with real input, which still fails for a control the
wheel cannot reach, and the extended tier went green on all 14 jobs. What is
left is a product choice the owner has not made: whether that footer is tall
enough at a small window.

The bisect and the tier did their job, since they named the commit within
hours. The reading of the failure was the weak step, for the second time in one
day (issue 819 was the first): a helper timeout was reported as a user-visible
defect without looking at the app. A timeout in a test helper says the helper
could not act, not that a user could not.

It also exposed two faults in this work. The attribution tool blamed the newest
commit, because five extended runs in a row had been superseded and carried no
verdict; it now answers UNDETERMINED with the last green commit and the
candidates to bisect (`c34354ff5`). And the real-window resize command, being
strict, turned the required smoke lane red for a test that asked for a window
the hosted virtual display could not hold; the display was enlarged
(`f0f927798`). The hosted macOS runner has a physical limit of about 942 px of
height, so a test there must ask for a size that fits.

## A repair from this work that asserted the wrong thing

The comment preview clamps to two lines and had `padding-bottom: 3px` as room
for a squiggly underline. Padding on a clamped box exposes glyph fragments of
the next line. This work's repair of the red `main` changed that padding to
`0.3lh`, about 5 px, so it scaled with the UI, and added a real-Chromium
assertion that the room covers the decoration's measured reach. The assertion
passed at every scale while a sliver of a third text line was visible in the
sidebar. Another thread removed the padding altogether in `266ab8f5d`, keeping
the wave inside the line box, and asserted what a reader sees: exactly two text
lines with no third-line fragments.

So a test written during this review measured a quantity the author had chosen
(room for the wave) instead of the outcome (what is painted in the row), in real
Chromium, with real layout. Moving a test to a layer with a layout engine does
not by itself make it assert the right thing.

## Three other red mails on the same day

- **Release build, Windows.** A dependency update moved Electron from 43.4.1 to
  44.3.0, which no longer ships `libEGL.dll` and `libGLESv2.dll` on Windows. The
  installed-app step used five file names as its signal that extraction had
  finished, waited fifteen minutes for two that could not arrive, and failed on
  x64 and ARM64 while the packaged-app smoke on the same build passed. Nothing
  caught it at the update because installers build only on a schedule or a
  dispatch. `59e00cfd5` names files both versions ship; the dispatched build on
  `2e780e0cd` passed on every platform, the installed journey in 43 s on x64 and
  62 s on ARM64.
- **Required tier, three pushes.** The two-line assertion from `266ab8f5d`
  counted blue-dominant glyph edges from Linux font smoothing as a third
  underline band. It had been run on macOS only. Fixed by its author in
  `2de57be03` on the second attempt.
- **Dependency audit.** Not a failure. The audit passed, and the workflow
  commented on an issue titled "found advisories" after every clean run, so the
  mail read as an alarm. `7bb1faf80` comments on a clean run only when the
  previous report was not clean.

Two of these are the pattern from the section above: a check that encodes a
stand-in (a list of DLL names, a colour threshold) for an outcome it could
observe directly, and breaks when the environment changes.

## Adoption

The same day, another thread filed issue 818 as `owner-observed` with a
`family:` label, reproduced it in a hidden session with trusted clicks before
fixing, named the contract statements it relied on, and used the pre-authorized
trailer for its real-app regression. Its new assertion currently fails on the
hosted Linux runner (three line fragments where two are expected), which keeps
the required tier red at the time of writing; the attribution tool marks that
failure as inherited from `266ab8f5d`.

## Not done
- **Bounded trial on the private corpus.** A hashed manifest of 30 local
  documents with a fail-closed resolver exists in the ignored `.devkit`, but
  nothing consumes it. No real document has been driven. A manifest is
  preparation, not coverage.
- **One timing overlap in a discovery task.** Settled-state checks say nothing
  about transient blanking, ignored input or jerky resize. The per-frame samplers
  exist and are not yet used outside open and navigation. The stress runner's
  `wheelBurst` awaits settlement per packet, so it is not a burst.
- **Nightly lane.** `ci-nightly.yml` runs native jobs; no scheduled real-app
  discovery run exists, and none should until someone is named to process its
  findings through the `robot-found` label.
- **Merge queue.** Viewer-core integration is serialized by rule, not by
  mechanism.
- **Completed extended verdicts.** Seven of nine extended runs during this work
  ended cancelled because another push landed within half an hour, which is also
  what hid the commit that broke the inspector. A release is
  protected by the two-tier rule; ordinary pushes often finish without an
  extended verdict. Dispatch `ci-extended.yml` for a commit that needs one.

## Owner decisions

1. Approve or amend the behavior contract, and answer its five open questions.
   Question 3 blocks issue 819.
2. Decide who processes findings from a non-blocking discovery run.
3. Decide whether to schedule a local nightly run on the Mac.

## Platform gaps

Native macOS trackpad momentum is unproven by automation. Hidden windows have no
real display geometry, so display-scale changes and multi-monitor moves are
untested. Native dialogs are outside the hidden session.
