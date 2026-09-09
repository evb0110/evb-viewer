# Design Principles

EVB Viewer is a large cross-process application. These principles keep changes
comprehensible as features cross the renderer, Electron, workers, native tools,
and serialized formats.

- Prefer deleting or extending existing code over adding a parallel mechanism.
  A new layer should replace an old one, not sit beside it.
- Give each piece of state and each lifecycle one owner. Other views derive from
  that owner instead of mirroring it through callbacks or copies.
- Define serialized, IPC, worker, and cross-process domain shapes in
  `packages/contracts`. Validate at trust boundaries; do not revalidate or clone
  an already typed representation inside one process.
- Import contracts through an owned `@contracts/<subpath>` entry point. The
  contracts package has no root barrel, and package aliases use one canonical
  spelling in source and tooling.
- Inline single-consumer interfaces, adapters, factories, barrels, and wrappers.
  Split files by responsibility, not merely to satisfy a size limit.
- Prefer generation when two representations can drift. Temporary compatibility
  layers must state a concrete removal condition.
- Test observable behavior and invariants at the narrowest useful layer, with at
  most one real-app proof for the same scenario. Reuse the shared test harnesses.
- Give structural changes an independent fresh-context review, and review public
  surfaces as product interactions rather than as component snapshots.
- Treat revert as a first-class outcome. Remove a failed approach instead of
  layering compensating machinery over it; after a fix, delete what it made dead.
- Native tools write into managed scratch. Electron or Node validates the result
  and publishes it atomically to the user-selected destination, so a failed or
  interrupted tool never leaves a partial file at a path the user chose.

The architecture boundary and dependency checks, the bundle static-integrity
check, and the commit/push artifact checks enforce the mechanical subset of
these principles. The remainder are review criteria, not reasons to add more
one-off gates.

## Boundary exception policy

`scripts/architecture/boundaryExceptionPolicy.mjs` contains the small set of
permitted diagnostic edges, private-access paths, and one retained PDF viewer
engine back edge. `boundary-check.mjs` consumes those constants directly. All
other imports remain subject to the regular boundary rules.
