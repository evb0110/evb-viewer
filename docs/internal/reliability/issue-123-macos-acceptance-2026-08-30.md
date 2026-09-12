# Issue 123 macOS acceptance

Issue [#123](https://github.com/evb0110/evb-viewer/issues/123) tracks
working-copy clone, fallback, capacity, revision, and path-identity behavior.
This report records the missing macOS acceptance run. The earlier Linux proof
remains in `issue-123-linux-acceptance-2026-08-29.md`.

## Exact fixture

- Path: `.devkit/fixtures/zaliznyak-three-distinct-copy-2646-pages.pdf`
- Size: 2,168,527,413 bytes
- Pages: 2,646
- SHA-256: `5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea`
- `qpdf --check`: passed

## APFS clone and reopen

`/bin/cp -c` cloned the exact fixture on APFS in 29 ms. The destination had a
distinct inode, matched the source size and SHA-256, opened with `O_RDWR`, and
passed `qpdf --check` with 2,646 pages. No streaming fallback was needed. The
temporary 2.0 GB target was removed after verification.

This closes the macOS clone and reopen part of `SAV-006`. The Linux report
separately covers forced unsupported clone, streaming fallback, and a
read-only destination refusal.

## Exact save and reopen

The xlarge Electron acceptance ran against the exact fixture and passed both
tests in 294.3 seconds. It opened and rendered pages 1, 1,323, and 2,646,
created two FreeText editors and one popup note, saved, ran `qpdf --check`,
started a fresh renderer, reopened the saved output, and compared annotation
objects and structural summaries. The final failure field was null.

The run recorded bounded renderer and IPC telemetry. The largest renderer
heartbeat gap before save was 2,091.1 ms against the 5,000 ms policy. The
largest IPC payload was 1,975 bytes. The final structural comparison retained
all six baseline object references and added four annotation objects.

The exact stable-source fallback copy also matched the fixture size and hash.
It completed in 2.25 seconds and its temporary target was removed. Together
with the held-source replacement regression and Linux exact-file probe, this
closes `SAV-009`.

## Constrained destination

A fresh 1.5 GiB APFS sparse image exposed 1,563,877,376 available bytes, less
than the 2,168,527,413-byte source. The probe forced clone fallback with
`EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT=unsupported`.

Both materialization attempts returned
`WORKING_COPY_MATERIALIZATION_NO_SPACE` with `retryable=true` before the
target was opened. No target or `.materializing-*` file remained. The same
registration ID stayed active and its backing state returned to
`lazy-original`. The image, mount, script, and scratch directory were removed.
This closes `SAV-012` on macOS.

## macOS path aliases

The red regressions used `/var/...` for one side of an operation and
`/private/var/...` for the other. Before `9d016f200`, lifecycle cancellation
missed the dependent operation and range-cache invalidation left its handle
open. The fix uses the existing working-copy path canonicalizer for lifecycle
comparisons and for every range-cache handle, epoch, pending-read, and byte
budget key.

After the fix, the focused working-copy and file-access run passed six files
and 154 tests. Electron and tests TypeScript checks, targeted ESLint, and diff
checks passed. CodeRabbit pass 1 reviewed the four changed files with zero
findings. The optional second pass was rate-limited after the included reviews
were exhausted, so the documented fail-open policy applied without paid use.
This closes `SEC-002`.

## Cleanup

The acceptance Electron sessions, hidden app copy, dev-server logs, APFS image,
clone target, and constrained-volume scratch data were removed. The compact
local JSON and gate records remain under `.devkit/evidence` and
`.devkit/analysis/gates` for local forensic use.
