# Project 6 #331 dependency placement

## Scope and starting point

This lane inspected `origin/main` at `bd38c2e36fd22e18d6537dcfd6174b005b6ea828` after `git fetch origin main --prune`. The worktree started at that same SHA and used pnpm `10.32.1`, matching `package.json`.

Owned changes are limited to the root package manifest, its lockfile, the root ignore file, and this note.

## Placement decisions

| Package | Result | Evidence |
| --- | --- | --- |
| `@anthropic-ai/sdk` | Moved to root `devDependencies` | Imports occur only in `scripts/stress/**` and their unit tests. The product assistant imports `@anthropic-ai/claude-agent-sdk` instead. This keeps the stress-only execution note out of the shipped production dependency set without changing assistant behavior. |
| `pdfjs-dist-codex-preview` | Moved to root `devDependencies` | Imports and path resolution occur only in the interoperability corpus generator, preview compatibility harness, and related tests/fixtures. The application imports the pinned `pdfjs-dist` archive, which remains a production dependency. |
| `@iconify/utils`, Vue compiler/server-renderer packages, `@vue/devtools-api`, `devalue`, `hookable`, `source-map-js`, `type-fest`, `unhead`, and `vue-router` | Moved to root `devDependencies` | They are used by Nuxt configuration, build/release scripts, type-only source, or unit tests. None is a shipped Electron runtime import. The Nuxt framework supplies its own transitive framework packages. `devalue`, `hookable`, `unhead`, `@vue/devtools-api`, and `vue-router` remain direct dev entries because `nuxt.config.ts` names them in `optimizeDeps`. |
| Pinned `@intlify/*`, remaining Vue runtime/compiler internals, `consola`, `cookie-es`, `defu`, `estree-walker`, `iron-webcrypto`, `node-mock-http`, `radix3`, `ufo`, `uncrypto`, `vue-bundle-renderer` | Removed as root direct entries | No direct production import exists in the checked source. These are framework transitive packages, and no repository source or release script establishes a standalone root pin or bug workaround. Their lockfile records remain when required by workspace packages. |
| `h3`, `vue`, `@vueuse/*`, `@cfworker/json-schema`, Sentry, Neon/Drizzle, PDF.js, `pdf-lib`, `utif`, `entities`, `fast-png`, and `electron-updater` | Kept in root `dependencies` | Production source imports or the generated web/Electron runtime require them. In particular, server routes and utilities import `h3`; the app and Electron search path import `pdfjs-dist`; the Claude assistant imports `@anthropic-ai/claude-agent-sdk`. |

The root source imports `@neondatabase/serverless` and `drizzle-orm` in the main server as well as landing code, so they are not landing-only. The landing workspace already declares its own copies for its independent build.

## Ignore change

The root now ignores the two electron-builder Store target staging directories:

- `/store-appx-win-x64/`
- `/store-appx-win-arm64/`

The rule does not ignore `build/appx/`, `release/`, source assets, or evidence.

## Verification record

Commands run from this worktree, with results recorded here:

- `git fetch origin main --prune` passed. Inspected SHA: `bd38c2e36fd22e18d6537dcfd6174b005b6ea828`.
- `pnpm install --lockfile-only --ignore-scripts --frozen-lockfile=false` passed with pnpm `10.32.1`. No workspace installation or generated build output was run.
- `pnpm install --lockfile-only --ignore-scripts --frozen-lockfile` passed with pnpm `10.32.1` after the edit.
- `node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'` passed.
- The static package-placement audit passed: 13 packages moved to devDependencies and 21 redundant direct pins removed.
- `pnpm run check:build-artifacts:hygiene` passed.
- `git check-ignore -v store-appx-win-x64/ store-appx-win-arm64/` passed for both rules.
- `git diff --check` passed.
- `pnpm run check:production-dependency-audit:production-only` and `pnpm run check:production-dependency-audit` could not start because the clean worktree has no `node_modules`; pnpm reported `Command "tsx" not found`. A workspace-wide install was not run because other task outputs share the host.
- `pnpm exec eslint package.json` and the focused Vitest command for `pdfjsProvenance.test.ts` and `depGraph.test.ts` could not start for the same missing-local-binary reason. These are deferred to the integrator's installed task environment.
- `coderabbit review --agent --base main` completed on the Mac with 0 findings across the four changed files.
- Read-only primary-checkout checks passed for `/Users/evb/WebstormProjects/evb-viewer` (`main...origin/main`, clean) and the VPS `/home/ubuntu/projects/evb-viewer` (`main...origin/main [behind 390]`, clean).

The full local packaging smoke command is `pnpm run release:verify:package:local`. It remains deferred to the serialized integrator because Project 4 owns the active Mac Electron session. The integrator should run it from the integrated clean worktree, preserving the existing hidden Electron launch policy.

## Lockfile scope correction

The follow-up audit compared the candidate lockfile with `origin/main` at `bd38c2e36fd22e18d6537dcfd6174b005b6ea828`. The first real frozen install reproduced a missing `@nuxt/icon` peer-context snapshot. The candidate graph contains the complete Nuxt peer-context chain required by the changed root importer, so those context records are required rather than unrelated upgrades. A task-local offline install with the candidate graph completed with pnpm `10.32.1`, installing 1,490 packages.

The corrected lockfile keeps the candidate's required peer-context graph, removes its unnecessary `@napi-rs/canvas@1.0.8` package and optional-platform records, and restores the vendored PDF.js snapshot to `@napi-rs/canvas: 0.1.100`. It also keeps the prior removal of now-unreachable direct-only records for `@intlify/h3@2.1.2`, `@intlify/utils@1.0.1`, `iron-webcrypto@2.0.0`, and `uint8array-extras@1.5.0`. The real corrected frozen install completed with pnpm `10.32.1`, installing 1,530 packages. No package version upgrade was introduced. The vendored archive was checked with `tar -xOf vendor/pdfjs-dist/pdfjs-dist-6.3.311-6922bee2.tgz package/package.json | rg '"(@napi-rs/canvas|name|version)"'`, which reports PDF.js `6.3.311` and its declared `@napi-rs/canvas: ^1.0.0` dependency.

Compared with `origin/main`, the lock contains 14 added and 15 replaced peer-context snapshot keys. They are the importer-induced variants for `@nuxt/devtools-kit`, `@nuxt/icon`, `@nuxt/nitro-server`, `@nuxt/telemetry`, `@nuxt/vite-builder`, `@nuxtjs/sitemap`, `nitropack`, `nuxt-site-config`, `nuxt-site-config-kit`, `nuxt`, `nuxtseo-shared`, `unplugin-auto-import`, `unplugin-vue-components`, and `vite-plugin-inspect`. The package-resolution section has no added or upgraded package records. Its only removals are the four unreachable direct-only records listed above. The candidate-to-correction diff removes only the 12 `@napi-rs/canvas@1.0.8` package/optional-platform records and changes the PDF.js optional dependency back to `0.1.100`.

After correction, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm install --lockfile-only --ignore-scripts --frozen-lockfile`, and `git diff --check` passed. The lockfile-only check was also run with `--offline`; the real install used `--offline` first and completed from the local store. No heavy build, Electron, corpus, or packaging suite was run.

## Nuxt i18n root-link correction

The integrated typecheck failure was reproduced at the package-link seam with `node -e "require.resolve('@intlify/shared/package.json')"`: before this correction, the root resolver reported `Cannot find module '@intlify/shared/package.json'`. The installed `@nuxtjs/i18n@10.5.0` package had `@intlify/shared: ^11.4.6` in its package-local dependencies, but the root importer had no visible link. Root probes for `@intlify/core`, `@intlify/core-base`, `@intlify/utils`, and `@intlify/h3` were also missing, but the reported Nuxt resolver failure named only `@intlify/shared`; no sibling was added.

The smallest fix adds root `devDependencies['@intlify/shared'] = '11.4.8'`, matching the existing pinned lock record. The lock importer adds only that entry. The first offline lockfile-only resolution could not obtain registry metadata (`ERR_PNPM_NO_OFFLINE_META`), so the pinned lock entry was resolved with network access using pnpm `10.32.1`. That regeneration reintroduced the known vendored-PDF.js `@napi-rs/canvas@1.0.8` records, so those unrelated records were removed again and the PDF.js snapshot was restored to `@napi-rs/canvas: 0.1.100`. The final diff from the prior correction is one manifest line and three lock importer lines.

After the fix, `@intlify/shared` is root-visible and `node scripts/run-nuxt-typecheck.mjs` passes. `pnpm install --frozen-lockfile --offline --ignore-scripts`, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run check:production-dependency-audit:production-only`, `pnpm run check:production-dependency-audit`, and `git diff --check` all pass. The full `pnpm run typecheck` reaches the workspace package phase but remains blocked by missing generated `landing/.nuxt/tsconfig.app.json`, `tsconfig.server.json`, `tsconfig.shared.json`, and `tsconfig.node.json` in this task tree. No generated landing output was created because generated artifacts are outside this correction's scope.

## Nuxt i18n strict-link correction, round two

The next integrated failure was `Cannot resolve module "@intlify/core-base" from @nuxt/kit while initializing @nuxtjs/i18n`. In this task tree, the focused repro `node -e "require.resolve('@intlify/core-base/package.json')"` failed before the edit, while `@intlify/shared` was root-visible from the prior correction. The installed `@nuxtjs/i18n@10.5.0` package declares `@intlify/core-base: ^11.4.6` locally, and the lock already pins `@intlify/core-base@11.4.8`. Root probes for `@intlify/core`, `@intlify/utils`, and `@intlify/h3` remained missing, so no speculative sibling was added.

The smallest fix adds only root `devDependencies['@intlify/core-base'] = '11.4.8'` and its three-line root importer lock entry. The network lockfile resolution again attempted to add the known unrelated PDF.js `@napi-rs/canvas@1.0.8` records; those records were removed and the PDF.js snapshot was restored to `@napi-rs/canvas: 0.1.100`. The final implementation diff from the prior head is one manifest line and three lockfile lines. No package version changed.

`pnpm install --frozen-lockfile --offline --ignore-scripts`, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm install --lockfile-only --ignore-scripts --frozen-lockfile`, `node scripts/run-nuxt-typecheck.mjs`, `pnpm run typecheck`, both production dependency audits, the focused Vitest command `pnpm exec vitest run --project unit-scripts tests/unit/scripts/depGraph.test.ts tests/unit/scripts/pdfjsProvenance.test.ts`, and `git diff --check` passed. The focused tests passed 2 files and 69 tests. `pnpm --filter landing exec nuxt prepare` generated only task-local ignored `landing/.nuxt` metadata; no generated file is tracked. Both primary `main` checkouts remained clean.

## Nuxt i18n strict-link correction, round three

The next integrated failure was `Cannot resolve module "@intlify/utils" from @nuxt/kit` while initializing `@nuxtjs/i18n`. The focused task-tree repro `node -e "require.resolve('@intlify/utils/package.json')"` failed before the edit, while `@intlify/shared` and `@intlify/core-base` were root-visible. The lock already contains compatible `@intlify/utils@0.14.1`, and the `@nuxtjs/i18n@10.5.0` package-local dependency resolves to that version. Root probes for `@intlify/core` and `@intlify/h3` remained missing, so no speculative sibling was added.

The smallest fix adds only root `devDependencies['@intlify/utils'] = '0.14.1'` and its three-line root importer lock entry. Network lockfile resolution again attempted to add unrelated PDF.js `@napi-rs/canvas@1.0.8` records; those records were removed and the PDF.js snapshot was restored to `@napi-rs/canvas: 0.1.100`. The final implementation diff from the prior head is one manifest line and three lockfile lines. No package version changed.

`pnpm install --frozen-lockfile --offline --ignore-scripts`, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm install --lockfile-only --ignore-scripts --frozen-lockfile`, `node scripts/run-nuxt-typecheck.mjs`, `pnpm run typecheck`, both production dependency audits, the focused Vitest command for `depGraph.test.ts` and `pdfjsProvenance.test.ts`, and `git diff --check` passed. The focused tests passed 2 files and 69 tests. No tracked generated output was created; the existing task-local `landing/.nuxt` metadata was used for the workspace typecheck. Both primary `main` checkouts remained clean.

## Nuxt i18n strict-link correction, round four

The next integrated failure was `Cannot resolve module "@intlify/message-compiler" from @nuxt/kit` while initializing `@nuxtjs/i18n`. Before this edit, the task tree reproduced the same root-link defect with `require.resolve('@intlify/message-compiler/package.json')`: the module was missing from the root resolver. The lock already contained `@intlify/message-compiler@11.4.8`; its package record depends on `@intlify/shared@11.4.8`. The installed `@nuxtjs/i18n@10.5.0` package-local graph already contains the related Intlify packages. Root probes showed `@intlify/shared@11.4.8`, `@intlify/core-base@11.4.8`, and `@intlify/utils@0.14.1` visible, while `@intlify/core` and `@intlify/h3` remained root-missing. No speculative sibling was added.

The smallest fix adds only root `devDependencies['@intlify/message-compiler'] = '11.4.8'` and its three-line root importer entry. Lockfile regeneration briefly added the unrelated `@napi-rs/canvas@1.0.8` package and platform records. Those records were removed, and the vendored PDF.js snapshot was restored to `@napi-rs/canvas: 0.1.100`. The final implementation diff is one manifest line and three lockfile lines. No package version or peer-context record changed.

With pnpm `10.32.1`, these checks passed:

- `pnpm install --frozen-lockfile --offline --ignore-scripts`
- `pnpm install --lockfile-only --ignore-scripts --frozen-lockfile`
- `pnpm install --frozen-lockfile --ignore-scripts`
- root-link assertions for the four proven links, with `@intlify/core` and `@intlify/h3` still root-missing
- `pnpm run typecheck`, using existing ignored task-local `landing/.nuxt` metadata; no generated file is tracked
- `pnpm run check:production-dependency-audit:production-only`
- `pnpm run check:production-dependency-audit`
- `pnpm exec vitest run --project unit-scripts tests/unit/scripts/depGraph.test.ts tests/unit/scripts/pdfjsProvenance.test.ts`, 2 files and 69 tests passed
- `git diff --check`

The exact before/after lock review contains only the new root importer entry. It retains the PDF.js canvas pin and has no `@napi-rs/canvas@1.0.8` records. Both primary `main` checkouts remained clean. The next integrated typecheck is the remaining resolver gate.

## Nuxt i18n strict-link correction, round five

The next integrated failure was `Cannot resolve module "@intlify/core/dist/core.node" from @nuxt/kit` while initializing `@nuxtjs/i18n`. Before this edit, the task tree reproduced the root visibility part of that failure: `require.resolve('@intlify/core/package.json')` and `require.resolve('@intlify/core/dist/core.node')` both failed. The lock already contained `@intlify/core@11.4.8`, and the installed `@nuxtjs/i18n@10.5.0` package declares `@intlify/core: ^11.4.6`. The compatible package exposes its Node implementation as `dist/core.node.mjs` through its exports map. Root probes showed the four earlier links visible, while `@intlify/h3` remained root-missing. No speculative sibling was added.

The smallest fix adds only root `devDependencies['@intlify/core'] = '11.4.8'` and its three-line root importer entry. Lockfile regeneration briefly added the unrelated `@napi-rs/canvas@1.0.8` package and platform records. Those records were removed, and the vendored PDF.js snapshot was restored to `@napi-rs/canvas: 0.1.100`. The final implementation diff is one manifest line and three lockfile lines. No package version or peer-context record changed.

With pnpm `10.32.1`, these checks passed:

- `pnpm install --lockfile-only --ignore-scripts --frozen-lockfile` after the lock correction
- `pnpm install --frozen-lockfile --offline --ignore-scripts`
- `pnpm install --frozen-lockfile --ignore-scripts`
- root-link, importer, and PDF.js pin assertions; `@intlify/h3` remained root-missing
- `pnpm run typecheck`, using existing ignored task-local `landing/.nuxt` metadata; no generated file is tracked
- `pnpm run check:production-dependency-audit:production-only`
- `pnpm run check:production-dependency-audit`
- `pnpm exec vitest run --project unit-scripts tests/unit/scripts/depGraph.test.ts tests/unit/scripts/pdfjsProvenance.test.ts`, 2 files and 69 tests passed
- `git diff --check`

The exact before/after lock review contains only the new root importer entry. It retains the PDF.js canvas pin and has no `@napi-rs/canvas@1.0.8` records. Both primary `main` checkouts remained clean. No further resolver failure occurred in this task tree; the integrator should rerun the exact integrated typecheck.

## Mac package smoke

On 2026-09-08, the task tree was clean at `1777f6b8e854f222027e11c81c152ca254e91afa`; fetched `origin/main` was `87d64d7c8c868195c1e38cf275a192c830e13d7e`. Both primary `main` checkouts were clean. No other release, Electron-builder, or heavy Mac package process owned this task checkout or slot.

The exact command was:

```bash
EVB_AUTOMATION_NO_FOCUS=1 EVB_AUTOMATION_HIDE_WINDOW=1 EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1 pnpm run release:verify:package:local
```

The successful run started at `2026-09-08T12:34:09Z` and ended at `2026-09-08T12:36:36Z` with exit status `0`. It built and verified the `mac-arm64` package using Electron `43.4.1`, electron-builder `26.15.3`, and pnpm `10.32.1`. Strict WASM freshness passed, the Nuxt production build and web deploy asset check passed, Electron and all four native tools built, native-tool packaging verification passed, and the packaged `app.asar` contained 593 entries.

Artifacts:

- `release/EVB-Viewer-0.1.452-arm64.dmg`, 190,588,900 bytes, SHA-256 `d189d3887cfd3ecb00023c0182714640b55522350f3bdd4a7a9c2b3330ca3200`
- `release/builder-debug.yml`, 1,872 bytes, SHA-256 `141c9a79dcb1320243f4bcfe7c2d9c52ff716f1cad1ede559f575e083a4b51d5`
- `release/mac-arm64/EVB Viewer.app`, 404M on disk, app bundle validated by codesign

The script skipped macOS notarization because `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` were absent. It applied an ad-hoc signature and skipped packaged startup verification because LaunchServices and Developer ID semantics require credentials. It also skipped the named packaged sidecar fold-clip smoke because an ad-hoc signed app is killed by provenance policy when that sidecar writes outputs in place. These are the remaining external credentialed acceptance gates. The package-placement smoke itself passed. A first wrapper invocation also passed the package script but ended in a shell-wrapper error from assigning to zsh's read-only `status` variable; the rerun above used a safe variable and is the authoritative exit result.

No tracked files changed and generated release/build outputs remain task-local and ignored. Both primary `main` checkouts remained clean after the run.

## Acceptance status

The source and package-placement portion is implemented in this lane. Production/full dependency audits, packaging smoke, hosted CI, and exact integrated-SHA evidence remain integration gates. This commit does not claim those external gates.
