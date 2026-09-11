# Project 8 utility cleanup qualification

Review date: 2026-09-11

Ticket: [#555](https://github.com/evb0110/evb-viewer/issues/555)

Tested SHA: `2d551750e96ddf552a1bc2d955fcd1d02b1e924a`

## Acceptance run

The focused utility, broker, fingerprint-admission, PDF-commit, and shutdown
tests were run through the existing `unit-electron` project:

```text
pnpm exec vitest run --project unit-electron \
  tests/unit/electron/documentSaveUtilityAbort.test.ts \
  tests/unit/electron/documentSaveUtilityProtocol.test.ts \
  tests/unit/electron/commitPdfTempFile.test.ts \
  tests/unit/electron/boundedFileFingerprint.test.ts \
  tests/unit/electron/jobBroker.test.ts \
  tests/unit/electron/mainShutdownOrder.test.ts --reporter=dot
```

Result: 6 files passed, 70 tests passed in 631 ms.

The selected cases cover a valid result returned before termination settles,
false or unproven termination retaining the utility lease, later owned retry,
shutdown retry, direct-child exit not being mistaken for descendant proof,
fingerprint and PDF-commit lease accounting, broker contention, and production
shutdown ordering. The document utility fixture checks that release occurs
once after authoritative cleanup, including duplicate result or exit paths.

## Qualification boundary

The checked-in implementation and focused tests satisfy the available local
qualification for #555. They do not claim hosted cross-platform process
behavior. Windows and macOS process-tree behavior, native resource limits
outside these deterministic broker tests, and a hosted exact-SHA desktop run
remain coordinator or platform-lane evidence.

No production source, browser/OCR/native implementation, or assistant code was
changed. This commit records evidence only.

