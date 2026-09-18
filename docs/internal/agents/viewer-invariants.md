# Viewer invariants

User-level properties of the viewer, read from the rendered document rather
than from the app's own view model. They exist because the defects found by
hand are geometry over time, lifecycle races and feature interactions, and
nothing read those from the screen.

## The checker

`checkViewerInvariants()` in [`app/modules/viewer-invariants/public.ts`](../../../app/modules/viewer-invariants/public.ts)
reads the viewer once and returns `{violations, skipped}`. It is pure DOM
reads, cheap enough to run on every settled state. Geometry is in CSS pixels of
the scroller's client box, which excludes a classic scrollbar.

| Id | Holds when |
| --- | --- |
| `R1-toolbar-page-visible` | The page number rendered in the toolbar is a page that intersects the viewport by at least a quarter of the smaller of page height and viewport height. Either page of a facing spread qualifies; which one should win is undecided, so it is not asserted. |
| `L1-fit-mode-scroll-range` | Fit-width leaves no horizontal scroll range, provided no visible page is wider than the current page or spread. Fit-height in paged mode leaves no vertical range. |
| `A1-annotation-page-containment` | Each overlay box intersects its page and its centre is within 24px of the page box. Shapes the app marked `data-annotation-outside-page` are exempt. |
| `A1-annotation-normalized-drift` | Between two settled observations on the same page and rotation, an annotation's position normalized to the page box moves by at most 0.5%. |
| `A2-note-window-inside-pane` | An open note window lies fully inside the visible pane. |
| `A2-note-window-follows-anchor` | Between two settled unclamped observations with a visible anchor, the window moves by the same on-screen delta as its anchor page, within 2px. |
| `C2-renderer-diagnostics-clean` | No renderer diagnostic since the last observation, for a document the caller declared well formed. Allowlist entries carry a narrow signature and a written reason. |

Settle is `waitForViewerSettled()`: no input for 500ms, no visible page still
showing a skeleton, and optionally a `navigation-idle` no older than the last
input. Its timeout is independent; failing to settle is reported as an `S0`
violation, never as a reason to skip a check.

## The monitor and the bug-report shortcut

A dev-only Nuxt plugin installs the monitor, which runs the checker on each
settled state (throttled), keeps a content-free ring buffer of recent actions
and violations, and logs one structured `console.warn` per violation. C2 is fed
by the renderer error guard's own notices, so there is no second global handler.

**Cmd/Ctrl+Alt+B** writes `<userData>/bug-reports/<ISO timestamp>/` with
`report.json` and `screenshot.png`, and confirms with a small toast. The main
process owns the timestamp, the directory and the screenshot; a packaged build
refuses the call. The report carries recent actions, violations, the toolbar
snapshot, a redacted workspace-checkpoint shape, window size, DPR, app version,
page count and a geometry-only document fingerprint. It never carries document
text, file names or annotation content.

Production exclusion works like the dev-only agent widget: the plugin reaches
its implementation through an `import.meta.dev` ternary, so rollup drops the
module from a production build. Verify with `pnpm exec nuxi build` followed by
a grep of `nuxt-output/public/_nuxt` for `checkViewerInvariants`.

## Tests

- `tests/integration/browser/viewerInvariants.test.ts` is the guard: one
  known-bad fixture per invariant plus a conforming one, laid out by real
  Chromium.
- `tests/e2e/electron/helpers/viewerInvariants.ts` exposes
  `assertViewerInvariants(page, {checkpoint, expected})` for real-app tests.
- `tests/e2e/electron/viewerInvariantJourney.e2e.test.ts` drives one composed
  reading session with trusted input.

## Adding an invariant

1. Add the id to `TViewerInvariantId` and the check to `checkViewerInvariants`.
2. Give it an explicit applicability predicate that pushes a `skipped` entry
   with a reason. Guessing is not allowed.
3. Add a known-bad fixture and a conforming fixture to the browser-integration
   spec. A stateful invariant needs a two-observation sequence.
4. If the check needs a DOM hook that does not exist, add a minimal `data-*`
   attribute to the component rather than depending on a styling class.
