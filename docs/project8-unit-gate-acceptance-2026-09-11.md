# Project 8 unit-gate acceptance receipt

Review date: 2026-09-11

Source: `800ea56d46ff12af19b620d42f1cb8fd34c96f18`, the current
`origin/project8/integration` tip at the start of this slot.

This slot tried the next broad unverified unit acceptance and then ran its
disjoint policy fallback after the broad gate exposed a setup failure.

## Primary command and result

```text
pnpm run test:unit

1,235 test files passed
1 test file failed
2 test files skipped
11,202 tests passed
18 tests skipped
```

The only failure was
`tests/unit/scripts/releaseShared.test.ts`, in the test that creates a
temporary Git tag. Its subprocess ran `git tag v99.0.0` with no `EDITOR` and
failed with `Terminal is dumb, but EDITOR unset`. This is a test-environment
setup failure. No product assertion failed.

The gate also emitted build/deployment fixture output from existing unit
helpers. Those messages were test fixture behavior, not a release or deploy
from this lane.

## Disjoint fallback

```text
pnpm exec vitest run --project unit-policy --reporter=dot

15 test files passed
302 tests passed
```

The policy fallback is green. It does not clear the aggregate unit-gate
failure or substitute for the missing `EDITOR` setup in the Git-tag test.

## Gaps, artifacts, and cleanup

The remaining local gap is to rerun the aggregate unit gate with the test
subprocess environment providing a noninteractive editor, without changing
the test contract. Hosted exact-SHA CI remains coordinator-owned.

The aggregate gate evidence is
`.devkit/analysis/gates/2026-09-11T18-14-26-356Z-3936611-8c250150.ndjson`.
Later fallback gate records remain under ignored `.devkit/`. No owned session,
Electron process, or untracked source output remained. No source, fixture,
workflow, issue state, `main`, or `project8/integration` was changed.
