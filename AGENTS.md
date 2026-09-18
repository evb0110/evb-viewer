# EVB Viewer agent rules

Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the engineering map. Shared personal preferences live in `~/AGENTS.md`.

## Design and checks

- Prefer deletion and reuse. Give state and lifecycles one owner, derive other views, and validate at trust boundaries using existing contracts. Extend shared mechanisms instead of adding feature-local copies.
- New layers should replace old ones. See the [design charter](docs/architecture/design-charter.md) and [ADRs](docs/architecture/adr/) when changing architecture.
- A change a user could see or feel follows [fix evidence](docs/internal/agents/fix-evidence.md): reproduce it in a hidden real-app session with real input before fixing, show the same script failing before and passing after, and otherwise report "mitigation applied, not confirmed". This applies to delegated workers too; never forbid a worker from launching the hidden app for such a change. Expected behavior comes from the [behavior contract](docs/architecture/behavior-contract.md), not from the implementation.
- Test what a user perceives: rendered text, real layout, pixels, saved bytes. One adequate real-app proof per scenario is enough. A geometry, lifecycle or interaction fix cannot close on a mock-level test alone, and do not add tests that assert private call sequences. Releases use `run-all-gates`; independent review is useful only when it adds coverage.
- New check infrastructure or flake tolerance requires an explicit user request and the commit trailer `Adds-Checks: <the words that asked for it>`. A real-app regression test for a user-facing fix is pre-authorized with `Adds-Checks: real-app regression for a user-facing fix`. Editing or deleting existing checks needs no trailer. Before diagnosing a red `main` or changing a flaky check, run `node scripts/ci/ci-health.mjs`; an inherited failure already has an owner.
- At most two viewer-core changes are active at once and they integrate one at a time, as [fix evidence](docs/internal/agents/fix-evidence.md#viewer-core-integration) describes. Work comes from observed behavior: owner-blocking failures, recurring defect families, then failures from ordinary tasks on varied documents. Do not start a static audit program unless the owner asks for one.

## OCR and UI

- Prioritize OCR quality and robustness. Use the pinned `tesseract-ocr/tessdata_best` models and keep their registry in sync.
- Use tokens from `app/assets/css/main.css`, localize UI strings with `t()` in English and Russian, and register icons in `clientBundle.icons` in `nuxt.config.ts`.
- Before changing annotation serialization or note windows, read [freetext persistence](docs/architecture/freetext-note-persistence.md).

## Operations

- For agent UI work and video evidence, use [recorded automation](docs/internal/agents/recorded-automation.md) and start a task-owned recorded session. The same CLI works for every model provider.

- Before any Electron launch, follow [hidden automation](docs/internal/agents/hidden-electron-automation.md) and its shared runner. Resolve the specific dev session over CDP using [session lifecycle](docs/internal/agents/electron-session-lifecycle.md); a generic Electron app name or bundle ID can target another task's app.
- Before cleanup, read [workspace hygiene](docs/internal/agents/workspace-hygiene.md). Preserve active worktrees, `.devkit` data, and Rust targets.
- Issues and specs live in GitHub. Use the [issue tracker](docs/internal/agents/issue-tracker.md) and [triage labels](docs/internal/agents/triage-labels.md).
- For Windows tests, follow [UTM tests](docs/internal/agents/utm-windows-tests.md) and [setup and repair](docs/contributing/windows-tests/setup-and-repair.md). Use `pnpm windows:test*`; never target the personal VM named `Windows` or record its UUID or bundle path.
- For an ambiguous Sentry check, start with [Sentry agent check](docs/internal/operations/sentry-agent-check.md), which defines the read-only default.
