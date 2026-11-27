# CI guide

This page maps the checked-in GitHub Actions workflows to the checks they run.
Use it with [local gates](./local-gates.md) when deciding which local proof to
run before opening a pull request.

## The required verdict

`ci.yml` is the one required CI verdict. Its `gates_ok` job aggregates every
job below; `gates_ok` and `Publication Policy` are the status contexts `main`'s
branch protection requires. A release is cut from a commit whose push run has a
green `gates_ok`, and nothing else gates a release.

It runs on the selected pull-request events, on pushes to `main` and the
integration-candidate patterns `*/integration` and `t3code/*integration*`, and
on manual dispatch. A push run on `main` always runs to completion. Jobs run in
parallel and the verdict lands in about fifteen minutes; see
[Runtime](#runtime).

| Job | What it checks | Runs when |
| --- | --- | --- |
| `publication_policy`, Publication Policy | Local-only artifacts, unexplained check infrastructure, flake tolerance and fix chains in the pushed range | Every PR and push |
| `changed_areas`, Changed Area Detection | Emits `selected` job IDs and Electron `lanes` from `scripts/ci/classify-changed-areas.mjs` | Always |
| `build_wasm`, Build Browser WASM | Restores or builds source-verified browser WASM and uploads `browser-wasm` | When `build_wasm` is in `selected` (any consumer selected) |
| `lint`, Lint | Generated-artifact drift, whole-tree lint, ASAR unpack list, web deploy sources, locale parity | When `lint` is in `selected` |
| `unit`, Typecheck And Unit Tests | `pnpm run typecheck`, `pnpm run test:unit` (downloads `browser-wasm`) | When `unit` is in `selected` |
| `rust`, Rust | `rustfmt`, clippy, `cargo-deny check bans licenses sources`, Rust tests, scan-cleanup catastrophe baseline | When `rust` is in `selected` |
| `strict_build`, Strict Build | `build:strict` and Electron bundle static integrity (downloads `browser-wasm`); sole Linux native builder, uploads `electron-e2e-build` | When `strict_build` is in `selected` |
| `native_pdf_integration`, Native PDF Save Integration | `native-integration` Vitest project against `strict_build`'s bundle | When `native_pdf_integration` is in `selected` |
| `windows_atomic_pdf_replacement`, Windows Atomic PDF Replacement | Real Windows filesystem replacement | When `windows_atomic_pdf_replacement` is in `selected` |
| `browser_integration`, Browser Integration | Browser integration suite in Chromium (depends on `build_wasm`, not `unit`) | When `browser_integration` is in `selected` |
| `scan_cleanup_oracles`, Scan Cleanup Export Oracles | Preview, export and word-loss oracles against `strict_build`'s bundle | When `scan_cleanup_oracles` is in `selected` |
| `landing`, Landing | Landing typecheck and build (root lint already lints it) | When `landing` is in `selected` |
| `electron_e2e`, Electron E2E (lane) | One Electron E2E lane per selected matrix entry on Linux; only smoke for an already proven tree | When `electron_e2e` is in `selected` |
| `gates_ok` | Every job succeeded, or was skipped because its ID is absent from `selected` | Always |

A dispatched run has no pushed range, so `publication_policy` is omitted from
`selected` and every gated job runs. `build_wasm` produces `browser-wasm` once
upstream for `unit`, `strict_build`, and `browser_integration`. `strict_build`
is the sole Linux native builder; `electron_e2e`, `native_pdf_integration`, and
`scan_cleanup_oracles` unpack its `electron-e2e-build` artifact.

Browser integration uses eight shards with one worker each. Vitest 5.0.5 assigns
equal file counts after sorting the SHA-1 hashes of root-relative file paths;
cached durations only order files inside a shard. Keep UI suites cohesive and
small enough to distribute their measured cost, sharing the lifecycle harness
in `tests/integration/browser/documentLifecycleTestHelpers.ts`. After moving or
adding a file, check all eight assignments and recent per-file CI timings.
`vitest list --shard` currently lists every file, so inspect the configured
sequencer's `shard()` result to see the actual assignment.

### Electron E2E lanes

A lane is a directory of `tests/e2e/electron`: `smoke/` is the project
`e2e-smoke`, and so on. When all lanes are selected, every directory except
`helpers/` and `nightly/` is one matrix job (`scripts/electron-e2e-lanes.mjs` lists
them), so a new test runs in CI by being saved in a lane directory, and a test
file outside one fails the run. Lanes are sized to finish in about ten minutes
on a hosted Linux runner; balance them by moving files. The tests run against
the production renderer in `nuxt-output/public`, the one the packaged app
loads, which Strict Build builds once per run. Run a lane locally
with `pnpm run test:e2e <lane>`, which builds first.

| Lane | Files |
| --- | --- |
| `e2e-smoke` | Blocking PDF save, OCR journey, startup, scan-cleanup toolbar, dialogs, DjVu print, performance profile |
| `e2e-viewer` | `viewerSmoke` |
| `e2e-annotations` | Annotation lifecycle, squiggly markup, stamp picker, interop acceptance |
| `e2e-markup` | Text-box interaction, annotation controls |
| `e2e-drawing` | Draw-shape lifecycle and stroke parity |
| `e2e-save` | Save pipeline, recovery close, compact page labels |
| `e2e-documents` | Native save and reopen, large-PDF open and virtualization, Recent files |
| `e2e-navigation` | Page navigation, fit modes, inactive tabs, fling handoff, viewer invariants, zoom menu |

Wall-clock budgets in these tests report a miss as a `[timing-budget]` log line
and fail only when `EVB_E2E_TIMING_BUDGETS=enforce`, which the nightly macOS run
sets. A budget on a shared hosted runner measures the runner as much as the
commit.

The baseline host for these budgets is the nightly run's GitHub-hosted
`macos-15` arm64 runner (3 CPU, 7 GB). A budget is a target on that runner:
it is enforced there, reported on the Ubuntu runners of the required verdict,
and reported on local and Windows verification hosts unless the run sets
`enforce`. For example, in `compactPageLabelsStructuralOperations`, rotating
page 2 of a three-page text PDF while Fit Width is active must paint the first
final-scale raster within 500 ms of the menu click on the baseline; that the
raster appears at the final zoom is checked on every host.

### A red verdict

A red `gates_ok` has one owner: the commit that turned it red. Run
`node scripts/ci/ci-health.mjs --sha <sha>` before diagnosing anything; it
prints each job as `NEW` or `INHERITED` and names the first bad SHA per failing
job. Fix a `NEW` failure in the next commit or revert the commit that caused it.
A red verdict is never a reason to widen a tolerance, add a retry, or mark a
step `continue-on-error`.

`node scripts/ci/ci-health.mjs --verdict-times [--days 7]` reports the median
and p90 minutes from a push to its verdict, the red share and the longest red
streak.

### Placing a check

A check belongs in `ci.yml` when its failure means the commit is wrong and it
fits the time budget. A check that is slow, needs a large fixture or another
platform, or measures wall-clock time belongs in `ci-nightly.yml`. New check
infrastructure (a workflow, job, lane, hook, CI script, lint rule, vitest
project or check script) or flake tolerance needs the owner's words in an
`Adds-Checks:` trailer; a test file in an existing lane needs no trailer. See
[local gates](./local-gates.md).

## Release evidence

`release:cut` picks the newest commit on `origin/main` whose `ci.yml` push run
has a green `gates_ok`. The tag-triggered `release.yml` waits for that
verdict on the tag commit before packaging:

```
node scripts/release/wait-for-exact-sha-ci.mjs [<commit-ish>]
```

The target defaults to `HEAD` and may be a short SHA, a branch name, or a full
SHA.

## Changed areas

The classifier and its path rules live in
[`scripts/ci/classify-changed-areas.mjs`](../../scripts/ci/classify-changed-areas.mjs).
It emits `selected` (JSON array of job IDs) and `lanes` (JSON array of Electron
E2E lane names). Every gated job checks whether its ID is in `selected`, and
`gates_ok` accepts `skipped` only for job IDs absent from `selected`. A push
diffs from the last push whose `ci.yml` run succeeded (resolved in one workflow
runs query by `scripts/ci/push-diff-base.sh`), so a lane that an unfinished or
failed run did not prove is selected again. A new ref with an empty or all-zero
`before` SHA fails open (`unavailable-push-base`).

A merge to `main` runs only the Electron smoke lane, with Build Browser WASM,
Strict Build, policy and classification, when four conditions hold:

- Its first parent is the pre-push commit, whose CI push run succeeded.
- The pull request head contains that pre-push commit.
- The merge tree equals the pull request head's tree.
- CI succeeded on that pull request head.

`scripts/ci/push-diff-base.sh` then prints the merged head as the diff base,
and the classifier selects only `publication_policy`, `build_wasm`,
`strict_build`, and `electron_e2e` (`["e2e-smoke"]`).

| Area or test scope | Paths | Extra jobs selected (beyond `lint`, `unit`, and `build_wasm` for consumers) |
| --- | --- | --- |
| `docs` | `docs/**`, `**/*.md`, `.husky/**`, workflows other than `ci.yml` | None |
| `landing` | `landing/**`, `packages/contracts/**`, `packages/i18n-core/**`, `packages/release-selection/**` | `landing`, `browser_integration` |
| `product` | `app/**`, `electron/**`, `packages/**`, `server/**`, `public/**`, `vendor/**`, `resources/**`, `build/**`, `types/**`, `nuxt.config.ts`, `electron-builder.yml`, `tests/fixtures/**`, `tests/helpers/**`, `tests/setup*.ts` | `build_wasm`, `strict_build`, all `electron_e2e` lanes, `native_pdf_integration`, `windows_atomic_pdf_replacement`, `browser_integration` |
| `native` | `native/**`, `.cargo/**`, `rust-toolchain.toml`, `packages/contracts/**`, `public/fonts/annotation/**`, `public/pdf/standard_fonts/**`, `tests/fixtures/electron/interop/**` | `rust`, all `product` jobs, `scan_cleanup_oracles` |
| `scan_cleanup` (additive) | `app/modules/scan-cleanup/**`, `packages/scan-cleanup/**`, `electron/features/scan-cleanup/**`, `scripts/scan-cleanup-*`, `scripts/scanCleanup*.ts`, `scripts/diagnostics/**`, `tests/unit/{scripts,electron}/scanCleanup*.test.ts`, `tests/fixtures/release/scan-cleanup-*`, `tests/fixtures/electron/test-scanned.pdf` | `scan_cleanup_oracles` (plus `strict_build` and `build_wasm`) |
| Electron lane tests | `tests/e2e/electron/<lane>/**` | `strict_build`, `electron_e2e` for `<lane>` only |
| Unit / nightly tests | `tests/unit/**`, `tests/e2e/electron/nightly/**` | None |
| Browser integration tests | `tests/integration/browser/**` | `build_wasm`, `browser_integration` |
| Native integration tests | `tests/integration/native/**` | `build_wasm`, `strict_build`, `native_pdf_integration`, `windows_atomic_pdf_replacement` |
| Unmatched (fail-open) | Anything else (`ci.yml`, `.github/actions/**`, `scripts/**`, `package.json`, `pnpm-lock.yaml`, root configs) | Every gated job and all Electron lanes |

## Nightly

`ci-nightly.yml` runs daily at 02:30 UTC and on dispatch. It reports and never
gates a commit or a release. A scheduled run keeps one open
`ci-nightly-failure` issue listing its failed jobs and closes it on the first
fully green run; dispatched runs do not touch the issue.

| Job | What it checks |
| --- | --- |
| Scan Cleanup Heavy Gates | Canonical scan-cleanup identity |
| Rust Tests (Linux arm64) | The Rust workspace on the second architecture |
| Native Parser Fuzz Canaries | Image, xref and JBIG2 fuzz targets, with cached cargo-fuzz and target builds |
| Public release mirror health | Current GitHub latest release, updater channel, mirror manifest and served asset |
| Electron E2E macOS Build and lanes | One macOS production build shared with the selected lanes, large-PDF and visible-window tests; ordinary lane timing budgets are enforced |
| Electron E2E Search Match Scroll | High-zoom native search over a generated large document |
| Electron E2E Large PDF | Large-PDF lane against generated fixtures |
| Electron E2E Visible Window | Visible-window lifecycle |

The ordinary macOS lanes run smoke Monday to Saturday and all eight lanes on
Sunday and manual dispatch. The producer shares its build with that run's
macOS consumers; large-PDF and visible-window tests still run nightly.
These also run hosted lanes under `tests/e2e/electron/nightly/`:
`e2e-search`, `e2e-large-pdf` and `e2e-visible-window`. The `e2e-exact-pdf` lane requires
the private fixture and runs only on a machine where that fixture is staged.

## Other workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `release.yml` | `v*` tags and dispatch | Five-target package matrix, draft validation, checksums, provenance, mirror transaction, final promotion |
| `store-appx.yml` | Dispatch only | Microsoft Store AppX packages for a release tag, uploaded by hand |
| `dependency-audit.yml` | Daily and dispatch | Full-graph JS and Rust (`cargo-deny check advisories`) advisory audits, reported as an issue |
| `process-safety-platform.yml` | Dispatch | Focused process-safety acceptance on Linux, macOS and Windows |

## Runtime

Measured on branch `arch/b2-ci-platforms` from dispatched runs that select
every job (`gh run view <id> --json jobs`); see the table in the change that
introduced this layout. A push that touches only one area runs fewer jobs.
