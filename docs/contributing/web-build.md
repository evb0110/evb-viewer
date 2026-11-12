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
- `pnpm lint && pnpm typecheck && pnpm build` is the current browser-app verification batch. The landing app shares the root pnpm workspace and lockfile but keeps its own lint, typecheck, and build commands. `lint` owns OxLint, Stylelint, and dependency-cruiser architecture checks; the slower web deploy source check is split into `pnpm run check:static:assets`.
- After a desktop build has produced `dist-electron/`, `pnpm run test:electron-bundle-static-integrity:no-build` runs static bundle assertions without forcing another build. Use `pnpm run test:electron-bundle-static-integrity` when you want the script-managed build, prune, and hygiene wrapper.
- Browser Rust/WASM builds live in `public/wasm/` but are not committed. `pnpm dev`, `pnpm dev:web`, `pnpm build`, `pnpm test:unit` and `pnpm test:integration:browser` run `scripts/ensure-wasm-artifacts.mjs`, which rebuilds a file when it is missing or its crates changed (it needs the `wasm32-unknown-unknown` Rust target). Web deploys upload the local files; the remote build does not rebuild them.
- The browser OCR engine (`public/wasm/evb-tesseract.wasm` and `.mjs`) is not built by cargo. The same script downloads the published files and checks their size and SHA-256 against `PREBUILT_WASM_FILES` in `scripts/wasm-artifacts.mjs`. To change the engine, run `scripts/build-tesseract-wasm.sh` with an activated emsdk at the version the script names (it refuses others), upload its two output files to the `runtime-binaries-v2` release under a new revision name, and update the pins. The build is reproducible: rebuilding unchanged sources gives the pinned bytes.
- The browser qpdf engine (`public/wasm/evb-qpdf.wasm` and `.mjs`) is desktop's qpdf built the same way by `scripts/build-qpdf-wasm.sh` and fetched and pinned the same way. `browserQpdfEngineClient.ts` runs it in one worker with desktop's command lines from `packages/pdf-core/qpdfCommands.ts`; opening a PDF uses it to rewrite a file whose cross-reference chain an edit cannot extend, as desktop does.

## Current Scope

- Browser routes:
  - `/` shared browser workspace
  - `/workspace` compatibility redirect to `/`
  - `/electron` desktop-only shell entry
- PDF-and-images-first browser runtime
- Browser-backed open/save/recent-files/search/page-ops flows
- Browser OCR (`app/platform/browser-api/browserOcr*`) runs the WebAssembly
  Tesseract in Web Workers on PDF.js rasters and writes the searchable layer
  with the page-ops WASM; the result is applied through a staged receipt bound
  to the document and its revision. Models download from GitHub at the pinned
  tessdata_best revision into Cache Storage. Search and the text catalog read
  the saved PDF's text, as on desktop.
- DjVu viewing and explicit PDF conversion are available in browser runtime
  through the vendored DjVu.js worker path. The worker reads a document one
  component at a time (`app/platform/browser-api/browserDjvuSource.ts`), so no
  step holds the whole source; only memory bounds a page's decode. An
  indirect DjVu opens when its index is selected in Open together with the
  files beside it; each component name resolves to the selected file.
  Printing a DjVu converts the selected pages, lays them out with the
  page-ops print layout, and prints them through the workspace's browser
  print frame.
- Desktop app updates unavailable in browser runtime

## Architecture and checks

- `pnpm run check:architecture` runs dependency-cruiser path-boundary and cycle checks.
- `pnpm lint` adds Stylelint and the landing-site lint command, using the tools' native caches.
- `pnpm typecheck` uses the existing incremental TypeScript builds; `pnpm run test:unit` runs the unit projects.
- Use `node scripts/run-all-gates.mjs` for full local release verification.

## Dependency graph

The browser app, landing app, and shared packages use one root pnpm workspace
and one `pnpm-lock.yaml`. Run installs from the repository root; package-level
commands such as `pnpm --dir landing run build` reuse that graph.
