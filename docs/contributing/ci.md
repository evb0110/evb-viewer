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
| `publication_policy`, Publication Policy | Local-only artifacts and unexplained checks in the pushed range | Every PR and push |
| `changed_areas`, Changed Area Detection | Selects the area-scoped jobs from `scripts/release/policy.mjs` | Always |
| `lint`, Lint | Generated-artifact drift, whole-tree lint, Drizzle schema, ASAR unpack list, web deploy sources | Always |
| `unit`, Typecheck And Unit Tests | `pnpm run typecheck`, `pnpm run test:unit` | Always |
| `rust`, Rust | `rustfmt`, clippy, `cargo-deny`, Rust tests, scan-cleanup catastrophe baseline | `native_or_build` |
| `strict_build`, Strict Build | Source-verified WASM, `build:strict`, Electron bundle static integrity | `native_or_build` |
| `native_pdf_integration`, Native PDF Save Integration | `native-integration` Vitest project against the built page-ops tool | `native_or_build` |
| `windows_atomic_pdf_replacement`, Windows Atomic PDF Replacement | Real Windows filesystem replacement | `electron_save_reopen` |
| `browser_integration`, Browser Integration | Browser integration suite in Chromium | `browser_integration` |
| `scan_cleanup_oracles`, Scan Cleanup Export Oracles | Preview, export and word-loss oracles | `scan_cleanup_export` |
| `landing`, Landing | Landing lint, typecheck and build | `landing` |
| `electron_e2e_build`, Electron E2E Build | Production renderer, Electron bundle and native tools, shared with every lane | `electron_smoke` |
| `electron_e2e`, Electron E2E (lane) | One Electron E2E lane per matrix job on Linux | `electron_smoke` |
| `gates_ok` | Every job succeeded, or was skipped because its area did not change | Always |

A dispatched run has no pushed range, so it skips the publication policy and
the classifier selects every job.

### Electron E2E lanes

A lane is a directory of `tests/e2e/electron`: `smoke/` is the project
`e2e-smoke`, and so on. Every directory except `helpers/` and `nightly/` is one
matrix job of the required verdict (`scripts/electron-e2e-lanes.mjs` lists
them), so a new test runs in CI by being saved in a lane directory, and a test
file outside one fails the run. Lanes are sized to finish in about ten minutes
on a hosted Linux runner; balance them by moving files. The tests run against
the production renderer in `nuxt-output/public`, the one the packaged app
loads, which the Electron E2E Build job builds once per run. Run a lane locally
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
platform, or measures wall-clock time belongs in `ci-nightly.yml`. New checks
need the owner's words in an `Adds-Checks:` trailer; see
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

The classifier's path policy lives in
[`scripts/release/policy.mjs`](../../scripts/release/policy.mjs). A push diffs
from the last push whose `ci.yml` run succeeded, so a lane that an unfinished
or failed run did not prove is selected again.

| Output | Path groups that select it |
| --- | --- |
| `browser_integration` | App, packages, public, vendor, server, browser tests, shared test and config files, package metadata |
| `electron_smoke` | App and Electron sources, Electron tests and runner scripts, packaging config, resources, PDF and vendor inputs, shared config, package metadata, native save paths |
| `electron_save_reopen` | `NATIVE_PDF_SAVE_DEPENDENCY_PATHS` |
| `native_or_build` | Actions and workflows, build, native, resources and server sources, native and release scripts, WASM scripts, native integration tests, packaging config, package metadata |
| `scan_cleanup_export` | CI setup and workflows, scan-cleanup and native sources, scan-cleanup scripts, Rust metadata, package metadata |
| `landing` | `landing/**`, shared contracts and i18n packages, `setup-ci-env`, workspace metadata, workflows |

## Nightly

`ci-nightly.yml` runs daily at 02:30 UTC and on dispatch. It reports and never
gates a commit or a release.

| Job | What it checks |
| --- | --- |
| Scan Cleanup Heavy Gates | Canonical scan-cleanup identity |
| Rust Tests (Linux arm64) | The Rust workspace on the second architecture |
| Native Parser Fuzz Canaries | Image, xref and JBIG2 fuzz targets |
| Electron E2E macOS (lane) | The `ci.yml` lanes on macOS with timing budgets enforced |
| Electron E2E Search Match Scroll | High-zoom native search over a generated large document |
| Manual Electron E2E Large PDF | Large-PDF lane against the local exact fixture (dispatch only) |
| Manual Electron E2E Visible Window | Visible-window lifecycle (dispatch only) |

These run the lanes under `tests/e2e/electron/nightly/`: `e2e-search`,
`e2e-large-pdf` and `e2e-visible-window`.

## Other workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `release.yml` | `v*` tags and dispatch | Five-target package matrix, draft validation, checksums, provenance, mirror transaction, final promotion |
| `store-appx.yml` | Dispatch only | Microsoft Store AppX packages for a release tag, uploaded by hand |
| `dependency-audit.yml` | Daily and dispatch | Advisory and license audit, reported as an issue |
| `process-safety-platform.yml` | Dispatch | Focused process-safety acceptance on Linux, macOS and Windows |

## Runtime

Measured on branch `arch/b2-ci-platforms` from dispatched runs that select
every job (`gh run view <id> --json jobs`); see the table in the change that
introduced this layout. A push that touches only one area runs fewer jobs.
