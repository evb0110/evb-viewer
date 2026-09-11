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
| `e2e-blocking-smoke` | `pnpm run test:e2e:electron:blocking-smoke:headless` | Changed app/Electron push gate | 5 files passed, 41 tests passed, 5 skipped |
| `e2e-draw-shapes` | `pnpm run test:e2e:electron:draw-shapes` | Manual dispatch | 1 file passed, 16 tests passed; 1 parity test failed |
| `e2e-large-pdf` | `pnpm run test:e2e:electron:large` | Manual dispatch and performance workflow | 3 files passed; 2 suites blocked by exact-fixture opt-in |
| `e2e-rapid-navigation` | `pnpm run test:e2e:electron:rapid-navigation` | Manual dispatch | 2 files passed, 17 tests passed |
| `e2e-visible-window` | `pnpm run test:e2e:electron:visible-window` | Manual dispatch | Blocked at Electron sandbox startup; 3 platform tests skipped |
| `e2e-quarantine` | `pnpm run test:e2e:electron:quarantine` | Manual dispatch | Runner exited 1; per-test report unavailable after temp cleanup |
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

## Blocking-smoke acceptance run

The next feasible browser-owned acceptance ran with its documented command:

```text
pnpm run test:e2e:electron:blocking-smoke:headless
5 test files passed, 41 tests passed, 5 skipped
Duration: 726.07s
```

The command built and staged the Linux `scan-cleanup` and `pdf-page-ops`
native tools, built Electron, and passed the PR smoke, DjVu committed-surface,
text interaction, annotation controls, bounded PDF save, and scan-cleanup
toolbar journeys. Five cases were intentionally skipped by the blocking scope,
including pressure and large-PDF checks.

This is local Linux Electron evidence. Hosted exact-SHA status, Windows and
macOS acceptance, and production-artifact replay remain external gaps.

## Draw-shapes acceptance run

The next browser-owned acceptance ran with its documented command:

```text
pnpm run test:e2e:electron:draw-shapes
1 test file passed, 16 tests passed; 1 test failed
Duration: 518.03s
```

The native page-operations build reused its fingerprinted artifact and the
draw-shape lifecycle file passed all 16 scenarios. The independent
Electron/Playwright stroke-parity test failed at
`annotationStrokeParity.e2e.test.ts:369`: the measured blue-pixel difference
was 41, above the allowed 28. The run is therefore not an acceptance pass.

Disjoint fallback TODO: investigate the Electron versus Playwright stroke
pixel-count delta, including the captured runtime metrics and viewport/device
scale inputs, then rerun only the parity acceptance after the cause is fixed.
Do not change the threshold to make this run green.

## Large-PDF acceptance run

The next browser-owned acceptance ran with its documented command:

```text
pnpm run test:e2e:electron:large
3 test files passed, 4 tests passed, 2 skipped
2 suites blocked at exact-fixture opt-in
Duration: 114.96s
```

The page-operations artifact reused successfully and the native-preview and
split-pane scenarios passed. The annotation-save and native-annotation-matrix
suites failed closed before their tests because
`EVB_EXACT_FIXTURE_PROFILE` was not set to an audited profile. This is not a
green large-PDF acceptance result.

Disjoint fallback TODO: obtain the coordinator-approved audited exact fixture
profile (`auditedZaliznyak882`, `localZaliznyak882`, or
`xlargeZaliznyak2646`), stage the matching fixture, and rerun the two blocked
suites with that profile. Do not bypass the opt-in boundary or substitute a
generated fixture for exact-fixture evidence.

## Visible-window acceptance run

The next browser-owned acceptance ran with its documented command:

```text
pnpm run test:e2e:electron:visible-window
1 suite failed at Electron startup, 3 tests skipped
Duration: 35.77s
```

The macOS print cases were correctly skipped on Linux. The visible-window test
did not reach its application assertion because Electron exited before CDP
readiness. The session log reports that `chrome-sandbox` is not root-owned with
mode `4755`, so Electron refused to launch.

Disjoint fallback TODO: repair or provision the approved Electron installation
with the required sandbox-helper ownership and mode, then rerun the visible
window test. Do not add `--no-sandbox`, weaken the launcher policy, or treat a
debug-only launch as visible-window acceptance.

## Quarantine acceptance run

The next browser-owned acceptance ran with its documented command:

```text
pnpm run test:e2e:electron:quarantine
native builds passed; quarantine gate exited 1
Duration: 252.51s
```

The page-operations and scan-cleanup native artifacts were reused, the
PDF-image-combine artifact built successfully, and Electron plus the isolated
renderer started. The quarantine runner then failed its validation stage. Its
temporary JSON report was removed by the runner, so this slot has no reliable
per-test counts or assertion identity and is not an acceptance pass.

Disjoint fallback TODO: preserve the quarantine JSON report before temporary
directory cleanup, rerun the policy suite in an isolated slot, and identify the
failing assertion or policy mismatch. Do not convert missing report data into a
green result and do not loosen quarantine admission rules.
