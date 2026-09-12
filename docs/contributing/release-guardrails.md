# Release guardrails reference

Detailed guardrails, platform caveats, and runbooks behind the short flow in
[`releasing.md`](./releasing.md). Read the section you are touching; nothing
here is required reading for an ordinary cut.

## Developer packaging verification

- `pnpm run release:verify` mirrors the local parts of the release workflow, includes current-platform build and packaging verification, and fails if the successful verify run changes the working tree snapshot.
- `release:verify:checks` forces `CI=1` and runs the release-specific checks: the Drizzle schema check, Electron install verification, and the electron-builder ASAR-unpack policy. Pass `--scan-cleanup-identity` to add the 200-second canonical scan-cleanup identity test, which CI selects for affected scan-cleanup changes.
- `pnpm run release:verify:package:local` owns the current-platform package proof: it accepts an exact verified build receipt from the combined verifier or performs a fresh strict build when invoked alone, then packages as the release workflow would, validates artifacts/updater metadata, verifies packaged native tools, and verifies packaged startup on macOS. Use `pnpm run test:electron-bundle-static-integrity:no-build` for a no-build static-integrity loop against existing `dist-electron/`.
- Changed or file-scoped local loops (for example `pnpm exec vitest run --changed origin/main ...`, `pnpm exec fallow dead-code --changed-since origin/main`) are iteration aids. They do not replace `pnpm run release:verify` when a developer needs local packaging proof.
- `pnpm run release:verify` is intentionally host-only for packaging. The release cutter relies on exact-SHA hosted CI for the cross-platform matrix.
- Fresh installs follow the checked-in build-script policy in [`pnpm-workspace.yaml`](../../landing/pnpm-workspace.yaml). If a new dependency needs an install script for release-critical behavior, update that allow/ignore list deliberately instead of tolerating pnpm's warning output.
- Main app release checks are app-scoped and do not read or build `landing/`. Landing-only working tree changes are ignored by the release cutter so the desktop/web app release path stays independent of the separate landing deploy.
- Routine local checks use `pnpm validate` and the affected plan. Coverage is an optional diagnostic with no numeric acceptance quota. Hosted CI runs for pull requests and every push to `main`, with expensive behavior lanes selected by changed area. Select broader checks only for a concrete risk.

## Release invariants

- `release:cut` runs from a clean `main` checkout and releases the newest commit on freshly fetched `origin/main` whose push CI run succeeded with a green `gates_ok`. It never waits on CI and never requires `HEAD` to be the tip.
- The release commit changes only the `package.json` version over that candidate and uses `release: <version> [skip ci]`. The version is then carried to `main`, by fast-forward when main still sits at the candidate, by a fresh version-only commit otherwise.
- Release CI accepts a target that is on protected `main`, or a version-only commit whose parent is, and judges that commit through a successful `gates_ok` run on its parent after checking the exact version-only diff.
- Core packaging, checksums, mirror staging, and public promotion determine whether the release is complete.
- The release cutter pushes the `vX.Y.Z` tag with developer credentials before it dispatches `release.yml`; `prepare` requires that tag at the target, and the draft is created against the tag without a `--target`. GitHub demands the `workflows` scope to point a new ref at a commit that is behind the `main` tip in `.github/workflows/`, and the built-in token cannot hold that scope, so a workflow-created tag or a `--target` on the draft fails with HTTP 403 whenever a workflow change landed on `main` after the release commit. Keep the tag in the cutter; the workflow only verifies it.
- macOS Intel, Windows ARM64, and Store lanes are supplemental. They never gate public promotion.
- The publish chain is exercised without a real release by the drill described in [Publish-chain drill](#publish-chain-drill).

## macOS signing, startup, and Gatekeeper

- The macOS packaged-startup step is meaningful only when local packaging uses real Developer ID credentials. Ad-hoc local signing still verifies bundled native-tool execution, but it does not faithfully reproduce LaunchServices/runtime-library-validation behavior for a shipped `.app`.
- After producing a signed macOS candidate, run `bash scripts/verify-macos-packaged-reactivation.sh mac <arm64|x64>` from the repository root. The diagnostic targets only `release/mac-<arch>/EVB Viewer.app`, launches a tokenized isolated profile, requires Accessibility access, and proves 20 Finder-to-LaunchServices foreground cycles plus minimized and hidden recovery. It closes the last window and requires the same macOS process to remain alive and recreate a window when activated, then explicitly terminates the app, requires its Electron process tree to exit, proves the bundle can be moved for replacement, and unregisters that exact workspace bundle from LaunchServices. It retains its main/window logs below `.devkit/test/macos-packaged-reactivation/` and terminates only the PID whose command contains the exact packaged executable and unique token. On a non-CI Mac it refuses to run without `EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST=1`, snapshots the Dock first, and removes only a matching test-path Dock item that did not pre-exist. Accessibility-denied hosts exit without weakening the assertions; keep this lane in a macOS manual/nightly environment with the permission pre-granted.
- The scripted reactivation matrix does not claim to automate the 30-minute soak, system sleep/wake, display or Space changes, or opening a user-selected document from Finder. Perform those checks manually against the same signed candidate with no installed production or development instance in scope, and record the evidence before a release whose macOS focus behavior changed.
- `codesign --verify` is not enough for macOS release safety. The GitHub mac packaging lanes must also pass `spctl --assess --type execute`, otherwise a bundle can look internally valid while still being rejected or crashing at launch on end-user machines.
- The signed macOS LaunchServices gate must start from a disposable copy of the final DMG, apply browser-download quarantine, mount it, copy the app to a disposable install location, and launch that installed copy. Launching the unpacked `release/mac-<arch>` bundle does not exercise Gatekeeper's first-launch execution policy. The diagnostic refuses local production-identity runs unless `EVB_ALLOW_PRODUCTION_BUNDLE_IDENTITY_TEST=1` is set after explicit approval, unregisters the mounted source bundle before detaching the DMG, and unregisters its exact disposable app path during cleanup.
- On macOS, packaged native-tool verification must execute the bundled tools from inside the signed app resources, not just inspect file presence or `otool` output. That is how we catch Team-ID/library-validation regressions in bundled DjVuLibre, Poppler, qpdf, and Tesseract payloads before tag push.
- The macOS PDF-tool bundler treats missing Homebrew binaries/libraries, failed install-name rewrites, and residual Homebrew references as fatal; it must never publish a partial Poppler/qpdf resource tree.

## Signing and updater-feed policy

- Public releases require the macOS Developer ID and notarization secrets. Artifact-only builds may remain ad-hoc signed and must still build and launch correctly.
- Ad-hoc macOS artifact builds are manual-install only. GitHub builds prune `latest-mac*.yml` and `.blockmap` for ad-hoc mac bundles so the updater feed cannot mix signed and ad-hoc framework blocks.
- Windows signing secrets are optional for public releases. Unsigned Windows releases are manual-install only: GitHub builds prune `latest*.yml` and `.blockmap` unless the Windows artifact is the signed x64 updater target.
- The release publish step must tolerate zero updater metadata files. Some releases are intentionally download-only across every platform.
- Distribution decisions must remain compatible with an individual, free, non-commercial project. Treat any business identity, paid account, or account conversion requirement as an explicit owner decision rather than an assumed release prerequisite.

## Pre-release proof of packaged behaviour

- The packaged core-PDF journey (`scripts/release/verifyPackagedCorePdfSmoke.ts`) has no local runner and no vitest coverage. Push CI's `pr_packaged_linux` job is where it executes before a release: it calls `build-target.yml` for Linux x64 exactly as the release matrix does, with `upload_artifacts: false`, whenever the `packagedSmoke` changed-area policy matches. Extend that path list in `scripts/release/policy.mjs` when the journey gains a new dependency.
- The proof is Linux-only by design. Both verifier regressions that failed v0.1.447 and v0.1.448 failed identically on all four platforms; the platform-specific steps (signing, notarization, NSIS install, Windows append sharing) stay release-only and are covered daily by the artifact canary.
- Do not add release-only assertions to the journey without a CI or canary execution first. A behaviour pin that has never run is not a guardrail.

## Dependency advisories

- `check:production-dependency-audit` rejects any advisory at any severity and permits no waiver. It runs daily in [`dependency-audit.yml`](../../.github/workflows/dependency-audit.yml) and reports through one open issue labelled `dependency-audit`; a clean run comments on that issue rather than closing it. It is absent from push CI and from every release workflow on purpose: advisories arrive on the registry's clock, and on the required lane one publication blocked two release cuts in one afternoon for a commit that changed nothing about dependencies.
- `pnpm-workspace.yaml` holds new registry releases for seven days (`minimumReleaseAge`). A fix version younger than that needs `pnpm install --config.minimum-release-age=0` for that install only; say so in the commit message. Do not lower the workspace setting.
- A dependency fix is ordinary work: it goes through push CI like any commit and may be released whenever the next cut happens.

## Artifact-only flow

- Run `pnpm run release:artifacts` from a clean worktree to have GitHub build the release artifacts without cutting a release. It uses the same preflight, clean-worktree, upstream, and publication-policy checks as the cutter, then dispatches [`Build Release Artifacts`](../../.github/workflows/release-artifacts.yml) for the exact pushed commit.
- The same workflow runs on a daily schedule as the artifact canary. With no `target_ref` input it resolves the current `main` tip itself and skips when `main` is older than 24 hours.
- The workflow runs the focused release checks only when the target SHA has no successful exact-SHA push-CI `gates_ok` run (for example a branch commit); a CI-vouched commit goes straight to packaging. It packages the core matrix, the supplemental macOS Intel, Windows ARM64, and Windows 7 legacy lanes, and Store AppX packages, applying the same packaged native-tool and ASAR/content verification as release lanes.
- It never creates a tag, a GitHub Release, or release assets. Downloads live as GitHub Actions artifacts on the workflow run.

## Current-tree size and Git history

The Project 6 binary-distribution work tracks current-tree inputs, build-time downloads, and their upstream provenance separately from Git history. Removing a third-party runtime file from a future tree, or fetching it during a build, reduces the current checkout or build inputs only. It does not rewrite the historical Git pack, existing commit IDs, tags, release identities, or Sentry references. The settled no-rewrite decision and its revisit condition are recorded in [Project 6 issue #326](https://github.com/evb0110/evb-viewer/issues/326). Do not rewrite history, force-push, retag, or migrate active clones unless a new explicit decision authorizes it with a measured storage and migration plan.

## Microsoft Store packages

The supplemental workflow builds and smoke-installs the Store AppX packages
and keeps them as workflow artifacts. Nothing submits them: the Store
submissions API is available only to Partner Center company accounts with an
Azure AD tenant, and this project publishes from an individual account. Keep
account-specific IDs, portal screenshots, submission IDs, and live
troubleshooting notes out of tracked docs. To ship a Store update:

1. Download both Store package artifacts from the supplemental run: `gh run download <run-id> -n store-appx-win-x64 -n store-appx-win-arm64`
2. Upload `store-appx-win-x64/EVB-Viewer-<version>-x64-store.appx` and `store-appx-win-arm64/EVB-Viewer-<version>-arm64-store.appx` in the Packages section of a new Partner Center submission and submit it for certification. See [Create app submission for MSIX apps](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission) and [Upload MSIX app packages](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages).

Store AppX packages must declare every shipped UI locale in `electron-builder.yml`. The Store workflow validates those manifest resources so Partner Center can offer matching localized listings.

Before submitting an AppX package, confirm that `Send privacy-sanitized error diagnostics` is off until the user enables it in Privacy settings. Microsoft Store Policy 10.5.2 requires express in-product permission before publishing customer personal information to an outside service. Every AppX ships client diagnostics off by default.

## Publication policy gate

`scripts/check-commit-attribution.mjs` is the single gate on what becomes public: the pre-commit hook checks the staged tree, the pre-push hook checks everything a push would newly publish (including annotated tag objects), the release cutter and the artifact-only flow run it before their push, and CI reruns it for pushes and pull requests. It rejects prohibited commit attribution and the local-only artifacts listed in `scripts/lib/local-artifact-policy.mjs`.

In CI, `--pushed-range <before> <head>` scans `before..head` when the before SHA is reachable, and otherwise scans the complete history of the pushed head. An absent SHA, a zero OID, and an unreachable SHA after a force history rewrite all take that wider path. This is intentional and fail-closed. The authorized public-history rewrite must remove agent instruction files and local-only directories from every public head and tag. After that rewrite has been validated and published, a full-history scan of a rewritten branch passes, and keeping it full prevents the purged content from re-entering public history through a later force push.

Until the rewrite is published, a complete-history scan is expected to report the legacy artifacts. After publication, a local branch created from the old history still contains them and will fail the gate. Rebase or cherry-pick its work onto the rewritten `main`, or rewrite the branch itself (`git rebase --onto`, `git filter-repo`) so no reachable commit adds those paths. Do not narrow the scanned range, skip the hook, or otherwise bypass the gate to push such a branch.

## Landing rollout, withdrawal, and rollback

The landing download endpoint selects from the public GitHub release list; it does not trust GitHub's mutable `latest` flag. Configure the deployed landing service with:

- `NUXT_RELEASE_STABLE_TAGS`: comma-separated, preference-ordered stable tags. The first available, non-withdrawn tag is served. Leave empty only for newest-public-release compatibility mode.
- `NUXT_RELEASE_WITHDRAWN_TAGS`: comma-separated tags that must never be served.
- `NUXT_RELEASE_CANARY_TAG` and `NUXT_RELEASE_CANARY_PERCENT`: an optional public canary and deterministic cohort percentage from 0 through 100.

To withdraw a bad release, add its tag to `NUXT_RELEASE_WITHDRAWN_TAGS`, put the prior known-good tag first in `NUXT_RELEASE_STABLE_TAGS`, set the canary percentage to zero, deploy the configuration, and verify `/api/releases/latest` from multiple user-agent/cohort keys. Keep the withdrawn release excluded until a replacement has passed the packaged smoke and downloaded-asset hash checks. Rollback is a server configuration change and does not require republishing or mutating old GitHub assets.

## Command behavior notes

- The release and artifact-only commands stop after the dispatched GitHub workflow run is visible; GitHub owns the remote matrix from that point.
- If GitHub takes longer than usual to surface a just-dispatched run, set `EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS` to a larger positive integer.
- The publish-chain jobs (draft, checksums, mirror, promote, Intel attach, Windows ARM64 attach, supplemental mirror) execute only during release runs. Latent defects there surface at release time by construction; the same-SHA repair path (re-run failed jobs, or re-dispatch the same tag and target) is the designed, proven recovery.
- Mirror transfers are bounded. The publisher uploads every artifact above 8 MiB as a multipart upload with 8 MiB parts, four parts in flight, and one HTTP request per part, so a stalled connection costs one part's request timeout (2 minutes) instead of a whole installer. The S3 client also aborts a socket that carries no bytes for 60 seconds, the publisher retries each artifact up to three times after aborting the failed multipart upload, and every publish-chain job declares `timeout-minutes` (finalize 20, mirror 40, promote 40, which covers its own three bounded activation attempts). A stalled upload fails within minutes and is repaired by re-running the failed jobs; it no longer holds the global release concurrency group for GitHub's six-hour job limit. Every drill seeds one asset larger than two parts, so the release drill proves the multipart path against the real bucket. The bucket needs a lifecycle rule that aborts incomplete multipart uploads (Yandex `AbortIncompleteMultipartUpload`, one day) because an aborted publisher process cannot clean up after itself.
- Supplemental assets reach the mirror without joining the immutable core set. `publish-release-mirror.mjs supplemental` writes the macOS Intel ZIP, the Windows ARM64 installer, and its provenance as plain objects under the release prefix once they are attached, and refuses any name outside that set. `manifest.json` and the stable channel keep exactly the bytes promotion verified, so a same-tag repair run still reproduces them byte for byte. The upload is skipped when the tag has no core manifest, because the mirror keeps four releases and an object under a pruned tag is unreachable weight. The landing page asks the mirror for each supplemental installer rather than assuming coverage, so a release cut before this lane existed, or one whose supplemental workflow failed, offers its GitHub link alone.
- The daily artifact canary no longer runs the Windows 7 legacy lane. It is dispatch-only and owned by Eugene Barsky. A red canary now always means a failure in a lane that ships: mac Intel, Windows ARM64, Store AppX, or the main build matrix.

## Deferred by evidence

Decisions parked with explicit revisit conditions after the 2026-08 rework
and the v0.1.427 campaign:

- **Build-receipt machinery** (`scripts/release/build-receipt.mjs` and the
  `EVB_RELEASE_BUILD_RECEIPT` handoff): dead on the release path now that
  `release:cut` never runs the local gate; only `release:verify` still uses it.
  Delete once one or two releases have gone through the new cutter cleanly.
- **Matrix-artifact reuse across same-SHA attempts**: worth building only if
  publish-chain failures recur. Same-SHA repair is proven cheap.
- **Linux container image** with preinstalled system deps: stronger fix for
  apt-mirror hangs; requires a registry decision first.

## Publish-chain drill

`release-drill.yml` runs the publish chain against a draft prerelease and a
dedicated mirror prefix. It uses tags shaped like `v0.0.0-drill.<run_id>` and
mirror objects under `evb-viewer/drill/<run_id>/`. The drill must never write to
`evb-viewer/releases/` or `evb-viewer/channels/`, and its cleanup job removes the
draft and the complete drill prefix even when an earlier job fails.

The drill uploads deterministic core assets, runs checksum finalization,
mirror staging, and draft verification, then runs the same Intel and Windows
ARM64 attachment code with small stub files and mirrors those stubs into the
run's own prefix. Attestation is skipped for drill files. The supplemental
lanes wait for the chain because a supplemental mirror copy is only written
next to a core manifest that already exists. A production release still uses the stable `vX.Y.Z` tag grammar, the
production mirror prefix, and GitHub release promotion.
