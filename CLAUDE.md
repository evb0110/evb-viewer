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
