# Releasing

Run one command from a clean `main` checkout:

```sh
pnpm run release:cut patch
```

Use `minor` or `major` when that is the intended version change. The checkout does not have to sit at the `origin/main` tip, and nothing has to be green at the moment you run it: the cutter releases the newest commit on `origin/main` that CI has already verified.

## What the command does

The cutter picks the release candidate, checks it, then publishes a release commit built from it.

- **Candidate.** The newest commit on freshly fetched `origin/main` whose `ci.yml` push run succeeded with a green `gates_ok`. Only push runs count; a `workflow_dispatch` run carries no `gates_ok`. A tip whose run is still in progress is skipped in favour of the newest finished green commit behind it, so a cut never waits on CI. If no commit qualifies, the cutter names every run it rejected and stops.
- **Newer than the last release.** The candidate must descend from the commit the newest release tag was built from, and must not be that commit. Otherwise there is nothing to cut.
- **Version.** The next version is bumped from the greater of the candidate's `package.json` version and the newest `vX.Y.Z` tag. The tag wins when main was released from a commit that predates the last version carry.
- **Canary.** The latest artifact canary run (`release-artifacts.yml`) on `main` succeeded. Push CI proves packaging on Linux only; the canary is the macOS and Windows proof, and a red one means the release would fail at the same platform step.
- **Release state.** The current-version GitHub release is not a draft, and the next tag does not exist.

The release commit is `release: <version> [skip ci]` with the candidate as its parent. It changes exactly one line, the `package.json` version, and is written with git plumbing, so the checkout and its worktree stay untouched. The cutter scans that one commit with the publication policy checker, pushes the lightweight tag `vX.Y.Z` at it, and dispatches `release.yml` with the commit SHA. The command prints the run and release links once the workflow appears.

The version is then carried to `main`. When `origin/main` still sits at the candidate, the release commit fast-forwards it, as before. When main moved on, a fresh version-only commit on the current tip carries the number instead, and a push that loses to another writer is retried from the new tip. Finally the local `main` is fast-forwarded to `origin/main`. Should every carry attempt fail, the release is still tagged and dispatched; `pnpm run release:resume` retries the carry, and the next cut reads the newest tag, so a stale `package.json` on main cannot reuse a version.

The cutter owns the tag because the workflow cannot create it. GitHub requires the `workflows` scope to point a new ref at a commit that is behind the `main` tip in `.github/workflows/`, and the built-in workflow token never has that scope. The workflow requires the tag at the target and creates the release against it without naming a target commit.

`release.yml` accepts a target that is on protected `main`, or a version-only `package.json` commit whose parent is. It then judges a version-only commit by its parent's push run at once, without waiting for a run that `[skip ci]` guarantees will never appear. Core packaging, checksum creation, mirror staging, and public promotion run in the core release workflow.

The supplemental workflow attaches the macOS Intel ZIP and the Windows ARM64 installer and provenance after promotion, copies whatever it attached to the release mirror, and builds the Microsoft Store AppX packages as workflow artifacts; nothing submits them to the Store. It is dispatched automatically. A rerun skips the build of every asset the release already holds and verifies the attached copy instead, so it is safe to repeat, and it repairs a missing mirror copy on the way:

```sh
gh workflow run release-supplemental.yml -f tag=vX.Y.Z
```

The release preflight (`node scripts/release/release-cut-preflight.mjs`, also a `run-all-gates` stage) answers every question above without publishing anything. `pnpm run release:verify` remains available as a developer tool when a packaging change needs local proof. Neither is part of `release:cut`.

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

Resume repairs the newest release tag from any clean `main` checkout:

```sh
pnpm run release:resume
```

It fetches tags, takes the newest `vX.Y.Z`, and checks that the tagged commit is a version-only commit whose parent is on `origin/main`. While the release is missing or still a draft, the same tag and SHA are dispatched again and any accepted assets remain in place. A tag that already points at the release commit is reused; a tag that points anywhere else stops the resume before dispatch. Then the version is carried to `main` if main is still behind it. A release that is already public and already carried is not touched; check it with `release:status` and repair only the missing supplemental work.

## When a release run is red

| Failing job or area | Action |
| --- | --- |
| `prepare` reports the target is not on `main` | The tagged commit is neither on `origin/main` nor a version-only commit over a commit that is. Only the cutter produces valid targets; run `pnpm run release:cut` again rather than dispatching by hand. |
| `prepare` or exact-SHA CI | Inspect the run URL. A release parent whose push run was cancelled has no verdict; `gh run rerun <id>` it and `pnpm run release:resume`. A parent without a run never happens for a cutter release, because the cutter picked the parent from finished runs; check the Actions page for that commit if it does. |
| A packaged or installed core-PDF journey in the build matrix | Read the step log for the journey, not the packaging. If the verifier or the app behaviour it asserts is wrong, fix it and push; push CI's packaged Linux proof runs the same journey on that commit, so wait for it before cutting again. Do not loosen the journey to get the release out. |
| Core package, validate, checksum, mirror, or promotion job | Rerun failed jobs on the same run. If a stale draft remains, run `pnpm run release:resume`. Do not create a new version for an infrastructure retry. |
| `prepare` reports that the tag does not exist on origin | The release was dispatched without the cutter, or the tag was deleted. Run `pnpm run release:resume`; it pushes the tag with your credentials and redispatches. Do not create the tag from a workflow. |
| Stage GitHub Release fails with `HTTP 403: Resource not accessible by integration` | The workflow tried to point a new ref at a commit behind the workflow files on `main`. That happens only when the cutter that dispatched the run predates tag ownership. Run `pnpm run release:resume` with the current cutter. |
| The cutter reports the carry to `main` failed | The release is tagged and dispatched. Run `pnpm run release:resume` once the push obstacle is gone; it carries the version without redispatching a public release. |
| macOS Intel, Windows ARM64, or Store supplemental job | The core release can remain public. Check the missing assets with `release:status`, then rerun `gh workflow run release-supplemental.yml -f tag=vX.Y.Z`. Assets already attached are verified, not rebuilt. |
| A release is already public but the status is incomplete | Keep the tag. Repair the named missing asset or supplemental workflow and use `release:status` again. |
