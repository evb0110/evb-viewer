# ADR 0009: lint runs on OxLint

- Status: accepted (2026-11-12)

## Context

Agents write and maintain this repository. Formatting and naming checks do not
justify keeping a second TypeScript program in memory. The supplied cold Mac
ESLint baseline took 117.73 s and 5.4 GiB; a fresh run on the migration worktree
with Node 26 took 132.56 s and 5.0 GiB. CI allocated a 6 GiB Node heap, and a
recent lint job exceeded its 15-minute deadline. Unsafe-assignment checks alone
accounted for 37% of measured rule time, import boundaries 17%, and naming plus
formatting 14%.

## Decision

Run OxLint 1.91.0 for JavaScript, TypeScript and Vue scripts. Select individual
rules that catch defects or protect documented architecture in `.oxlintrc.json`;
formatting, naming and unsafe-any families are removed. TypeScript and vue-tsc
remain the typechecking owners. Stylelint is unchanged.

Move import-boundary zones into `.dependency-cruiser.cjs`, retaining generated
owner directories, public entrypoints and composition-root exceptions. Cruise
type imports for boundaries while checking cycles only through runtime edges.
Scripts may import Electron types; the existing exact-fixture stager may reuse
the app's native-tool path resolver and fsync helper. These were pre-existing
edges that ESLint missed, not new product dependencies.

Use native restrictions for shared package entrypoints, typed i18n, platform
access, portable contracts and diagnostic sinks. A small OxLint JS plugin keeps
AST invariants for annotation ownership, platform capabilities, workspace format
dispatch, component placement, core timers, shared failure presentation and
real-input E2E evidence. Existing diagnostic-timer and drawing-oracle exceptions
remain narrow. JS plugins see extracted Vue scripts, not template ASTs.

Reject type-aware linting for now. OxLint with oxlint-tsgolint 7.0.2006 took
8.66 s and 5.4 GiB; serial execution took 19.35 s and 4.8 GiB. Planted floating
promises were detected under the app, scripts, Electron and landing tsconfigs,
but the same violation in a Vue SFC script was missed. Neither memory nor Vue
coverage meets the migration's acceptance condition.

## Consequences

`pnpm run lint` runs OxLint, dependency-cruiser and Stylelint. `lint:clean` makes
Stylelint cold; OxLint has no result cache. `lint:fix` and lint-staged use OxLint's
safe fixes. CI keeps its existing steps and deadline, without the lint job's
6 GiB heap override. Unused disable directives fail lint.

Vue template rules from ESLint are not retained, including the red-alert
presentation visitor; script calls still use the shared failure presenter.
Type-aware promise and exhaustiveness linting is absent. Typechecking and
behavior tests remain necessary. Rule additions are explicit and continue to
follow the publication policy.
