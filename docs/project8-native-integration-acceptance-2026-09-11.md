# Project 8 native integration acceptance receipt

Review date: 2026-09-11

Source: `b97ddd26a2f41e55da2004cb6d8799329a2cc845`, the current
`origin/project8/integration` tip at the start of this slot.

This run takes the next unverified configured acceptance project after the
Electron blocking smoke. It is separate from the large-document and browser
acceptance lanes.

## Command and result

```text
pnpm exec vitest run --project native-integration --reporter verbose

3 test files passed
3 tests passed
5 tests skipped
```

The passing tests exercised native placed-image lifecycle, native PDF save and
reopen after an injected failure, and 10,001 flat bookmark continuation. The
five skipped cases are the existing Windows atomic-PDF-replacement tests and
were skipped by their platform condition on Linux. No test failed.

## Gaps and fallback

This qualifies the configured native-integration project on Linux. Windows
atomic replacement behavior remains a Windows-host acceptance gap, and hosted
exact-SHA CI remains coordinator-owned. No fallback Todo was needed because
the primary project completed successfully.

## Artifacts and cleanup

The existing native build receipts under ignored `.tmp/` and gate records under
ignored `.devkit/` were reused or retained by the workspace. The test run left
no owned native subprocess, Electron session, or session directory. No tracked
source, fixture, workflow, issue state, `main`, or `project8/integration` was
changed.
