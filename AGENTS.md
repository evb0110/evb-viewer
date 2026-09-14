# EVB Viewer agent rules

Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the engineering map. Shared personal preferences live in `~/AGENTS.md`.

## Design and checks

- Prefer deletion and reuse. Give state and lifecycles one owner, derive other views, and validate at trust boundaries using existing contracts. Extend shared mechanisms instead of adding feature-local copies.
- New layers should replace old ones. See the [design charter](docs/architecture/design-charter.md) and [ADRs](docs/architecture/adr/) when changing architecture.
- Test observable behavior using existing checks and shared runners. Use at most one real-app proof per scenario. Releases use `run-all-gates`; independent review is useful only when it adds coverage.
- New check infrastructure or flake tolerance requires an explicit user request and the commit trailer `Adds-Checks: <the words that asked for it>`. Editing or deleting existing checks needs no trailer. Before changing a flaky check, run `node scripts/ci/ci-health.mjs`.

## OCR and UI

- Prioritize OCR quality and robustness. Use the pinned `tesseract-ocr/tessdata_best` models and keep their registry in sync.
- Use tokens from `app/assets/css/main.css`, localize UI strings with `t()` in English and Russian, and register icons in `clientBundle.icons` in `nuxt.config.ts`.
- Before changing annotation serialization or note windows, read [freetext persistence](docs/architecture/freetext-note-persistence.md).

## Operations

- Before any Electron launch, follow [hidden automation](docs/internal/agents/hidden-electron-automation.md) and its shared runner. Resolve the specific dev session over CDP using [session lifecycle](docs/internal/agents/electron-session-lifecycle.md); a generic Electron app name or bundle ID can target another task's app.
- Before cleanup, read [workspace hygiene](docs/internal/agents/workspace-hygiene.md). Preserve active worktrees, `.devkit` data, and Rust targets.
- Issues and specs live in GitHub. Use the [issue tracker](docs/internal/agents/issue-tracker.md) and [triage labels](docs/internal/agents/triage-labels.md).
- For Windows tests, follow [UTM tests](docs/internal/agents/utm-windows-tests.md) and [setup and repair](docs/contributing/windows-tests/setup-and-repair.md). Use `pnpm windows:test*`; never target the personal VM named `Windows` or record its UUID or bundle path.
- For an ambiguous Sentry check, start with [Sentry agent check](docs/internal/operations/sentry-agent-check.md), which defines the read-only default.
