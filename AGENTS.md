# Agent rules for EVB Viewer

Rules for the automated workflow that builds this repository. Human
contributors start at [CONTRIBUTING.md](CONTRIBUTING.md); the engineering map
is [ARCHITECTURE.md](ARCHITECTURE.md).

Claude Code reads `CLAUDE.md`, which imports this file. There is one rulebook.

## Design

These decisions outrank convenience.

- Prefer deletion and reuse. Inline one-consumer abstractions rather than
  adding interfaces, ports, adapters, wrappers, barrels, or files.
- Give each piece of state and each lifecycle one owner. Derive other views
  instead of synchronizing duplicate containers.
- Validate only at trust boundaries. Reuse the contract schemas; do not add a
  second representation, clone, or validation pass inside the same process.
- Extend the shared platform, operation, progress, codec, scheduler, and test
  mechanisms in place instead of writing feature-local copies.
- Split a responsibility only when the new layer replaces the old one. State
  the removal condition for any temporary compatibility code.
- Test observable invariants with the shared harnesses, at most one real-app
  proof per scenario. Revert a failed approach instead of patching around it.

Background: [docs/architecture/design-charter.md](docs/architecture/design-charter.md)
and the decision records in [docs/architecture/adr/](docs/architecture/adr/).

## Checks

- Routine changes run the smallest affected checks. Add native, real-behavior,
  security, or platform proof only when the changed contract needs it. Releases
  use `run-all-gates`. Reuse evidence whose inputs and contracts are unchanged.
- Do not add a test file, CI job, workflow, npm check script, lint rule, vitest
  project, git hook, or validation stage unless the current request asked for
  it. Proof, acceptance, and evidence mean running the checks that already
  exist. Extend an existing test only when user-observable behavior changed and
  nothing covers it. The hooks and CI reject a commit that adds a check unless
  its message carries `Adds-Checks: <the words that asked for it>`. Deleting or
  editing a check needs no trailer.
- The same trailer covers flake tolerance. Do not add a retry, a wall-clock
  sleep, a raised timeout, or `continue-on-error` to make a check pass. Fix the
  cause or delete the check.
- Pick an independent reviewer for a non-trivial change only when it adds
  coverage. Documentation and test-only changes use affected checks.

## Publication

- An implementation request authorizes the change, a verified commit, and a
  direct push to `main`. Read-only diagnosis or review authorizes no writes.
- Create a branch, worktree, or pull request only when asked.
- For a requested pull request, write the body around intent, behavior, impact,
  invariants, and non-goals. Leave code mechanics to the diff.

## OCR

- Prioritize OCR quality and robustness over tool, language, or bundle-size
  constraints.
- Use `tessdata-best` models from the pinned `tesseract-ocr/tessdata_best`
  revision. Keep the language models and the canonical registry in sync.

## UI

- Use the design tokens in `app/assets/css/main.css`. No raw CSS values in
  components.
- Localize every UI string with `t()` and update the English and Russian
  message files in the same change.
- Register icons in `clientBundle.icons` in `nuxt.config.ts`.
- Read [docs/architecture/freetext-note-persistence.md](docs/architecture/freetext-note-persistence.md)
  before changing annotation serialization or note-window code.

## Electron automation

- Every Electron launch follows
  [docs/internal/agents/hidden-electron-automation.md](docs/internal/agents/hidden-electron-automation.md)
  and its shared packaged runner. A hidden macOS launch requires a verified
  `LSUIElement=true` in the bundle before startup. Environment flags and
  runtime Dock hiding cannot prevent a Dock flash on their own.
- Drive a resolved dev session over CDP. A generic `Electron` app name or the
  `com.github.Electron` bundle ID is not a safe target, because it can be
  someone else's app. When no session is ready or the window is ambiguous, see
  [docs/internal/agents/electron-session-lifecycle.md](docs/internal/agents/electron-session-lifecycle.md).
- Stop only the sessions the current task started and verify their processes
  exit. Leave other sessions running.

## Workspace

- Preserve active worktrees, running processes, `.devkit`, and Rust target
  directories. See [docs/internal/agents/workspace-hygiene.md](docs/internal/agents/workspace-hygiene.md).
- Issues and specs live in this repository's GitHub Issues; see
  [docs/internal/agents/issue-tracker.md](docs/internal/agents/issue-tracker.md)
  and [docs/internal/agents/triage-labels.md](docs/internal/agents/triage-labels.md).
- The Windows lane runs the packaged app in a UTM VM through the
  `pnpm windows:test*` scripts. Follow
  [docs/internal/agents/utm-windows-tests.md](docs/internal/agents/utm-windows-tests.md).
  Never target the personal VM named `Windows`, and keep its UUID and bundle
  path out of the repository and the logs.
- For an ambiguous request to check, verify, or inspect Sentry, start with
  [docs/internal/operations/sentry-agent-check.md](docs/internal/operations/sentry-agent-check.md).
  It defines the read-only default and which words select a state-changing
  operation.
