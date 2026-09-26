# Local checks

Run the smallest check that can detect a defect in the change. Remove a check
when its value is unclear. Counts, quotas, source spelling, file layout, and
duplicated proof are not acceptance criteria. The default
Run the smallest direct package command that covers the change: `pnpm lint`,
`pnpm typecheck`, `pnpm run test:unit`, or a focused Vitest project/file.
CI selects platform and Electron lanes from the changed areas.

The pre-push hook runs the publication policy first, then `pnpm typecheck` only
when a pushed range includes TypeScript or Vue files. It reads the ref-update
lines once, so first pushes, force pushes, deletions, and multiple ref updates
use the push's actual ranges. It does not run unit tests.
For a rare deliberate bypass, set `EVB_SKIP_PRE_PUSH_VERIFICATION=1` for that
push. The attribution check still runs.

| Change | Useful checks |
| --- | --- |
| Documentation | Checks for the changed document or executable example |
| Ordinary test edit | The changed suite and relevant typing |
| App behavior | Affected lint, types, and behavior tests |
| Native behavior | Relevant Rust tests and lint, plus the affected boundary or platform proof |
| Build or packaging | Build and packaged-artifact checks that exercise the changed contract |

The native PDF integration tests run `qpdf`, `pdftotext` and `pdftoppm` from
`PATH` (CI installs `qpdf` and `poppler-utils`) and otherwise use the app's
bundled copies under `resources/`. On Windows, run
`pnpm.cmd fetch:runtime-binaries` once before
`cargo test --manifest-path native/Cargo.toml --workspace`.

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

Push CI has one required verdict, `ci.yml`'s `gates_ok`, described in
[the CI guide](./ci.md): lint, typecheck, unit tests, the Rust, build, native,
browser, scan-cleanup and landing jobs its changed areas select, and the
Electron E2E lanes as a Linux matrix, in about fifteen minutes. The release
cutter reads only this verdict. [ci-nightly.yml](../../.github/workflows/ci-nightly.yml)
reports the slow, large-fixture, second-platform and timing-budget checks and
never gates.

Routine CI runs the unit suite without coverage instrumentation. Coverage is an
optional diagnostic without percentage thresholds.

Every push to main runs `ci.yml` to completion; a newer push does not cancel
it. The changed-area classifier diffs from the last push whose run succeeded,
so lanes that an unfinished or failed run has not verified are selected again
by the next run.

### A red verdict

A red `gates_ok` has one owner: the commit that turned it red. Before
diagnosing anything, run:

```
node scripts/ci/ci-health.mjs --sha <sha>
```

It prints each job as `NEW` or `INHERITED` and names the
first bad SHA per failing job. When superseded runs hide where a job broke, it
lists the pushes the break could be in instead of one SHA. An `INHERITED` failure is another commit's
defect; do not re-diagnose it and do not treat it as a reason to stop pushing.
A `NEW` failure is fixed in the next commit or reverted. Neither case justifies
widening a tolerance, adding a retry, or marking a step `continue-on-error`.

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
  job. `--sha <sha>` answers the narrower question of whether this commit broke
  anything or inherited it.
- A failure that starts at one commit and repeats on every later run is a
  regression in that commit, not flake. Fix the product or the test.
- A `vi.mock` factory for a module under `app/` or `electron/` spreads
  `await importOriginal()` and overrides only what the test controls. A
  hand-written partial mock throws `No "<name>" export is defined on the mock`
  for every test of that module the moment the module gains an export, which
  breaks other writers' tests without touching them. Modules whose load starts
  workers, writes files, logs, or touches Electron main-process APIs stay
  wholesale mocks.
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

ESLint, Stylelint, TypeScript, and Vitest use their own caches. Avoid overlapping
dependency installation or shared-output rebuilds with tests that consume those
files.

## Explicit broad and release checks

Use `node scripts/run-all-gates.mjs` when complete local release verification
is required. It runs the direct lint, typecheck, unit, strict-build, bundle
integrity, Electron smoke, and release-verification commands in sequence.

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
