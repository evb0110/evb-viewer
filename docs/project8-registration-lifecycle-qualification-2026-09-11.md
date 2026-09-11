# Project 8 registration lifecycle qualification

Review date: 2026-09-11

Source under review: `19830bd36` (`origin/project8/integration`)

Tickets: [#333](https://github.com/evb0110/evb-viewer/issues/333) and
[#535](https://github.com/evb0110/evb-viewer/issues/535)

## Current contract

`electron/main.ts` is a one-line composition entry that imports the bootstrap
owner. The feature registration table contains 20 descriptors with unique,
ordered start positions and complete create, IPC registration, and shutdown
labels. The table's highest-level runtime owns disposal in reverse start order.

The raw IPC list contains five explicit bridge descriptors. Their reasons are
specific to the bridge contract: the diagnostics canary is automation-only,
renderer log and renderer diagnostic are one-way diagnostic bridges, shutdown
save flush is a temporary handshake, and window close response is a temporary
native close handshake. The three `ipcMain` registration sites outside feature
descriptors are those named bridge owners, not unlisted product features.

The existing inventory at
`docs/architecture/project6-ticket333-registration-table-inventory-2026-09-07.md`
records the same boundary and its shutdown dependencies. This qualification
does not move bridge security or lifecycle code into an artificial wrapper.

## Focused acceptance

```text
pnpm exec vitest run tests/unit/electron/featureRegistrationTable.test.ts tests/unit/electron/mainShutdownOrder.test.ts --reporter=dot
2 test files passed, 14 tests passed
```

The suite verifies the 20-name start order, unique positions, complete hooks,
reverse shutdown order, raw-bridge reasons, duplicate-scope rejection,
single-flight disposal, renderer save-flush ordering, materialization settling,
fatal-handler ordering, and retained utility cleanup.

## Result and gaps

The table and reverse-disposal contract are qualified on Linux with the real
registration descriptors and source ordering. The remaining #333 acceptance
gap is the Electron smoke lane, which was not launched in this quality slot.
Hosted exact-SHA CI and the platform-specific smoke remain coordinator-owned
publication evidence. No browser, OCR, assistant, or native source was edited.
