# Scan Cleanup Audit Resolution

Date: 2026-08-16

This is the implementation record for the 47-item scan-cleanup audit supplied
for the 2026-08-16 remediation pass. The audit was reconciled against current
`main` before changes were assigned. Findings already closed by intervening
pull requests were verified rather than reimplemented.

## Disposition

| Finding(s) | Disposition | Resolution |
| --- | --- | --- |
| 2, 4 | Already closed | Current `main` uses the full-resolution routing plane. This pass adds a rectangle-level debug invariant and an over-`MAX_ANALYSIS_EDGE` parity fixture. |
| 5 | Already closed | The unreachable non-preview page-size branch was already removed. |
| 8, 38 | Already closed | Desktop discard now includes the SHA identity, with regression coverage. |
| 28 | Not a defect | `AnalysisPurpose::Classification` remains a supported direct native `--manifest` API. Compatibility/defaulting tests now make that reachability explicit. |
| 33 | Intentional behavior | The run-global ETA floor is a product behavior pinned by tests. Changing it requires a separate product decision, not a correctness fix. |
| 44 | Duplicate of 25 | One scheduler correction and one focused test set cover both reports. |
| 1, 3, 6, 7, 9-27, 29-32, 34-37, 39-47 | Fixed | Implemented and covered as summarized below. |

The reconciliation accounts for all 47 finding identifiers without treating a
refuted or intentional behavior as an implementation success.

## Correctness and determinism

- Analyze now stages retained PNG files before launching native processing.
  Native execution requires every Analyze `inputPath` to be an existing regular
  file, while Render retains its one-shot FIFO contract. Prior-seeded
  classification reruns are unconditional, so scratch capacity can affect
  admission but cannot select a different output.
- Source-MRC foreground, source text, and corpus verification share one matched
  canvas placement resolver, including intrinsic-overflow subtraction.
- PGM backgrounds use the P5 writer. Raster failures retain their typed
  `Io`/`InvalidRequest`/`TooLarge` classification plus page and path context.
- Stride padding is excluded from grayscale histograms, transposition reads by
  row/stride, and independent padded-input tests prevent the old oracle from
  agreeing with the defect.
- Canonical and working split rectangles are compared in common coordinates;
  an over-analysis-cap spread fixture exercises fallback/canonical parity.

## Resource and lifecycle bounds

- Preview/detection PNG compression runs in the `pdftoppm` child process rather
  than synchronously on the Electron main thread. The shared renderer validates
  PNG dimensions from the header and removes over-budget output without loading
  the compressed payload; preview and detection retain their context-specific
  bounds as defense in depth.
- Render bypasses decoded-input caching while Analyze retains replayable
  decodes. Cache reservation is operation-aware, and the trusted-MRC ink
  prepass uses the memory-derived page bound.
- Halftone reconstruction uses cluster-local buffers, box mean allocates a
  tight output, and unmasked multiscale threshold consensus is fused into one
  output traversal.
- Raster-page helpers settle sibling workers before rejecting. Analysis-file
  cleanup promises are observed in `finally`, delivery cursors are released by
  their job lifecycle, and scratch ownership uses an unambiguous prefix.
- Provenance hashing streams the source file. PDF combine writes prepared pages
  immediately unless shared-symbol JBIG2 is explicitly enabled.
- The page scheduler uses bounded scoped page workers rather than fixed chunk
  barriers. Waiting happens outside the Rayon processing pool, including when
  the host exposes only one CPU; explicit one- and two-thread tests pin that
  invariant. Page panics settle admitted siblings, roll back the publication
  transaction, and only then resume unwinding. Finding 44 is the same
  scheduling defect as finding 25.

## Contracts, tests, and user-visible behavior

- The runtime native-tool protocol is 7 across the registry, generated Rust,
  release metadata, and handshake tests. The public manifest wire version
  remains 3. Scan cleanup now uses the shared native CLI, including `-V`.
- The word-loss audit fails closed on skipped, errored, empty, or incomplete
  coverage. Harness baseline evaluation counts and truth-backed directional
  metrics are load-bearing; descriptive route counts remain report-only.
- Operator-fixture quarantine probes are explicitly diagnostics rather than
  graduation evidence. Graduation uses scheduled GitHub history plus manual
  review, and retries remain conditional on `[INFRA]` failures.
- Canonical analysis DPI, auxiliary-mask mapping, page-number formatting, and
  page-plan decoding each have one owner.
- Lossless progress and sidecar timings use terminal `page-complete` events,
  avoiding provisional/reconciled double counting.
- Renderer-owned detection, run, subscription, recovery, availability, and
  already-running fallbacks are localized in every desktop locale. Bounded raw
  bridge detail is retained only as optional diagnostic context.
- The process ledger now distinguishes historical batch closure from this
  audit's transport-determinism remediation and no longer points work at a
  deleted branch.

## Deliberate non-goals

- Render FIFO streaming remains supported; only Analyze requires replayable
  inputs.
- Route-count changes are not inherently quality regressions and therefore do
  not fail the harness.
- The existing run-global ETA floor is unchanged.
- Shared-symbol JBIG2 remains opt-in and may still use chunked preparation.

## Independent final review

An Opus 5 read-only review rejected the first bounded-dispatch implementation:
Rayon executed the `ThreadPool::scope` dispatcher on a pool worker, which could
deadlock a one-thread pool, and a resumed page panic bypassed transaction
rollback. Both findings were accepted and fixed before publication. The same
pass made trusted-ink prepass failures observable, skipped that prepass when no
eligible trusted inputs exist, enforced PNG `IHDR` and post-render bounds in
both preview paths, and replaced the final raw localization-key fallback. The
post-review full matrix then exposed stale OCR expectations and a lost shared
renderer bound; direct PNG output now retains header-only limits for OCR and all
other renderer consumers as well.

The complete unit matrix also showed that the unchanged PDF range-preload
oracle could complete correctly in isolation yet exceed its 15-second timeout
under bounded project concurrency. Its behavior and assertions remain
unchanged; only the test budget was raised to 30 seconds so host load is not an
implicit correctness condition.
