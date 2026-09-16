# CI guide

This page maps the checked-in GitHub Actions workflows to the checks they run.
Use it with [local gates](./local-gates.md) when deciding which local proof to
run before opening a pull request.

## Merge verdict

`ci.yml` runs on the selected pull-request events, pushes to `main` and the
integration-candidate branch patterns `*/integration` and
`t3code/*integration*`, and manual dispatch. It has no workflow-level path
filter. `pr_changed_areas` classifies changed files, so the affected-area jobs
can skip cleanly while the aggregate still checks the result.

`gates_ok` is the required aggregate for pull requests and pushes. Its `needs`
list currently contains these jobs:

`publication_policy`, `pr_quality`, `pr_changed_areas`,
`pr_electron_blocking_smoke`, `pr_packaged_linux`,
`pr_electron_native_save_reopen`, `pr_native_pdf_integration`,
`pr_windows_atomic_pdf_replacement`, `pr_browser_integration`,
`pr_native_build_safety`, `pr_scan_cleanup_heavy`, `pr_rust_tests_arm64`,
`pr_scan_cleanup_oracles`, `pr_landing_quality`,
`push_electron_e2e_build`,
`push_electron_e2e_regression`, `push_electron_e2e_save_pipeline`, and
`push_electron_e2e_rapid_navigation`.

The `pr_*` jobs run when the changed-area classifier selects their contract.
The shared macOS Electron build and the three `push_electron_e2e_*` jobs run on
pushes to `main`, pushes matching the integration-candidate patterns above,
and manual dispatch. They run on a pull request only when it carries the
`qualify-platform` label; other pull requests keep these jobs skipped. The
three suites download `electron-e2e-build-${{ github.run_id }}` and run with
`--no-build`, while each macOS job keeps its own isolated checkout and Electron
session state. Promote an integration candidate to `main` only after all
three suites pass on the candidate SHA. The `gates_ok` script knows which
conditional jobs may be skipped. A failure in an applicable job fails the
aggregate.

The classifier's path policy lives in
[`scripts/release/policy.mjs`](../../scripts/release/policy.mjs). Its CI areas
are summarized below. A changed workflow or composite action is included in
the native/build and scan-cleanup areas, and `setup-ci-env` is also included in
the landing and scan-cleanup areas.

| CI output | Path groups that select the job |
| --- | --- |
| `browser_integration` | `app/**`, `drizzle/**`, `packages/**`, `public/**`, `vendor/**`, scan-cleanup adapters/core, `server/**`, browser tests, shared test/config files, `package.json`, `pnpm-lock.yaml`, and patches |
| `electron_smoke` | App and Electron sources, Electron tests and runner scripts, packaging config, resources, PDF/vendor inputs, shared config, package metadata, and the native save dependency paths |
| `electron_save_reopen` | The native PDF save dependency paths defined in `NATIVE_PDF_SAVE_DEPENDENCY_PATHS` in the policy file |
| `packaged_smoke` | Release build workflows/actions, packaging config, native PDF operations, WASM and packaging scripts, packaged Electron tests, and package metadata |
| `native_or_build` | `.github/actions/**`, `.github/workflows/**`, build/native/resources/server sources, native and release scripts, WASM scripts, native integration tests, packaging config, and package metadata |
| `scan_cleanup_export` | CI setup/workflows, scan-cleanup and native sources, scan-cleanup diagnostics/scripts, native manifests, relevant tests, Rust metadata, and package metadata |
| `landing` | `landing/**`, shared contracts and i18n packages, `setup-ci-env`, workspace/package metadata, policy/classifier scripts, and workflows |

`pr_quality` and `pr_changed_areas` have no path filter and run for every pull
request or main push. `publication_policy` and `gates_ok` do the same for the
CI events described above.

The other workflows do not feed `ci.yml`'s `gates_ok`. Their jobs still block
the release or manual operation that calls them. For example,
`pr_packaged_linux` calls `build-target.yml`, so that reusable build is part of
the pull-request verdict through its caller.

## Runtime method

The times below were measured on 2026-09-13 with `gh run list` and
`gh run view --json jobs` against `evb0110/evb-viewer`. They are rounded median
wall-clock times from three recent successful runs where three samples were
available. Called workflows were measured through their parent workflow runs.
Skipped jobs do not contribute a sample. `n/a` means GitHub had no recent
successful run for that workflow, so the configured job timeout is shown
instead of inventing a runtime.

## Workflows and jobs

### `.github/workflows/ci.yml`

Triggers: selected `pull_request` events, pushes to `main` and the integration
candidate branch patterns, and `workflow_dispatch`. No path filter. The
changed-area classifier uses the repository's changed-file policy.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `publication_policy`, Publication Policy | Publication-policy checks for pull requests and pushes | Yes | 0.5 min |
| `pr_quality`, Quality Gates | Generated-file drift, changed-source lint, typecheck, unit tests, and release checks | Yes | 8 min |
| `pr_changed_areas`, Changed Area Detection | Selects the conditional browser, Electron, native, packaging, scan-cleanup, and landing jobs | Yes | 0.6 min |
| `pr_electron_blocking_smoke`, Electron Blocking Smoke | Electron smoke for changes selected by the Electron smoke policy | Yes, conditional | 10 min |
| `pr_packaged_linux`, Packaged Linux Proof | Linux packaged-app proof through `build-target.yml` | Yes, conditional | 17 min |
| `pr_electron_native_save_reopen`, Electron Native Save And Reopen | Native save and fresh-process reopen behavior | Yes, conditional | 13 min |
| `pr_native_pdf_integration`, Native PDF Save Integration | Native PDF save integration | Yes, conditional | 4 min |
| `pr_windows_atomic_pdf_replacement`, Windows Atomic PDF Replacement | Windows filesystem replacement behavior | Yes, conditional | 2 min |
| `pr_browser_integration`, Browser Integration | Browser integration tests for selected browser changes | Yes, conditional | 2.5 min |
| `pr_native_build_safety`, Native And Build Safety | Rust tests, native safety, WASM freshness, strict build, and packaged static integrity | Yes, conditional | 17 min |
| `pr_scan_cleanup_heavy`, Scan Cleanup Heavy Gates | Canonical scan-cleanup identity gate | Yes, conditional | 9 min |
| `pr_rust_tests_arm64`, Rust Tests (Linux arm64) | Rust workspace tests on Linux ARM64 | Yes, conditional | 7 min |
| `pr_scan_cleanup_oracles`, Scan Cleanup Export Oracles | Scan-cleanup preview, export, and word-loss oracles | Yes, conditional | 3 min |
| `pr_landing_quality`, Landing Quality Gates For Changed Sources | Landing lint, typecheck, and build | Yes, conditional | 2 min |
| `gates_ok`, gates_ok | Required aggregate for pull-request, integration-candidate-push, and main-push CI verdicts | N/A | seconds |
| `push_electron_e2e_build`, macOS Electron E2E Shared Build | Builds the shared Electron bundle plus pdf-image-combine, pdf-page-ops, and scan-cleanup outputs | Yes for main/integration candidates and labelled PRs | n/a, 60 min timeout |
| `push_electron_e2e_regression`, Electron E2E Regression | macOS regression suite using the shared build | Yes for main/integration candidates and labelled PRs, manual | n/a in recent sampled push runs |
| `push_electron_e2e_save_pipeline`, Electron E2E Save Pipeline | macOS save pipeline suite using the shared build | Yes for main/integration candidates and labelled PRs, manual | n/a in recent sampled push runs |
| `push_electron_e2e_rapid_navigation`, Electron E2E Rapid Navigation | macOS rapid-navigation suite using the shared build | Yes for main/integration candidates and labelled PRs, manual | n/a in recent sampled push runs |
| `nightly_rust_fuzz`, Native Parser Fuzz Canaries | Manual parser fuzz canaries | No | n/a, 20 min timeout |
| `nightly_electron_e2e_large_pdf`, Manual Electron E2E Large PDF | Manual large-PDF Electron acceptance | No | n/a, 90 min timeout |
| `nightly_electron_e2e_quarantine`, Manual Electron E2E Quarantine | Manual quarantined Electron scenarios | No | n/a, 60 min timeout |
| `nightly_electron_e2e_visible_window`, Manual Electron E2E Visible Window | Manual visible-window lifecycle acceptance | No | n/a, 30 min timeout |

### `.github/workflows/build-target.yml`

Trigger: `workflow_call`. It is called by `build.yml`, `ci.yml`'s
`pr_packaged_linux`, `release-artifacts.yml`, and
`release-supplemental.yml`. It has no path filter.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `build`, `build (${{ inputs.os }}, ${{ inputs.platform }}, ${{ inputs.arch }})` | One release target's native tools, strict build, package, and artifact verification | Indirectly through `pr_packaged_linux` for CI; no for release callers | 15-38 min, target-dependent |

### `.github/workflows/build.yml`

Trigger: `workflow_call`, called by `release.yml` and
`release-artifacts.yml`. Its matrix covers macOS ARM64, Linux x64, Linux
ARM64, and Windows x64. It has no path filter.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `build`, `build (${{ matrix.os }}, ${{ matrix.platform }}, ${{ matrix.arch }})` | The four core release build targets | No, release workflow path | 15-28 min per target |

### `.github/workflows/build-mac-intel.yml`

Trigger: `workflow_call`, called by `release-artifacts.yml` and
`release-supplemental.yml`. It has no path filter.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `build_mac_intel`, `build (macos-15-intel, mac, x64)` | Supplemental macOS Intel package and native-tool verification | No, release workflow path | 28 min |

### `.github/workflows/build-win7-legacy.yml`

Trigger: manual `workflow_dispatch` only. It has no path filter. The workflow
is an optional Windows 7 packaging experiment and has no recent successful run
from which to calculate a runtime.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `build_win7_legacy`, `build (windows-2022, win7 legacy, x64)` | Optional Windows 7 legacy package and smoke checks | No | n/a, no successful sample |

### `.github/workflows/dependency-audit.yml`

Triggers: daily schedule (`40 4 * * *`) and `workflow_dispatch`. No path
filter. It reports advisory findings through its issue workflow rather than
the merge verdict.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `audit`, Audit dependencies | Dependency advisory and license checks | No | 1 min |

### `.github/workflows/perf-lane.yml`

Trigger: manual `workflow_dispatch` only. No path filter. GitHub has no recent
successful run for this workflow, so the table records its configured limits.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `build`, Build Electron once | Shared Electron build for the large-document jobs | No | n/a, 30 min timeout |
| `large_pdf`, 882-page save and reopen | 882-page save and reopen performance acceptance | No | n/a, 60 min timeout |
| `xlarge_pdf`, 2646-page budget acceptance | 2646-page memory and budget acceptance | No | n/a, 90 min timeout |
| `report_failure`, Report failed performance lane | Opens the failure report when a performance job fails | No | n/a |

### `.github/workflows/process-safety-platform.yml`

Trigger: manual `workflow_dispatch` with the `acceptance` choice. No path
filter. The `unix-cli` matrix runs on Ubuntu 24.04 and macOS 14. The
`project8-fixture` matrix is currently configured for Ubuntu 24.04.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `unix-cli`, CLI process safety (`${{ matrix.os }}`) | CLI process lifecycle tests on Unix platforms | No | 1-2 min |
| `windows-identity`, Windows process identity representation | Windows process identity and ancestry tests | No | 2 min |
| `host-protocol`, Windows host protocol acceptance (macOS) | Host lock, lease, coordinator, and stop protocol tests | No | 1-2 min |
| `project8-fixture`, Project 8 process proof (`${{ matrix.os }}`) | Project 8 process-proof fixture | No | 1-2 min |

### `.github/workflows/publish-chain.yml`

Trigger: `workflow_call`, called by `release.yml` and `release-drill.yml`. No
path filter.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `finalize`, Finalize immutable release assets | Validates and stages immutable release assets | No, release path | 1 min |
| `stage_mirror`, Stage release mirror | Stages the verified mirror publication | No, release path | 18 min, variable |
| `promote`, Promote verified release | Promotes the verified release channel | No, release path | 2 min |

### `.github/workflows/release-artifacts.yml`

Triggers: manual `workflow_dispatch` and daily schedule (`10 4 * * *`). No
path filter. This workflow packages artifacts without publishing a release.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `freshness`, Check main freshness | Scheduled-run freshness check | No | 0.5 min |
| `prepare`, Resolve Target | Resolves the exact commit and release inputs | No | 0.5 min |
| `quality`, Shared Quality Gates | Shared release quality checks when required | No | 3 min |
| `build_artifacts`, Package Release Artifacts | Core release matrix through `build.yml` | No, release path | 15-28 min per target |
| `build_win_arm64`, Package Supplemental Windows ARM64 Assets | Windows ARM64 supplemental package | No | 38 min |
| `build_mac_intel`, Package Release Artifacts / build (macos-15-intel, mac, x64) | macOS Intel supplemental package | No | 28 min |
| `build_store`, Package Microsoft Store AppX | Store x64 and ARM64 packages plus installed smoke | No | 22-35 min per package |
| `summarize`, Summarize Artifact Downloads | Confirms expected artifact downloads | No | seconds |

### `.github/workflows/release-drill.yml`

Triggers: manual dispatch, daily schedule (`17 3 * * *`), and pushes to
`main` that touch `.github/workflows/release*.yml`,
`.github/workflows/publish-chain.yml`, `.github/workflows/build-target.yml`,
`.github/workflows/build*.yml`, `.github/workflows/store-appx.yml`, or
`scripts/release/**`.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `seed`, Seed drill release | Creates the disposable draft release state | No | 1 min |
| `chain`, Run publish chain in drill mode | Runs the publish chain against draft assets | No, drill path | 3-5 min |
| `supplemental_drill`, Run supplemental attachment drill | Tests supplemental asset attachment in drill mode | No, drill path | 3-5 min |
| `supplemental_redispatch_drill`, Run supplemental attachment drill again | Repeats the supplemental attachment path | No, drill path | 3-5 min |
| `cleanup`, Clean up drill state | Removes disposable drill state after every outcome | No | 1 min |

### `.github/workflows/release-supplemental.yml`

Triggers: manual `workflow_dispatch` and `workflow_call`. No path filter.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `resolve`, Resolve supplemental release | Resolves the target release and existing assets | No, release path | 1 min |
| `release_credentials`, Validate supplemental release credentials | Checks public release credentials outside drill mode | No, release path | seconds |
| `build_win_arm64`, Package Supplemental Windows ARM64 Assets | Windows ARM64 supplemental package | No | 34 min |
| `build_mac_intel`, Package Supplemental macOS Intel Assets | macOS Intel supplemental package | No | 29 min |
| `publish_store`, Package Microsoft Store AppX | Store package matrix and installed smoke | No | 22-35 min per package |
| `attach_mac_intel`, Attach Supplemental macOS Intel Asset | Attaches the verified Intel artifact | No | 1 min |
| `attach_win_arm64`, Attach Supplemental Windows ARM64 Assets | Attaches the verified ARM64 artifact | No | 1 min |
| `mirror_supplemental`, Mirror supplemental assets | Mirrors supplemental artifacts | No | 1 min, variable |
| `summary`, Summarize supplemental release | Records the supplemental release result | No | seconds |

### `.github/workflows/release.yml`

Trigger: manual `workflow_dispatch` only. No path filter. This is the stable
release path, so its own completion job is the release verdict rather than
`ci.yml`'s `gates_ok`.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `prepare`, Resolve Target | Resolves and validates the requested release target | No, release path | 0.5 min |
| `release_credentials`, Validate Public Release Credentials | Checks credentials needed for public publication | No, release path | seconds |
| `build_artifacts`, Package Release Artifacts | Core release build matrix | No, release path | 15-28 min per target |
| `verify_packaged_scan_cleanup`, Verify packaged scan-cleanup (macOS arm64) | Packaged scan-cleanup proof | No, release path | 2 min |
| `publish`, Stage GitHub Release | Stages the GitHub release assets | No, release path | 2 min |
| `chain`, Publish verified release chain | Finalizes, mirrors, and promotes the release | No, release path | 4-42 min, mirror-dependent |
| `dispatch_supplemental`, Dispatch supplemental release | Starts the supplemental release workflow | No, release path | seconds |
| `release_complete`, Release complete | Aggregates the stable release result | No | seconds |

### `.github/workflows/store-appx.yml`

Trigger: `workflow_call`, called by `release-artifacts.yml`,
`release-supplemental.yml`, and their drill paths. No path filter.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `build`, `appx (${{ matrix.arch }})` | Store x64 and Windows ARM64 package builds | No, release path | 22 min x64, 35 min ARM64 |
| `installed_smoke`, `installed smoke (Windows 11 ARM64, ${{ matrix.arch }})` | Installed-package smoke for both architectures | No, release path | 7-9 min |

## Runtime samples

The measurements came from these successful runs:

- [CI push 34683428692](https://github.com/evb0110/evb-viewer/actions/runs/34683428692), [34678082034](https://github.com/evb0110/evb-viewer/actions/runs/34678082034), and [34656075112](https://github.com/evb0110/evb-viewer/actions/runs/34656075112)
- [Release artifacts 34683683587](https://github.com/evb0110/evb-viewer/actions/runs/34683683587), [34617444334](https://github.com/evb0110/evb-viewer/actions/runs/34617444334), and [34573886423](https://github.com/evb0110/evb-viewer/actions/runs/34573886423)
- [Release 34622226938](https://github.com/evb0110/evb-viewer/actions/runs/34622226938), [34578043307](https://github.com/evb0110/evb-viewer/actions/runs/34578043307), and [33950547119](https://github.com/evb0110/evb-viewer/actions/runs/33950547119)
- [Release drill 34747472829](https://github.com/evb0110/evb-viewer/actions/runs/34747472829), [34722968720](https://github.com/evb0110/evb-viewer/actions/runs/34722968720), and [34682024661](https://github.com/evb0110/evb-viewer/actions/runs/34682024661)
- [Supplemental release 34593941468](https://github.com/evb0110/evb-viewer/actions/runs/34593941468), [33928366620](https://github.com/evb0110/evb-viewer/actions/runs/33928366620), and [33924847859](https://github.com/evb0110/evb-viewer/actions/runs/33924847859)
- [Process safety 34339335417](https://github.com/evb0110/evb-viewer/actions/runs/34339335417), [34353904737](https://github.com/evb0110/evb-viewer/actions/runs/34353904737), and [34488079416](https://github.com/evb0110/evb-viewer/actions/runs/34488079416)
- [Dependency audit 34207997596](https://github.com/evb0110/evb-viewer/actions/runs/34207997596), [34107474199](https://github.com/evb0110/evb-viewer/actions/runs/34107474199), and [34023120328](https://github.com/evb0110/evb-viewer/actions/runs/34023120328)

No successful run was available for `perf-lane.yml` or
`build-win7-legacy.yml`. The reusable build workflow's direct successful runs
are older, so its current target runtimes use the newer release-artifact
parent runs above.
