# Project 8 Electron regression and save-pipeline acceptance receipt

Review date: 2026-09-11

Source: `873c1621d2eb2c9410fb67bc020eccfae0249eec`, the current
`origin/project8/integration` tip at the start of this slot.

The primary acceptance was the next unverified Electron regression project.
The disjoint fallback was the configured save-pipeline acceptance.

## Primary command and result

```text
pnpm run test:e2e:electron:regression

14 test files: 11 passed, 1 skipped, 2 failed
105 tests: 91 passed, 12 skipped, 2 failed
exit 1
```

The run built the native E2E tools and Electron bundle, then exercised the
full regression project for 2,299.06 seconds. The two failures were:

- `annotationLifecycle.e2e.test.ts`: after undo and redo, a saved highlight
  retained `annotationDirty: false` in workspace state but the active tab
  remained dirty.
- `recentFiles.e2e.test.ts`: deleting a Recent Files row returned
  `removed: false`; the target and Open button became disabled and the tab
  title changed instead of removing the row without opening it.

These are application behavior failures, not setup skips. The 12 skips are
the existing platform or conditional cases reported by the regression suite.

## Fallback command and result

```text
pnpm run test:e2e:electron:save-pipeline

save-pipeline: 2 files passed, 2 skipped; 11 tests passed, 4 skipped
native-save-reopen: 2 files passed; 8 tests passed
exit 0
```

The save-pipeline project completed in 426.34 seconds. Native save/reopen and
compact page-label structural acceptance completed in 445.14 seconds. The
skipped cases were the existing conditional issue-124 cases and the benchmark.

## Gaps and artifacts

The regression lane remains red for the saved-highlight dirty-tab state and
Recent Files deletion behavior. Those need a code-owner follow-up. The run
also retains the normal Linux-host gaps and conditional skips; Windows-only
behavior and hosted exact-SHA CI remain coordinator-owned.

Gate evidence was emitted at:

```text
.devkit/analysis/gates/2026-09-11T18-39-56-727Z-4090346-fabdd082.ndjson
.devkit/analysis/gates/2026-09-11T19-18-30-858Z-50943-d02b397f.ndjson
.devkit/analysis/gates/2026-09-11T19-25-41-199Z-74676-aacf3424.ndjson
```

The native page-ops artifact was reused from `.tmp/pdf-page-ops/`. Test
fixtures and isolated session logs stayed under ignored `.devkit/tmp/` and
`.devkit/sessions/` paths.

## Cleanup and branch safety

The fallback runner shut down its sessions. The earlier regression invocation
left a detached process tree after reporting its final result, so the exact
worktree-owned validation, Xvfb, Nuxt, and Electron PIDs were terminated and
verified absent. No broad process cleanup was used.

This receipt is the only tracked change. The work is on
`t3code/legacy-quality-campaign`; `main` and `project8/integration` were not
checked out or modified. No force-push was used. The coordinator should merge
the branch.
