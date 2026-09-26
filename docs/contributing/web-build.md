# Web Build Notes

## Commands

- `pnpm dev`
- `pnpm dev:web`
- `pnpm build`
- `pnpm build:desktop`
- `pnpm preview`
- `pnpm lint && pnpm typecheck && pnpm build`
- `pnpm run test:electron-bundle-static-integrity:no-build`
- `pnpm exec vitest run --project unit-policy tests/unit/scripts/releasePolicy.test.ts`
- `pnpm run test:unit`
- `pnpm run check:architecture`

## Intended Use

- `dev` starts one Nuxt dev server plus Electron, with the browser app at `/` and the Electron shell at `/electron`.
- `build` produces the Nuxt web build used for deployment, including prerendered app routes, Nitro server endpoints, and a post-build check that required browser WASM assets were copied into the deploy output.
- `build:desktop` adds the Electron bundles on top of the Nuxt web build for local packaging and release flows.
- Vercel builds emit Nitro output into `.vercel/output`; local desktop flows keep using `nuxt-output/`.
- `pnpm lint && pnpm typecheck && pnpm build` is the current browser-app verification batch. The landing app shares the root pnpm workspace and lockfile but keeps its own lint, typecheck, and build commands. `lint` owns ESLint, stylelint, and the fast static checks; the slower web deploy source check is split into `pnpm run check:static:assets`.
- After a desktop build has produced `dist-electron/`, `pnpm run test:electron-bundle-static-integrity:no-build` runs static bundle assertions without forcing another build. Use `pnpm run test:electron-bundle-static-integrity` when you want the script-managed build, prune, and hygiene wrapper.
- Browser Rust/WASM builds live in `public/wasm/` but are not committed. `pnpm dev`, `pnpm dev:web`, `pnpm build`, `pnpm test:unit` and `pnpm test:integration:browser` run `scripts/ensure-wasm-artifacts.mjs`, which rebuilds a file when it is missing or its crates changed (it needs the `wasm32-unknown-unknown` Rust target). Web deploys upload the local files; the remote build does not rebuild them.

## Current Scope

- Browser routes:
  - `/` shared browser workspace
  - `/workspace` compatibility redirect to `/`
  - `/electron` desktop-only shell entry
- PDF-and-images-first browser runtime
- Browser-backed open/save/recent-files/search/page-ops flows
- OCR and searchable-PDF generation are desktop-only. Browser search uses
  text extracted from the current PDF bytes and does not consume browser OCR
  sidecar artifacts.
- DjVu viewing and explicit PDF conversion are available in browser runtime
  through the vendored DjVu.js worker path.
- Desktop app updates unavailable in browser runtime

## Architecture and checks

- `pnpm run check:architecture` runs ESLint path-boundary rules and dependency-cruiser cycle checks.
- `pnpm lint` adds Stylelint and the landing-site lint command, using the tools' native caches.
- `pnpm typecheck` uses the existing incremental TypeScript builds; `pnpm run test:unit` runs the unit projects.
- Use `node scripts/run-all-gates.mjs` for full local release verification.

## Dependency graph

The browser app, landing app, and shared packages use one root pnpm workspace
and one `pnpm-lock.yaml`. Run installs from the repository root; package-level
commands such as `pnpm --dir landing run build` reuse that graph.
