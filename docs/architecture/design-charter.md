# Design charter

These are the binding design rules for this repository. They outrank convenience,
and they apply to reviewers as well as authors: a change that violates one of them
is wrong even when it is small, local, and passes every gate.

Until now these rules lived only in the untracked agent-instruction file, so no
reviewer working from a clone — human or automated — could read them. This document
is the tracked home for them; `.coderabbit.yaml` points its per-path review
instructions here. The rules themselves are unchanged, and the reasoning behind the
architecture rules is recorded in
[`docs/internal/architecture-audit-2026-07-23.md`](../internal/architecture-audit-2026-07-23.md).

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
- Test observable invariants with shared harnesses; use at most one real-app proof
  per scenario. Revert failed approaches instead of patching around them.

## OCR

- OCR quality and robustness take priority over tool, language, or bundle-size
  constraints.
- Use `tessdata-best` models from <https://github.com/tesseract-ocr/tessdata_best>.
- OCR language models and the canonical registry stay in sync.

## UI

- Use design tokens from `app/assets/css/main.css`; raw CSS values do not belong in
  components.
- Localize UI-facing text with `t()`, and update the English and Russian message
  files together.
- Register every icon in `clientBundle.icons` in `nuxt.config.ts`.

## Native and CI

- Local gates passing does not cover CI-only Rust checks that use a different
  toolchain: run `cargo fmt --check` and `cargo clippy` before committing Rust.
- After native scan-cleanup changes, local green from `cargo test --release` is not
  sufficient evidence for CI: the integration targets under `native/*/tests/` (for
  example `page_cli.rs`) must explicitly reflect intentional behavior changes. A
  behavior-pinning test that still passes locally can fail on CI's build, and an
  intentional change updates its pins in the same commit.
