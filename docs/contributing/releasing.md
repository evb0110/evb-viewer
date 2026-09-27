# Releasing

Run the command from any checkout of the repository:

```sh
pnpm run release:cut -- patch
```

Use `minor` or `major` for the corresponding version change. The cutter fetches `origin/main`, chooses the newest commit with a successful exact-SHA `ci.yml` push run and green `gates_ok` that descends from the previous release tag, computes the next version from the newest stable tag, and pushes a lightweight tag. It does not write a version commit or dispatch a workflow. The tag starts `.github/workflows/release.yml`.

Run the same candidate selection and release checks without pushing the tag:

```sh
pnpm run release:cut -- patch --preflight
```

To recover a workflow for a tag that already exists, dispatch `Release` with that tag. The workflow validates that the tag points to a commit on `main` and waits for that commit's exact-SHA CI verdict before packaging.

## Release workflow

One tag-triggered workflow packages five targets in parallel: macOS arm64 (Developer ID signed and notarized DMG plus updater ZIP), Windows x64 and ARM64 (NSIS), and Linux x64 and ARM64 (deb). It sets the package version from the tag before building, uploads Sentry source maps before packaging, checks each package, validates final updater metadata and asset bytes, creates checksums and provenance, stages the mirror transaction, and promotes the GitHub draft last. electron-builder remains on `--publish never`; the final upload happens only after macOS notarization rewrites the DMG and updater metadata.

The Microsoft Store AppX lane remains manual. Dispatch `store-appx.yml` for the published tag, download both artifacts, then submit them in Partner Center as described in [Microsoft Store packages](release-guardrails.md#microsoft-store-packages).

## Dry run

Dispatch `Release` with `dry_run=true` to run the same five package jobs, exact-SHA lookup, draft validation and mirror transaction under a unique drill version. If the candidate has no exact-SHA push run on main, the lookup reports a notice; API, authentication and permission errors fail the run. The drill keeps its GitHub release as a draft, uses a run-specific mirror prefix and channel, verifies the stable channel was not changed, checks the public updater route when it serves the drill prefix (otherwise it reads the isolated objects through the mirror client), and cleans up the draft, drill tag and mirror prefix. The packaged core smoke includes an English OCR job and requires the recognized word `lantern` on each target.

After a real release becomes public, the workflow fetches GitHub's latest release and the same updater channel, release manifest and asset route used by the app. All must name the new tag and serve an asset. The daily public mirror health check reports failures through one `release-mirror-health` issue and closes it after recovery.

## Status and recovery

Check a release with:

```sh
pnpm run release:status vX.Y.Z
```

The command reports the tag, draft or public state, expected assets, checksums, the release workflow run, and the mirror pointer. For a failed run, fix the cause and re-run the workflow for the same existing tag. Immutable uploaded assets are compared with the new local files before reuse; mismatching bytes stop the recovery.

After promotion, follow the [updater canary](release-updater-canary.md) on each published updater feed. A draft proves package and mirror handling but cannot prove that an installed client sees a public update.
