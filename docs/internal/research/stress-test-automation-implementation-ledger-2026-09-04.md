# Stress-test automation implementation ledger

Date: 2026-09-04

Source plan: [stress-test-automation-plan-2026-09-04.md](stress-test-automation-plan-2026-09-04.md).

Repository baseline: `f39a0e2d6fcb3610f96fcde81496a9dc5108483d`.

## Purpose

This ledger turns the plan into bounded packages with closure gates and
records their state. The first four packages have implementation commits and
unit tests but no run evidence, so they are in progress, not qualified. The
plan stays the design reference; status changes belong here.

## Baseline and publication boundary

- Planning baseline: `main` at `f39a0e2d6`, clean.
- The implementation adds `scripts/stress/`, `tests/unit/scripts/stress/`,
  six empty baselines under `docs/internal/benchmarks/stress/`, three package scripts,
  one automation environment variable in `scripts/electron-run/`, and the
  `@anthropic-ai/sdk` devDependency pinned to 0.122.0. Two transitive
  packages younger than the minimum release age were grandfathered in
  `pnpm-workspace.yaml` for that install.
- No Electron session was launched and no model was called while building.
  Nothing in `.devkit/stress/` exists yet.
- The Anthropic API key reaches the runner only through the environment.
  No artifact, log line or document may contain it.
- Implement each package directly on `main` under the repository rules.
  Ship runner code, registry entries, documentation and tests together.

## State vocabulary

| State | Meaning |
| --- | --- |
| Planned | Design and closure gates are concrete; no implementation commit exists. |
| Evidence first | Run the named experiment before writing more code. |
| Blocked | A recorded prerequisite failed or is unproven. Do not start. |
| In progress | An implementation commit exists but closure gates are incomplete. |
| Qualified | Every closure gate has linked evidence in this ledger. |
| Declined | Reviewed and rejected. Do not re-propose without new evidence. |
| Invariant | A safety property every package must preserve. |

## Invariants

| ID | Invariant | Plan section |
| --- | --- | --- |
| S1 | `scripts/stress/*` never imports `@app/*`. The architecture boundary check enforces it. | 2 |
| S2 | A slow-host profile whose calibration floor is not met produces no scenario results. The run verdict is `failed` and the summary names the failed check. | 6 |
| S3 | Operator scenarios halt on any of turn count, scenario cost, run cost or wall clock. A model without a known price disables only the cost halts and the summary says so. | 5, 9 |
| S4 | The operator may open only task-card paths, through `open_document`. Native open, save and print dialogs are never reachable. | 5 |
| S5 | Fixtures are never opened for writing. Scenarios that save work on copies under the run directory. | 4 |
| S6 | Cleanup is limited to the session's own process tree, identified by session name and pid. Nothing is killed by name. | 10 |
| S7 | `--update-baseline` refuses a run with any failed or infra-failed scenario, and the runner skips the update entirely when the run verdict is not `passed`. | 9 |
| S8 | Every run binds to git SHA, host profile, platform and calibration record. A result without those is not evidence. | 9 |
| S9 | The API key is read from the environment only and never written to any artifact. | 10 |

## Packages

### P1 harness, fixtures and host profiles

Status: In progress

Proposed location: `scripts/stress/stressFixtures.ts`, `stressHostProfiles.ts`,
`applyStressHostProfile.ts`, `stressSessionLifecycle.ts`, `stressCalibration.ts`.

Closure gates:

- [x] Fixture specs hash-invalidate on content change and survive field reordering (unit test).
- [x] Six profiles resolve, describe themselves, and pass extra Chromium switches only as `--switch` tokens (unit tests).
- [x] Calibration verdict bands pinned per profile, and the run gate blocks on a missed floor (unit tests).
- [ ] `pnpm run stress:fixtures` generates every generated fixture on this Mac and records sizes in the manifest.
- [ ] `pnpm run stress -- --calibrate-only --profile slow-a` reports `met` for renderer slowdown and heap limit on this Mac.
- [ ] `--calibrate-only --profile slow-b` on the Linux VPS reports the cgroup as verified.

### P2 deterministic scenarios and metrics

Status: In progress

Proposed location: `stressScenarioRegistry.ts`, `stressDeterministicDriver.ts`,
`stressMetricsSampler.ts`, `stressAppState.ts`.

Closure gates:

- [x] Nine deterministic scenarios with unique ids, declared fixtures and steps that only reference declared fixtures (unit test).
- [x] Metrics summary pins peak RSS with pid, heap first and last, heartbeat gaps, long-task p95 and dropped-frame ratio (unit test).
- [ ] `pnpm run stress -- --kind deterministic --profile baseline` completes with every scenario `passed` or `skipped` and no `infra-failed`.
- [ ] The same on `slow-a`, with thresholds adjusted from the observed distribution and the adjustments recorded here.
- [ ] Baselines for `baseline` and `slow-a` written with `--update-baseline` and committed.

### P3 oracles, report and baselines

Status: In progress

Proposed location: `stressOracles.ts`, `stressReport.ts`, `docs/internal/benchmarks/stress/`.

Closure gates:

- [x] Every oracle threshold and severity pinned (unit test).
- [x] Regression needs both percent and absolute slack; improvement is info; update refuses failures (unit tests).
- [x] `run.json` written atomically after every scenario.
- [ ] One deliberate regression (for example a 2x throttle on a `slow-a` baseline) produces exactly the expected `baseline-regression` findings.
- [ ] Calibration drift compared against the stored baseline calibration (plan section 11, item 7).

### P4 model operator and replay

Status: In progress

Proposed location: `runStressOperatorScenario.ts`, `stressOperatorToolExecutor.ts`,
`stressOperatorToolSchemas.ts`, `stressOperatorConversation.ts`,
`stressOperatorCost.ts`, `stressReplayDriver.ts`, `replayStress.ts`.

Closure gates:

- [x] Tool definitions for both profiles, system prompt and task card pinned (unit tests).
- [x] Screenshot pruning, freeze detector, halt policy, batch cap and cost ledger pinned (unit tests).
- [x] Replay plan drops interrupted and not-executed calls and carries state hashes (unit test).
- [ ] `op-corrupt-then-recover` on `baseline` with Sonnet 5 finishes with a `report` call under 2.50 USD, and the cost in `run.json` matches the console's usage view within 5 percent.
- [ ] `op-explore-many-pages` on `slow-a` with the semantic profile on Haiku 4.5 reaches page 2500 at least once in three attempts.
- [ ] `stress:replay` of a recorded `actions.jsonl` reports zero divergences on the same host.

### P5 CI stress job

Status: Planned

Depends on: P2 closure on `baseline`.

Closure gates:

- [ ] A dispatch-only workflow runs the deterministic kind on `slow-c` with its own timeout and uploads `summary.md` and `run.json`.
- [ ] Operator scenarios excluded from CI, or gated behind a secret and a manual input, and the spend cap documented.

### P6 virtual-machine profiles

Status: Blocked

Depends on: the UTM plan's M0a image and transport package.

Closure gates:

- [ ] A Linux guest at 2 vCPU and 2 GiB runs the headless entry point with `detectedTier === 'low'` and `totalRamBytes` under 2.5 GiB in calibration.
- [ ] The Windows clone profile follows once the UTM ledger's I1 identity checks exist.

## Initial scenario registry

| Id | Kind | Default profile | Fixtures |
| --- | --- | --- | --- |
| `open-xlarge-sparse` | deterministic | baseline | xlarge-sparse-513mib |
| `many-pages-navigation-storm` | deterministic | slow-a | many-pages-text-4000 |
| `dense-annotations-scroll` | deterministic | slow-a | dense-annotations-2000 |
| `deep-outline-open` | deterministic | slow-a | deep-outline-3000 |
| `multi-tab-pressure` | deterministic | slow-a | four fixtures, split view |
| `annotate-save-loop` | deterministic | slow-a | text-small-12 working copy |
| `corrupt-open-recovery` | deterministic | baseline | corrupt-truncated, text-small-12 |
| `djvu-open-navigate` | deterministic | slow-a | djvu-reference |
| `scanned-large-scroll` | deterministic | slow-a-gpu | scanned-large-431 |
| `op-explore-many-pages` | operator | slow-a | many-pages-text-4000 |
| `op-annotate-and-save` | operator | slow-a | text-small-12 working copy |
| `op-tab-juggle` | operator | slow-a | dense-annotations-2000, scanned-large-431 |
| `op-corrupt-then-recover` | operator | baseline | corrupt-truncated, text-small-12 |
| `op-xlarge-endurance` | operator | baseline | xlarge-sparse-513mib |

## Open questions

| Question | Owner package | Resolution path |
| --- | --- | --- |
| Are the 2 s heartbeat and 500 ms long-task thresholds survivable under `slow-a`? | P2 | First `slow-a` run; adjust and record. |
| Does the app expose a worker heartbeat channel the sampler can read? | P2 | If not, the worker checks stay `unverifiable` and the plan says so. |
| How much does a five-scenario operator run actually cost? | P4 | First operator run; compare `run.json` with the console. |
| Can the semantic profile place annotations without pixel access? | P4 | `op-annotate-and-save` on Haiku 4.5; if not, mark that scenario pixel-only. |
| Where do genuinely heavy corpora come from in CI? | P5 | A fixture-dir option pointing at a staged corpus, following `stageExactPdfFixture.ts`. |

## Declined proposals

| Proposal | Why declined |
| --- | --- |
| Haiku 4.5 as the pixel operator | No computer-use support in the current documentation. It drives the semantic profile instead. |
| Claude Agent SDK as the operator loop | No computer toolset type, a coding system prompt, and no access to the per-request tools array. |
| OS-level input (xdotool, AppleScript) instead of CDP | Depends on window placement and host focus; fails headless and on CI. |
| Multi-GiB fixture with real content tracked in git | Minutes to generate, real disk, and the sparse file already crosses every size threshold. |
| A single `vitest` project for stress | Scenarios run for up to 15 minutes each and spend money; a CLI runner with its own budgets fits better than a test project with a 90 s default timeout. |
| Failing the run on `unverifiable` calibration checks | A missing worker probe or absent cgroup files is a coverage gap, not a wrong result. Only `constraint-not-effective` and `constraint-excessive` block. |
| Sanitising images out of top-level transcript blocks (CodeRabbit pass 1) | Images only ever appear inside `tool_result` content, which the sanitiser already covers. |
| Documenting a `--` value rule for the CLI parser (CodeRabbit pass 1) | No option takes a value beginning with `--`; adding a rule would document a case that cannot occur. |
| Merging the run and replay CLI parsers (CodeRabbit pass 1) | The two option sets differ; a generic parser would hide which flags each command accepts. Revised 2026-09-05: the argv walk (`--flag=value` splitting and value lookahead) is now one shared helper because the duplicate-code gate flagged it, while each command keeps its own switch. |
| Rewriting the finding comparator (CodeRabbit pass 1) | Stylistic; the severity-rank subtraction is already stable and pinned by a test. |
| Closing the new tab when `open_document` fails in it (CodeRabbit pass 1) | The failure is reported to the operator and the extra tab is visible through `app_state`; closing it would hide state the scenario is meant to observe. |

## Plan verification record

- 2026-09-04: scripts typecheck (`tsconfig.scripts.json`, TypeScript 7.0.2 native) and `eslint` on `scripts/stress` and `tests/unit/scripts/stress` pass. The `unit-scripts` vitest project passes, including the package-script cap raised from 111 to 114 and the automation-args test for the new environment variable.
- 2026-09-04: while writing the README the runner was found to log a failed calibration and continue. That violated S2 and was fixed before the first commit; `calibrationBlocksStressRun` and its test pin the rule.
- 2026-09-04: CodeRabbit CLI pass 1 against `main` on the Mac returned 24 findings. Nineteen were applied: `ps` sampling made asynchronous, probe teardown on sampler stop, nullable worker and long-task gaps instead of `-1` sentinels, transcript and action streams closed in a `finally`, the interrupt handler stops whichever session is live, cgroup limits parsed and compared with the declared 1 CPU and 3 GiB, the wheel probe finalises on the same deadline check it reports, `--update-baseline` skipped on a non-passing verdict, baseline durations keep a twenty-sample history with real p50 and p95, a zero baseline p95 regresses on the absolute rule, the tool-call cap interpolated into the system prompt, per-entry error handling for crash reports, a three-state integrity result with an info finding for skipped checks, atomic baseline writes, tolerant `actions.jsonl` parsing, zoom regions clamped to the viewport, session cleanup when a profile fails to apply, the freeze streak counted from one with shared thresholds, and the replay tool reading its input once. Five were declined and are listed under declined proposals. Unit tests cover every applied change.
- 2026-09-04: CodeRabbit CLI pass 2 against `main` returned 12 findings, none caused by the pass-1 fixes. Ten were applied: the sampler's stop waits at most ten seconds for an in-flight sample, console and page error counts no longer stop at the fifty stored messages, a failed viewport or throttle setup detaches its CDP session, the freeze count in the system prompt comes from the shared constant, `qpdf --check` gets a five-minute timeout, replay records must carry an object `input` and a string-or-null toolset name, session stop logs instead of throwing when a kill fails, the README names which oracles fail a scenario and what slow-b reports on macOS, and the plan separates baseline files from run artifacts. Two repeated pass-1 declines (parser dedup, closing the tab after a failed open) stay declined.
- 2026-09-05: the first push to `main` (`b310848ce`) failed CI's Quality Gates job on two CI-only checks. The zero-execution coverage tripwire listed five stress files with no executed lines (`applyStressHostProfile`, `replayStress`, `runStress`, `runStressOperatorScenario`, `stressSessionLifecycle`), and the duplicate-code check flagged the two argv loops in `stressCliOptions`. Fix: both CLIs export their entry function (`runStress`, `replayStress`) and only self-invoke when tsx launched the file directly, the argv walk is one helper, and five new unit tests drive the runner, the replay CLI, the operator loop (canned Messages API responses through the injectable client), the session lifecycle, and the CDP profile application with mocked Electron and mocked tool execution. `pnpm run test:coverage` with the tripwire and `pnpm run fallow:dupes` were run locally before the second push.
- At the original implementation handoff, no stress run had executed. The 2026-09-05 takeover began the real Mac campaign; qualification still requires the per-package evidence above.

## Existing-agent operator correction, 2026-09-05

The original API-only operator did not match the requested workflow. The
runner now defaults to `--operator external`: the agent already running in
Codex or T3 uses its computer-use tools on a visible isolated session. The
runner publishes an exact session target and task card, samples metrics,
validates the operator report and evaluates the shared oracles. It makes no
model API calls. The pixel and semantic API drivers remain explicit options.

External reports carry a fresh request ID and a unique report filename. A
missing, malformed, stale or blocked report cannot pass. A confirmed renderer
crash remains an application failure even if the operator cannot report.
The runner marks the handoff closed after it ends. It cannot measure the
outer agent's turns, actions or subscription usage, and native computer-use
actions do not produce an API replay recording. Screenshots and chronological
operator notes provide the interaction evidence instead.

The documented `pnpm run stress -- ...` command also exposed a CLI defect:
the package manager forwards the leading separator. Both stress parsers now
accept it. The run entry point removes its signal listeners when it returns.
Scenario deadlines include setup and cannot extend beyond the remaining
whole-run budget. A timed-out deterministic step cancels its loop and skips
later steps so abandoned input cannot overlap the next action. Operator
cancellation stops further API requests and tools. Forced-low calibration
reads the effective app tier from the host bridge, not browser hardware hints.
The artifact field keeps its legacy name `detectedTier` for compatibility.

Use [the operator runbook](../stress-operator-runbook.md) for the corrected
campaign, including isolated targeting and per-scenario report submission.
Unrelated Electron processes and a missing Anthropic key are not blockers for
this workflow.

## Closure rule

A package moves to Qualified only when every closure gate links to a run
directory's `summary.md` and `run.json` recorded here with the git SHA and
profile. A rerun gets a new run id and never replaces a failed result.

Takeover validation: all 147 stress tests in 21 files pass, scoped scripts
typechecking and ESLint pass, and the duplicate-code gate passes. Three
CodeRabbit CLI passes completed; the third followed a new major deadline
finding in pass two. Review fixes include cancellation and validated screenshot
and action-log evidence. The Mac baseline and corrected slow-a deterministic
runs each finished with six passes and three failures. The remaining campaign
and visible operator acceptance are recorded in the local campaign report.
