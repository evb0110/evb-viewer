# Development

Setup, commands, packaging, checks, and the architecture boundaries enforced
in CI. Start at [CONTRIBUTING.md](../../CONTRIBUTING.md) for what is welcome;
this page is how to build and verify.

## Desktop Packaging

The Electron app is configured to package:

- macOS: DMG and ZIP
- Windows: NSIS installer
- Linux: AppImage and DEB

The GitHub release workflow builds:

- macOS arm64, plus a supplemental Intel ZIP lane
- Windows x64 and arm64
- Windows 7 x64 legacy artifacts are manual-only via workflow_dispatch of
  `.github/workflows/build-win7-legacy.yml`, and are not part of releases or
  the nightly canary
- Linux x64 and arm64

Desktop releases bundle native tools for OCR, image export, page operations, and DjVu handling. The packaging and verification scripts live under `scripts/`, and platform resources are assembled into `resources/`.

## Repository Layout

```text
app/        Shared Nuxt viewer UI, PDF/DjVu components, workspace shell
electron/   Electron main/preload code and native-tool-backed features
server/     SSR routes for the root web build (sitemap, robots, analytics)
landing/    Separate Nuxt landing/download/docs site
packages/   Shared contracts, i18n core/messages, release-selection logic
resources/  Bundled native binaries and OCR language data
scripts/    Build, packaging, resource-bundling, and release helpers
tests/      Unit, integration, and Electron E2E coverage
docs/       Project-specific implementation and release notes
```

## Tech Stack

- Electron 42
- Nuxt 4 + Vue 3 + TypeScript 6 (TypeScript 7 native compiler for plain-TypeScript checks)
- Nuxt UI 4 + Tailwind CSS 4
- PDF.js 5 for rendering
- `pdf-lib` for document rewriting and page operations
- Tesseract + Poppler + qpdf + DjVuLibre + unpaper for desktop-native workflows
- Vitest, Playwright, and Puppeteer-based Electron E2E coverage

## Getting Started

### Requirements

- Node.js latest LTS, currently `24.x`
- `pnpm` `10.x`

### Root App Setup

```bash
pnpm install
```

### Root App Commands

```bash
# Default desktop development flow (Nuxt dev server + Electron)
pnpm dev

# Web workspace only
pnpm dev:web

# Nuxt SSR web build
pnpm build

# Nuxt build + Electron bundles
pnpm build:desktop

# Run the built desktop app locally
# Best used after: pnpm build:desktop
pnpm start

# Package installers for the current host, or for a selected electron-builder target
pnpm dist
pnpm dist --mac
pnpm dist --win
pnpm dist --linux
```

### Landing Site Setup

The landing site is a separate Nuxt app with its own lockfile:

```bash
cd landing
pnpm install
pnpm dev
```

Its runtime release API uses:

- `NUXT_GITHUB_OWNER`
- `NUXT_GITHUB_REPO`
- `NUXT_GITHUB_API_BASE`
- `NUXT_GITHUB_TOKEN` (optional)
- `LANDING_ANALYTICS_HASH_SECRET` (independent random secret, 32+ characters)
- `CRON_SECRET` (32+ characters; required by the daily analytics-retention route)

Copy `.env.example` files when you need local environment overrides. Do not commit filled-in `.env` files.

## Testing And Verification

### Useful tests

Test observable behavior with the smallest fixture that reproduces the defect.
Use real collaborators when they clarify the behavior, and mocks when they make
the test smaller and deterministic. Mock counts and allowlists are not quality
checks. Remove tests that only freeze source text, file layout, or test inventories.

```bash
# Root app lint and fast static checks
pnpm lint

# Static checks split out from lint
pnpm run check:static:reports
pnpm run check:static:assets

# Type checks
pnpm typecheck

# Unit tests
pnpm run test:unit

# Optional coverage diagnostic
pnpm run test:coverage

# Heavy generated Electron bundle static-integrity check
pnpm run test:electron-bundle-static-integrity

# No-build static integrity against an existing dist-electron/
pnpm run test:electron-bundle-static-integrity:no-build

# Fast release/local policy loop
pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts

# Manual Electron E2E diagnostics
pnpm run test:e2e:electron

# Changed/related local loop
pnpm run validate:iteration

# Affected worktree acceptance
pnpm validate

# Affected integration checks and Electron regression
pnpm run validate:integration

# Exhaustive maintenance/soak tier
pnpm run validate:nightly

# Native-resource sanity check
pnpm run check:resources:matrix

# Host-side release verification
pnpm run release:verify
```

Electron E2E Vitest setup starts one shared Nuxt renderer server for the run,
passes its port to detached Electron sessions, and tears it down only when the
setup process owns it. Individual sessions launch Electron against that shared
renderer instead of starting their own Nuxt server. Session boot is a suite
hook, so a filtered command such as `vitest ... -t 'specific journey'` does not
need to include a synthetic infrastructure-test title.

Failed fixture-backed E2E tests retain their bounded session log, diagnostics,
and an automatic renderer screenshot under `.devkit/sessions/e2e-*/`. Set
`EVB_E2E_PRESERVE_ARTIFACTS=1` to retain the same diagnostics for successful
local runs. CI enables retention and uploads session logs, screenshots, and
shared-renderer logs with `if: always()`; Electron browser profile data is
intentionally excluded from the upload.

Root app checks are intentionally scoped to the browser/Electron app and shared
packages. The landing site is checked from `landing/` with its own dependency
install and build commands.

`pnpm run release:verify` is the full host-side release proof. Its checks phase
produces one strict build and a source/toolchain/target-fingerprinted receipt;
the package phase reuses those exact outputs only while both the inputs and
artifact hashes still match. Standalone package verification builds normally.
Select coverage reports, stress tests, and quarantine E2E only when they answer
a concrete question. Run native and
platform checks when the changed behavior requires them. For local iteration, use affected or file-scoped loops
such as `pnpm run validate:iteration -- --file=app/path/to/change.ts`,
`pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts`, or
`pnpm run test:electron-bundle-static-integrity:no-build` after
`dist-electron/` already exists. Use `pnpm validate` for affected local acceptance. Select
`node scripts/run-all-gates.mjs` when full local release verification is needed. Every pull request and every
push to `main` runs the hosted checks; the release cutter trusts only the
exact-SHA push run. The dormant Python page-processor was
removed after the native scan-cleanup pipeline superseded it and remains
recoverable from git history. CI selects the relevant Electron behavior lanes by changed area. Broader
PDF tab diagnostics remain available through their dedicated workflow.

The Electron E2E regression suite currently covers:

- Startup hydration, recent files, core viewer smoke, inactive PDF/DjVu tabs,
  annotation lifecycle, and squiggly markup on desktop

Opt-in Electron E2E subsets are selected by named Vitest projects through
package scripts: `pnpm run test:e2e:electron:draw-shapes`,
`pnpm run test:e2e:electron:large`, and
`pnpm run test:e2e:electron:rapid-navigation`.
The high-zoom PDF search-match regression runs with
`pnpm run test:e2e:electron:search-match-scroll`.
To replay a captured PDF, set `EVB_SEARCH_SCROLL_PDF` and override its query,
result count, target group, target viewer page, or target match with the
corresponding `EVB_SEARCH_SCROLL_*` variables before running the named project.
The manually dispatched macOS `pnpm run test:e2e:electron:visible-window` lane deliberately
uses the real show/maximize/focus lifecycle. Unlike the default hidden lanes,
running it locally can bring the development app to the foreground.

Broader regressions such as page operations, DOCX/image export, browser/desktop page extraction, recent-files persistence, and external-open routing are covered by fast unit tests so releases do not depend on long serial UI automation.

## OCR Tuning

The desktop OCR pipeline supports two common concurrency knobs:

| Variable | Default | Description |
| --- | --- | --- |
| `OCR_CONCURRENCY` | `min(cpuCount, 8)` | Max pages processed in parallel |
| `OCR_TESSERACT_THREADS` | `floor(cpuCount / OCR_CONCURRENCY)` | Thread limit per Tesseract process |

There are also advanced queue/worker controls under `EVB_OCR_*` for release and stress scenarios.

For manual OCR quality tuning, run the profile benchmark:

```bash
pnpm run diag:ocr-profile-benchmark -- tests/fixtures/electron/test-scanned.pdf --pages 1 --languages eng
```

It writes `.devkit/tmp/ocr-profile-benchmark/<timestamp>/summary.csv` plus TSV,
text, render, preprocessing, and log artifacts for `balanced`, `accurate`,
`poor-scan`, and `stock` profiles. Compare `text_length`, confidence, word
count, preprocessing result, and runtime together; inspect the parsed text
before accepting a profile change.

Tesseract remains the default OCR backend. Improve wrapper profiles, language
ordering, rendering, and preprocessing first; treat PaddleOCR or vision models
as future optional backends only after they have a repeatable quality, packaging,
privacy, and searchable-PDF story.

## Architecture Notes

The root app is a shared Nuxt codebase used by both the browser workspace and the Electron shell:

- `/` is the browser workspace
- `/electron` is the desktop-only shell route
- `/workspace` is a compatibility redirect

Architecture boundaries are enforced in CI and local validation:

- `electron/**` must not import `app/**`
- `landing/**` must not import `app/**`
- `app/services/**` must not import `app/composables/**`
- cross-feature boundaries are checked by `pnpm run check:architecture`
