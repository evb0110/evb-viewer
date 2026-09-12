# Stress lane

Runs EVB Viewer through extra-large documents, fast complex flows and slow-host
emulation, then judges the run with independent oracles. Two scenario kinds
share one harness. Deterministic scenarios replay scripted steps through the
existing automation session. Operator scenarios hand a task card to a model
that drives the app through screenshots or through semantic tools, so the
harness exercises the interaction patterns a scripted step never produces.

Design and status live in `docs/internal/research/stress-test-automation-plan-2026-09-04.md`
and the matching implementation ledger.

## Commands

```sh
pnpm run stress -- --list                       # scenarios, host profiles, fixtures
pnpm run stress:fixtures                        # generate fixtures into .devkit/stress/fixtures
pnpm run stress -- --dry-run --profile slow-a   # resolve the plan without Electron
pnpm run stress -- --kind deterministic --profile slow-a
pnpm run stress -- --scenario op-explore-many-pages --operator external
pnpm run stress -- --calibrate-only --profile slow-a
pnpm run stress -- --kind deterministic --update-baseline
pnpm run stress:replay -- --actions .devkit/stress/runs/<run-id>/op-tab-juggle/actions.jsonl
```

Both commands export their entry function (`runStress`, `replayStress`) as a
function of argv and only self-invoke when tsx launched the file directly, so
the unit tests under `tests/unit/scripts/stress` drive the whole CLI with a
mocked Electron session and mocked model responses.

`pnpm run stress` builds the Electron main bundle first, exactly like the E2E
lane. Operator scenarios default to `--operator external`. The existing agent
uses its installed computer-use tools. The runner makes no model API calls and
needs no API key. It does not select or launch a model for you.

Run the command as a background terminal task so the agent can operate the app
while the runner waits. Each `EXTERNAL OPERATOR READY` line names an
`operator-request.json`. Read its task card, resolve the exact session app,
perform the steps with computer use, then atomically write the requested JSON
report. The task card supplies the report shape, unique request ID, file paths,
PID, CDP endpoint and deadline. Repeat for each scenario until the runner exits.
The runner owns the visible session, sampling, host profile and teardown.

A missing, malformed, stale or blocked report fails the scenario. `app_broken`
is an application failure. Only a completed report plus passing oracles counts
as a pass. The report is operator testimony, not independent proof that every
requested interaction occurred. A completed report must reference a screenshot and an action log. The runner
checks that every evidence path names a nonempty regular file inside the
scenario directory. It cannot verify the truth of the reported actions.
Agent turns, actions and subscription usage are not measured by the runner.
Direct computer-use actions cannot be replayed by `stress:replay`.

The optional `--operator pixel` and `--operator semantic` modes explicitly use
the paid Anthropic API and require `ANTHROPIC_API_KEY`. Use them only when that
separate API workflow is intended. A missing key fails before Electron starts.
See [the operator instructions](../../docs/internal/stress-operator-runbook.md) for the
complete no-key campaign.

## Host profiles

| Profile | What it constrains | Verified by |
| --- | --- | --- |
| `baseline` | Nothing. Reference numbers. | Calibration records the ratio only. |
| `slow-a` | Renderer main thread throttled 4x through the DevTools protocol, 1 GiB V8 heap, one renderer process. | Renderer slowdown ratio inside 3.0 to 5.5, heap limit under 1.25 GiB. |
| `slow-a-gpu` | `slow-a` plus software compositing and rasterization. | Same as `slow-a`. |
| `slow-b` | Whole process tree under a Linux cgroup, one CPU and 3 GiB. | The runner's own `cpu.max` and `memory.max` match the declared 1 CPU and 3 GiB within 10 percent. On macOS the host-wrapper check reports `constraint-not-effective` and the run stops. |
| `slow-c` | 2x throttle and no GPU compositing, approximating a hosted CI runner. | Ratio inside 1.6 to 2.8. |
| `forced-low` | App tier forced to `low` through `EVB_TEST_PERFORMANCE_MODE`. | The app reports tier `low`. |

The profile runs a calibration probe before the first scenario. When a check
reports `constraint-not-effective` or `constraint-excessive`, or the probe
itself crashes, the run stops before any scenario with verdict `failed` and
the summary names the check, because a slow-host result that was not actually
slow proves nothing. `unverifiable` checks only warn. `slow-b` needs the runner itself started under `systemd-run` with the
prefix printed by `--list`.

## Scenario kinds

Deterministic scenarios are step lists in `stressScenarioRegistry.ts`. Steps
open fixtures by path, jump pages, fire wheel bursts, run viewer commands,
cycle tabs, split the view, add free-text notes, save, search, force garbage
collection and wait. Each step has a hard timeout and records its duration.

Operator scenarios pair a fixture set with a task card. External mode hands it
to the current agent. The optional API pixel profile gives
the model the Anthropic computer toolset and executes every action through
Puppeteer over the Chrome DevTools Protocol. The semantic profile gives a model
without computer use a small set of JSON tools (`observe`, `click`,
`type_text`, `press_key`, `scroll`, `drag`) that address controls by ids
collected from the DOM. Both profiles share `open_document`, `wait_for_idle`,
`app_state` and `report`.

API guards per scenario: 40 turns, 2.50 USD, 12 minutes, 4 tool calls per turn,
and a freeze halt once five screenshots in a row, each taken after a
state-changing action, are identical (the third already produces a `ui-frozen`
finding). Guards per run: 40 USD and 3 hours. Unknown model prices disable the
cost guards and say so in the summary. External mode enforces the scenario
deadline and watches for renderer crashes while the shared sampler records
responsiveness and memory. It does not enforce the outer agent's turn or cost
budget, or the API driver's screenshot freeze detector.

## Fixtures

Fixtures are generated on first use into `.devkit/stress/fixtures` and reused
while their spec hash matches. The sparse 513 MiB PDF is written with holes so
it costs almost no disk. The scanned 431-page fixture and the DjVu fixture come
from the E2E fixture cache and are skipped, not failed, when absent. Scenarios
that save work on copies under the run directory; the originals are never
touched.

## Run artifacts

```
.devkit/stress/runs/<timestamp>-<sha>-<profile>/
  run.json          run manifest, calibration, per-scenario results
  run.log           chronological log
  summary.md        human summary with findings sorted by severity
  <scenario>/
    manifest.json   scenario, profile, fixtures, working copies
    metrics.jsonl   process RSS, JS heap, heartbeat gaps, long tasks, frame gaps
    result.json     steps, findings, operator report
    operator-request.json  external session handoff, marked closed afterward
    operator-report-<id>.json  external agent report
    task-card.txt   scenario instructions and exact session target
    actions.jsonl   API operator tool calls with usage
    screenshots/    the operator's screenshots (operator scenarios)
    working/        copies of fixtures the scenario may modify
```

Oracles that fail a scenario (critical or major): `renderer-crash`,
`macos-crash-report`, `main-thread-unresponsive`, `peak-rss`,
`js-heap-growth`, `step-failed`, `saved-file-integrity`, `ui-frozen`,
`leaked-process`, `page-error`, `operator-report` when the operator reports
`app_broken`, and the `baseline-regression`, `baseline-rss-ceiling` and
`baseline-heartbeat` comparisons. Minor findings are recorded in the summary
but do not fail the scenario: `step-slow`, `leaked-working-copy`,
`dialog-left-open`, `console-error`, `long-task-p95` and `frame-gap-p95`. When
`qpdf` is not installed, saved copies get an info-level
`saved-file-integrity-skipped` finding instead of a silent pass.

## Baselines

`docs/internal/benchmarks/stress/<profile>.json` keeps the last twenty accepted
durations per scenario and step kind; p50 and p95 are computed from that
history, so one slow run does not become the new floor. A step regresses only
when it is both 25 percent and 150 ms slower than the baseline p95, so jitter
on a fast step never fails a run. A baseline p95 of zero fires on the absolute
rule alone. Pass `--update-baseline` after a fully green run to accept new
numbers; the runner skips the update and exits 1 when the run verdict is not
`passed`, and the writer refuses any run with a failed scenario.

## Replay

`stress:replay` reads an API operator `actions.jsonl`, replays the executed tool
calls in order without a model, and reports the first step whose app-state
hash diverges from the recording. Use it to turn an operator finding into a
deterministic reproduction before filing it.
