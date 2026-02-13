# Project Instructions

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

## Design System

**Rule**: Follow design system principles. Never hardcode CSS values — use design tokens.

All visual values (colors, shadows, spacing, radii, etc.) must reference design tokens defined in `app/assets/css/main.css`. When a new visual value is needed:

1. Add a CSS custom property to the appropriate section in `main.css`:
   - Brand palette → `@theme` block (Tailwind v4 theme tokens)
   - Semantic/app-level tokens → `:root` block (with `.dark` override if needed)
2. Reference the token in component styles via `var(--token-name)` or the corresponding Tailwind utility
3. Never use raw color values (`#fff`, `oklch(...)`, `rgb(...)`) or magic numbers directly in component `<style>` blocks or inline styles

**Adding a new token:**
```css
/* In main.css — @theme for Tailwind-integrated tokens */
@theme {
    --color-brand-new: oklch(...);
}

/* In main.css — :root for semantic app tokens */
:root {
    --app-new-surface: var(--color-brand-200);
}
.dark {
    --app-new-surface: var(--color-brand-800);
}
```

**In components — always reference tokens:**
```scss
/* GOOD */
.panel { background: var(--app-chrome); }

/* BAD — hardcoded value */
.panel { background: oklch(95% 0.01 235); }
```

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

## Skill Maintenance

**Rule**: If the `electron-puppeteer` skill stops working, investigate and fix it.

The skill at `.claude/skills/electron-puppeteer/SKILL.md` documents how to launch, interact with, and verify the Electron app. If the skill's commands fail or produce unexpected results:

1. Diagnose the root cause (stale process, missing build step, changed API, etc.)
2. Fix the underlying scripts or configuration
3. Update `SKILL.md` to reflect the fix so the documentation stays accurate
4. Verify the skill works again before continuing with other tasks

Do not work around a broken skill — fix it so all future sessions benefit.

## Task Completion Checks

**Rule**: A task is not complete until all repository checks pass.

Before considering any implementation task done, run:
```bash
pnpm lint && pnpm typecheck
```

Both must exit with zero errors. Fix any issues introduced by your changes before reporting completion. This applies to all code changes — features, bug fixes, refactors, and style updates.

## Dead Code Detection (Knip)

**Rule**: Run `pnpm validate` (which includes `pnpm knip`) after major changes — refactors, feature completions, or dependency changes. Do not run it after every small step or individual stage.

Knip finds unused files, exports, types, and dependencies. Configuration lives in `knip.json`. When Knip reports something unused, remove it rather than suppressing with `_` prefixes (the `_` prefix is only acceptable for positional parameters where a later parameter is needed).
