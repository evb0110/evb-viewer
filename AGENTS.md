# EVB Viewer agent rules

Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the engineering map and the [design charter](docs/architecture/design-charter.md) for the binding design rules. Shared personal preferences live in `~/AGENTS.md`.

## Design

- Prefer deletion and reuse. Give each state and lifecycle one owner and derive other views. Validate at trust boundaries with the existing contracts. Extend shared mechanisms instead of adding feature-local copies. New layers replace old ones in the same change.
- Fix chains: once a product file has taken three fix commits in seven days, the next fix there must shrink the file or revert. Delete the redundant state or path; do not add another fence, flag, timer, retry or generation counter. The publication policy enforces this on push and in CI; only the owner can waive it with a `Fix-Chain-Override:` trailer. See [fix evidence](docs/internal/agents/fix-evidence.md#fix-chains).
- Before changing note writing, legacy note-marker recognition or note windows, read [ADR 0003](docs/architecture/adr/0003-notes-are-text-annotations.md).

## Evidence and checks

- A change a user could see or feel follows [fix evidence](docs/internal/agents/fix-evidence.md): reproduce it in a hidden real-app session with real input, show the same script failing before and passing after, and otherwise report "mitigation applied, not confirmed". Expected behavior comes from the [behavior contract](docs/architecture/behavior-contract.md). Never forbid a worker from launching the hidden app for such a change.
- Test what a user perceives: rendered text, real layout, pixels, saved bytes. Do not add tests that assert private call sequences or grep source text.
- New check infrastructure or flake tolerance needs the owner's request, quoted in an `Adds-Checks:` trailer. One focused real-app regression test in an existing lane for a user-facing fix is pre-authorized with `Adds-Checks: real-app regression for a user-facing fix`. Editing or deleting existing checks needs no trailer.
- After a push, wait for the required verdict with `ci-wait -w CI <sha>`. If your commit broke it, fix or revert promptly; never widen a tolerance or skip a test to get green.
- Concurrency: at most one agent changes viewer core (`app/modules/pdf-viewer`, `document-viewer`, `workspace-shell`, annotations) at a time, and at most three agents write to the repository at once. Check active threads and branches before starting.
- Work comes from observed behavior: owner-blocking failures, recurring defect families, then failures from ordinary tasks on varied documents. Do not start a static audit program unless the owner asks for one, and do not commit dated audit, ledger or campaign documents; findings become issues or code.

## Product rules

- Prioritize OCR quality and robustness. Use the pinned `tesseract-ocr/tessdata_best` models and keep their registry in sync.
- Use tokens from `app/assets/css/main.css`, localize UI strings with `t()` in all nine locale files, and register icons in `clientBundle.icons` in `nuxt.config.ts`.

## Operations

- Before any Electron launch, follow [hidden automation](docs/internal/agents/hidden-electron-automation.md) and [session lifecycle](docs/internal/agents/electron-session-lifecycle.md). For UI evidence and video, use [recorded automation](docs/internal/agents/recorded-automation.md).
- Keep worktrees only while their branch is open, keep scratch in `.devkit`, and run Rust builds only when the task touches `native/` (see [workspace hygiene](docs/internal/agents/workspace-hygiene.md)).
- Issues live in GitHub (use `gh`); labels are in [triage labels](docs/internal/agents/triage-labels.md).
- Run Windows checks on the BGK Windows guest (`ssh bgk-win11`), following "Windows checks" in `~/fleet-hosts.md`, or on GitHub Windows runners.
- For an ambiguous Sentry check, start with [Sentry agent check](docs/internal/operations/sentry-agent-check.md), which defines the read-only default.
