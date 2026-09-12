# Run the stress campaign with the current computer-use agent

Use the existing model session and its installed computer-use tools. No
Anthropic API key or separate model API is needed. Do not run a second stress
campaign concurrently. Leave unrelated apps and other agents' sessions alone.

Start in the repository root. Record the commit, OS and
`qpdf` availability. Check the working tree and active processes before any
install or build. Never install dependencies while another task launches
Electron from the same checkout. Background test/build activity can distort
calibration and performance baselines, even when its sessions are isolated.

```sh
pnpm exec tsx scripts/stress/runStress.ts --list
pnpm run stress:fixtures
pnpm run stress -- --dry-run --profile slow-a
```

Fixture generation reports availability per file. Record unavailable fixtures
and dependent scenario skips. Do not call a skipped scenario a pass. On macOS,
record `slow-b` as unsupported because it needs Linux cgroups.

Run these commands serially. For deterministic runs, wait for the runner and
leave its app untouched. For external runs, keep the terminal job running and
operate each session as described below.

```sh
pnpm run stress -- --kind deterministic --profile baseline --update-baseline
pnpm run stress -- --kind deterministic --profile slow-a --update-baseline
pnpm run stress -- --kind deterministic --profile slow-a-gpu --update-baseline
pnpm run stress -- --kind deterministic --profile slow-c --update-baseline
pnpm run stress -- --kind deterministic --profile forced-low --update-baseline
pnpm run stress -- --kind operator --profile slow-a --operator external
pnpm run stress -- --kind operator --profile baseline --operator external
```

For each `EXTERNAL OPERATOR READY` line:

1. Read the named request JSON and its task card. Confirm status is `waiting`.
2. Resolve the exact session with the command in the card. Select that app path
   or PID through computer use. Do not target an app merely named Electron.
3. Perform the task card with your computer-use tools. Open only its listed
   fixtures and save only its working copies. Use screenshots to verify results.
   If native targeting resolves another Electron instance, use the card's exact
   CDP endpoint. Pass `defaultViewport: null` to `puppeteer.connect` so the
   connection preserves the runner's viewport instead of applying 800 by 600.
   For file setup, use `openPdfInApp` or `triggerOpenPathInApp` from
   `tests/e2e/electron/helpers/viewerCore` on that page. Record the fallback, then
   use visible mouse and keyboard controls for the requested interactions. Do
   not send native input to an unverified window. CUA key names include `Return`
   and `Tab`, with combinations such as `super+o`. Puppeteer instead uses
   `keyboard.press('Enter')`; send chords with `keyboard.down('Meta')`, the key
   press and `keyboard.up('Meta')`, not `keyboard.press('Meta+A')`.
4. Save screenshots and a chronological action log in the scenario directory.
   Record bugs and incomplete steps honestly. Do not dismiss error dialogs to
   make the scenario look successful.
5. Reserve the final two minutes for verification and reporting. Do not wait for
   the runner to exit; it is waiting for the report. Before the deadline, write
   the report using the card's exact request ID and
   report path. Include screenshot and action-log paths in its `evidence` list.
   All evidence must be nonempty regular files within that scenario directory.
   Write to a temporary file and rename it atomically. Use
   `completed`, `blocked` or `app_broken` and list what you actually verified.
6. Stop acting on that session after submitting the report. The runner closes
   it, evaluates the oracles and announces the next session. Continue until the
   command exits, then read `summary.md` and `run.json`.

Do not send direct computer-use recordings to `stress:replay`. That command
accepts the API driver's structured action records. Document manual
reproduction steps for external findings instead.

A calibration failure means the requested host constraint was not established.
Retry that profile once after checking background load. If it fails again,
record the exact check and continue with the remaining profiles. Do not relax
calibration thresholds or accept baselines gathered under competing heavy load.
Baseline updates require a fully passing run. Leave baseline changes for review.

Write `.devkit/stress/REPORT-<date>.md` with the tested SHA and any working-tree
changes, environment and fixtures, a row per run with its exit code and
passed/failed/infra-failed/skipped totals, calibration results, and links to
artifacts. Include the exact findings for failures, operator reports and
screenshots, unsupported profiles, baseline changes and any surviving processes
owned by this campaign. Distinguish application failures from runner failures.
The runner makes no paid API calls in external mode; outer-agent usage is not
measured. Do not report an unrun or interrupted scenario as passed.
