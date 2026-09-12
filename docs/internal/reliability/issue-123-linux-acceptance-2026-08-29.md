# Issue #123 Linux acceptance evidence

Run date: 2026-08-29 UTC. Host filesystem: ext4 on `/dev/sda1`. The source was
read-only and was never modified.

Source: `/home/ubuntu/services-infra/data/cloud/zaliznyak-large-2646-pages.pdf`

- 2,168,527,413 bytes
- SHA-256 `5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea`

## Large-file clone and fallback

The probe ran `attemptWorkingCopyClone` and `copyFileFromStableSource` against
the source, with targets under `.devkit/issue-123-large-copy/`.

| Path | Result | Time |
| --- | --- | ---: |
| Linux `COPYFILE_FICLONE_FORCE` | known unsupported on this ext4 host; no target remained | 0.6 ms |
| `fs.promises.copyFile` kernel copy | 2,168,527,413 bytes, SHA matched | 4,044.0 ms |
| `copyFileFromStableSource` held-source JavaScript loop | 2,168,527,413 bytes, SHA matched | 3,489.1 ms |
| clone into mode `0555` parent | immediate `EACCES`; no target remained | 0.8 ms |

Raw output: `.devkit/evidence/large-copy-probe.jsonl`.

The Linux clone path selected its tested streaming fallback. The JavaScript
loop was not slower than the kernel copy in this run, so no performance fix was
warranted.

## Constrained filesystem

A fresh 128 MiB tmpfs was mounted at `.devkit/evidence/space-mount/`, then
unmounted after the probe. The source is larger than the filesystem by more than
2 GiB. `ensureWorkingCopyMaterialized` returned
`WorkingCopyMaterializationError` with code
`WORKING_COPY_MATERIALIZATION_NO_SPACE` and `retryable=true` before opening a
materialization target. The working-copy path was `ENOENT`, no
`.materializing-*` file remained, and the registration stayed `lazy-original`
with the same typed source error.

Raw output: `.devkit/evidence/space-probe.json` and
`.devkit/evidence/space-probe-df.txt`.

## Background plus explicit revision transition

The checked-in headless wrapper ran
`tests/e2e/electron/xlargeDocumentAcceptance.e2e.test.ts` with the exact source.
The fixture was admitted at 2,168,527,413 bytes and staged with
`cloneMode=stream`. Session A opened and closed it. Session B explicitly edited
and saved it. The save, revision token, qpdf, structural, reopen, and cleanup
assertions passed. The test process reported failure only because the separate
renderer heartbeat check measured 9,231.1 ms against its 5,000 ms limit. That
timing check belongs to #134, not the #123 working-copy assertions.

Raw artifact: `.devkit/evidence/xlarge-document-acceptance.json`.

## Gates

- Focused working-copy suites: 3 files, 65 tests passed.
- Focused ESLint on the working-copy implementation and regression files passed.
- `pnpm run typecheck` passed after generating the fresh Nuxt metadata.
- `pnpm run fallow:all` passed, including duplication regression.
- `node scripts/architecture/boundary-check.mjs --scope=focused` passed.
- `node scripts/run-all-gates.mjs --only validate` completed coverage with 1,158 files and 10,084 tests, but recorded one unrelated 5-second timeout in `pdfOutlineToolbarState.test.ts`; its type-coverage ratchets passed. The coordinator's full lint child then stopped progressing under shared-host saturation, so the wrapper was stopped and the gate is recorded as non-green. The failed file rerun alone passed 8/8 tests.
- CodeRabbit `coderabbit review --agent --base main` was rate-limited because the account had exhausted its included reviews. No paid capacity was requested.

## Platform boundary

macOS clone behavior and `/var` versus `/private/var` alias coverage are out of
scope for this Linux lane. The macOS acceptance remains open for its owning
platform lane.
