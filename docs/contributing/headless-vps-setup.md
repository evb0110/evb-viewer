# Headless Linux VPS Setup

Use this guide when preparing a Linux VPS or CI-like box for EVB Viewer agent
work. The app can run on a headless host, but Electron still needs a display
server. On Linux without `DISPLAY` or `WAYLAND_DISPLAY`, use Xvfb.

## One-command Setup

From the repository root on Ubuntu:

```bash
bash scripts/setup-linux-dev-host.sh
```

The script installs host packages, `fpm` for Linux packaging, Rust 1.89.0 plus
the WASM target, root and landing `pnpm` dependencies, Playwright Chromium,
Linux native document-tool bundles, and then runs:

```bash
pnpm run check:dev-env -- --strict
```

Node.js 24.x with Corepack/pnpm must already be available.

## Environment Preflight

Run this at the start of agent sessions that may touch Electron, browsers,
native tools, OCR, packaging, or diagnostics:

```bash
pnpm run check:dev-env
```

The report says whether the host is `headed` or `headless`. On a headless Linux
host it should also show `pnpm run electron:run:headless -- <command>` as the
Electron wrapper.

## Headless Electron Commands

Use the checked-in wrapper script instead of assuming a local desktop. It keeps
one Xvfb process alive per detached Electron session and removes it on `stop`:

```bash
pnpm run electron:run:headless -- startd
pnpm run electron:run:headless -- status
pnpm run electron:run:headless -- screenshot home
pnpm run electron:run:headless -- stop
```

For foreground development:

```bash
pnpm run dev:headless
```

For Electron E2E smoke on a VPS:

```bash
pnpm run test:e2e:electron:headless
```

The existing CDP/Puppeteer session commands remain the preferred way to click,
type, inspect console output, and capture screenshots on headless hosts.

`xvfb-run -a` is still fine for single foreground commands that own their whole
lifetime, such as `pnpm run test:e2e:electron:headless`. Do not use plain
`xvfb-run -a pnpm electron:run startd`; the Xvfb process exits as soon as
`startd` returns.

## Manual Package List

If the setup script is not appropriate, install the same host packages manually:

```bash
sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl build-essential pkg-config ruby-dev \
  tesseract-ocr poppler-utils qpdf djvulibre-bin unpaper patchelf \
  xvfb xauth dbus-x11 \
  libgtk-3-0 libnss3 libasound2t64 libxss1 libgbm1 libdrm2 \
  libxshmfence1 libatk-bridge2.0-0 libatspi2.0-0 libcups2 \
  libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
  libpango-1.0-0 libcairo2
sudo gem install fpm --no-document
```

Then run:

```bash
rustup toolchain install 1.89.0 --profile minimal
rustup target add wasm32-unknown-unknown
node scripts/ci-install-dependencies.mjs --frozen-lockfile
pnpm exec playwright install chromium
bash scripts/bundle-tools-linux.sh
pnpm run check:dev-env -- --strict
```
