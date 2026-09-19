# Viewer invariants

Checkable forms of the statements in the
[behavior contract](../../architecture/behavior-contract.md), read from the
rendered document rather than from the app's own view model. The contract owns
the statements, their applicability and their tolerances; this page only says
how they are checked.

## The checker

`checkViewerInvariants()` in [`app/modules/viewer-invariants/public.ts`](../../../app/modules/viewer-invariants/public.ts)
reads the viewer once and returns `{violations, skipped}`. Pure DOM reads,
cheap enough to run on every settled state. Each violation id names the
contract statement it checks:

| Id | Statement |
| --- | --- |
| `R1-toolbar-page-visible` | R1 |
| `L1-fit-mode-scroll-range` | L1 |
| `A1-annotation-page-containment` | A1, one observation |
| `A1-annotation-normalized-drift` | A1, two observations |
| `A2-note-window-inside-pane` | A2, one observation |
| `A2-note-window-follows-anchor` | A2, two observations |
| `C2-renderer-diagnostics-clean` | C2 |
| `S0-viewer-settled` | the Settled definition |

`waitForViewerSettled()` implements Settled: no input for 500ms, no visible
page still showing a skeleton, and, for a caller that just drove a navigation,
a `navigation-idle` no older than the last input. Its 10s bound is its own;
failing to settle is reported as `S0`, never as a reason to skip a check.

The unobscured viewport is the scroller's client box, which already excludes
the toolbar, the sidebar and a classic scrollbar. C2 is fed by the renderer
error guard's own notices, so there is no second global handler.

## The monitor and the bug-report shortcut

A dev-only Nuxt plugin installs the monitor, which runs the checker on each
settled state (throttled), keeps a content-free ring buffer of recent actions
and violations, and logs one structured `console.warn` per violation.

**Cmd/Ctrl+Alt+B** writes `<userData>/bug-reports/<ISO timestamp>/` with
`report.json` and `screenshot.png`, and confirms with a small toast. The main
process owns the timestamp, the directory and the screenshot; a packaged build
refuses the call. `report.json` carries recent actions, violations, the toolbar
snapshot, a redacted workspace-checkpoint shape, window size, DPR, app version,
page count and a geometry-only document fingerprint, and never document text,
file names or annotation content. The screenshot is a picture of the window and
therefore shows whatever is on screen.

Production exclusion works like the dev-only agent widget: the plugin reaches
its implementation through an `import.meta.dev` ternary, so rollup drops the
module. Verify with `pnpm exec nuxi build` and a grep of
`nuxt-output/public/_nuxt` for `checkViewerInvariants`.

## Tests

- `tests/integration/browser/viewerInvariants.test.ts`: one known-bad fixture
  per statement plus a conforming one, laid out by real Chromium. This is the
  guard against a weakened checker.
- `tests/e2e/electron/helpers/viewerInvariants.ts` exposes
  `assertViewerInvariants(page, {checkpoint, expected})`.
- `tests/e2e/electron/viewerInvariantJourney.e2e.test.ts` drives one composed
  reading session with trusted input.

## Adding an invariant

1. Start from a contract statement. If none fits, propose one there first.
2. Add the id and the check, with an applicability predicate that pushes a
   `skipped` entry with a reason. Guessing is not allowed.
3. Add a known-bad and a conforming fixture to the browser-integration spec. A
   two-observation statement needs a two-observation sequence.
4. If the check needs a DOM hook that does not exist, add a minimal `data-*`
   attribute to the component rather than depending on a styling class.
