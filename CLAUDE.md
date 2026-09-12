# Claude Code rules for EVB Viewer

@AGENTS.md

Claude-specific mechanics only; everything else is in the file above.

- Domain vocabulary and the single-context layout:
  [docs/internal/agents/domain.md](docs/internal/agents/domain.md) and
  [docs/architecture/glossary.md](docs/architecture/glossary.md).
- Select CodeRabbit through the `coderabbit-review` skill when it adds coverage
  to a non-trivial change. Never enable paid capacity without explicit approval.
- Read `~/Library/Logs/DiagnosticReports/Electron-*.ips` before touching
  processes after a crash dialog. Sequence installs and Electron launches so
  `node_modules` is not relinking during a launch.
