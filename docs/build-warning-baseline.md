# Build Warning Baseline

## Status
- Date: February 18, 2026
- Policy: CI fails on unknown build warnings (`pnpm run build:strict`)
- Current baseline: zero allowlisted warnings

## Historical Context
The project previously emitted warnings from upstream `pdfjs-dist/web/pdf_viewer.css`:
- unresolved `images/*.svg` references that do not exist in `pdfjs-dist@5.4.530`
- PostCSS `Unmatched selector: %` warnings in built-in `newAltText` and `viewsManager` sections

Those warnings are mitigated by a generated sanitized stylesheet:
- Source: `node_modules/pdfjs-dist/web/pdf_viewer.css`
- Generated file: `app/assets/css/vendor/pdfjs-viewer-sanitized.css`
- Generator: `scripts/sync-pdfjs-viewer-css.mjs`

## Enforcement
Run:

```bash
pnpm run build:strict
```

This command:
1. builds Nuxt + Electron and captures output
2. checks warning output with `scripts/check-build-warnings.mjs`
3. fails if any warning is not explicitly allowlisted

## Updating the Baseline
If a new warning must be accepted temporarily:
1. add a regex pattern to `scripts/build-warning-allowlist.json`
2. document why + owner + expiry date in this file
3. remove the allowlist entry once fixed
