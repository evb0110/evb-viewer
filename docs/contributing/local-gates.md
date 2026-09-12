# Local checks

Run the smallest check that can detect a defect in the change. Remove a check
when its value is unclear. Counts, quotas, source spelling, file layout, and
duplicated proof are not acceptance criteria. The default
`pnpm validate` selects affected checks. Use `pnpm validate:iteration` while
editing and `pnpm validate:integration` when the change needs the affected
Electron regression lane. Preview or inspect the selected plan before an
expensive run when its scope is unclear.

Run `pnpm test:tooling` when editing `scripts/windows-test` or `scripts/stress`; it is not part of `pnpm test:unit`.

The pre-push hook checks commit attribution and runs the existing affected
typecheck plan for the commits being pushed. It reads the ref-update lines once
and passes them to both checks, so first pushes, force pushes, deletions, and
multiple ref updates use the push's actual range. It does not run unit tests.
For a rare deliberate bypass, set `EVB_SKIP_PRE_PUSH_VERIFICATION=1` for that
push. The attribution check still runs.

| Change | Useful checks |
| --- | --- |
| Documentation | Checks for the changed document or executable example |
| Ordinary test edit | The changed suite and relevant typing |
| App behavior | Affected lint, types, and behavior tests |
| Native behavior | Relevant Rust tests and lint, plus the affected boundary or platform proof |
| Build or packaging | Build and packaged-artifact checks that exercise the changed contract |

Unknown impact uses the planner's broader fallback. Shared test helpers,
fixtures, runners, compiler settings, and dependencies can affect consumers
beyond the edited file. A regression test should fail on the defect it claims
to detect. Keep observable assertions; avoid freezing source spelling or a
particular file layout.

## Adding a check

New checks are a deliberate decision, not a by-product of a task. A commit that
adds a test file, workflow, CI script, git hook, vitest project, package.json
check script, custom lint rule, or gate policy entry must carry an
`Adds-Checks:` trailer that quotes the request for it:

```
Cover Windows atomic replacement on a real filesystem

Adds-Checks: user asked for "a real Windows filesystem test for atomic save"
```

`scripts/check-publication-policy.mjs` enforces this in the commit-msg hook,
the pre-push hook, and the CI publication-policy job. Deleting or editing a check
needs no trailer. Audit past additions with `git log --grep=Adds-Checks`.

The same trailer covers flake tolerance. A test retry, a wall-clock sleep in a
test, a raised `testTimeout` or `hookTimeout`, a per-test timeout argument, an
`[INFRA]` retry marker, a `continue-on-error` step, a retried packaging step,
or a changed `timeout-minutes` needs the user's words too. See
[Flaky checks](#flaky-checks).

## Routine CI

Each main push still gets CI and the `gates_ok` aggregate used by the release
cutter. Routine CI runs the unit suite without coverage instrumentation. Keeping the full
unit suite on main avoids missing filesystem and auto-import dependencies. Relevant
browser, Electron, native, and packaging lanes follow the changed areas.
Coverage is an optional diagnostic without percentage thresholds. See
[ci.yml](../../.github/workflows/ci.yml) for the current selections.

Every push to main runs to completion; a newer push does not cancel it. The
changed-area classifier diffs from the last push whose run finished, so lanes
that an unfinished or hand-cancelled run has not verified are selected again
by the next run. A cancelled run is not a verdict: the release waiter accepts
a cancelled parent through a newer green run that contains it, or re-run it
with `gh run rerun <id>` when the exact commit needs its own verdict.

## Flaky checks

A check that fails without a related change is either broken or measuring
something nondeterministic. Both are defects in the check. Fix the cause or
delete the check. Do not add a retry, a sleep, a longer timeout, or
`continue-on-error` to make it pass; each of those hides the defect, slows
every run, and needs an `Adds-Checks:` trailer with the user's words.

- Diagnose from the run: `node scripts/ci/ci-health.mjs --days 7` lists
  failure and cancellation rates, commits whose reruns flipped between red and
  green, the jobs and steps that fail most, the slowest green jobs, and the
  first red commit, subject, run, and matching failure lines for each failing
  job.
- A failure that starts at one commit and repeats on every later run is a
  regression in that commit, not flake. Fix the product or the test.
- A `vi.mock` factory for a module under `app/` or `electron/` spreads
  `await importOriginal()` and overrides only what the test controls. A
  hand-written partial mock throws `No "<name>" export is defined on the mock`
  for every test of that module the moment the module gains an export, which
  breaks other writers' tests without touching them. Modules whose load starts
  workers, writes files, logs, or touches Electron main-process APIs stay
  wholesale mocks.
- An Electron E2E test with a named product or harness failure under
  investigation moves to `tests/e2e/electron/quarantine/` with its reason and
  expiry recorded in `graduation-policy.json`, and moves back when fixed.
- Deep-equality on large buffers, real sleeps, and shared fixtures under
  parallel writers are the usual causes of slow and unstable tests. Compare
  bytes with `Buffer#equals`, wait on events or `expect.poll`, and give each
  test its own temporary directory.

A failing behavior test needs diagnosis. A broken test or measurement needs
repair. Passing local tests do not establish behavior on an untested platform.
There are no source-line, test-file-length, assertion-count, or coverage quotas.
Type checking checks types; tests check behavior. Neither needs a second system
counting how its source was written.

## Reuse and parallel work

The existing validation runner schedules independent stages by weight.
`EVB_GATE_CAPACITY` can lower capacity when another workload shares the host.
Cross-process heavy-gate coordination prevents concurrent runs from consuming
the same capacity twice. Preserve the user's processes and other tasks' output
directories. Do not overlap dependency installation or shared-output rebuilds
with tests that consume those files.

Lint and typecheck caches use source, configuration, toolchain, and environment
fingerprints. Reuse successful evidence when its relevant inputs are unchanged.
Rerun affected checks after changing a dependency, a test helper, or a conflict
resolution. A new commit identifier alone does not require repeating every local
check. Tests and artifact-producing stages execute whenever their selected
plan runs.

`--cold` uses clean lint and typecheck caches. `--no-cache` disables stage reuse.
Use these to investigate cache behavior, not as routine extra acceptance runs.
Gate logs are under `.devkit/analysis/gates/` and include stage results and
elapsed time.

## Explicit broad and release checks

Use `node scripts/run-all-gates.mjs` when a complete local release verification
is actually required. It consolidates checks and reuses the validated strict
build during packaging. `node scripts/validation-gates.mjs acceptance --all`
selects its broad validation portion. These are deliberate selections, not the
default path for ordinary fixes.

Select stress, fuzz, exhaustive corpora, and platform commands for the risks they
exercise. Do not append every available suite to each release or repeat checks
already completed on the same artifact. Release commands and hosted evidence
requirements are documented in [releasing.md](./releasing.md).

Before any local Electron launch, follow
[hidden-electron-automation.md](../internal/agents/hidden-electron-automation.md). A hidden
macOS launch requires the verified copied app bundle and the shared launcher.

## Compiler and build boundaries

`pnpm typecheck` uses vue-tsc for the Nuxt app and Vue files, and the TypeScript 7
native compiler for the workspace projects. A diagnostic can occur in only one
of these checks. Identify the owning compiler before changing a type or option.

Strict desktop builds require the pinned Rust toolchain and
`wasm32-unknown-unknown`. They verify generated WASM fingerprints. A web-only
session can use the committed fallback artifacts; a release must use artifacts
that match its sources. The strict-build marker lets local packaging reuse an
unchanged validated build.
