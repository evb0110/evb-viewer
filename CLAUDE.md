# Project Instructions

## Vue Scoped Styles

**Rule**: Do not use SCSS parent selector concatenation (`&-` or `&_`) in Vue components.

Vue scoped styles eliminate the need for BEM methodology. Use flat, descriptive class names instead.

```scss
// BAD - any parent selector concatenation
.sidebar {
    &-header { ... }
    &_content { ... }
    &__element { ... }
    &--modifier { ... }
}

// GOOD - flat class names
.sidebar { ... }
.sidebar-header { ... }
.sidebar-content { ... }
.sidebar.is-active { ... }
```

For state variations, use separate state classes (`.is-active`, `.is-loading`) that combine with the base class.

This rule is enforced by stylelint via `selector-nested-pattern`.

## OCR Architecture & Design

**Principle**: Optimize for robustness and quality without constraints on tool choice, language, or bundle size.

For the OCR system (PDF processing, text extraction, searchable PDF generation):
- Choose best tools regardless of language (Python, Node.js, native binaries, etc.)
- Bundle anything needed - size is not a constraint
- Prioritize quality of output and reliability over minimalism
- This applies to the entire architecture: PDF rendering, image preprocessing, OCR execution, text embedding, and PDF assembly

## Tesseract Language Models

**Rule**: Always use `tessdata-best` models for maximum OCR accuracy.

When adding new language support to the OCR system:
1. Download from the official repository: `https://github.com/tesseract-ocr/tessdata_best`
2. Use the direct raw URL: `https://github.com/tesseract-ocr/tessdata_best/raw/main/{lang}.traineddata`
3. Place the model in `resources/tesseract/tessdata/`
4. Add the language to `AVAILABLE_LANGUAGES` in `electron/ocr/ipc.ts`

**Model quality tiers** (always choose "best"):
- `tessdata_best` (~10-15MB per language) - highest accuracy, required for this project
- `tessdata` (~1-4MB) - standard accuracy, not recommended
- `tessdata_fast` (~1-2MB) - fastest but lowest accuracy, never use

The "best" models use float LSTM weights and provide significantly better accuracy for complex scripts (Arabic, Hebrew, CJK) with contextual letter forms.

## Icon Bundling

**Rule**: When adding or changing icons, always verify they are included in the client bundle.

Icons must be added to `clientBundle.icons` in `nuxt.config.ts`. Without this, icons will attempt to fetch from the Iconify API at runtime, which violates CSP in Electron.

**Before using a new icon:**
1. Check if `lucide:<icon-name>` exists in `nuxt.config.ts` → `icon.clientBundle.icons`
2. If not, add it to the array
3. Rebuild to verify no CSP violations

```typescript
// In nuxt.config.ts
icon: {
    clientBundle: {icons: [
        // ... existing icons
        'lucide:new-icon-name',  // Add new icons here
    ]},
},
```

## Task Completion Checks

**Rule**: A task is not complete until all repository checks pass.

Before considering any implementation task done, run:
```bash
pnpm lint && pnpm typecheck
```

Both must exit with zero errors. Fix any issues introduced by your changes before reporting completion. This applies to all code changes — features, bug fixes, refactors, and style updates.
