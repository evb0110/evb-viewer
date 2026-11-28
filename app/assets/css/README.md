# Stylesheet Layout

- `main.css` is the global Nuxt/Tailwind entry and design-token source.
- `vendor/**/*.css` is generated or third-party CSS.
- App-owned asset styles use `.scss`.
- Shared Sass modules use lower kebab-case partial names, for example `_settings-panel-shared.scss`, and are imported without the leading underscore; shared global component styles like `toolbar-menu.scss` are registered once in `nuxt.config.ts` to avoid duplicating rules inline across SFCs.
