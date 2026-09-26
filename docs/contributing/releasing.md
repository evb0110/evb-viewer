# Releasing

Run the command from any checkout of the repository:

```sh
pnpm run release:cut -- patch
```

Use `minor` or `major` for the corresponding version change. The cutter fetches `origin/main`, chooses the newest commit with a successful exact-SHA `ci.yml` push run and green `gates_ok` that descends from the previous release tag, computes the next version from the newest stable tag, and pushes a lightweight tag. It does not write a version commit or dispatch a workflow. The tag starts `.github/workflows/release.yml`.

Inspect a candidate without creating a tag:

```sh
node scripts/release/release-cut-preflight.mjs patch
```

To recover a workflow for a tag that already exists, dispatch `Release` with that tag. The workflow validates that the tag points to a commit on `main` and waits for that commit's exact-SHA CI verdict before packaging.

## Release workflow

One tag-triggered workflow packages five targets in parallel: macOS arm64 (Developer ID signed and notarized DMG plus updater ZIP), Windows x64 and ARM64 (NSIS), and Linux x64 and ARM64 (deb). It sets the package version from the tag before building, uploads Sentry source maps before packaging, checks each package, validates final updater metadata and asset bytes, creates checksums and provenance, stages the mirror transaction, and promotes the GitHub draft last. electron-builder remains on `--publish never`; the final upload happens only after macOS notarization rewrites the DMG and updater metadata.

The Microsoft Store AppX lane remains manual. Dispatch `store-appx.yml` for the published tag, download both artifacts, then submit them in Partner Center as described in [Microsoft Store packages](release-guardrails.md#microsoft-store-packages).

## Dry run

Dispatch `Release` with `dry_run=true` to build the same five packages and exercise draft asset validation and the mirror transaction under a unique drill version. The run reports that protected-main and exact-SHA CI gates are bypassed for branch dry runs. It keeps the GitHub release as a draft, uses a run-specific mirror prefix and channel, verifies the stable channel was not changed, and cleans up the draft, drill tag, and mirror prefix. It does not run on a schedule and does not publish a real release.

A branch dry run cannot use secrets or environments restricted to protected branches or tags. The affected signing, notarization, Sentry upload, or mirror steps will be reported by the run; do not weaken environment protections to make a branch run pass.

## Status and recovery

Check a release with:

```sh
pnpm run release:status vX.Y.Z
```

The command reports the tag, draft or public state, expected assets, checksums, the release workflow run, and the mirror pointer. For a failed run, fix the cause and re-run the workflow for the same existing tag. Immutable uploaded assets are compared with the new local files before reuse; mismatching bytes stop the recovery.

After promotion, follow the [updater canary](release-updater-canary.md) on each published updater feed. A draft proves package and mirror handling but cannot prove that an installed client sees a public update.
