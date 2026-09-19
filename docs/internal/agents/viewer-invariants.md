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
| `A2-note-window-over-chrome` | A2, one observation, anchor on screen |
| `A2-note-window-follows-anchor` | A2, two observations |
| `C2-renderer-diagnostics-clean` | C2 |
| `S0-viewer-settled` | the Settled definition |

`unresolved` is a separate list and never a failure. It carries an observation
whose expected behavior the contract has not decided, with the rects, so the
monitor and a bug bundle still show it. An undecided rule cannot establish a
defect, so neither the monitor nor `assertViewerInvariants` may fail on one.

| Id | Open question |
| --- | --- |
| `A2-anchor-offscreen` | A2 and open question 3: hide, dock, or stay? |

`waitForViewerSettled()` implements Settled: no input for 500ms, no visible
page still showing a skeleton, the viewport and the mounted page boxes
identical to the previous frame, and, for a caller that just drove a
navigation, a `navigation-idle` no older than the last input. Its 10s bound is
its own; failing to settle is reported as `S0`, never as a reason to skip a
check.

Two-observation statements compare against the previous observation of the same
workspace. The memory is dropped when the active workspace tab changes, and an
annotation that stops drawing while its own page is still mounted is forgotten;
a page the viewer virtualized away keeps its memory, because bringing an
annotation back in the wrong place is the defect the comparison exists for.

The unobscured viewport is the scroller's client box, which already excludes
the toolbar, the sidebar and a classic scrollbar. C2 is fed by the renderer
error guard's own notices, so there is no second global handler.

## The monitor and the bug-report shortcut

A dev-only Nuxt plugin installs the monitor, which runs the checker on each
settled state (throttled), keeps a content-free ring buffer of recent actions
and violations, and logs one structured `console.warn` per violation. An action
records its type, its timestamp, the page track's presentation modes and the
control's authored identity: test id, role, element id, tag name. No free-text
attribute is read, because a tab's `aria-label` is the open document's file
name. Recording measures nothing, so it cannot perturb the gesture it observes.

**Cmd/Ctrl+Alt+B** writes `<userData>/bug-reports/<ISO timestamp>/` with
`report.json` and `screenshot.png`, and confirms with a small toast. The main
process owns the timestamp, the directory and the screenshot, and keeps the
newest twenty bundles; a packaged build refuses the call. `report.json` carries
recent actions, violations, the toolbar snapshot, a redacted
workspace-checkpoint shape, window size, DPR, app version, page count and a
geometry-only document fingerprint, and never document text, file names or
annotation content. The screenshot is a picture of the window and therefore
shows whatever is on screen.

Production exclusion works like the dev-only agent widget: the plugin reaches
its implementation through an `import.meta.dev` ternary, so rollup drops the
module. Verify with `pnpm exec nuxi build` and a grep of
`nuxt-output/public/_nuxt` for `checkViewerInvariants`.

## Tests

- `tests/integration/browser/viewerInvariants.test.ts`: one known-bad fixture
  per statement plus a conforming one, laid out by real Chromium. This is the
  guard against a weakened checker.
- `tests/e2e/electron/helpers/viewerInvariants.ts` exposes
  `assertViewerInvariants(page, {checkpoint, expected})`. `expected` is the
  exact list of tolerated violations, each naming its statement, the annotation
  it is about and a written reason. The list is matched in both directions, so
  a fix cannot leave a stale exception behind and a second defect cannot hide
  behind one.
- `tests/e2e/electron/viewerInvariantJourney.e2e.test.ts` drives one composed
  reading session with trusted input.

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
