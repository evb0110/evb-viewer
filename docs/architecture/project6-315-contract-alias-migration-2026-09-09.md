# Project 6 #315 contract alias migration

## Scope and starting point

This slice was prepared on integration commit `3575f0476af643b3361ced59cf70a561209437e6`, before the subsequent remote-main WASM freshness merge. It owns the contracts import migration, package alias configuration, the lint rule, and the affected architecture fixtures. No native, renderer, or primary checkout files were changed.

## Changes

- Deleted `packages/contracts/index.ts` and removed the root export from
  `packages/contracts/package.json`.
- Migrated repository bare contracts imports to named subpaths. The symbol
  mapping covers document identity and revisions, page numbers, timestamps,
  shared IDs, release types, host profiles, native protocols, Electron API, and
  analytics.
- Removed duplicate scoped aliases from TypeScript, Nuxt, Vitest, guest-worker,
  dependency-graph, and mock-alias configuration. `@evb/scan-cleanup` remains
  because it is a distinct package with no canonical replacement in this slice.
- Added `custom/no-removed-package-aliases`, with RuleTester coverage for the
  contracts barrel and removed scoped aliases.
- Kept the directory resolver for `@contracts/*` so subpath consumers resolve in
  Vite/Nuxt and guest bundles, while the exact root alias is absent from
  TypeScript paths and the dependency graph.

## Verification

- `pnpm exec vitest run --project unit-scripts tests/unit/scripts/eslintPluginCustom.test.ts tests/unit/scripts/depGraph.test.ts --reporter=verbose`: 2 files, 54 tests passed.
- `pnpm exec vitest run tests/unit/architecture/sentryBoundaryPolicy.test.ts --reporter=verbose`: 1 file, 12 tests passed.
- `node scripts/architecture/boundary-check.mjs --scope=all`: 9,996 internal imports scanned, passed.
- Changed TypeScript, Vue, and JavaScript sources pass ESLint with no warnings.
- The first full typecheck reached the workspace checks but stopped on the
  already-advanced remote-main WASM test changes. It is rerun after integrating
  that exact remote head.

## #316 handoff

This slice leaves the existing portable contracts graph intact. The remaining
#316 question is whether the published `@evb/*` package names in `landing` and
`packages/scan-cleanup` are intentional external package dependencies or stale
internal aliases. Resolve that policy against the #316 owner before changing
those manifests. Do not reintroduce a root contracts barrel to make package
bootstrap easier.
