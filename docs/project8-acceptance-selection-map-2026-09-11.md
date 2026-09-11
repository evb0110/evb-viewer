# Project 8 automated acceptance selection map

Review date: 2026-09-11

Source under review: `19830bd36` (`origin/project8/integration`)

Ticket: [#537](https://github.com/evb0110/evb-viewer/issues/537)

The current `vitest.shared.config.ts` defines 22 projects. The older ticket
count of 21 is stale. This map records the configured project, its entry point,
and whether this lane has exact run evidence. "Unknown" means no hosted result
was available here, not that the project is green.

| Project | Entry point and condition | Automatic path | Exact evidence in this slot |
| --- | --- | --- | --- |
| `unit-core` | `pnpm run test:unit` or coverage; package, contract, PDF, server, and i18n files select it | Push/PR quality | Unknown for the full project |
| `unit-app` | `pnpm run test:unit` or coverage; app files select it | Push/PR quality | Unknown for the full project |
| `unit-electron` | `pnpm run test:unit` or coverage; Electron files select it | Push/PR quality | Unknown for the full project |
| `unit-scripts` | `pnpm run test:unit`; scripts and tooling changes select it | Push/PR quality; process-safety workflow also runs it | 54 policy-selection tests passed across the selected policy suites |
| `unit-tooling` | `pnpm run test:tooling` | Manual process-safety workflow | Unknown |
| `unit-policy` | `pnpm run test:unit`; policy changes select all unit projects | Push/PR quality | 54 policy-selection tests passed across the selected policy suites |
| `unit-static-architecture` | `pnpm run test:unit`; app, native/build, architecture, and selected test paths select it | Push/PR quality | Unknown for the full project |
| `unit-landing` | `pnpm run test:unit`; landing changes select it | Push/PR quality | Unknown for the full project |
| `browser-integration` | `pnpm run test:integration:browser` | Changed-area browser job on push/PR | 12 files passed, 25 tests passed, 1 skipped |
| `native-integration` | `vitest run --project native-integration` | Changed-area native/build job on push/PR | Unknown |
| `electron-bundle-static-integrity` | `pnpm run test:electron-bundle-static-integrity:no-build`, after the build job | Native/build safety and release checks | Unknown |
| `e2e-regression` | `pnpm run test:e2e:electron:regression` | Changed app/Electron integration; manual dispatch | Unknown |
| `e2e-blocking-smoke` | `pnpm run test:e2e:electron:blocking-smoke:headless` | Changed app/Electron push gate | Unknown |
| `e2e-draw-shapes` | `pnpm run test:e2e:electron:draw-shapes` | Manual dispatch | Unknown |
| `e2e-large-pdf` | `pnpm run test:e2e:electron:large` | Manual dispatch and performance workflow | Unknown |
| `e2e-rapid-navigation` | `pnpm run test:e2e:electron:rapid-navigation` | Manual dispatch | 2 files passed, 17 tests passed |
| `e2e-visible-window` | `pnpm run test:e2e:electron:visible-window` | Manual dispatch | Unknown |
| `e2e-quarantine` | `pnpm run test:e2e:electron:quarantine` | Manual dispatch | Unknown |
| `e2e-save-pipeline` | `pnpm run test:e2e:electron:save-pipeline` | Push/PR save-path integration and manual dispatch | Unknown |
| `e2e-native-save-reopen` | Invoked by the save-pipeline script after `e2e-save-pipeline` | Save-pipeline command, not a separate workflow job | Unknown |
| `e2e-xlarge-pdf` | `pnpm run test:e2e:electron:xlarge` | Manual dispatch and performance workflow | Unknown |
| `e2e-search-match-scroll` | `pnpm run test:e2e:electron:search-match-scroll` | Package script only; no current CI workflow invocation found | 1 file passed, 2 tests passed |

## Policy checks

```text
pnpm exec vitest run tests/unit/scripts/validationGatePolicy.test.ts tests/unit/scripts/changedAreaClassifier.test.ts tests/unit/scripts/ciTopologyPolicy.test.ts --reporter=dot
3 test files passed, 54 tests passed
```

The first attempt exposed a missing clean-checkout prerequisite,
`landing/.nuxt/eslint.config.mjs`. Running `pnpm --dir landing exec nuxt prepare`
generated the normal metadata. The rerun above passed. No project selector,
workflow schedule, quarantine rule, or gate was changed.

The map establishes configured selection and invocation paths. It does not turn
manual or platform-specific projects into green results. Hosted exact-SHA run
inspection for excluded projects remains coordinator/CI evidence. No browser,
OCR, assistant, or native source was edited.

## Browser acceptance run

The next browser acceptance slot ran:

```text
pnpm run test:integration:browser -- --reporter verbose
12 test files passed, 25 tests passed, 1 skipped
Duration: 96.89s
```

The run covered Chromium document lifecycle UI, source-version and Recent Files
replacement, live-lease and transfer ownership, maintenance sweeps, annotation
saves, page operations, DjVu finalization, IndexedDB migration, text selection,
stroke scaling, comment-row geometry, and print-dialog layout. The skipped test
was intentional and did not fail the project.

This is local Chromium evidence for the configured browser project. Hosted
exact-SHA CI remains the source for publication status, and native-dialog,
installed-app, Windows, macOS, and production-deployment acceptance remain
outside this VPS run.

## Search-match scroll acceptance run

The next feasible browser-owned acceptance ran with its documented command:

```text
pnpm run test:e2e:electron:search-match-scroll
1 test file passed, 2 tests passed
Duration: 118.09s
```

The command built and staged the Linux PDF-search native tool, built Electron,
then ran the high-zoom xlarge search journey and the repeated-match navigation
journey. Both scenarios passed. The native build gate also passed.

This is local Linux Electron evidence. The package script has no automatic CI
invocation in the current map, and hosted exact-SHA status, platform-specific
acceptance, and any supplied production PDF replay remain external gaps.

## Rapid-navigation acceptance run

The next feasible browser-owned acceptance ran with its documented command:

```text
pnpm run test:e2e:electron:rapid-navigation
2 test files passed, 17 tests passed
Duration: 284.04s
```

The run built Electron and passed the deep page-jump, rapid wheel and keyboard
navigation, fit-mode continuity, invalid-open recovery, and overlay-preservation
journeys. Both the generated page-jump fixture and the standard 1,200-page
fixture completed under the existing headless Electron harness.

This is local Linux Electron evidence. Hosted exact-SHA status, Windows and
macOS acceptance, and any production-artifact replay remain external gaps.
