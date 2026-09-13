# Project 8 large-document acceptance receipt

Review date: 2026-09-11

Source: `7d784ada38b95c77659b9809dc24e24ab9dfc40e`, the current
`origin/project8/integration` tip at the start of this slot.

Primary target: the unverified large-document Electron acceptance behind #552.
The run used the repository's existing `test:e2e:electron:large` command.

## Results

The native PDF page-operations build passed:

```text
Finished `release` profile [optimized] target(s) in 3m 14s
Staged evb-pdf-page-ops for linux-x64
```

The Electron lane reached the real application and ran five test files:

```text
4 passed, 2 skipped
2 failed
```

The two failures were the exact-fixture opt-in boundary in
`largePdfAnnotationSave.e2e.test.ts` and
`largePdfNativeAnnotationMatrix.e2e.test.ts`. The runner did not provide one
of the required profiles: `auditedZaliznyak882`, `localZaliznyak882`, or
`xlargeZaliznyak2646`. This is an intentional fail-closed fixture policy, not
a product assertion failure. The passing tests covered native preview handoff,
preview cancellation, and same-path split-pane lifecycle. One exact dictionary
test and the xlarge annotation-save test were skipped by their existing
conditions.

## Disjoint fallback

Because the primary lane could not supply its audited fixture, I ran the
existing large-document contract suites:

```text
pnpm exec vitest run \
  tests/unit/electron/largePdfMutationAdmission.test.ts \
  tests/unit/electron/xlargeIndexBuilder.test.ts \
  tests/unit/electron/xlargeNativeSearch.test.ts \
  tests/unit/electron/xlargeSearchRouting.test.ts \
  tests/unit/app/utils/performanceProfile.test.ts \
  tests/unit/app/plugins/performanceProfilePlugin.test.ts \
  --reporter=dot

6 test files passed
46 tests passed
```

This fallback qualifies admission, indexing, native search routing, and
performance-profile contracts only. It does not replace the exact-fixture
Electron acceptance.

## Gaps and cleanup

The remaining gap is an approved exact large-PDF fixture and its explicit
`EVB_EXACT_FIXTURE_PROFILE` selection in a supported acceptance environment.
Hosted performance status and exact-SHA CI evidence remain coordinator-owned.

The runner stopped all sessions it created. No owned Electron process or
session directory remained in this worktree. Native build output and gate
evidence remain under ignored `.tmp/` and `.devkit/` paths. No tracked source,
fixture, workflow, issue state, or shared checkout was changed.
