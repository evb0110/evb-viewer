# Project 8 coverage baseline refresh

Review date: 2026-09-11

Ticket: [#538](https://github.com/evb0110/evb-viewer/issues/538)

Tested SHA: `27d49e24d892471841f552451d9263342dfe8794`

## Fresh measurement

The existing normal coverage command was run once from the campaign branch:

```text
pnpm run test:coverage
```

The command selected the seven configured coverage projects from
`package.json`: `unit-core`, `unit-app`, `unit-electron`, `unit-scripts`,
`unit-policy`, `unit-static-architecture`, and `unit-landing`.

The run completed after 345.73 seconds with 1,234 test files passing, three
skipped, and one failing. It exercised 11,211 tests: 11,191 passed and 19
skipped. The failure was:

```text
|unit-scripts| tests/unit/scripts/releaseShared.test.ts
rejects a lower manifest when a release tag is reachable through a merge parent
Error: Command failed: git tag v99.0.0
error: Terminal is dumb, but EDITOR unset
Please supply the message using either -m or -F option.
```

The failing test creates a temporary Git repository and asks `git tag` to
create an annotated tag. The VPS environment has no `EDITOR`, so Git stops for
an editor instead of completing the fixture. This is an environment/setup
failure, not evidence of a coverage regression. The run therefore produced no
publishable coverage summary and must not refresh thresholds or baseline
counts.

A focused retry with `GIT_EDITOR=true` also failed in 464 ms, with five tests
passing and the same test failing because Git reported `fatal: no tag message?`.
An environment variable alone cannot repair this fixture; it needs an explicit
tag-message argument or a test-owned command seam.

## Reconciliation and gaps

This run proves the current seven-project selection and gives a fresh exact-SHA
test count. It does not satisfy the ticket's metric comparison or baseline
refresh criteria because the normal command was not green and no coverage
summary was emitted.

The next safe step is to repair or explicitly configure the temporary Git tag
fixture under its owning release-test scope, then rerun this same command with
the same seven projects. The independent #473 pointer-policy prerequisite and
any hosted CI result remain coordinator-owned. No threshold, exclusion, test
selection, or source behavior changed here.
