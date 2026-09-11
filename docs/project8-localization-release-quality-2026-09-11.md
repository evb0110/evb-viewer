# Project 8 Mac localization release quality

Review date: 2026-09-11

Source under review: `ad2ea1439` (`origin/project8/integration`)

Tickets: [#547](https://github.com/evb0110/evb-viewer/issues/547),
[#548](https://github.com/evb0110/evb-viewer/issues/548), and
[#551](https://github.com/evb0110/evb-viewer/issues/551)

## Scope and disposition

This lane owns the desktop locale catalogs and quality documentation only. It
does not own assistant, OCR, browser, renderer, native, or release-workflow
implementation. The current English-equality inventory was regenerated from
`packages/i18n-app/messages/en.ts` and compared with `nl.ts`, `pt.ts`,
`ptBr.ts`, and `ru.ts`. Plural objects count as one leaf. Equality is a review
signal, not a translation failure.

Every current equal leaf is listed below. `shared` means the same short word is
valid in the target language. `technical` means a product name, format,
algorithm, unit, protocol label, or placeholder-only diagnostic value. No
ordinary English sentence remains in these four catalogs, so #547 and #548
need no catalog edit on this source.

### #547, Dutch and Portuguese

| Locale | Count | Disposition ledger |
| --- | ---: | --- |
| `nl` | 58 | `technical`: `scanCleanup.settings.rotationDegrees`, `scanCleanup.output.autoShort`, `scanCleanup.advanced.binarization.otsu`, `scanCleanup.advanced.binarization.sauvola`, `scanCleanup.advanced.binarization.wolf`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.edgeStrokeValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.boundsValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.pages.override.auto`, `scanCleanup.preview.zoomValue`, `assistant.toolActivity`, `assistant.imagePreviewPosition`, `notifications.docxSavedDescription`, `ocr.button`, `ocr.pageSegmentation.options.auto`, `ocr.languagePicker.downloadSizeHint`, `djvu.documentFallback`, `djvu.convertDialog.compact`, `common.unitDpi`, `common.unitByte`, `common.unitKilobyte`, `common.unitMegabyte`, `print.orientationAuto`, `menu.assistant`, `pageNumbering.lettersLower`, `pageNumbering.lettersUpper`, `status.zoomUnknown`, `status.zoomValue`, `settings.uiScaleAuto`, `settings.uiScaleCompact`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpServerName`, `settings.agentMcpUrl`, `crop.unitPoints`, `crop.unitMillimeters`, `crop.unitInches`; `shared`: `app.title`, `app.webTitle`, `assistant.title`, `assistant.roleSystem`, `seo.title`, `toolbar.appMenu`, `annotations.pen`, `menu.help`, `emptyState.start`, `emptyState.itemsCount`, `settings.privacy`, `settings.updates`, `updates.deferAction`. |
| `pt` | 50 | `technical`: `scanCleanup.settings.rotationDegrees`, `scanCleanup.output.autoShort`, `scanCleanup.advanced.binarization.otsu`, `scanCleanup.advanced.binarization.sauvola`, `scanCleanup.advanced.binarization.wolf`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.deskewManualValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.edgeStrokeValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.boundsValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.pages.override.auto`, `scanCleanup.preview.zoomValue`, `assistant.toolActivity`, `assistant.imagePreviewPosition`, `notifications.docxSavedDescription`, `ocr.button`, `ocr.pageSegmentation.options.auto`, `ocr.languagePicker.downloadSizeHint`, `djvu.convertDialog.original`, `common.unitDpi`, `common.unitByte`, `common.unitKilobyte`, `common.unitMegabyte`, `print.orientationAuto`, `menu.assistant`, `status.zoomUnknown`, `status.zoomValue`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpUrl`, `crop.unitPoints`, `crop.unitMillimeters`; `shared`: `app.title`, `app.webTitle`, `assistant.title`, `seo.title`, `toolbar.appMenu`, `scanCleanup.settings.manual`, `scanCleanup.advanced.despeckle.normal`, `scanCleanup.preview.original`, `zoom.sectionLayout`, `print.layoutLabel`, `pageNumbering.decimal`. |
| `ptBr` | 52 | `technical`: `scanCleanup.settingsBadges.items.layoutMode`, `scanCleanup.settings.rotationDegrees`, `scanCleanup.output.autoShort`, `scanCleanup.advanced.binarization.otsu`, `scanCleanup.advanced.binarization.sauvola`, `scanCleanup.advanced.binarization.wolf`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.deskewManualValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.edgeStrokeValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.boundsValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.pages.override.auto`, `scanCleanup.preview.zoomValue`, `assistant.toolActivity`, `assistant.imagePreviewPosition`, `notifications.docxSavedDescription`, `ocr.button`, `ocr.pageSegmentation.options.auto`, `ocr.languagePicker.downloadSizeHint`, `djvu.convertDialog.original`, `common.unitDpi`, `common.unitByte`, `common.unitKilobyte`, `common.unitMegabyte`, `print.orientationAuto`, `menu.assistant`, `status.zoomUnknown`, `status.zoomValue`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpUrl`, `crop.unitPoints`, `crop.unitMillimeters`, `crop.unitInches`; `shared`: `app.title`, `app.webTitle`, `assistant.title`, `assistant.roleSystem`, `seo.title`, `toolbar.appMenu`, `zoom.sectionLayout`, `scanCleanup.pages.diagnostics.layout`, `scanCleanup.settings.manual`, `scanCleanup.advanced.despeckle.normal`, `scanCleanup.preview.original`, `print.layoutLabel`, `pageNumbering.decimal`. |

The assistant status keys named in #547 are translated in all three owned
catalogs. The equal OCR and diagnostic values above contain only units,
algorithms, short labels, or placeholders. European Portuguese and Brazilian
Portuguese retain their existing catalog-specific wording elsewhere.

### #548, Russian

| Locale | Count | Disposition ledger |
| --- | ---: | --- |
| `ru` | 27 | `technical`: `app.title`, `app.webTitle`, `assistant.title`, `assistant.toolActivity`, `assistant.imagePreviewPosition`, `seo.title`, `notifications.docxSavedDescription`, `ocr.button`, `scanCleanup.settings.rotationDegrees`, `scanCleanup.pages.diagnostics.deskewValue`, `scanCleanup.pages.diagnostics.contrastIlluminationValue`, `scanCleanup.pages.diagnostics.borderAgreementValue`, `scanCleanup.pages.diagnostics.acceptedTrimValue`, `scanCleanup.pages.diagnostics.sideConfidenceValue`, `scanCleanup.preview.zoomValue`, `scanCleanup.runPercent`, `scanCleanup.runStatus`, `common.unitDpi`, `menu.assistant`, `settings.assistantPanel`, `settings.agentMcpSetupCodexTitle`, `settings.agentMcpSetupClaudeTitle`, `settings.agentMcpSetupCursorTitle`, `settings.agentMcpUrl`, `crop.unitPoints`, `crop.unitMillimeters`, `crop.unitInches`. |

Russian has no equal ordinary UI prose in the current catalog. The remaining
values are product names, tool names, units, and diagnostic templates whose
English tokens are part of the value or are preserved by placeholder parity.

## #551, suppression accounting

The three historical `max-lines` directives are absent from this source. The
historical text-layer renderer path was removed by the renderer cleanup. The
two remaining historical paths no longer contain the directive:

| Historical owner | Current evidence | Disposition |
| --- | --- | --- |
| `app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer.ts` | Path absent | Already removed by renderer cleanup. No stale directive remains to explain. |
| `scripts/architecture/boundary-check.mjs` | File exists; no `max-lines` directive | Already resolved before this qualification. No line-limit or source change is justified. |
| `scripts/diagnostics/scan-cleanup-representative-audit.mjs` | File exists; no `max-lines` directive | Already resolved before this qualification. No line-limit or source change is justified. |

`git grep -n -E 'max-lines|eslint-disable.*max-lines' -- ':!vendor' ':!public/vendor'`
returns no source matches. This qualifies the stale finding without changing
runtime code, moving files, or adding a suppression.

## Checks

Existing checks passed on `ad2ea1439`:

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec nuxt prepare
pnpm exec tsx --tsconfig tsconfig.workspace-paths.json scripts/checkLocales.ts --target=app
Locale parity check passed for desktop package locales.

pnpm exec vitest run tests/unit/scripts/checkLocales.test.ts tests/unit/i18n/localeRegistry.test.ts tests/unit/i18n/messageFormat.test.ts tests/unit/i18n/privacyPageLocalization.test.ts tests/unit/i18n/aboutPageLocalization.test.ts --reporter=dot
5 test files passed, 22 tests passed

pnpm exec vitest run tests/unit/scripts/publishReleaseMirror.test.ts tests/unit/scripts/releasePolicy.test.ts tests/unit/scripts/releaseStatus.test.ts tests/unit/scripts/ciTopologyPolicy.test.ts --reporter=dot
4 test files passed, 97 tests passed

git diff --check
passed
```

The first inventory attempt ran before dependency setup and failed because
`tsx` was unavailable. Locked dependency installation fixed that setup issue.

## Gaps and ownership handoff

This lane did not run headed Electron or browser rendering of synthetic
assistant/OCR states. That proof remains with the browser/OCR owners. It also
did not run Windows ARM64 installer acceptance or a live cross-service release
promotion interruption. No catalog, assistant, OCR, browser, renderer, native,
or release-workflow implementation was changed.
