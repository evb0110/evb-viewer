# Scan-cleanup behavior checks

Use the affected scan-cleanup oracles when a change needs proof of generated PDF
content, placement, rendering, or preservation of text and strokes:

```bash
pnpm run test:scan-cleanup:affected-oracles
```

The command compares work against the Git upstream and includes uncommitted
changes. An empty post-push diff does not test the published patch. CI selects
these checks for affected changes. Reuse that result instead of requiring a
duplicate local run. While editing, run the particular failing oracle or test
that exercises the change. A new ledger entry is not required.
