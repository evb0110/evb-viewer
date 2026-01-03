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
