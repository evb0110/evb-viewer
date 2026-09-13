# Project 8 quality, contracts, and tooling continuation

Review date: 2026-09-13

Source qualified: `c0e5164e7e79390afe7395d5696a768824ea5809`, the exact
`origin/project8/integration` tip inspected before this receipt.

This receipt advances the remaining quality and contract evidence for #375,
#477/#478, #522, #535, and #553. It does not cover browser or OCR
implementation.

## Local acceptance

The locked workspace setup completed with `pnpm install --frozen-lockfile`.
The first full tooling run was started alongside the native suite and hit two
30-second oracle timeouts. Both cases passed when rerun alone, and the clean
full run passed after the native build settled.

```text
pnpm exec vitest run --project unit-electron \
  tests/unit/electron/agentAssistantOptIn.test.ts \
  tests/unit/electron/featureRegistrationTable.test.ts \
  tests/unit/electron/scanCleanupPipeline.test.ts \
  tests/unit/electron/scanCleanupPageBatches.test.ts
4 files passed, 169 tests passed

pnpm exec vitest run --project unit-scripts \
  tests/unit/scripts/worktreesPrune.test.ts \
  tests/unit/scripts/releaseStatus.test.ts
2 files passed, 12 tests passed

pnpm exec vitest run --project unit-policy
15 files passed, 292 tests passed

pnpm run test:tooling
72 files passed, 680 tests passed, 1 skipped

pnpm exec vitest run --project unit-tooling \
  tests/unit/scripts/windows-test/ocrPageMarkerOracle.test.ts
1 file passed, 6 tests passed

pnpm exec vitest run --project unit-tooling \
  tests/unit/scripts/windows-test/windowsHostOracleDispatcher.test.ts
1 file passed, 12 tests passed

cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup --locked
670 unit tests passed, 4 harness tests passed, 47 CLI tests passed,
2 protocol tests passed, 2 split tests passed, 3 strict-CLI tests passed;
0 failed, 19 ignored
```

The focused checks establish the following current-tip contracts:

- #375 keeps unselected, incomplete, dirty, ambiguous, and unreadable
  worktrees, and removes only a selected clean completed target with an absent
  owner.
- #477/#478 retain bounded page batching, cancellation, staged input, render
  ownership, geometry, composition, and unchanged-output behavior in the
  existing TypeScript and native suites.
- #522 keeps promotion state re-read after a lost GitHub edit response and
  preserves unresolved and conditional mirror-recovery outcomes.
- #535 checks typed disposer keys, reverse shutdown order, exactly-once
  disposal, and shared concurrent disposal settlement.
- #553 exercises malformed successful Codex turn-start replies for undefined,
  null, numeric, empty, and whitespace-only IDs, plus stale-turn fencing in
  the real assistant pipeline fixture.

## Hosted exact-SHA evidence

The existing push CI run for the exact qualified source is
[34748189862](https://github.com/evb0110/evb-viewer/actions/runs/34748189862).
GitHub reports `completed / success` for head SHA
`c0e5164e7e79390afe7395d5696a768824ea5809`. This is the hosted evidence for
the source reviewed above, not evidence for this receipt commit.

## Gaps

The large-document Electron performance lane associated with the budget
follow-up remains separate hosted evidence. The Linux native and unit checks
above do not replace that lane. Windows/macOS installed-app and platform
acceptance remain coordinator-owned. The receipt does not change issue state,
project state, `main`, or `project8/integration`.

## Cleanup

The native and Vitest commands exited successfully. No owned Electron,
browser, VM, or release process was started. Dependency, Nuxt, native-target,
and gate output remains ignored under the checkout's existing `.devkit`,
`.nuxt`, `.tmp`, `node_modules`, and `native/target` paths. No tracked output
other than this receipt was created.
