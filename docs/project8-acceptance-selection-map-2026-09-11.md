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
| `browser-integration` | `pnpm run test:integration:browser` | Changed-area browser job on push/PR | Unknown |
| `native-integration` | `vitest run --project native-integration` | Changed-area native/build job on push/PR | Unknown |
| `electron-bundle-static-integrity` | `pnpm run test:electron-bundle-static-integrity:no-build`, after the build job | Native/build safety and release checks | Unknown |
| `e2e-regression` | `pnpm run test:e2e:electron:regression` | Changed app/Electron integration; manual dispatch | Unknown |
| `e2e-blocking-smoke` | `pnpm run test:e2e:electron:blocking-smoke:headless` | Changed app/Electron push gate | Unknown |
| `e2e-draw-shapes` | `pnpm run test:e2e:electron:draw-shapes` | Manual dispatch | Unknown |
| `e2e-large-pdf` | `pnpm run test:e2e:electron:large` | Manual dispatch and performance workflow | Unknown |
| `e2e-rapid-navigation` | `pnpm run test:e2e:electron:rapid-navigation` | Manual dispatch | Unknown |
| `e2e-visible-window` | `pnpm run test:e2e:electron:visible-window` | Manual dispatch | Unknown |
| `e2e-quarantine` | `pnpm run test:e2e:electron:quarantine` | Manual dispatch | Unknown |
| `e2e-save-pipeline` | `pnpm run test:e2e:electron:save-pipeline` | Push/PR save-path integration and manual dispatch | Unknown |
| `e2e-native-save-reopen` | Invoked by the save-pipeline script after `e2e-save-pipeline` | Save-pipeline command, not a separate workflow job | Unknown |
| `e2e-xlarge-pdf` | `pnpm run test:e2e:electron:xlarge` | Manual dispatch and performance workflow | Unknown |
| `e2e-search-match-scroll` | `pnpm run test:e2e:electron:search-match-scroll` | Package script only; no current CI workflow invocation found | Unknown, no automatic lane found |

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
