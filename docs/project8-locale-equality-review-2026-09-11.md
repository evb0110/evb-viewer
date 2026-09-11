# Project 8 locale equality review

Review date: 2026-09-11

Source under review: `b25487ccb` (campaign branch with `origin/project8/integration` at `2dcf80dbd`)

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

The exact-equality inventory was also retained by key so a later reviewer can
distinguish a translation gap from a valid shared value:

| Locale | Equal leaves classified as valid unchanged values |
| --- | --- |
| `nl` | `app.title`, `app.webTitle`, `assistant.title`, `assistant.toolActivity`, `assistant.roleSystem`, `assistant.imagePreviewPosition`, `seo.title`, `toolbar.appMenu`, `notifications.docxSavedDescription`, `annotations.pen`, `ocr.button`, `ocr.pageSegmentation.options.auto`, `ocr.languagePicker.downloadSizeHint`, `scanCleanup.settings.rotationDegrees`, `scanCleanup.output.autoShort`, `scanCleanup.advanced.binarization.otsu`, `scanCleanup.advanced.binarization.sauvola`, `scanCleanup.advanced.binarization.wolf`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.edgeStrokeValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.boundsValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.pages.override.auto`, `scanCleanup.preview.zoomValue`, `scanCleanup.details`, `scanCleanup.runStatus`, `djvu.documentFallback`, `djvu.convertDialog.compact`, `common.unitDpi`, `common.unitByte`, `common.unitKilobyte`, `common.unitMegabyte`, `print.orientationAuto`, `menu.assistant`, `menu.help`, `emptyState.start`, `emptyState.itemsCount`, `pageNumbering.lettersLower`, `pageNumbering.lettersUpper`, `status.zoomUnknown`, `status.zoomValue`, `settings.privacy`, `settings.uiScaleAuto`, `settings.uiScaleCompact`, `settings.updates`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpServerName`, `settings.agentMcpUrl`, `updates.deferAction`, `crop.unitPoints`, `crop.unitMillimeters`, `crop.unitInches` |
| `pt` | `app.title`, `app.webTitle`, `assistant.title`, `assistant.toolActivity`, `assistant.imagePreviewPosition`, `seo.title`, `toolbar.appMenu`, `notifications.docxSavedDescription`, `zoom.sectionLayout`, `ocr.button`, `ocr.pageSegmentation.options.auto`, `ocr.languagePicker.downloadSizeHint`, `scanCleanup.settings.rotationDegrees`, `scanCleanup.settings.manual`, `scanCleanup.output.autoShort`, `scanCleanup.advanced.binarization.otsu`, `scanCleanup.advanced.binarization.sauvola`, `scanCleanup.advanced.binarization.wolf`, `scanCleanup.advanced.despeckle.normal`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.deskewManualValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.edgeStrokeValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.boundsValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.pages.override.auto`, `scanCleanup.preview.original`, `scanCleanup.preview.zoomValue`, `scanCleanup.runStatus`, `djvu.convertDialog.original`, `common.unitDpi`, `common.unitByte`, `common.unitKilobyte`, `common.unitMegabyte`, `print.layoutLabel`, `print.orientationAuto`, `menu.assistant`, `pageNumbering.decimal`, `status.zoomUnknown`, `status.zoomValue`, `settings.uiScaleAuto`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpUrl`, `crop.unitPoints`, `crop.unitMillimeters` |
| `ptBr` | `app.title`, `app.webTitle`, `assistant.title`, `assistant.toolActivity`, `assistant.roleSystem`, `assistant.imagePreviewPosition`, `seo.title`, `toolbar.appMenu`, `notifications.docxSavedDescription`, `zoom.sectionLayout`, `ocr.button`, `ocr.pageSegmentation.options.auto`, `ocr.languagePicker.downloadSizeHint`, `scanCleanup.settingsBadges.items.layoutMode`, `scanCleanup.settings.rotationDegrees`, `scanCleanup.settings.manual`, `scanCleanup.output.autoShort`, `scanCleanup.advanced.binarization.otsu`, `scanCleanup.advanced.binarization.sauvola`, `scanCleanup.advanced.binarization.wolf`, `scanCleanup.advanced.despeckle.normal`, `scanCleanup.pages.diagnostics.layout`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.deskewManualValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.edgeStrokeValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.boundsValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.pages.override.auto`, `scanCleanup.preview.original`, `scanCleanup.preview.zoomValue`, `scanCleanup.runStatus`, `djvu.convertDialog.original`, `common.unitDpi`, `common.unitByte`, `common.unitKilobyte`, `common.unitMegabyte`, `print.layoutLabel`, `menu.assistant`, `pageNumbering.decimal`, `status.zoomUnknown`, `status.zoomValue`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpUrl`, `crop.unitPoints`, `crop.unitMillimeters`, `crop.unitInches` |
| `ru` | `app.title`, `app.webTitle`, `assistant.title`, `assistant.toolActivity`, `assistant.imagePreviewPosition`, `seo.title`, `notifications.docxSavedDescription`, `ocr.button`, `scanCleanup.settings.rotationDegrees`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.preview.zoomValue`, `scanCleanup.runPercent`, `scanCleanup.runStatus`, `common.unitDpi`, `menu.assistant`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpUrl`, `crop.unitPoints`, `crop.unitMillimeters`, `crop.unitInches` |

The inventory contains no unresolved ordinary prose. The assistant activity
messages and OCR descriptions named in #547 and #548 are translated in every
owned catalog. The one previously identified Dutch catalog correction,
`optimizePdf.presetLabel`, is `Voorinstelling`.

The assistant status keys named by the tickets are already localized in all four
owned catalogs. The OCR and diagnostic labels that remain equal are short
technical labels or values containing placeholders and units. I did not change
assistant, OCR, browser, or native implementation files.

## Checks

These existing checks passed on `b25487ccb`:

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
translate in the owned `nl`, `pt`, `ptBr`, or `ru` files. A headed or browser
render of synthetic assistant/OCR states was not run in this quality lane. That
visual acceptance remains with the browser/OCR owners and is an explicit gap,
not a claim of completion here. No catalog source edit was needed in this
campaign because the required translations are already present on the base.

## Rendered acceptance

The real web preview was started from `b25487ccb` with `pnpm run dev:web`.
Port 3235 was occupied, so Nuxt served the same entrypoint on its configured
fallback at `http://127.0.0.1:3000/`. At a 1280x800 browser viewport, I opened
Settings, selected Nederlands, and verified rendered Dutch text for the
language control, settings headings, PDF Save As explanation, performance,
privacy, updates, and about copy. No unresolved `{...}` placeholders or
horizontal overflow were visible in that view.

| Rendered area | Locale | Result |
| --- | --- | --- |
| Settings and language selector | `nl` | Pass |
| Synthetic assistant and OCR states | `nl`, `pt`, `ptBr`, `ru` | Not run; owner gap |
| Portuguese and Russian settings pages | `pt`, `ptBr`, `ru` | Not run; owner gap |

The captured browser artifact is
`browser-screenshot-localhost-mtx8fehu-86a78847.png` in the local T3
browser-artifact store. The preview also emitted repeated browser-recovery
heartbeat warnings; they did not prevent the Dutch settings page from
rendering, but they remain an environment warning rather than a localization
result.
