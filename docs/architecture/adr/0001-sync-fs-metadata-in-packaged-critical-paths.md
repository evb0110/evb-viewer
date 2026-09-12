# ADR 0001: Sync fs metadata calls in packaged-critical Electron paths

- Status: accepted (2026-08-23)
- Evidence: issue #82; release runs 32560820174, 32570721080, artifacts run
  32579579728 (failures); release run 32604802270 (green after the fix)

## Context

A performance pass (`38ba4bd18`) converted the temp-sandbox path validator and
the document read handlers from sync `fs` metadata calls (`lstatSync`,
`realpathSync`, `statSync`) to `fs/promises`. Every Linux and macOS lane
stayed green. In packaged **Windows** builds, Electron's ASAR fs shim
intercepts `fs.promises`, and its handling of these metadata calls rejected
valid working-copy paths: `resolveAllowedReadPath` returned null for a
materialized working copy sitting directly under the sole temp base dir,
while the sync API on the exact same path succeeded (proven by in-error
validator diagnostics that ran both). The shim's deprecated `fs.Stats`
construction (`DEP0180`) fired on the same requests. Result: every packaged
file read failed with "reads only allowed within temp directory", killing the
Windows lanes of three release runs.

## Decision

The temp-sandbox validator (`electron/utils/pathValidator.ts`), the document
path resolution module (`documentFilePathResolution.ts`), and the read
handlers' stat sites (`documentFileReadHandlers.ts`) use the synchronous `fs`
metadata API. Public async signatures are kept by wrapping sync bodies in
`Promise.resolve` where callers expect promises. Bulk data reads
(`readFile`, file handles) remain async; only metadata calls are affected.

## Consequences

- A few synchronous syscalls per IPC validation on the main process. These
  are not hot-loop operations; the perf pass's real wins (streaming,
  virtualization, debouncing) are unaffected.
- A tripwire test (`tests/unit/electron/packagedCriticalFsPolicy.test.ts`)
  fails any reintroduction of `fs/promises` metadata imports in these files,
  because Linux/macOS CI cannot detect this regression class.

## Revisit when

An Electron upgrade demonstrably fixes the shim's `fs.promises` metadata
handling on Windows, proven by the packaged Windows core-PDF smoke passing
with an async conversion on a real windows-2022/windows-11-arm run — not by
green Linux/macOS lanes.
