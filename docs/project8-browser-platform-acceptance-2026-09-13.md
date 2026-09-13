# Project 8 browser and platform acceptance continuation

Review date: 2026-09-13

Source under review: `69c30c0f6` (`origin/project8/integration`)

Prior receipt: `docs/project8-quality-legacy-campaign-2026-09-11.md`, reviewed
at `e9f082ae`. This continuation answers only the new browser questions about
real unload behavior, BFCache observability, and IndexedDB connection disposal.

## Results

| Question | Evidence | Disposition |
| --- | --- | --- |
| Does a real browser unload guard stop navigation for a dirty page? | A headed Chromium probe installed a real `beforeunload` handler, observed a browser dialog, dismissed it, and remained on the original URL. | Passed for the browser prompt contract. |
| Does the clean page return from BFCache? | The probe reported `navigation.type = "back_forward"`, but `pageshow.persisted` stayed false. Playwright's Chromium process includes `--disable-back-forward-cache`, so this lane cannot claim BFCache acceptance. | Still open. Requires a non-automation browser session or a runner that permits BFCache. |
| Does production IndexedDB code close durable connections? | A real Chromium probe bundled `app/platform/browser/browserDocumentIdb.ts`, patched `IDBDatabase.prototype.close`, persisted and read a record, and counted three closes. A second page reopened the database and read the same bytes, then deleted the record and verified an empty key list. | Passed for the exercised write/read/reopen/delete path. |

## Source review

`useBrowserDirtyUnloadGuard` attaches `beforeunload` only while the document is
dirty and removes it when the document becomes clean or its Vue scope stops
(`app/modules/workspace-shell/composables/useShutdownSaveFlushReporting.ts:36`).
The real prompt probe matched that behavior. No source change is justified by
this run.

The IndexedDB helpers close each opened database after request completion,
transaction completion, request failure, transaction failure, and a late
success after the bounded open timeout (`app/platform/browser/browserDocumentIdb.ts:31`,
`:109`, `:164`). The real disposal probe matched the normal committed path.
No source change is justified by this run.

## Checks

```text
pnpm install --frozen-lockfile
pnpm exec vitest run --project browser-integration tests/integration/browser/realIndexedDbMigration.test.ts --reporter verbose
1 test file passed, 3 tests passed
```

The direct probes were run with the locked Playwright Chromium. Their JSON
outputs are kept in the ignored `.devkit/browser-platform/` directory. The
BFCache probe remains a documented gap because the automation browser disables
the behavior it needs to observe.

## Cleanup

The temporary IndexedDB record was deleted by the probe. The generated bundle
and probe artifacts are ignored under `.devkit/browser-platform/`. No browser
process, dev server, tracked source, issue state, or unrelated lane was left
running or changed.
