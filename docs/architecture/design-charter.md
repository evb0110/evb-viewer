# Design charter

These are the binding design rules for this repository. They apply to reviewers
as well as authors: a change that violates one of them is wrong even when it is
small, local, and passes every gate. `.coderabbit.yaml` points its per-path
review instructions here.

## Design

- Prefer deletion and reuse. Inline one-consumer abstractions rather than adding
  interfaces, ports, adapters, wrappers, barrels, or files.
- Give each state and lifecycle one owner. Derive other views; do not synchronize
  duplicate containers.
- Validate only at trust boundaries. Reuse contract schemas and do not add another
  representation, clone, or validation pass inside the same process.
- Extend shared platform, operation, progress, codec, scheduler, and test mechanisms
  in place instead of creating feature-local copies.
- Split responsibilities, not files. New layers must replace old ones, and temporary
  compatibility code must state its removal condition.
- Test observable invariants with shared harnesses, at the layer that can see the
  defect: geometry, lifecycle and interaction defects need the real app with real
  input, and one adequate real-app proof per scenario is enough.
- Revert failed approaches instead of patching around them. After a fix, delete
  what it made dead. When the same file has taken three fix commits in seven
  days, the next change there removes a path or reverts; it does not add another
  fence, flag, timer, retry or generation counter.
- Prefer generation when two representations of one shape can drift, for example
  TypeScript mirrors of Rust wire types.
- Wire shapes, schemas and guards for IPC, workers and native tools live in
  `packages/contracts`, imported through an owned `@contracts/<subpath>` entry
  point. Contracts depend only on themselves and `@i18n-core`. Domain algorithms
  belong in their owning module.
- Native tools write into managed scratch. Electron or Node validates the result
  and publishes it atomically, so an interrupted tool never leaves a partial file
  at a path the user chose.

## OCR

- OCR quality and robustness take priority over tool, language, or bundle-size
  constraints.
- Use `tessdata-best` models from <https://github.com/tesseract-ocr/tessdata_best>.
- OCR language models and the canonical registry stay in sync.

## UI

- Use design tokens from `app/assets/css/main.css`; raw CSS values do not belong in
  components.
- Localize UI-facing text with `t()` and update all nine locale message files in
  the same change.
- Register every icon in `clientBundle.icons` in `nuxt.config.ts`.

## Native and CI

- Local gates passing does not cover CI-only Rust checks that use a different
  toolchain: run `cargo fmt --check` and `cargo clippy` before committing Rust.
- After native scan-cleanup changes, local green from `cargo test --release` is not
  sufficient evidence for CI: the integration targets under `native/*/tests/` (for
  example `page_cli.rs`) must explicitly reflect intentional behavior changes. A
  behavior-pinning test that still passes locally can fail on CI's build, and an
  intentional change updates its pins in the same commit.
