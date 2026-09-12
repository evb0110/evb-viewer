# Project 6 #324 CI workflow consolidation

## Scope and identity

This batch started from `31ed428c5327ac12198dc63278ecd58da2e07e68`, which matched freshly fetched `origin/main`.

- Project: `6b0c8150-d5c2-4b91-bd94-34f3c2e33f69`
- Checkout: `/Users/evb/.t3/worktrees/evb-viewer/t3code-eb281259`
- Branch: `t3code/project-six-bootstrap-1`
- Git common directory: `/Users/evb/WebstormProjects/evb-viewer/.git`
- Protected checkouts: not modified

The dispatcher-created branch name is recorded as-is. No branch or worktree mutation was made.

## Before and after

Before the change, 21 dependency-installing jobs each repeated the same three setup steps in `.github/workflows/ci.yml`:

1. `pnpm/action-setup@v5`
2. `actions/setup-node@v6` with pnpm caching
3. `node scripts/ci-install-dependencies.mjs --frozen-lockfile`

Eight of those jobs also repeated Electron-install verification. The workflow was 1,234 lines.

After the change:

- The 21 jobs call `./.github/actions/setup-ci-env`.
- The composite action owns the pinned pnpm setup, Node setup, pnpm cache configuration, frozen dependency install, and optional Electron verification.
- Eight jobs pass `verify-electron: 'true'`. The native save/reopen job keeps its original behavior and does not opt into verification because it did not run that step before.
- The original workflow was 1,234 lines. The first consolidation commit reduced it to 1,081 lines. This correction reduces it to 1,071 lines, removing the three-line duplicate blocking-job verification step and seven blank separators introduced around the opt-in inputs.
- The blocking job restores staged Electron native binaries before the blocking smoke. Its verification runs once inside the shared action, and no longer runs again after the cache step.
- `pr_changed_areas` keeps its standalone Node setup because it does not install dependencies.
- The reusable `pr_packaged_linux` job, `gates_ok`, attribution, and fuzz jobs keep their existing wiring.

Job IDs, conditions, needs, permissions, secrets, matrices, artifact names and paths, cache keys, and gate commands remain in `ci.yml`. The extraction does not change failure conditions or make a job optional.

## Job inventory

The 26 current CI job IDs remain present:

`commit_attribution`, `pr_quality`, `pr_electron_blocking_smoke`, `pr_packaged_linux`, `pr_electron_native_save_reopen`, `pr_native_pdf_integration`, `pr_changed_areas`, `pr_browser_integration`, `pr_native_build_safety`, `pr_scan_cleanup_heavy`, `pr_rust_tests_arm64`, `pr_scan_cleanup_oracles`, `pr_landing_quality`, `nuxt_compatibility_v5`, `gates_ok`, `manual_quality`, `nightly_rust_fuzz`, `manual_landing`, `nightly_maintenance`, `nightly_electron_e2e_regression`, `nightly_electron_e2e_save_pipeline`, `nightly_electron_e2e_rapid_navigation`, `nightly_electron_e2e_large_pdf`, `nightly_electron_e2e_quarantine`, `nightly_electron_e2e_visible_window`, and `nightly_pdf_tabs_diagnostics`.

The shared setup action is used by:

`pr_quality`, `pr_electron_blocking_smoke`, `pr_electron_native_save_reopen`, `pr_native_pdf_integration`, `pr_browser_integration`, `pr_native_build_safety`, `pr_scan_cleanup_heavy`, `pr_rust_tests_arm64`, `pr_scan_cleanup_oracles`, `pr_landing_quality`, `nuxt_compatibility_v5`, `manual_quality`, `manual_landing`, `nightly_maintenance`, `nightly_electron_e2e_regression`, `nightly_electron_e2e_save_pipeline`, `nightly_electron_e2e_rapid_navigation`, `nightly_electron_e2e_large_pdf`, `nightly_electron_e2e_quarantine`, `nightly_electron_e2e_visible_window`, and `nightly_pdf_tabs_diagnostics`.

## Ownership and handoffs

Changed paths belong to this batch:

- `.github/actions/setup-ci-env/action.yml`, new CI-only composite action.
- `.github/workflows/ci.yml`, setup calls only. The job graph and gate wiring remain owned by current Main CI.
- `tests/unit/scripts/project6-324-ciWorkflowContract.test.ts`, ticket-unique contract coverage.
- This report.

No #325 collision was found. The live #325 owner `5f4bbeb2-2528-4b80-bbcb-14a77816d8c0` is settled with no active turn and owns its binary/provenance inventory worktree and report only. This batch did not edit that report, release/cache policy, package files, binaries, or reserved paths.

The integration owner must review the combined CI diff with parallel writers before publication. Release workflows, release/cache policy, #296 validation budgets and runners, native gates, package manifests and lockfiles, native sources, Project 4 files, and shared ESLint/Vitest configuration remain handoffs outside this batch.

## Focused evidence

The ticket-unique contract test checks the complete 26-job inventory, the 21 composite-action callers, the unchanged standalone changed-area Node setup, the exact eight Electron-verification opt-ins, the blocking cache-before-smoke order, and the frozen dependency-install command. It also pins the action default, composite mode, and bash shells. GitHub Actions YAML parsing covers the new action and workflow.

Evidence from this checkout:

- Dependency setup: `/Users/evb/.nvm/versions/node/v24.11.1/bin/pnpm install --frozen-lockfile --ignore-scripts --store-dir /Users/evb/.cache/project6-324-pnpm-store`, exit 0. `pnpm exec nuxt prepare`, exit 0, generated the ignored local `.nuxt` TypeScript configuration required by Vitest.
- Focused contract and GitHub Actions syntax tests: `pnpm exec vitest run tests/unit/scripts/project6-324-ciWorkflowContract.test.ts tests/unit/scripts/githubActionsSyntax.test.ts`, exit 0, 2 files and 6 tests passed.
- Shared policy evidence: `pnpm exec vitest run tests/unit/scripts/ciTopologyPolicy.test.ts`, exit 1, 24 passed and 3 failed. The exact stale assertions are `keeps PR feedback bounded and release workflow checks delegated`, `keeps expensive PR and release-push checks path-filtered from checked-in policy`, and `keeps stable Electron desktop automation blocking and quarantined diagnostics advisory`. The failures are the old inline dependency-install and Electron-install strings. The shared file was not edited.
- GitHub Actions checker: `pnpm exec tsx scripts/checkGithubActionsSyntax.ts`, exit 0, 16 YAML files passed.
- Changed-file ESLint: `pnpm exec eslint tests/unit/scripts/project6-324-ciWorkflowContract.test.ts`, exit 0.
- `git diff --check`, exit 0.

## Shared-file handoffs

This lane did not edit the shared files below.

- `tests/unit/scripts/ciTopologyPolicy.test.ts` still contains its existing inline setup assertions. Run it read-only for evidence. Its failures belong to the shared policy owner or integrator, not this ticket, unless ownership is reassigned explicitly.
- `scripts/release/policy.mjs` does not include `.github/actions/setup-ci-env/**` in the `landing.paths` list or the `scanCleanupExport.paths` list. The policy owner should add that exact path to both lists and add regression assertions that `classifyChangedFiles(['.github/actions/setup-ci-env/action.yml']).landing.matched` and `.scan_cleanup_export.matched` are true. This lane does not edit release policy.
- `docs/contributing/release-guardrails.md` still calls CI setup consolidation deferred. Its owner can withdraw that deferral after this commit is reviewed, the unique contract test and YAML checks pass, the old policy test failures are reconciled, and the release-policy path classification is updated and covered. This lane does not edit the guardrail.
