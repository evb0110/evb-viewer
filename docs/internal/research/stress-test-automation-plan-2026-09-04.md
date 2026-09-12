# Stress-test automation plan for EVB Viewer

Date: 2026-09-04. Repository baseline: `f39a0e2d6fcb3610f96fcde81496a9dc5108483d`.

Audience: the EVB Viewer maintainer and whoever runs or extends the stress lane.

Status: research plus a first implementation. The harness, fixtures, host profiles, operator loop, oracles, baselines and replay tool described in sections 4 through 9 exist under `scripts/stress/` and are unit tested. The per-profile baseline files live under `docs/internal/benchmarks/stress/` and are committed; run artifacts go to the ignored `.devkit/stress/runs/` directory. No stress run has executed yet. The baseline files hold no scenario entries on purpose and get filled by the first accepted run on each profile.

Tracking: the [implementation ledger](stress-test-automation-implementation-ledger-2026-09-04.md) records package state, closure gates and evidence. This plan is the design reference; status changes belong in the ledger.

Read sections 1 and 10 for the decision and how to run it. Sections 5 and 6 define the model operator and the slow-host profiles. Section 8 is the failure-mode catalogue that oracles are built against.

[Decision](#1-decision) · [What exists](#2-what-the-repository-already-had) · [Gaps](#3-gaps-the-lane-fills) · [Fixtures](#4-fixture-design) · [Operator](#5-model-driven-operator) · [Host profiles](#6-slow-and-legacy-host-emulation) · [Measurement](#7-measurement-and-oracles) · [Failure modes](#8-failure-mode-catalogue) · [Budgets and artifacts](#9-budgets-artifacts-and-baselines) · [Runbook](#10-runbook) · [Open questions](#11-open-questions-and-evidence-gaps) · [Sources](#12-research-sources-and-review-record)

## 1. Decision

Yes, the app can be stress-tested with automation and a cheaper model as the operator, and the pieces to do it now exist in the repository. Three choices shape the design.

**Two scenario kinds, one harness.** Deterministic scenarios replay scripted steps through the automation session the E2E lane already uses. Operator scenarios hand a task card to a model that drives the app. Both produce the same result record, run under the same metrics sampler, and are judged by the same oracles. The deterministic kind gives repeatable numbers for regression tracking. The operator kind produces the messy interaction patterns a script never does, such as clicking during a load, scrolling while a tab switches, or retrying a control that did not respond.

**Sonnet 5 as the default operator, not Haiku.** The request asked for "a dumber model that has very good computer use capabilities". The current computer-use documentation lists no Haiku model as supported, so the cheapest model that can drive the Anthropic computer toolset is Claude Sonnet 5 at 2 USD per million input tokens and 10 USD per million output tokens. Haiku 4.5 still has a place. The harness has a second operator profile, `semantic`, that uses plain JSON tools addressing DOM controls by id, and any model can drive it. The runner refuses the `pixel` profile for a model without computer use so a run cannot silently downgrade.

**Perceive and act through the DevTools protocol, not the operating system.** Puppeteer already attaches to Electron over `--remote-debugging-port`. Screenshots, clicks, keys and scrolls all go through that channel, so the harness works headless, works on CI, and never depends on window placement or the host's input focus. Native dialogs are bypassed the same way the E2E lane bypasses them: `open_document` goes through the app's programmatic open path with an allowlist of fixture paths.

### What was built

1. Fixture generator with a spec hash, so fixtures regenerate when their definition changes and never otherwise.
2. Six host profiles with a calibration probe that measures whether the constraint actually took effect. A profile that misses its floor stops the run.
3. Nine deterministic scenarios and five operator scenarios covering extra-large files, page storms, annotation density, deep outlines, tab pressure, save loops, corrupt files, DjVu and scanned pages.
4. A metrics sampler for process-tree RSS, JS heap, main-thread and worker heartbeats, long tasks and frame gaps.
5. An operator loop over the raw Messages API with screenshot pruning, a freeze detector, cost accounting and four independent halts.
6. Twenty oracles that turn the evidence into findings with severity, plus per-profile baselines with a tolerance model.
7. A replay tool that turns an operator's action log into a deterministic reproduction.

## 2. What the repository already had

The inventory stream of the research (`01-inventory.md`, see section 12) mapped what a stress lane could reuse. The most useful pieces, all reused unchanged:

| Mechanism | Where | Used for |
| --- | --- | --- |
| Automation session lifecycle over CDP | `scripts/electron-run/` | Every stress session, including calibration and replay |
| Programmatic open by path with an allowlist | `openPathCapabilities`, `EVB_ALLOWED_OPEN_PATHS` | `open_document` for both scenario kinds |
| Renderer test API and workspace helpers | `tests/e2e/electron/helpers/` | App state, viewer commands, tab and split control |
| Sparse 513 MiB PDF generator | `scripts/generate-large-pdf-e2e-fixture.mjs` | Pattern for the extra-large fixture |
| E2E fixture cache with the 431-page scanned PDF and DjVu rules | `tests/e2e/electron/helpers/fixtures.ts` | Two fixtures reused instead of regenerated |
| Host tier override | `EVB_TEST_PERFORMANCE_MODE` | The `forced-low` profile |
| macOS `--disable-gpu` under automation | `electronRunLaunchConfig.ts` | Recorded by calibration, left in place |
| Process tree enumeration and leak detection | `electronRunProcessTree.ts` | `leaked-process` oracle |
| Deadline wrapper for E2E sessions | `runWithElectronE2EDeadline` | Deterministic scenario deadline |

Two existing lanes are the nearest neighbours: `e2e-xlarge-pdf` and the `pdfTabPressure` diagnostic. Both measure one thing well inside one test file. Neither exports a sampler, drives an operator, or emulates a slow host.

## 3. Gaps the lane fills

The inventory listed seventeen gaps. The ones this implementation closes:

- No throttling levers. Nothing called `Emulation.setCPUThrottlingRate` or passed extra Chromium switches through automation. Both now exist, the latter through `EVB_AUTOMATION_EXTRA_CHROMIUM_SWITCHES`, which accepts only `--switch` tokens so a stray path can never become a positional argument.
- No shared measurement library. The heartbeat, long-task, RSS and heap samplers lived as private functions inside one test file. `stressMetricsSampler.ts` is the exported version, and it samples the whole Electron process tree instead of one pid.
- No extra-large fixture generator beyond the sparse PDF. The fixture module adds a 4000-page text document, a 2000-annotation document, a 3000-bookmark outline and a truncated corrupt file.
- No operator scaffolding. The operator loop, tool contracts, budgets, action log and replay are new.
- No stress documentation home. This plan and its ledger follow the UTM pair.

Gaps left open on purpose are listed in section 11.

## 4. Fixture design

The fixture research stream was cut short by a rate limit before it wrote a report, so this section records the design decided in-session.

### Principles

Every fixture is either generated from code with a spec hash, or resolved from a cache the E2E lane already maintains. Nothing large is tracked in git. Generated fixtures live under `.devkit/stress/fixtures` with a manifest that records the spec hash, byte size and SHA-256 of each file. A fixture is reused only when its manifest record matches the current spec hash and generator version and the file still has the recorded size. Changing a fixture's page count or content invalidates it; reordering spec fields does not.

Scenarios that write declare `workingCopies`. The runner copies those fixtures into the scenario's `working/` directory before the session starts, and the `leaked-working-copy` oracle checks that the app leaves no temporary directories behind. Originals are never opened for writing.

### Catalogue

| Id | Content | Size | Exercises |
| --- | --- | --- | --- |
| `xlarge-sparse-513mib` | 431 text pages padded with a sparse hole to 513 MiB | 513 MiB on disk, near zero real blocks | The native-preview size threshold, range reads, first-page latency on a huge file |
| `many-pages-text-4000` | 4000 text pages | 6 MiB | Page virtualization, page-box navigation, search over a wide range |
| `dense-annotations-2000` | 200 pages with 10 embedded annotations each (Square, FreeText, Text) | 2 MiB | Annotation inventory, layer rendering, sidebar filtering |
| `deep-outline-3000` | 300 pages with a three-level outline of 3000 bookmarks | 1 MiB | Outline tree construction and navigation |
| `scanned-large-431` | 431 JPEG pages plus a 28 MiB attachment, reused from the E2E cache | 30 MiB | Raster-heavy rendering, memory per page |
| `text-small-12` | 12 text pages | 100 KiB | Control document for annotate and save flows |
| `corrupt-truncated` | `text-small-12` cut to 60 percent, so the xref and trailer are missing | 60 KiB | Open-error presentation, recovery without restart |
| `djvu-reference` | Tracked or corpus DjVu resolved through the E2E rules | varies | DjVu decode path under throttle |

The sparse extra-large fixture is deliberately easy to parse. It proves the size-threshold code paths, not parsing cost. Genuinely heavy inputs remain the operator-supplied Zaliznyak files that the CI staging script pins; they are not in the repository and section 11 records that gap.

### What was declined

A multi-GiB fixture with real content. Generating one takes minutes, costs real disk, and the sparse file already crosses every size threshold the app checks. A 1 GiB DjVu. No generator exists and the corpus rules already give the lane a real DjVu when one is present.

## 5. Model-driven operator

### Tool contract

The pixel profile sends the `computer_toolset_20260801` toolset with all seventeen members and executes each action through Puppeteer. Screenshots are 1280 by 800 at device scale factor 1, so screenshot pixels equal CSS pixels and no coordinate scaling is needed. Key chords use the xdotool vocabulary the toolset expects and are mapped to Puppeteer key names.

The semantic profile sends six custom JSON tools. `observe` lists visible controls with short ids and labels. `click`, `type_text`, `press_key`, `scroll` and `drag` act on those ids. Ids are invalidated by every state-changing call, so the model cannot act on a stale snapshot.

Both profiles share four tools. `open_document` opens a task-card path, waits for the first page or an open error, and rejects anything not on the allowlist. `wait_for_idle` blocks on the app's own busy flags. `app_state` returns page, zoom, tabs, dirty flag, readiness, visible dialogs and toasts as text, which is far cheaper than a screenshot and is what the operator is told to prefer for verification. `report` ends the task with an outcome of `completed`, `blocked` or `app_broken`, the steps the model verified on screen, and the slowest action it noticed.

### Prompting

The system prompt states nine rules. The ones that matter for stress work: never open Settings, never dismiss error dialogs, never save unless told, look before acting again, and report `app_broken` after three identical screenshots plus one `wait_for_idle`. The task card lists the goal, the numbered file paths, the numbered steps, the pace, the done condition, the turn budget and the prohibitions. Task cards for the five operator scenarios live in the registry beside the deterministic steps so the two kinds stay comparable.

### Loop and guards

The loop uses the raw Messages API rather than the Claude Agent SDK. The Agent SDK has no computer toolset type and spawns a Claude Code subprocess with a coding system prompt; it would fight the operator at every turn. The loop keeps the newest three screenshots and replaces older ones with a one-line note, which is where most of the token cost goes. Each turn executes at most four tool calls; extra calls get an error result. A freeze detector hashes every screenshot taken after a state-changing action and counts identical hashes in a row, so the first such screenshot is a streak of one. Three identical screenshots produce a major `ui-frozen` finding, five make it critical and halt the scenario; both limits derive from one exported constant.

Four halts are independent: turn count, scenario cost, run cost and wall clock. Cost comes from the `usage` block on every response with cache reads at 10 percent and cache writes at 125 percent of the input price. A model without a known price disables the cost halts and the summary says so; turn and time halts remain.

Every tool call becomes one line in `actions.jsonl` before it executes, with the app-state hash after it executes. That file is the input to replay.

## 6. Slow and legacy host emulation

A profile is a named record with a constraint set and a required calibration outcome. The calibration probe runs once per run in its own session: it measures a fixed CPU loop on the main thread and in a worker, requestAnimationFrame intervals, the V8 heap limit, a 64 MiB disk read, and the tier the app detected. It runs once unthrottled and once under the profile, and the ratio must fall inside the profile's band.

| Profile | Constraint | Calibration floor | Claims |
| --- | --- | --- | --- |
| `baseline` | none | ratio recorded only | reference numbers |
| `slow-a` | CDP throttle 4x, 1 GiB old space, one renderer process | main-thread ratio 3.0 to 5.5, heap limit under 1.25 GiB | slow renderer front end; not PDF.js worker, native tools or disk |
| `slow-a-gpu` | `slow-a` plus software compositing and rasterization | same as `slow-a` | the software-canvas clamp in the performance profile |
| `slow-b` | runner under `systemd-run --user --scope -p CPUQuota=100% -p MemoryMax=3G` | own `cpu.max` and `memory.max` parse to 1 CPU and 3 GiB within 10 percent | the whole process tree, including workers and native tools |
| `slow-c` | throttle 2x, no GPU compositing | ratio 1.6 to 2.8 | a hosted CI runner |
| `forced-low` | `EVB_TEST_PERFORMANCE_MODE=low` | app reports tier `low` | tier-branch coverage, never slow-host coverage |

Rate 4 is the value the viewport-lifecycle E2E test already survives with real navigation. Rate 50, used by one narrow interruption probe, is too aggressive for a whole suite. `slow-b` is the only profile that slows the PDF.js worker and the native tools, and it needs Linux with cgroup v2 delegated to the user slice; on macOS its host-wrapper check reports `constraint-not-effective` and the run stops. The research also proposed two virtual-machine profiles (a UTM Windows clone at 2 vCPU and 2 GiB, and a Linux guest at the same size). Those depend on the UTM plan's image and consent work and are recorded in the ledger as planned, not built.

A profile that fails calibration ends the run with verdict `failed` and no scenario results. A "passed" slow-host run on an unthrottled renderer would be read as coverage it never was.

## 7. Measurement and oracles

### Sampler

`stressMetricsSampler.ts` samples every 250 ms by default. It reads RSS for every process in the Electron tree, `performance.memory` in the renderer, a main-thread heartbeat timer and a worker heartbeat channel, `PerformanceObserver` long tasks, and requestAnimationFrame gaps. It also captures console errors, page errors and renderer crash events. The summary holds peak RSS with the pid that produced it, first and last heap, the largest heartbeat gap on each thread, long-task count and p95, frame-gap p95 and the dropped-frame ratio.

### Oracles

Every oracle is a pure function over the summary, the step records, the final app state, integrity checks, leaked pids, leaked working directories, crash reports and the freeze streak, so a unit test pins each threshold.

| Oracle | Fails the scenario | Trigger |
| --- | --- | --- |
| `renderer-crash`, `macos-crash-report` | yes, critical | crash event, or a `.ips` report for an app process written since the scenario started |
| `main-thread-unresponsive` | yes | heartbeat gap over 2 s; critical over 10 s |
| `peak-rss` | yes | over 3 GiB by default, 4 GiB for the tab-pressure scenario |
| `js-heap-growth` | yes | last heap minus first heap over 512 MiB |
| `step-failed`, `step-slow` | yes | a step threw, or exceeded 60 s (120 s for the extra-large open) |
| `saved-file-integrity` | yes | `qpdf --check` rejects a saved working copy |
| `saved-file-integrity-skipped` | no, info | `qpdf` is not installed so a saved copy went unverified |
| `ui-frozen` | yes | three identical screenshots in a row after state-changing actions (critical at five) |
| `leaked-process`, `leaked-working-copy` | yes | app processes alive after stop, or new temp work directories |
| `dialog-left-open` | yes | a dialog visible in the final app state |
| `operator-report` | yes on `app_broken` | the operator's own verdict; info when missing |
| `console-error`, `page-error` | no, minor | anything not on the allowlist (ResizeObserver loop, favicon) |
| long tasks, frame gaps | no, minor | p95 over 500 ms and 250 ms |
| `baseline-*` | regression yes | see section 9 |

## 8. Failure-mode catalogue

The failure-modes research stream was cut short by the same rate limit, so this catalogue was assembled in-session from the app's architecture notes, the E2E lane's history and the existing diagnostics. Each row names the scenario that provokes it and the oracle that catches it.

| Failure mode | Provoked by | Caught by |
| --- | --- | --- |
| Renderer out-of-memory on a huge document | `open-xlarge-sparse`, `op-xlarge-endurance` under the 1 GiB heap cap | `renderer-crash`, `peak-rss` |
| Main thread blocked by synchronous parsing or layout | `many-pages-navigation-storm`, `deep-outline-open` | `main-thread-unresponsive`, long tasks |
| Virtualization leaks pages on fast scrolling | wheel bursts in every navigation scenario | `js-heap-growth`, `peak-rss` |
| Annotation layer rebuilds on every scroll | `dense-annotations-scroll` | long tasks, `step-slow` |
| Tabs never release memory when inactive | `multi-tab-pressure` with the aggressive memory policy | `peak-rss` with the 4 GiB ceiling |
| Save corrupts the file or the incremental update | `annotate-save-loop`, `op-annotate-and-save` | `saved-file-integrity` |
| Undo and redo desynchronise from the document | `annotate-save-loop` undo, redo, save again | `saved-file-integrity`, `step-failed` |
| Corrupt file crashes the process instead of showing an error | `corrupt-open-recovery`, `op-corrupt-then-recover` | `renderer-crash`, `dialog-left-open`, operator report |
| Recovery after an error needs a restart | same two scenarios | `step-failed` on the second open |
| DjVu decode stalls under throttle | `djvu-open-navigate` | heartbeat, `step-slow` |
| Raster pages exhaust the GPU or software canvas | `scanned-large-scroll` on `slow-a-gpu` | frame gaps, `peak-rss` |
| Search over 4000 pages blocks the UI | search steps in the navigation storm | heartbeat, long tasks |
| App looks alive but stops repainting | any operator scenario | `ui-frozen` |
| Child processes outlive the session | every scenario | `leaked-process` |
| Temporary work directories accumulate | save scenarios | `leaked-working-copy` |
| Performance regresses without any crash | every deterministic scenario with a baseline | `baseline-regression` |
| Error dialog stays modal and traps the operator | operator scenarios | `dialog-left-open`, operator `blocked` |
| Slow-host profile silently not applied | every run | calibration gate |

Not covered here, on purpose: network failure (the app does not fetch documents), print paths (the UTM plan owns them), and packaged-binary behavior (the lane runs the built main bundle through the automation session, which cannot lower the tier of a packaged app).

## 9. Budgets, artifacts and baselines

### Budgets

| Scope | Turns | Cost | Time | Other |
| --- | --- | --- | --- | --- |
| Operator scenario | 40 | 2.50 USD | 12 min (15 for endurance) | 4 tool calls per turn, 3 screenshots kept |
| Deterministic scenario | n/a | 0 | 15 min | 120 s per step |
| Run | n/a | 40 USD | 3 h | scenarios past the cap are marked `skipped` |

A full operator run of five scenarios on Sonnet 5 costs at most 12.50 USD by construction and should cost far less in practice because screenshots are pruned.

### Artifacts

Every run writes `run.json`, `run.log` and `summary.md` under `.devkit/stress/runs/<timestamp>-<sha>-<profile>/`, and every scenario writes `manifest.json`, `metrics.jsonl`, `result.json`, plus `actions.jsonl` and `screenshots/` for operator scenarios. `run.json` is rewritten atomically after each scenario so an interrupted run still has partial evidence. The summary sorts findings by severity and lists calibration checks, per-scenario status, peak RSS, heartbeat gap, duration and operator spend.

### Baselines

`docs/internal/benchmarks/stress/<profile>.json` stores the last twenty accepted durations for the scenario total and for each step kind, with p50 and p95 computed from that window, plus the peak RSS ceiling and the heartbeat ceiling. A duration regresses only when it is both 25 percent and 150 ms slower than the stored p95, so a 10 ms jitter on a 20 ms step never fails; a stored p95 of zero falls back to the absolute rule alone. Improvements over 20 percent are recorded as info so a suspicious speedup is visible. `--update-baseline` is skipped with exit code 1 when the run verdict is not `passed`, the writer refuses any run with a failed scenario, and each update increments the iteration count so the first accepted run is distinguishable from the tenth. The baseline file is written through a temporary file and rename so an interrupted update cannot leave a half-written JSON. Calibration numbers are stored beside the timings with a declared 30 percent drift tolerance; enforcing that tolerance is open work, see section 11.

## 10. Runbook

### Before a run

1. `pnpm run stress -- --list` and confirm the profile, scenarios and fixtures you expect.
2. `pnpm run stress:fixtures` once; it exits non-zero when a cache-only fixture is missing, and the scenarios that need it will be skipped, not failed.
3. Export `ANTHROPIC_API_KEY` for operator scenarios. The runner refuses to start them without it. The key is never written to any artifact.
4. For `slow-b`, start the runner under the `systemd-run` prefix printed by `--list`.
5. `pnpm run stress -- --dry-run --profile <id>` to see the plan without launching Electron.

### Running

`pnpm run stress -- --kind deterministic --profile slow-a` is the regression run. `pnpm run stress -- --kind operator --profile slow-a --model claude-sonnet-5` is the operator run. `--calibrate-only` checks a profile on a new host in about a minute. Interrupting with Ctrl-C stops the active Electron session by its session name, writes `run.json` and exits 130.

### When a scenario fails

Read `summary.md` first. A `critical` finding means a crash; open the crash report path in the evidence. An `infra-failed` status means the harness, not the app, broke: the fixture was missing, the API returned an error, or the session did not start. For an operator failure, run `pnpm run stress:replay -- --actions <scenario>/actions.jsonl` to replay the same tool calls without a model. The first divergent app-state hash is where the reproduction starts.

### After a run

Runs live under `.devkit` and are not tracked. Keep `summary.md` and `result.json`; screenshots and metrics can go once the finding is filed. Update a baseline only from a green run on the same profile and host.

## 11. Open questions and evidence gaps

1. **No run has executed.** Every threshold in section 7 is a research-informed guess until the first `baseline` and `slow-a` runs produce distributions. Expect the heartbeat and long-task thresholds to need loosening under `slow-a`.
2. **The worker heartbeat depends on the app exposing a channel.** When it does not, the worker checks report `unverifiable` and only the main thread is measured.
3. **Genuinely heavy inputs are not in the repository.** The operator-supplied Zaliznyak files exercise parsing cost that the sparse fixture cannot. A `--fixture-dir` pointing at a local corpus is the intended extension.
4. **Virtual-machine profiles are unbuilt.** The Windows and Linux VM profiles from the slow-host research wait on the UTM plan's image and consent packages.
5. **CI has no stress job.** Every macOS lane is dispatch-only and the largest budget is 90 minutes. A stress workflow needs its own timeout and probably runs the deterministic kind only, since operator scenarios spend money.
6. **Semantic profile coverage is thinner than pixel.** `observe` lists buttons, inputs, tabs and links. Canvas-only regions have no ids, so a semantic operator cannot drag inside the page. That is acceptable for navigation and save flows and wrong for annotation placement.
7. **Calibration drift is stored but not enforced.** The baseline keeps the accepted profile's CPU-loop and disk-read timings and a 30 percent tolerance. Nothing compares a new run against them yet, so a host that got faster between baseline runs would not be flagged.
8. **Diagnostic buffers still overflow silently on a multi-hour run.** The console and DevTools ring buffers keep 400 and 1200 entries with no overflow counter. The sampler keeps its own error lists, which reduces but does not remove the gap.

## 12. Research sources and review record

### Method

Six research streams ran as Opus subagents against primary sources: the repository itself, the Anthropic SDK 0.122.0 type declarations in `node_modules`, the Chrome DevTools Protocol domain definitions, the Chromium switch list, systemd and cgroup v2 documentation, and the GitHub-hosted runner specifications. Four streams delivered reports under `.devkit/analysis/stress-research/`: inventory of reusable mechanisms (`01`), operator design (`03`), slow-host emulation (`04`), and metrics, oracles and reporting (`06`). Two streams, fixture design (`02`) and the failure-mode catalogue (`05`), stopped on an Opus rate limit before writing. Sections 4 and 8 of this plan cover those two topics from in-session reading of the fixture helpers, the E2E history and the architecture notes, and they carry less evidence than the other sections.

### Facts checked against sources

- Computer toolset type string, member list, and the absence of Haiku from the supported models: SDK 0.122.0 declarations and the computer-use documentation as of 2026-09-04.
- Prices per million tokens for Sonnet 5, Haiku 4.5, Opus 5 and Fable 5.1, and the cache multipliers: the pricing page as of the same date. They are pinned in `stressOperatorCost.ts` with the date.
- `Emulation.setCPUThrottlingRate` semantics and the existing rate-4 usage in the viewport-lifecycle test: CDP definitions and `prBlockingSmoke.e2e.test.ts`.
- `--js-flags=--max-old-space-size`, `--renderer-process-limit`, `--disable-gpu-compositing` and `--disable-gpu-rasterization`: the Chromium switch reference.
- `systemd-run --user --scope` with `CPUQuota` and `MemoryMax` needing cgroup v2 delegation: systemd documentation.
- Hosted runner sizes for the `slow-c` approximation: GitHub documentation.

### Verification of this implementation

Unit tests under `tests/unit/scripts/stress/` pin the CLI parser, host profiles, calibration bands and the calibration gate, fixture spec hashing and manifest parsing, the scenario registry invariants, the metrics summary, every oracle threshold, the report and baseline rules, cost accounting, screenshot pruning, the freeze detector, the halt policy, tool schemas, key-chord mapping, seeded randomness, app-state hashing and replay planning. The scripts typecheck and lint pass. No Electron session was launched while building this.
