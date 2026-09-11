# Project 8 locale equality review

Review date: 2026-09-11

Source under review: `876be7914` (`origin/project8/integration`)

Tickets: [#547](https://github.com/evb0110/evb-viewer/issues/547) and [#548](https://github.com/evb0110/evb-viewer/issues/548)

## Method

I compared each leaf in the English desktop catalog with the corresponding leaf
in `nl.ts`, `pt.ts`, `ptBr.ts`, and `ru.ts`. Plural objects were treated as one
message, not as separate `kind` and `forms` candidates. Equality is a review
signal, not a translation failure. Each equal leaf was checked against its
caller-facing meaning and grouped as a product name, format or unit, numeric
diagnostic template, shared UI term, or already translated semantic value.

The inventory was generated from the current files, so the older counts in the
ticket bodies are historical. The current leaf counts are:

| Locale | Equal leaves | Result |
| --- | ---: | --- |
| `nl` | 58 | No ordinary sentence remained. `Details`, `Help`, `Start`, `Privacy`, `Updates`, product names, units, and diagnostic templates are valid Dutch/shared terms in context. |
| `pt` | 50 | No ordinary sentence remained. `Manual`, `Original`, `Decimal`, `Layout`, product names, units, and diagnostic templates are valid Portuguese/shared terms in context. |
| `ptBr` | 52 | No ordinary sentence remained. `Manual`, `Original`, `Layout`, product names, units, and diagnostic templates are valid Brazilian Portuguese/shared terms in context. |
| `ru` | 27 | No ordinary sentence remained. The remaining values are product names, units, format names, and numeric diagnostic templates. |

The assistant status keys named by the tickets are already localized in all four
owned catalogs. The OCR and diagnostic labels that remain equal are short
technical labels or values containing placeholders and units. The Dutch PDF
optimization preset label is `Voorinstelling`. No assistant, OCR, browser, or
native implementation file was changed by this campaign.

## Checks

These existing checks passed on `876be7914`:

```text
pnpm exec tsx --tsconfig tsconfig.workspace-paths.json scripts/checkLocales.ts --target=app
Locale parity check passed for desktop package locales.

pnpm exec vitest run tests/unit/scripts/checkLocales.test.ts tests/unit/i18n/localeRegistry.test.ts tests/unit/i18n/messageFormat.test.ts tests/unit/i18n/privacyPageLocalization.test.ts tests/unit/i18n/aboutPageLocalization.test.ts --reporter=dot
5 test files passed, 22 tests passed
```

The first Vitest attempt needed the normal clean-checkout setup step because
`.nuxt/tsconfig.json` was absent. `pnpm exec nuxt prepare` generated it; the
rerun above is the accepted result.

## Acceptance record

The current catalogs have parity, placeholder parity, and no English-schema
fallback imports. The equality review found no ordinary user-facing prose to
translate in the owned `nl`, `pt`, `ptBr`, or `ru` files.

Rendered acceptance also passed for synthetic assistant, OCR, and PDF states in
`nl`, `pt`, `pt-BR`, and `ru` using the production components and app CSS. The
OCR dialogs measured 768x656 with no horizontal overflow. The PDF dialogs were
512px wide with `scrollWidth === clientWidth`. No unresolved `{activity}`,
`{age}`, `{page}`, `{count}`, or `{value}` placeholder appeared.
