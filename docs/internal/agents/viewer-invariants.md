# Viewer invariants

Checkable forms of the statements in the
[behavior contract](../../architecture/behavior-contract.md), read from the
rendered document rather than from the app's own view model. The contract owns
the statements, their applicability and their tolerances; this page only says
how they are checked.

## The checker

`checkViewerInvariants()` in [`app/modules/viewer-invariants/public.ts`](../../../app/modules/viewer-invariants/public.ts)
reads the viewer once and returns `{violations, skipped, unresolved}`. Pure DOM
reads, cheap enough to run on every settled state. Each violation id names the
contract statement it checks:

| Id | Statement |
| --- | --- |
| `R1-toolbar-page-visible` | R1 |
| `L1-fit-mode-scroll-range` | L1 |
| `A1-annotation-page-containment` | A1, one observation |
| `A1-annotation-normalized-drift` | A1, two observations |
| `A2-note-window-over-chrome` | A2, one observation: show, contain and hide note windows |
| `A2-note-window-follows-anchor` | A2, two observations |
| `C2-renderer-diagnostics-clean` | C2 |
| `S0-viewer-settled` | the Settled definition |

`unresolved` is a separate list and never a failure. It carries an observation
whose expected behavior the contract has not decided, with the rects, so the
monitor and a bug bundle still show it. An undecided rule cannot establish a
defect, so neither the monitor nor `assertViewerInvariants` may fail on one.
The current A2 behavior is decided by ADR 0007, so the checker emits no A2
unresolved entry; the legacy report id remains readable for older bundles.

The anchor is the annotation's own marker, not its page. While the page is
visible, an open note must be visible; if its marker is offscreen but the page
remains visible, the note must be fully inside the active pane. The checker
does not infer which pane edge is the intended docking edge from rectangles
alone. Once the page leaves the viewport, the connected note must be hidden so
that reopening it retains the user's note without leaving a stray window. When
no marker is drawn for the annotation, the page stands in for it.

The checker reads the PDF page track only. On a DjVu document every statement
is skipped and `S0` reports that there is no page track, so a DjVu run has no
invariant coverage yet; read the toolbar and the action outcomes instead.

`waitForViewerSettled()` implements Settled: no input for 500ms, no visible
page still showing a skeleton, the viewport and the mounted page boxes
identical to the previous frame, and, for a caller that just drove a
navigation, a `navigation-idle` no older than the last input. Its 10s bound is
its own; failing to settle is reported as `S0`, never as a reason to skip a
check.

Two-observation statements compare against the previous observation of the same
workspace. The memory is dropped when the active workspace tab changes, and an
offscreen, hidden or otherwise non-comparable note interval breaks the memory;
a page the viewer virtualized away keeps a non-comparable entry so that bringing
an annotation back cannot compare across the interval.

The unobscured viewport is the scroller's client box, which already excludes
the toolbar, the sidebar and a classic scrollbar. C2 is fed by the renderer
error guard's own notices, so there is no second global handler, and a failure
the product reports through its own logger, such as a refused save, is not a
C2 diagnostic.

A note window clips itself to its pane, so its layout box reaches over the
toolbar while nothing of it is painted there. `A2-note-window-over-chrome`
therefore compares the window's painted rect, which is its layout box narrowed
by its own `inset()` clip path; the two-observation comparison still uses the
layout box, because that is what follows the anchor. A window clipped so far
that its title bar and close button are gone is observed as hidden while its
page is offscreen; if its page is visible, the checker reports the missing
window as an A2 violation.

## The monitor and the bug-report shortcut

A dev-only Nuxt plugin installs the monitor, which runs the checker on each
settled state (throttled), keeps a content-free ring buffer of recent actions
and violations, and logs one structured `console.warn` per violation and one
`console.info` per unresolved observation.

An action records the control's authored identity only: test id, role, element
id, tag name. No free-text attribute is read, because a tab's `aria-label` is
the open document's file name. Wheel packets are coalesced into one gesture
entry, split at a pause, a direction reversal or a modifier change, carrying
the packet count, the summed and first and last deltas, the ctrl modifier that
means zoom, and the start point in the viewport. Meaningful actions live in a
separate bounded queue that wheel volume cannot flush. A key action keeps its
`code` and modifiers only when it is not a typed character; typing is a count.
Recording measures nothing per packet: one rect read starts a gesture.

**Cmd/Ctrl+Alt+B** writes `<userData>/bug-reports/<ISO timestamp>/` with
`report.json` and `screenshot.png`, and confirms with a small toast. The main
process owns the timestamp, the directory and the screenshot, and keeps the
newest twenty bundles; a packaged build refuses the call. `report.json` carries
recent actions, the invariant report, the toolbar snapshot, a redacted
workspace-checkpoint shape, window size, DPR, app version, page count, the
build's commit, and the first 16 hex of the sha256 of the source file's bytes.
The renderer hands the path to the main process, which hashes the file and
discards it, so the bundle identifies the document without naming it. It never
carries document text, file names or annotation content. The screenshot is a
picture of the window and therefore shows whatever is on screen.

A bundle is a diagnostic snapshot, not a replayable checkpoint. What is missing
for a replay is measured and named in
`.devkit/methodology/findings/capture-reconstruction.md`.

Production exclusion works like the dev-only agent widget: the plugin reaches
its implementation through an `import.meta.dev` ternary, so rollup drops the
module. Verify with `pnpm exec nuxi build` and a grep of
`nuxt-output/public/_nuxt` for `checkViewerInvariants`.

## Tests

- `tests/integration/browser/viewerInvariants.test.ts`: one known-bad fixture
  per statement plus a conforming one, laid out by real Chromium. This is the
  guard against a weakened checker.
- `tests/e2e/electron/helpers/viewerInvariants.ts` exposes
  `assertViewerInvariants(page, {checkpoint, expected, requireRan,
  requirePresent})`. `expected` is the exact list of tolerated violations, each
  naming its statement, the annotation it is about and a written reason, matched
  in both directions, so a fix cannot leave a stale exception behind and a
  second defect cannot hide behind one. `requireRan` names the invariants the
  checkpoint is about, so a skipped check fails with its reason instead of
  looking green. `requirePresent` names the annotations, note windows and page
  indicator the scenario created and has not deleted: the checker cannot judge
  that, because deleting is legitimate and it does not know the user's intent.
- `tests/e2e/electron/viewerInvariantJourney.e2e.test.ts` drives one composed
  reading session with trusted input.

## Discovery run on real documents

`tests/e2e/electron/calibration/corpusDiscoveryCalibration.e2e.test.ts` is a
discovery run, not a gate. It lives in the manual `e2e-calibration` project, so
no CI lane runs it. For each document of a manifest it starts a fresh hidden
session, opens a working copy under a neutral name, and takes ordinary reader
actions with real input: a real window resize, a sticky note, wheel bursts that
never wait for the viewer, a zoom click while a burst is still scrolling, a
typed page jump, the fit modes, the sidebar, a second tab and back. After each
action it records the settled invariant report, the page the toolbar shows, and
renderer console errors. During the wheel steps it also reads the checker every
frame and records how long each violation lasted and the worst frame gap; that
is a measurement, because the contract has not decided transition time bounds.

It asserts only that the run happened. A person reads the results, because a
real document may be malformed and an unexpected result may be a wrong
expectation. Reproduce a finding on a synthetic document before filing it: the
issue then carries public evidence, and nobody has to look at a private page.

```bash
EVB_CORPUS_MANIFEST=/abs/path/manifest.json \
  bash scripts/test-electron-e2e-headless.sh --no-build e2e-calibration \
  tests/e2e/electron/calibration/corpusDiscoveryCalibration.e2e.test.ts
```

The manifest is `{"entries": [{"id", "path", "sha256", "format": "pdf" | "djvu",
"pages"}]}` and stays outside the repository. `EVB_CORPUS_IDS=c03,c07` limits the
run, `EVB_CORPUS_RESULTS` moves the per-document JSON (default
`.devkit/trial/results`), and `EVB_CORPUS_SCREENSHOTS=1` adds a picture at open,
which shows document content and is off by default. Results name a document by
id and hash prefix only. Thirty documents take about 13 minutes.

## Adding an invariant

1. Start from a contract statement. If none fits, propose one there first.
2. Add the id and the check, with an applicability predicate that pushes a
   `skipped` entry with a reason. Guessing is not allowed.
3. Add a known-bad and a conforming fixture to the browser-integration spec. A
   two-observation statement needs a two-observation sequence.
   If part of the statement is still open, that part goes to `unresolved` with
   its own fixture proving it produces no violation.
4. If the check needs a DOM hook that does not exist, add a minimal `data-*`
   attribute to the component rather than depending on a styling class.
