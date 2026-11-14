import {createHash} from 'node:crypto';
import {
    readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import {
    basename, resolve,
} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    getOcrModelDownloadUrl, OCR_LANGUAGE_MODEL_BYTES, OCR_LANGUAGE_MODEL_SHA256,
} from '@contracts/ocrLanguages';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    installPickerHandleFixture, openPdfFromChooser, lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, addNote, noteTexts, clickCenter, settleActiveOpen,
} from './documentLifecycleTestHelpers';
import {
    createReadingBook, readReadingView, openReadingBook,
} from './documentReadingTestHelpers';

describe('browser document lifecycle UI', () => {

    it('keeps the rendered document and tab identity after a corrupt replacement is rejected', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const validChooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const validChooser = await validChooserPromise;
            await validChooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));

            const renderedCanvas = page.locator('.page_container--rendered canvas').first();
            await renderedCanvas.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            const activeTab = page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            );
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            const canvasCountBefore = await page.locator('.page_container--rendered canvas').count();

            const corruptChooserPromise = page.waitForEvent('filechooser');
            await page.keyboard.press('Control+O');
            const corruptChooser = await corruptChooserPromise;
            await corruptChooser.setFiles({
                name: 'corrupt-replacement.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\ncorrupt and truncated'),
            });

            await page.locator('.app-toast-failure').filter({hasText: 'Failed to open file'}).waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            await expect.poll(() => renderedCanvas.isVisible()).toBe(true);
            expect(await page.locator('.page_container--rendered canvas').count())
                .toBe(canvasCountBefore);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    // R4: with "Reopen documents where I left off" off, a document opened in
    // the tab that closing the last tab leaves starts at page 1 with the
    // default zoom and no view rotation, whatever the closed document showed.
    it('opens the next PDF in the emptied last tab at its defaults, not the closed view', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const readView = () => readReadingView(page);
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            await openReadingBook(page, 'First', 'first.pdf');
            const opened = await readView();
            expect(opened).toMatchObject({
                indicator: '1',
                landscape: false,
            });

            await page.locator('.page-controls-display').click();
            await page.locator('.page-controls-inline-input').fill('4');
            await page.keyboard.press('Enter');
            await page.locator('#editor-global-toolbar-host button[aria-label^="Zoom In"]:not([disabled])').first().click();
            await expect.poll(async () => (await readView()).zoom, {timeout: 15_000}).not.toBe(opened.zoom);
            // The browser shows no view-rotation control yet (desktop has it in its View menu).
            await page.evaluate(() => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!testApi?.callActiveWorkspaceSyncCommand?.('handleViewRotationCw').called) throw new Error('View rotation is unavailable');
            });
            await expect.poll(readView, {timeout: 15_000}).toMatchObject({
                indicator: '4',
                visibleText: 'First page 4',
                landscape: true,
            });

            await page.getByRole('button', {name: 'Close Tab'}).click();
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"]').count()).toBe(1);
            await waitForOpenFileReady(page);
            await openReadingBook(page, 'Second', 'second.pdf');
            await page.screenshot({path: resolve(process.cwd(), '.devkit/browser-last-tab-next-open.png')});
            await expect.poll(readView, {timeout: 15_000}).toEqual({
                ...opened,
                visibleText: 'Second page 1',
            });
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 120_000);

    // R4: with "Reopen documents where I left off" on, a Recent PDF reopens at
    // the page, zoom and view rotation it was closed at, also after a Save; a
    // file of the same name and page count with other bytes opens at its start.
    it.each([
        'download',
        'file-handle',
    ] as const)('reopens a Recent PDF where the reader left it, and other bytes of that name at their start (%s)', async (saveMode) => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const readView = () => readReadingView(page);
        const settle = () => settleActiveOpen(page);
        const openFile = (label: string) => openReadingBook(page, label, 'reading-view.pdf');
        try {
            if (saveMode !== 'download') await page.addInitScript(installPickerHandleFixture);
            await page.addInitScript((mode) => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                if (mode === 'download') {
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    return;
                }
                // A File is a structured-cloneable picker-handle fixture. Its
                // prototype methods survive an IndexedDB round trip and reload,
                // and the actual bytes and writes live in a real OPFS file.
                // Chromium 153 traps when deserializing native OPFS handles.
                Reflect.set(window, 'showSaveFilePicker', async () => new File([], 'reading-view.pdf'));
            }, saveMode);
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            await page.locator('.rail-item', {hasText: 'Settings'}).click();
            await page.getByRole('switch', {name: 'Reopen documents where I left off'}).click();
            await expect.poll(() => page.getByRole('switch', {name: 'Reopen documents where I left off'}).getAttribute('aria-checked')).toBe('true');
            await page.locator('.rail-item', {hasText: 'Recent Files'}).click();
            await openFile('Reading');
            const opened = await readView();

            await page.locator('.page-controls-display').click();
            await page.locator('.page-controls-inline-input').fill('4');
            await page.keyboard.press('Enter');
            await page.locator('#editor-global-toolbar-host button[aria-label^="Zoom In"]:not([disabled])').first().click();
            await expect.poll(async () => (await readView()).zoom, {timeout: 15_000}).not.toBe(opened.zoom);
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {
                name: 'View',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {
                name: 'Rotate View Clockwise',
                exact: true,
            }).click();
            // An ordinary Save of a note writes the reader's own bytes; the view stays theirs.
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container[data-page="4"]').first().click({position: {
                x: 80,
                y: 80,
            }});
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Saved where I left off');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            // The button's name is its tooltip, which changes once nothing is left to save.
            const save = page.locator('.save-split-primary').first();
            const download = saveMode === 'download' ? page.waitForEvent('download') : null;
            await save.click();
            if (download) {
                expect(noteTexts(await PDFDocument.load(readFileSync(await (await download).path())))).toEqual(new Set(['Saved where I left off']));
            }
            await expect.poll(async () => [
                await save.getAttribute('aria-busy'),
                await save.isDisabled(),
            ], {timeout: 15_000}).toEqual([
                'false',
                true,
            ]);
            if (saveMode === 'file-handle') {
                const bytes = await page.evaluate(async () => {
                    const root = await navigator.storage.getDirectory();
                    const handle = await root.getFileHandle('reading-view.pdf');
                    return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
                });
                expect(noteTexts(await PDFDocument.load(Uint8Array.from(bytes)))).toEqual(new Set(['Saved where I left off']));
            }
            await expect.poll(readView, {timeout: 15_000}).toMatchObject({
                indicator: '4',
                visibleText: 'Reading page 4',
                landscape: true,
            });
            const left = await readView();
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-left.png`)});
            // A reload leaves nothing of the closed view but what Recent stored.
            // Close remembers the view before its tab goes, so the reload waits for that.
            const closeAndReload = async () => {
                await page.getByRole('button', {name: 'Close Tab'}).click();
                await expect.poll(() => page.locator('[data-tab-list] [role="tab"]').filter({hasText: '.pdf'}).count(), {timeout: 15_000}).toBe(0);
                await page.locator('.workspace-host[data-workspace-active="true"] .workspace-host__start').waitFor();
                await page.reload({waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
            };
            const reopenFromRecent = async (name: string) => {
                await page.locator('[data-recent-open-actionable="true"] .recent-open').filter({hasText: name}).click();
                await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered').first().waitFor({timeout: 30_000});
                await settle();
            };
            await closeAndReload();

            await reopenFromRecent('reading-view.pdf');
            await expect.poll(readView, {timeout: 15_000}).toEqual(left);
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-restored.png`)});
            await closeAndReload();

            await openFile('Changed');
            await expect.poll(readView, {timeout: 15_000}).toEqual({
                ...opened,
                visibleText: 'Changed page 1',
            });
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-changed-bytes.png`)});
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 120_000);

    it('renders an externally replaced PDF and reopens that persisted Recent file', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            // A previous PDF can remain painted before the incoming open claims
            // the workspace. Readiness must belong to the requested document.
            const waitForDocument = (fileName: string, expectedText: string) => page.waitForFunction(({
                fileName, expectedText,
            }) => {
                const tab = document.querySelector('[data-tab-list] [role="tab"][aria-selected="true"]');
                const container = document.querySelector('.page_container--rendered[data-page="1"]');
                const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                const layer = container?.querySelector('.textLayer');
                const rect = canvas?.getBoundingClientRect();
                return tab?.textContent?.includes(fileName)
                    && canvas && canvas.width > 0 && canvas.height > 0
                    && rect && rect.width > 0 && rect.height > 0
                    && getComputedStyle(canvas).visibility === 'visible'
                    && layer?.getAttribute('data-pdf-text-layer-ready') === 'true'
                    && layer.textContent?.includes(expectedText);
            }, {
                fileName,
                expectedText,
            }, {timeout: 60_000});
            let openCount = 0;
            const openWithFile = async (filePath: string, expectedText: string) => {
                const chooserPromise = page.waitForEvent('filechooser');
                if (openCount === 0) {
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().click();
                } else {
                    await page.keyboard.press('Control+O');
                }
                await (await chooserPromise).setFiles(filePath);
                openCount += 1;
                await waitForDocument(basename(filePath), expectedText);
                await page.evaluate(async () => {
                    const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                    if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                        throw new Error('PDF viewer open did not settle');
                    }
                });
            };

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ), 'Hello Arabic world');
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ), 'EVB annotation interoperability corpus');
            const replacementTab = page.locator('[data-tab-list] [role="tab"][aria-selected="true"]');
            await expect.poll(() => replacementTab.textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-replacement-rendered.png'),
                fullPage: true,
            });

            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await page.reload({waitUntil: 'domcontentloaded'});
            const recentReplacement = page.locator(
                '[data-recent-open-actionable="true"] .recent-open',
            ).filter({hasText: 'synthetic-annotation-interoperability.pdf'});
            await recentReplacement.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await recentReplacement.click();
            await waitForDocument('synthetic-annotation-interoperability.pdf', 'EVB annotation interoperability corpus');
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-recent-reopen-rendered.png'),
                fullPage: true,
            });
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);
});


// A3/T2: file commands retain annotation transactions and the external saved frontier.
describe('B01 file command annotation isolation', () => {
    it.each([
        'A26-1',
        'A26-3',
    ] as const)('%s retains separate note and page transactions', async item => {
        const context = await lifecycle.browser.newContext({acceptDownloads: true});
        const page = await context.newPage();
        const diagnostics: string[] = [];
        page.on('console', message => {if ([
            'error',
            'warning',
        ].includes(message.type())) diagnostics.push(message.text());});
        page.on('pageerror', error => diagnostics.push(error.stack ?? error.message));
        const orientation = async () => {
            const rect = await page.locator('.page_container--rendered[data-page="1"]').first().boundingBox();
            return rect ? rect.width > rect.height : null;
        };
        const markers = page.locator('.pdf-annotation-editor-layer [data-annotation-kind="note"]');
        const history = async (direction: 'Undo' | 'Redo') => {
            await page.getByRole('button', {
                name: direction,
                exact: true,
            }).click();
            await settleActiveOpen(page);
        };
        const rotate = async () => {
            if (!await page.getByRole('tab', {
                name: 'Pages',
                exact: true,
            }).isVisible()) await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Pages',
                exact: true,
            }).click();
            await clickCenter(page, '[data-thumbnail-page="1"]', 'right');
            await page.getByRole('menuitem', {
                name: 'Rotate Clockwise',
                exact: true,
            }).click();
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{isPageOperationInProgress: boolean}>(['isPageOperationInProgress']).isPageOperationInProgress === false;
            });
            await settleActiveOpen(page);
            await expect.poll(orientation).toBe(true);
        };
        try {
            await openPdfFromChooser(page, await createReadingBook('B01', 'b01.pdf'));
            await settleActiveOpen(page);
            if (item === 'A26-1') {
                if (await page.locator('.browser-install-dismiss').isVisible()) await page.locator('.browser-install-dismiss').click();
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await page.getByRole('tab', {
                    name: 'Pages',
                    exact: true,
                }).click();
                const disclosure = page.locator('.pdf-sidebar-pages-disclosure');
                if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
                await page.locator('#page-label-prefix-input').fill('B01-');
                await page.getByRole('button', {
                    name: 'Apply numbering',
                    exact: true,
                }).click();
                await expect.poll(() => page.locator('[data-thumbnail-page="1"] [data-document-thumbnail-label]').innerText()).toBe('B01-1 (1)');
                await disclosure.click();
                await expect.poll(() => disclosure.getAttribute('aria-expanded')).toBe('false');
            }
            if (item === 'A26-3') await rotate();
            await addNote(page, 'B01 accepted note', {
                x: 120,
                y: 180,
            });
            await expect.poll(() => markers.count()).toBe(1);
            if (item === 'A26-1') await rotate();
            else {
                const download = page.waitForEvent('download');
                await page.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).click();
                await (await download).path();
                // Sticky-note text and marker creation are separate accepted commands.
                await history('Undo');
                await history('Undo');
                await expect.poll(() => markers.count()).toBe(0);
            }
            await history('Undo');
            await expect.poll(orientation).toBe(false);
            if (item === 'A26-3') {
                await history('Redo');
                await expect.poll(orientation).toBe(true);
            }
            await expect.poll(() => markers.count()).toBe(item === 'A26-1' ? 1 : 0);
            await expect.poll(async () => await page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').getAttribute('aria-description') ?? '').toMatch(/unsaved/iu);
            if (item === 'A26-1') {
                await expect.poll(() => page.locator('[data-thumbnail-page="1"] [data-document-thumbnail-label]').innerText()).toBe('B01-1 (1)');
                await history('Undo');
            }
            await history(item === 'A26-1' ? 'Undo' : 'Redo');
            await expect.poll(() => markers.count()).toBe(item === 'A26-1' ? 0 : 1);
            if (item === 'A26-1') {
                await expect.poll(async () => await page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').getAttribute('aria-description') ?? '').toMatch(/unsaved/iu);
                await history('Undo');
                await expect.poll(() => page.locator('[data-thumbnail-page="1"] [data-document-thumbnail-label]').innerText()).toBe('1');
                diagnostics.push(JSON.stringify(await page.evaluate(() => (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi).readActiveWorkspaceStateValues?.([
                    'dirtyState',
                    'sortedAnnotationNoteWindows',
                ])), null, 2));
                await expect.poll(async () => await page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').getAttribute('aria-description') ?? '').toBe('');
            }
        } finally {
            if (process.env.EVB_B01_EVIDENCE_DIR) {
                mkdirSync(process.env.EVB_B01_EVIDENCE_DIR, {recursive: true});
                writeFileSync(resolve(process.env.EVB_B01_EVIDENCE_DIR, `${item}.log`), diagnostics.join('\n'));
                await page.screenshot({path: resolve(process.env.EVB_B01_EVIDENCE_DIR, `${item}.png`)});
            }
            await context.close();
        }
    }, 90_000);
});


// A26-2: real OCR, renderer text, note marker and document dirty state.
it('B01 A26-2 preserves an unsaved note through OCR Undo and Redo', async () => {
    const context = await lifecycle.browser.newContext({viewport: {
        width: 1440,
        height: 900,
    }});
    const page = await context.newPage();
    try {
        const response = await fetch(getOcrModelDownloadUrl('eng'));
        expect(response.ok).toBe(true);
        const model = Buffer.from(await response.arrayBuffer());
        expect(model.byteLength).toBe(OCR_LANGUAGE_MODEL_BYTES.eng);
        expect(createHash('sha256').update(model).digest('hex')).toBe(OCR_LANGUAGE_MODEL_SHA256.eng);
        await page.route('**/eng.traineddata', route => route.fulfill({
            contentType: 'application/octet-stream',
            body: model,
        }));
        await openPdfFromChooser(page, {
            name: 'b01-ocr.pdf',
            mimeType: 'application/pdf',
            buffer: readFileSync(resolve('tests/fixtures/release/packaged-core-ocr-smoke.pdf')),
        });
        await settleActiveOpen(page);
        await addNote(page, 'B01 note before OCR', {
            x: 120,
            y: 180,
        });
        const markers = page.locator('.pdf-annotation-editor-layer [data-annotation-kind="note"]');
        await expect.poll(() => markers.count()).toBe(1);
        const text = () => page.locator('.textLayer').allTextContents().then(values => values.join(' ').trim());
        expect(await text()).toBe('');
        await page.getByRole('button', {
            name: 'OCR',
            exact: true,
        }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', {name: /^(Download and start OCR|Start OCR)$/u}).click();
        const completion = 'OCR complete - PDF is now searchable';
        await dialog.getByText(completion, {exact: true}).or(dialog.getByRole('alert')).first().waitFor({timeout: 90_000});
        expect(await dialog.innerText()).toContain(completion);
        await dialog.getByRole('button', {
            name: 'Close',
            exact: true,
        }).last().click();
        await settleActiveOpen(page);
        await expect.poll(text).toMatch(/\w{4}/u);
        for (const direction of [
            'Undo',
            'Redo',
        ] as const) {
            await page.getByRole('button', {
                name: direction,
                exact: true,
            }).click();
            await settleActiveOpen(page);
            if (direction === 'Undo') await expect.poll(text).toBe('');
            else await expect.poll(text).toMatch(/\w{4}/u);
            await expect.poll(() => markers.count()).toBe(1);
            await expect.poll(async () => await page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').getAttribute('aria-description') ?? '').toMatch(/unsaved/iu);
        }
        if (process.env.EVB_B01_EVIDENCE_DIR) {
            mkdirSync(process.env.EVB_B01_EVIDENCE_DIR, {recursive: true});
            await page.screenshot({path: resolve(process.env.EVB_B01_EVIDENCE_DIR, 'A26-2.png')});
        }
    } finally {
        await context.close();
    }
}, 120_000);
