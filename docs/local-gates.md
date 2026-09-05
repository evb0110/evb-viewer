# Local gates

How `pnpm validate` and its tiers are scheduled, what they cache, and how to
bypass the cache. Numbers are from an M3 Pro (11 cores, 36 GB) on
2026-09-01; see [Measured runs](#measured-runs).

## Tiers

| command | plan |
| --- | --- |
| `pnpm validate:iteration` | affected lint, typecheck, and related unit tests; falls back to full lint, typecheck, and unit tests when change impact is unknown |
| `pnpm validate` | the all-gates acceptance plan below |
| `pnpm validate:integration` | acceptance plus the affected Electron regression lane |
| `pnpm validate:nightly` | clean lint and typecheck, static checks, type coverage, coverage, duplicates, Rust tests, resource matrix, and the Electron quarantine lane |

The large-document Electron performance lane lives in
[`.github/workflows/perf-lane.yml`](../.github/workflows/perf-lane.yml). It runs on a
nightly schedule or by manual dispatch on Ubuntu 22.04. The 882-page save/reopen
lane and the 2,646-page budget lane download immutable assets from the dedicated
fixture repository and verify their manifest identities before staging them.

Those jobs are blocking within the performance workflow, but they do not gate
pushes or pull requests. The 882-page save deadline and the 2,646-page heartbeat
and renderer-heap budgets remain in their Electron specs. The workflow records
the xlarge save duration, largest heartbeat gap, and renderer heap delta in both
the step summary and a retained artifact. A failed run opens or updates one
tracking issue with the run URL.

`pnpm validate` runs `node scripts/validation-gates.mjs acceptance --all`.
Without `--all`, the acceptance tier builds an affected plan from the change
classification; `EVB_VALIDATE_ALL_GATES=1` is the environment equivalent.

## Acceptance plan

Stages form a dependency graph, not phases. `build.prepare` runs first because
it writes generated source; everything else becomes ready as soon as it
finishes. `build.strict` feeds `electron.bundle-integrity`, which feeds
`electron.blocking-smoke`. Nothing else waits on anything. That chain is the
longest path in the plan (about 120 s of build plus 60 to 90 s of Electron),
so `build.strict` has the highest priority after preparation.

| stage | script | weight | cacheable |
| --- | --- | ---: | --- |
| build.prepare | generate:build-artifacts | 1 | no |
| build.strict | build:strict | 2 | no (records a build marker) |
| native.test | test:rust | 4 | no |
| test.coverage | test:coverage | 5 | no |
| lint.full | lint (`lint:clean` with `--cold`) | 2 | yes |
| typecheck.coverage | typecheck:coverage | 2 | yes |
| native.lint | lint:rust | 2 | yes |
| typecheck.full | typecheck (`typecheck:clean` with `--cold`) | 1 | yes |
| fallow.dead-code | fallow | 1 | yes |
| fallow.dupes | fallow:dupes | 1 | yes |
| static.platform-report | check:static:reports | 1 | yes |
| static.web-deploy-source | check:static:assets --allow-dirty | 1 | yes |
| native.resource-matrix | check:resources:matrix | 1 | yes |
| electron.bundle-integrity | test:electron-bundle-static-integrity:no-build | 1 | no |
| electron.blocking-smoke | e2e-blocking-smoke (no build) | 3 | no |

### Scheduling

The pool admits stages by weight against `os.availableParallelism()` (11 on
the reference machine). `EVB_GATE_CAPACITY=<n>` overrides it when another
workload shares the machine. Ready stages launch highest priority first, then
heaviest first, so coverage, Rust tests, and the strict build start in the
first second instead of after a phase barrier. The cross-process
`acquireHeavyGate` coordinator still bounds concurrent sessions on one
machine; its default capacity follows the same core count.

A failing stage does not stop the run. Its transitive dependents are skipped
and every independent stage still finishes, so one pass lists every failure
instead of the first one. The final error names each failed stage and each
skipped dependent.

Weights only work if stages respect them. Cargo and vitest both default to
one job per logical core, which put an 11-job Rust compile and ten vitest
forks next to the Nuxt build, vue-tsc, and Electron. In the first measured
runs that slowed `unit-app` tests past their 5 s timeout and the blocking
smoke lane past its 30 s waits. The heavy stages therefore bound themselves:
`native.test` sets `CARGO_BUILD_JOBS=4` and `RUST_TEST_THREADS=4`,
`native.lint` sets `CARGO_BUILD_JOBS=2`, and `test.coverage` sets
`VITEST_MAX_WORKERS=6` (weight 5; a fork spends part of its time waiting on
I/O and coverage merging).

`test.coverage` runs the same zero-execution tripwire scope as push CI. CI
passes the push base and head; the local plan passes the merge base with
`origin/main` as `EVB_COVERAGE_BASE_SHA` and `WORKTREE` as
`EVB_COVERAGE_HEAD_SHA`, which covers committed, uncommitted, and untracked
production files. A changed production file with zero executed lines fails
the stage locally before it fails on `main`.

`check:static:assets` measures the tracked deploy source. The deploy script
requires a clean snapshot; the local gate passes `--allow-dirty` because an
uncommitted worktree measures the same tracked files.

### Stage cache

A cacheable stage is skipped when its input fingerprint equals the fingerprint
recorded at `stage-end` in a previous gate run that passed as a whole. The
fingerprint covers:

- the content of every file under the stage's input scope (for example lint
  hashes `app`, `electron`, `landing`, `packages`, `scripts`, `server`,
  `tests`, `.github`, the ESLint and stylelint configs, `nuxt.config.ts`,
  `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, and the vitest configs);
- missing paths, so a deleted input changes the key;
- the command, arguments, stage environment, and dependency list;
- Node, pnpm, and the tool packages the stage runs (ESLint, TypeScript,
  vue-tsc, type-coverage, fallow, cargo, rustc, and so on);
- platform, architecture, and the `CI`, `NODE_ENV`, `RUSTFLAGS`, `CARGO_*`,
  `NUXT_*`, and `VITE_*` environment values.

Build outputs are excluded by exact root path (`.devkit`, `.tmp`, `coverage`,
`dist-electron`, `nuxt-output`, `release`) or by name at any depth (`.git`,
`.nuxt`, `.output`, `node_modules`, `target`). `scripts/release` and
`tests/fixtures/release` are ordinary inputs. Large files are digested once per
process and reused by size and mtime, so the 830 MB `resources` tree costs
about one second per run, not one second per stage.

Stages that run tests or produce artifacts (`test.coverage`, `native.test`,
`build.strict`, the Electron stages) are never skipped.

Escapes:

- `pnpm validate -- --cold` uses `lint:clean` and `typecheck:clean`, which
  drop the ESLint and vue-tsc incremental caches.
- `node scripts/validation-gates.mjs acceptance --all --no-cache` (or
  `EVB_GATE_NO_CACHE=1`) runs every stage and also disables the incremental
  caches inside the lint and typecheck scripts.

ESLint and stylelint caches live under `.devkit/cache/eslint/<fingerprint>`;
the Nuxt typecheck cache under `.devkit/cache/typecheck`. Gate evidence is
written to `.devkit/analysis/gates/*.ndjson` with per-stage fingerprint,
weight, dependency, and cache fields.

### Strict-build marker

`build:strict` records `.devkit/cache/build/strict.json` after the build and
its warning check pass. The marker holds the build input fingerprint and the
size and mtime of every file under `dist-electron`, `nuxt-output`, and
`.tmp/native-build-manifest`. `release:verify:package:local` reuses the
build when the marker is fresh or a matching all-gates receipt exists, and
rebuilds otherwise.

## Type coverage and native tests

`typecheck:coverage` runs its four projects (app, electron, tests, scripts)
concurrently; each child must exit 0 and meet its floor. This took the stage
from 105 s sequential to 28 s.

`native/Cargo.toml` sets `[profile.test] opt-level = 1`. The scan-cleanup
library tests spend their time in image code, and at `opt-level = 0` that one
crate took 89 s of a 195 s native stage; at `opt-level = 1` the test body runs
in about 7 s. Debug assertions and overflow checks stay on. The browser WASM
fingerprint covers all of `native/`, so any edit to that manifest, including
a profile change, needs `node scripts/build-wasm-tool.mjs <family>` for
`pdf-image-combine` and `pdf-page-ops` and a commit of the re-stamped
`public/wasm` files, or `build:strict` reports stale artifacts.

## Release verification

`release:verify:checks` runs only what `pnpm validate` does not:
`check:drizzle-schema`, `check:electron:install`, and
`check:electron-builder:asar-unpack`. Pass `--scan-cleanup-identity` to add the
200-second canonical identity test, which CI runs on every push in
`pr_scan_cleanup_heavy`. `release:cut` runs no local gate at all; exact-SHA
push CI is the release authority (see [releasing.md](./releasing.md)).

## Measured runs

Full `pnpm validate` on the reference machine, same commit, nothing else
running:

| run | wall time | notes |
| --- | ---: | --- |
| before (2026-09-01 09:50 evidence) | 538 s | phase barriers, capacity 2, no stage cache, sequential type coverage |
| after, run 1 | 222 s | no warm evidence; every stage executed |
| after, run 2 | 192 s | unchanged inputs; 9 cacheable stages skipped |

The floor is now the two paths that never cache: `test.coverage` (170 to
186 s with six workers) and `build.strict` followed by
`electron.blocking-smoke` (about 70 s plus 120 to 130 s). Everything else
finishes inside that window. Cutting further means making coverage or the
Electron lane itself faster, not scheduling.
