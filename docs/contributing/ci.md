# CI guide

This page maps the checked-in GitHub Actions workflows to the checks they run.
Use it with [local gates](./local-gates.md) when deciding which local proof to
run before opening a pull request.

## Tiers

Push CI has three tiers. They differ in one thing: what a red job means.

| Tier | Workflow | Trigger | A red job means | Supersedes |
| --- | --- | --- | --- | --- |
| Required | `ci.yml` | PR, push to `main` and candidate branches, dispatch | This commit is broken. Fix or revert it. | Never on `main` |
| Extended | `ci-extended.yml` | PR, push to `main` and candidate branches, dispatch | The tip of `main` is broken somewhere. Fix it, but no commit is blocked. | Newer push cancels older run |
| Nightly | `ci-nightly.yml` | Daily 02:30 UTC, dispatch | Something slow and commit-independent broke. | No |

Place a check by three questions, in order.

1. **Defect relevance.** Does a failure here mean the commit that triggered it
   is wrong? If a failure is usually inherited, environmental, or about the
   tree rather than the change, it is not required.
2. **Diagnostic value.** Does knowing this per commit change what anyone does?
   A check whose answer is the same for a whole day belongs in nightly.
3. **Runtime.** The required tier answers in about twelve minutes. A check that
   cannot fit and is not the only proof of a shipping-critical property belongs
   in the extended tier.

Everything that is only style, policy shape, sub-pixel measurement, or
packaging tooling fails question 1 or 2 and does not belong in the required
tier, however cheap it is.

## Merge verdict

`ci.yml` is the required tier. It runs on the selected pull-request events,
pushes to `main` and the integration-candidate branch patterns `*/integration`
and `t3code/*integration*`, and manual dispatch. It has no workflow-level path
filter. `pr_changed_areas` classifies changed files, so the Electron smoke lane
can skip cleanly while the aggregate still checks the result.

`gates_ok` is the required aggregate for pull requests and pushes. Its `needs`
list contains `publication_policy`, `pr_quality`, `pr_changed_areas`, and
`pr_electron_blocking_smoke`. `gates_ok` and `Publication Policy` are the two
status contexts `main`'s branch protection requires, and they keep meaning
"the required set passed". No job outside `ci.yml` may carry either name.

The critical path is `pr_changed_areas` (about 0.6 min) then
`pr_electron_blocking_smoke` (about 10.8 min), with `pr_quality` (about 8.1
min) and `publication_policy` (about 0.5 min) in parallel, so a verdict lands
in about twelve minutes of wall clock plus runner queueing.

`pr_quality` lints the pushed range itself, not the last green base. A skipped
lane claims a proven base already covered it, so that base has to be green; a
lint run skips nothing, so a green base only widens its file list to code the
push never touched and fails the wrong commit for an error that already
existed. `ci-extended.yml`'s `extended_tree_lint` lints the whole tree on every
main push, so drift in untouched files is still reported, just never as this
commit's verdict.

### A red required set

The required set has one owner: the commit that turned it red. Run
`node scripts/ci/ci-health.mjs --sha <sha>` before diagnosing anything. It
prints each job as `NEW` or `INHERITED` and names the first bad SHA per failing
job. Do not re-diagnose an `INHERITED` failure; it is someone else's commit.
For a `NEW` failure, fix it in the next commit or revert the commit that caused
it. A red required set is not a reason to stop pushing, and it is never a
reason to widen a tolerance, add a retry, or mark a step `continue-on-error`.

### Extended tier

`ci-extended.yml` carries the browser integration suite, the native and
packaging lanes, the Linux packaged proof, the landing gates, the whole-tree
lint, and the three macOS Electron suites. Nothing there feeds `gates_ok`, so a
failure reports without blocking a commit. It does block a release: see
[release evidence](#release-evidence).

A newer push to `main` cancels an older in-progress first-attempt run. The tier
answers "is the tip of `main` sound", so re-proving a commit that `main` has
already moved past is wasted runner time. A rerun (attempt two and up) and a
`workflow_dispatch` run get their own concurrency group and always finish,
because those are requests for release evidence on one exact commit. A
dispatched run also ignores the changed-area classifier and executes every
lane. The required tier keeps its own exact-SHA run that is never cancelled.

The shared macOS Electron build and the three `push_electron_e2e_*` jobs run on
pushes to `main`, pushes matching the integration-candidate patterns above, and
manual dispatch. They run on a pull request only when it carries the
`qualify-platform` label. The three suites download
`electron-e2e-build-${{ github.run_id }}` and run with `--no-build`, while each
macOS job keeps its own isolated checkout and Electron session state. Promote
an integration candidate to `main` only after all three suites pass on the
candidate SHA.

`pr_packaged_linux` stays on this per-push tier rather than nightly: its job is
to prove the commit a release will be cut from, so a release is never the first
execution of its own packaged proof.

### Nightly tier

`ci-nightly.yml` carries the canonical scan-cleanup identity gate, the Linux
ARM64 Rust suite, and the parser fuzz canaries on a daily schedule, plus the
large-PDF, quarantine, and visible-window Electron lanes on manual dispatch
only. Those three need a local fixture profile or run quarantined scenarios, so
a scheduled red from them would teach everyone to ignore the workflow.

Nightly execution certifies nothing about a release. The release path runs its
own packaging and packaged verification for the exact target SHA through
`build.yml`, `build-target.yml`, and `release.yml`'s packaged proofs.

## Release evidence

Narrowing `gates_ok` narrowed what a green required run proves, so the release
path asks for the rest explicitly rather than by convention. A release
candidate must have, for its own SHA:

- a successful `ci.yml` push run with a green `gates_ok`, and
- a completed successful `ci-extended.yml` run.

`selectReleaseCandidate` skips any commit missing either one and walks back to
the newest that has both. Lanes the changed-area classifier skipped inside a
successful extended run count as success, exactly as they do for `gates_ok`.

Because the extended tier supersedes older first-attempt runs, many commits
carry a cancelled extended run, which is not a verdict. When the newest green
commit has no successful extended run, `assertExtendedCiGreen` names that
commit, its run, and the repair: `gh run rerun <id>` for a superseded run, or
`gh workflow run ci-extended.yml --ref main` while the candidate is the tip. A
rerun keeps the candidate's head SHA, so it is the repair that qualifies it.

`release.yml` waits on both tiers for its exact target:

```
node scripts/release/wait-for-exact-sha-ci.mjs <sha>                  # both tiers, the release default
node scripts/release/wait-for-exact-sha-ci.mjs <sha> --required-only  # ci.yml and gates_ok only
```

Use `--required-only` when you only want the verdict for a commit you just
pushed. A version-only release commit carries `[skip ci]` and has no run of its
own in either tier; its parent's runs vouch for it in both.

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
the release or manual operation that calls them.

## Runtime method

The times below were measured on 2026-09-13 with `gh run list` and
`gh run view --json jobs` against `evb0110/evb-viewer`. They are rounded median
wall-clock times from three recent successful runs where three samples were
available. The `ci.yml`, `ci-extended.yml`, and `ci-nightly.yml` figures are
median job minutes on `main` from a 500-run, 8-day sample taken on 2026-09-19,
measured before the tier split, so they describe the same jobs under their
former workflow. Called workflows were measured through their parent workflow
runs. Skipped jobs do not contribute a sample. `n/a` means GitHub had no recent
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
| `pr_quality`, Quality Gates | Generated-file drift, pushed-range lint, typecheck, unit tests, and the release fallback checks | Yes | 8 min |
| `pr_changed_areas`, Changed Area Detection | Selects the Electron smoke lane | Yes | 0.6 min |
| `pr_electron_blocking_smoke`, Electron Blocking Smoke | The one real Electron journey in the required tier | Yes, conditional | 10.8 min |
| `gates_ok`, gates_ok | Required aggregate for pull-request, integration-candidate-push, and main-push CI verdicts | N/A | seconds |

### `.github/workflows/ci-extended.yml`

Triggers: selected `pull_request` events, pushes to `main` and the integration
candidate branch patterns, and `workflow_dispatch`. A newer push cancels an
older in-progress run. No job feeds `gates_ok`.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `pr_changed_areas`, Changed Area Detection | Selects the conditional browser, Electron, native, packaging, scan-cleanup, and landing jobs | No | 0.6 min |
| `extended_tree_lint`, Tree Lint | Whole-tree lint, so an error in an untouched file is reported and attributed | No | 3 min |
| `pr_packaged_linux`, Packaged Linux Proof | Linux packaged-app proof through `build-target.yml` | No | 12.9 min |
| `pr_browser_integration`, Browser Integration | Browser integration tests for selected browser changes | No | 2.5 min |
| `pr_electron_native_save_reopen`, Electron Native Save And Reopen | Native save and fresh-process reopen behavior | No | 13 min |
| `pr_native_pdf_integration`, Native PDF Save Integration | Native PDF save integration | No | 4 min |
| `pr_windows_atomic_pdf_replacement`, Windows Atomic PDF Replacement | Windows filesystem replacement behavior | No | 2 min |
| `pr_native_build_safety`, Native And Build Safety | Rust tests, native safety, WASM freshness, strict build, and packaged static integrity | No | 17 min |
| `pr_scan_cleanup_oracles`, Scan Cleanup Export Oracles | Scan-cleanup preview, export, and word-loss oracles | No | 3 min |
| `pr_landing_quality`, Landing Quality Gates For Changed Sources | Landing lint, typecheck, and build | No | 2 min |
| `push_electron_e2e_build`, macOS Electron E2E Shared Build | Builds the shared Electron bundle plus pdf-image-combine, pdf-page-ops, and scan-cleanup outputs | No | 7.4 min |
| `push_electron_e2e_regression`, Electron E2E Regression | macOS regression suite using the shared build | No | 30.6 min |
| `push_electron_e2e_save_pipeline`, Electron E2E Save Pipeline | macOS save pipeline suite using the shared build | No | 10.9 min |
| `push_electron_e2e_rapid_navigation`, Electron E2E Rapid Navigation | macOS rapid-navigation suite using the shared build | No | 5 min |

### `.github/workflows/ci-nightly.yml`

Triggers: daily schedule (`30 2 * * *`) and `workflow_dispatch`. No job feeds
`gates_ok`, and nightly execution is not release evidence.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `nightly_scan_cleanup_heavy`, Scan Cleanup Heavy Gates | Canonical scan-cleanup identity gate | No | 9 min |
| `nightly_rust_tests_arm64`, Rust Tests (Linux arm64) | Rust workspace tests on Linux ARM64 | No | 7 min |
| `nightly_rust_fuzz`, Native Parser Fuzz Canaries | Parser fuzz canaries | No | n/a, 20 min timeout |
| `nightly_electron_e2e_large_pdf`, Manual Electron E2E Large PDF | Manual large-PDF Electron acceptance | No | n/a, 90 min timeout |
| `nightly_electron_e2e_quarantine`, Manual Electron E2E Quarantine | Manual quarantined Electron scenarios | No | n/a, 60 min timeout |
| `nightly_electron_e2e_visible_window`, Manual Electron E2E Visible Window | Manual visible-window lifecycle acceptance | No | n/a, 30 min timeout |

### `.github/workflows/build-target.yml`

Trigger: `workflow_call`. It is called by `build.yml`, `ci-extended.yml`'s
`pr_packaged_linux`, `release-artifacts.yml`, and
`release-supplemental.yml`. It has no path filter.

| Job ID and name | What it gates | `gates_ok` | Typical runtime |
| --- | --- | --- | ---: |
| `build`, `build (${{ inputs.os }}, ${{ inputs.platform }}, ${{ inputs.arch }})` | One release target's native tools, strict build, package, and artifact verification | No | 15-38 min, target-dependent |

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
