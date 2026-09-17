# Scan-cleanup behavior checks

Use the affected scan-cleanup oracles when a change needs proof of generated PDF
content, placement, rendering, or preservation of text and strokes:

```bash
pnpm run test:scan-cleanup:affected-oracles
```

The command compares work against the Git upstream and includes uncommitted
changes. An empty post-push diff does not test the published patch. CI selects
these checks when the changed-area policy matches any of the following:

- `packages/scan-cleanup/**` or `app/modules/scan-cleanup/**`;
- the native scan-cleanup crates and their shared native dependencies; or
- the scan-cleanup scripts, fixtures, diagnostics, and oracle harnesses.

Reuse that result instead of requiring a duplicate local run. While editing,
run the particular failing oracle or test that exercises the change. A new
ledger entry is not required.

The export gate uses the existing one-page scanned fixture and generated RGB
fixture for focused checks, then runs preview assertions over
`tests/fixtures/release/scan-cleanup-four-page-grayscale.pdf` pages 1–4. The
one-page and RGB word-loss audits remain blocking with `--fail-on any`; the
release fixture is used for its four-page grayscale preview/content surface
because its grayscale-only pages are outside the word-loss audit's text-mask
contract. No new binary corpus is required.
