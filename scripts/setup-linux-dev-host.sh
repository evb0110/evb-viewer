#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

if [ "$(uname -s)" != "Linux" ]; then
  echo "scripts/setup-linux-dev-host.sh only supports Linux hosts." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required to install host packages." >&2
  exit 1
fi

APT_PACKAGES=(
  ca-certificates
  curl
  build-essential
  pkg-config
  ruby-dev
  tesseract-ocr
  poppler-utils
  qpdf
  djvulibre-bin
  patchelf
  xvfb
  xauth
  dbus-x11
  libgtk-3-0
  libnss3
  libasound2t64
  libxss1
  libgbm1
  libdrm2
  libxshmfence1
  libatk-bridge2.0-0
  libatspi2.0-0
  libcups2
  libxcomposite1
  libxdamage1
  libxrandr2
  libxkbcommon0
  libpango-1.0-0
  libcairo2
)

echo "Installing Linux host packages..."
sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${APT_PACKAGES[@]}"

if ! command -v fpm >/dev/null 2>&1; then
  echo "Installing fpm for Linux packaging..."
  sudo gem install fpm --no-document
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install Node.js 24.x with Corepack, then rerun this script." >&2
  exit 1
fi

RUST_TOOLCHAIN="$(sed -nE 's/^channel[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' rust-toolchain.toml | head -1)"
if [ -z "$RUST_TOOLCHAIN" ]; then
  echo "Could not read Rust toolchain from rust-toolchain.toml." >&2
  exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing rustup with Rust $RUST_TOOLCHAIN..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain "$RUST_TOOLCHAIN"
fi

export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal
rustup target add wasm32-unknown-unknown --toolchain "$RUST_TOOLCHAIN"

echo "Installing root workspace dependencies..."
node scripts/ci-install-dependencies.mjs --frozen-lockfile

echo "Installing Playwright Chromium..."
pnpm exec playwright install chromium

echo "Bundling Linux native document tools..."
bash scripts/bundle-tools-linux.sh

echo "Running strict dev-environment preflight..."
pnpm run check:dev-env -- --strict
