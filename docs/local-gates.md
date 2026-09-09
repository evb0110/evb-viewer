# Local checks

Run the smallest check that can detect a defect in the change. Remove a check
when its value is unclear. Counts, quotas, source spelling, file layout, and
duplicated proof are not acceptance criteria. The default
`pnpm validate` selects affected checks. Use `pnpm validate:iteration` while
editing and `pnpm validate:integration` when the change needs the affected
Electron regression lane. Preview or inspect the selected plan before an
expensive run when its scope is unclear.

Run `pnpm test:tooling` when editing `scripts/windows-test` or `scripts/stress`; it is not part of `pnpm test:unit`.

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

`scripts/check-commit-attribution.mjs` enforces this in the commit-msg hook,
the pre-push hook, and the CI attribution job. Deleting or editing a check
needs no trailer. Audit past additions with `git log --grep=Adds-Checks`.

## Routine CI

Each main push still gets CI and the `gates_ok` aggregate used by the release
cutter. Routine CI runs the unit suite without coverage instrumentation. Keeping the full
unit suite on main avoids missing filesystem and auto-import dependencies. Relevant
browser, Electron, native, and packaging lanes follow the changed areas.
Coverage is an optional diagnostic without percentage thresholds. See
[ci.yml](../.github/workflows/ci.yml) for the current selections.

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
[hidden-electron-automation.md](./agents/hidden-electron-automation.md). A hidden
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
