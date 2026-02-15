# Build Warning Triage

Date: 2026-02-15

## Current warning classes

1. `pdfjs-dist/web/pdf_viewer.css` emits unresolved `url(images/*.svg)` warnings during Vite build.
- Impact: low in current Electron runtime because assets are resolved at runtime by PDF.js stylesheet URLs.
- Action: tracked as upstream/vendor stylesheet behavior; no app logic regression.

2. `pdfjs-dist/web/pdf_viewer.css` emits PostCSS "Unmatched selector: %" warnings.
- Impact: low; warning originates from vendor CSS syntax edge-cases and has not blocked rendering.
- Action: tracked as vendor pipeline noise; keep monitoring after dependency upgrades.

3. Chunk-size warning for a large client bundle.
- Impact: low for desktop app runtime, but useful signal for development ergonomics.
- Action completed: added manual chunk splitting for heavy vendor dependencies and raised warning threshold for Electron context.

## Follow-up rule

If PDF viewer rendering regressions appear, prioritize replacing direct `pdfjs-dist` CSS import with a curated local copy and explicit static asset paths.
