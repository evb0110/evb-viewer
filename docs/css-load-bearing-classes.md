# Load-Bearing CSS Classes

CSS classes in this project that are **queried at runtime from JavaScript** (via `querySelector`, `querySelectorAll`, `closest`, or class-toggle logic). Renaming any of these requires a synchronized update of **all consumers**.

## Runtime-Queried Classes

| Class | Query method | Approx. consumer files |
|---|---|---|
| `page_container` | querySelector / closest / querySelectorAll | 37 |
| `page_container--rendered` | classList toggle | 2 |
| `text-layer` / `textLayer` | querySelector / closest (dual) | 18+ |
| `page_canvas` / `canvasWrapper` | querySelector (dual) | 4+ |
| `annotation-layer` / `annotationLayer` | querySelector (dual) | 2+ |
| `annotation-editor-layer` / `annotationEditorLayer` | querySelector / closest (dual) | 1+ |
| `pdf-page-skeleton` | querySelector | 2 |
| `pdf-thumbnail` | querySelectorAll | 3+ |
| `pdf-word-box` | className assignment | 2+ |
| `pdf-word-box--current` | classList toggle | 2+ |
| `pdf-word-boxes-layer` | querySelector | 1 |
| `pdf-ocr-debug-box` | querySelectorAll | 1 |
| `pdf-ocr-debug-layer` | querySelector | 1 |
| `pdf-search-highlight--current` | querySelector | 2 |
| `pdf-comment-focus-pulse` | querySelectorAll | 1 |
| `pdf-image-placement` | closest | 1 |
| `end-of-content` | querySelectorAll | 1 |

### Finding consumers

```bash
# Example: find all files referencing a load-bearing class
rg --type ts --type vue 'page_container' -l
```

PDF viewer-owned selector constants and page lookup helpers live in
`app/modules/pdf-viewer/dom/pdf-viewer-dom/`. Prefer those helpers for new
viewer runtime/rendering code so selector ownership stays explicit.

## Dual camelCase / kebab-case Convention

`app/modules/pdf-viewer/components/PdfViewerPage.vue` emits **both** naming
formats on PDF.js layer elements:

```html
<div class="text-layer textLayer" />
<div class="annotation-layer annotationLayer" />
<div class="annotation-editor-layer annotationEditorLayer" />
<div class="page_canvas canvasWrapper" />
```

**Why:** pdfjs-dist (currently v5.7.304 from the committed EVB fork) internally uses camelCase class names (`textLayer`, `annotationLayer`, `annotationEditorLayer`). PDF.js's own CSS and JS reference these names. The kebab-case variants (`text-layer`, `annotation-layer`, `annotation-editor-layer`) are the app's convention for custom styling and JS queries.

Both formats must be preserved. CSS selectors and JS queries throughout the codebase target one or both:

```css
/* pdfjs-overrides.scss and PdfViewer.vue style both */
.pdfViewer .annotation-editor-layer,
.pdfViewer .annotationEditorLayer { ... }
```

```typescript
// useAnnotationHighlight.ts queries both
element.closest('.text-layer, .textLayer')
```

The sanitized PDF.js viewer CSS is regenerated from the installed local
`vendor/pdfjs-dist` tarball with `pnpm run copy:pdfjs`. The complete package is
not a web asset. Keep the generated CSS and its referenced `public/pdfjs/images/`
files in sync, and run the provenance verifier before accepting a PDF.js
artifact update. The artifact is not published to npm. Human legal review is
required for upstream modification notices and third-party assets.

**History:** Introduced deliberately in commits `1c095e3`, `12c3f2e`, `853d900` as a robustness pattern.

## Accepted Exceptions

### SVG cursor data URIs (PdfImagePlacementOverlay.vue)

Lines ~198-204 contain hardcoded colors (`fill="#0f172a"`, `stroke="white"`) inside SVG strings used as CSS `cursor: url(data:image/svg+xml,...)` values. CSS custom properties **cannot be used inside data URI strings**, so these are an accepted exception to the design token rule. The colors are functional (dark icon on light halo for visibility on any background), not theme-dependent.
