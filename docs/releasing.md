# Releasing

Run one command from a clean, green `main` checkout:

```sh
pnpm run release:cut patch
```

Use `minor` or `major` when that is the intended version change.

## What the command checks

Before changing `package.json`, the cutter checks the following.

- The checkout is clean, the branch is `main`, and `HEAD` equals freshly fetched `origin/main`.
- `ci.yml` passed for that exact `HEAD`. A running check is awaited. Every push to `main` runs `ci.yml`, so a `HEAD` without a run is one whose run has not appeared yet; the cutter waits up to a minute for it.
- The latest artifact canary run (`release-artifacts.yml`) on `main` succeeded. Push CI proves packaging on Linux only; the canary is the macOS and Windows proof, and a red one means the release would fail at the same platform step.
- The current-version GitHub release is not a draft, and the next tag does not exist.

The cutter then writes only the new package version and creates `release: <version> [skip ci]`. The commit is pushed, the cutter pushes the lightweight tag `vX.Y.Z` at that commit, and `release.yml` is dispatched with that commit SHA. The command stops after the workflow appears and prints the run and release links.

The cutter owns the tag because the workflow cannot create it. GitHub requires the `workflows` scope to point a new ref at a commit that is behind the `main` tip in `.github/workflows/`, and the built-in workflow token never has that scope. Before the cutter pushed the tag, any workflow change merged during the release window made the draft creation fail with `HTTP 403: Resource not accessible by integration`. The workflow now requires the tag at the target and creates the release against it without naming a target commit.

The release workflow waits for exact-SHA CI. For a version-only release commit with `[skip ci]`, it accepts a successful `gates_ok` run from the parent commit. Core packaging, checksum creation, mirror staging, and public promotion run in the core release workflow.

The supplemental workflow attaches the macOS Intel ZIP and the Windows ARM64 installer and provenance after promotion, copies whatever it attached to the release mirror, and builds the Microsoft Store AppX packages as workflow artifacts; nothing submits them to the Store. It is dispatched automatically. A rerun skips the build of every asset the release already holds and verifies the attached copy instead, so it is safe to repeat, and it repairs a missing mirror copy on the way:

```sh
gh workflow run release-supplemental.yml -f tag=vX.Y.Z
```

`pnpm run release:verify` remains available as a developer tool when a packaging change needs local proof. It is not part of `release:cut`.

## What is proven before the cut

A release run must never be the first execution of one of its own checks. Three mechanisms keep it that way.

- Push CI runs the packaged Linux proof (`pr_packaged_linux`) whenever the packaged core-PDF verifier, its E2E helpers, `electron-builder.yml`, the bundling scripts, the build workflows, or the dependency manifests change. It is the same `build-target.yml` job the release matrix runs on Linux x64, without the artifact upload. A verifier or packaging mistake fails that commit's CI, not the next release.
- The artifact canary (`release-artifacts.yml`) packages the current `main` tip on every platform once a day when `main` changed in the last 24 hours. It covers drift the path filter does not catch.
- The dependency audit runs daily in `dependency-audit.yml`, never on push CI or the release path. It maintains one open issue labelled `dependency-audit`. An advisory published five minutes ago is not a reason to stop a cut; fix it as ordinary dependency work.

Windows-, macOS-, and signing-specific steps run in the canary and in the release. When one of them fails on a code or verifier change, fix it, push, run `pnpm run release:artifacts` from the fixed `main` tip, and cut once that canary run is green. The cutter refuses a red or running canary, so a platform break can no longer ride into a release unnoticed.

## Check a release

Use the read-only status command for one-screen state:

```sh
pnpm run release:status vX.Y.Z
```

It reports the tag, draft or public release state, publication time, core and supplemental assets, `SHA256SUMS`, both workflow runs, and the mirror pointer when local mirror credentials are configured. Exit code 0 means the public core release is complete. Exit code 1 means it is not.

## Resume a failed release

Use resume only from the release commit for the current package version:

```sh
pnpm run release:resume
```

Resume checks that `HEAD` is the version-only release commit and that it exists on `origin/main`. The same tag and release SHA are dispatched again while any draft and its accepted assets remain in place. A tag that already points at the release commit is reused; a tag that points anywhere else stops the resume before dispatch. An already-public release is not redispatched. Check it with `release:status` and repair only the missing supplemental work.

## When a release run is red

| Failing job or area | Action |
| --- | --- |
| `prepare` or exact-SHA CI | Inspect the run URL. Every push to `main` runs `ci.yml`, so a release parent without a run means its push run was cancelled or never appeared; check the Actions page for that commit. Only push runs count; a `workflow_dispatch` run of `ci.yml` executes the manual lanes and carries no `gates_ok`. A target with code changes needs a new green commit and version. |
| A packaged or installed core-PDF journey in the build matrix | Read the step log for the journey, not the packaging. If the verifier or the app behaviour it asserts is wrong, fix it and push; push CI's packaged Linux proof runs the same journey on that commit, so wait for it before cutting again. Do not loosen the journey to get the release out. |
| Core package, validate, checksum, mirror, or promotion job | Rerun failed jobs on the same run. If a stale draft remains, run `pnpm run release:resume` from the release commit. Do not create a new version for an infrastructure retry. |
| `prepare` reports that the tag does not exist on origin | The release was dispatched without the cutter, or the tag was deleted. Run `pnpm run release:resume` from the release commit; it pushes the tag with your credentials and redispatches. Do not create the tag from a workflow. |
| Stage GitHub Release fails with `HTTP 403: Resource not accessible by integration` | The workflow tried to point a new ref at a commit behind the workflow files on `main`. That happens only when the cutter that dispatched the run predates tag ownership. Run `pnpm run release:resume` from the release commit with the current cutter. |
| macOS Intel, Windows ARM64, or Store supplemental job | The core release can remain public. Check the missing assets with `release:status`, then rerun `gh workflow run release-supplemental.yml -f tag=vX.Y.Z`. Assets already attached are verified, not rebuilt. |
| A release is already public but the status is incomplete | Keep the tag. Repair the named missing asset or supplemental workflow and use `release:status` again. |
