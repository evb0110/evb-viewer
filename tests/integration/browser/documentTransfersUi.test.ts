import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, StandardFonts,
} from 'pdf-lib';
import type {Page} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, freezeWindow, addNote, noteTexts, readRecoveries, readWindowLocks, clickCenter, paneSelector, readPanePageWidth, zoomActivePane,
    installPickerHandleFixture, settleActiveOpen,
} from './documentLifecycleTestHelpers';
import {
    createReadingBook, readReadingView,
} from './documentReadingTestHelpers';

describe('browser document lifecycle UI', () => {
    // T2 (#1284): a frozen or throttled window is alive while it holds its
    // window lock. A second window must not take its checkpoint or its
    // documents, and the owner's later notes stay recoverable.
    it('leaves a frozen window its recovery and recovers its later notes after it closes', async () => {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([
            612,
            792,
        ]).drawText('Frozen owner recovery', {
            x: 72,
            y: 720,
            font,
            size: 18,
        });
        const source = Buffer.from(await pdf.save());
        const firstNote = 'Note before the freeze';
        const secondNote = 'Note after the resume';
        const consoleProblems: string[][] = [];
        try {
            const context = await lifecycle.browser.newContext({viewport: {
                width: 1_280,
                height: 800,
            }});
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            async function openWindow(prepare?: (page: Page) => Promise<unknown>) {
                const page = await context.newPage();
                consoleProblems.push(collectConsoleProblems(page));
                await prepare?.(page);
                await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
                return page;
            }
            const owner = await openWindow();
            keepFileChooserInterceptionEnabled(owner);
            const chooser = owner.waitForEvent('filechooser');
            await owner.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'frozen-owner.pdf',
                mimeType: 'application/pdf',
                buffer: source,
            });
            await owner.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await addNote(owner, firstNote, {
                x: 200,
                y: 200,
            });
            await expect.poll(async () => (await readRecoveries(owner)).map(record => [...record.notes]), {timeout: 15_000})
                .toEqual([[firstNote]]);
            const [ownerRecord] = await readRecoveries(owner);
            const ownerId = ownerRecord!.ownerId;
            await expect.poll(async () => (await readWindowLocks(owner)).held, {timeout: 15_000}).toContain(ownerId);

            const resumeOwner = await freezeWindow(context, owner);

            // However long the owner stays silent, its held lock says it is alive.
            const second = await openWindow(page => page.addInitScript((aheadMs) => {
                const now = Date.now.bind(Date);
                Date.now = () => now() + aheadMs;
            }, 60_000));
            expect((await readWindowLocks(second)).held).toContain(ownerId);
            expect((await readRecoveries(second)).map(record => record.ownerId)).toEqual([ownerId]);
            expect(await second.locator('.page_container').count()).toBe(0);

            await resumeOwner();
            await addNote(owner, secondNote, {
                x: 300,
                y: 400,
            });
            await expect.poll(async () => (await readRecoveries(second)).map(record => [...record.notes].sort()), {timeout: 15000}).toContainEqual([
                secondNote,
                firstNote,
            ].sort());


            // Closing the window releases its lock, the browser's proof that
            // the owner is gone; its checkpoint is recoverable at once.
            await owner.close();
            await expect.poll(async () => (await readWindowLocks(second)).held, {timeout: 15_000}).not.toContain(ownerId);
            const recovered = await openWindow();
            await recovered.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await expect.poll(
                () => recovered.locator('.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind="note"]').count(),
                {timeout: 15_000},
            ).toBe(2);
            const download = recovered.waitForEvent('download');
            await recovered.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await recovered.getByRole('menuitem', {name: /^Save As/u}).click();
            const saved = await PDFDocument.load(readFileSync(await (await download).path()));
            expect(noteTexts(saved)).toEqual(new Set([
                firstNote,
                secondNote,
            ]));
            expect(consoleProblems.flat()).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    // T2 (#1313): a duplicated tab copies window.name, so two windows start
    // with one window id. The window holding that id's lock keeps it; the
    // copy takes a new id, its notes reach recovery, and its lock goes with
    // it, so another window recovers its checkpoint after it closes.
    it('keeps a duplicated window\'s notes recoverable', async () => {
        const consoleProblems: string[][] = [];
        try {
            const context = await lifecycle.browser.newContext({viewport: {
                width: 1_280,
                height: 800,
            }});
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            async function openWindow(prepare?: (page: Page) => Promise<unknown>, preparedPage?: Page) {
                const page = preparedPage ?? await context.newPage();
                consoleProblems.push(collectConsoleProblems(page));
                keepFileChooserInterceptionEnabled(page);
                await prepare?.(page);
                await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
                return page;
            }
            async function openPdf(page: Page, fileName: string) {
                const pdf = await PDFDocument.create();
                const font = await pdf.embedFont(StandardFonts.Helvetica);
                pdf.addPage([
                    612,
                    792,
                ]).drawText(fileName, {
                    x: 72,
                    y: 720,
                    font,
                    size: 18,
                });
                const chooser = page.waitForEvent('filechooser');
                await page.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await chooser).setFiles({
                    name: fileName,
                    mimeType: 'application/pdf',
                    buffer: Buffer.from(await pdf.save()),
                });
                await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            }

            const original = await openWindow();
            await openPdf(original, 'original.pdf');
            await addNote(original, 'Original note', {
                x: 200,
                y: 200,
            });
            await expect.poll(async () => (await readRecoveries(original)).map(record => [...record.notes]), {timeout: 15_000})
                .toEqual([['Original note']]);
            const [originalRecord] = await readRecoveries(original);
            const originalOwnerId = originalRecord!.ownerId;
            await expect.poll(async () => (await readWindowLocks(original)).held, {timeout: 15_000})
                .toEqual([originalOwnerId]);
            const frozenReader = await context.newPage();
            await frozenReader.goto(`${lifecycle.origin}/pdfjs/images/annotation-paperclip.svg`);
            const resumeOriginal = await freezeWindow(context, original);

            // The copy's instance nonce sorts first, so the nonces alone would
            // make the original give up the id. It cannot answer discovery
            // while frozen: its held lock must keep the copy from taking over
            // the original's checkpoint.
            const copy = await openWindow(page => page.addInitScript((windowName) => {
                if (!window.name) window.name = windowName;
                Reflect.set(window, '__evbBrowserWindowTabsState', {recoveryInstanceNonce: '!'});
            }, `evb-viewer-window:${originalOwnerId}`), frozenReader);
            const copyOwnerId = await copy.evaluate(() => window.name.slice('evb-viewer-window:'.length));
            expect(copyOwnerId).not.toBe(originalOwnerId);
            expect(await copy.locator('.page_container').count()).toBe(0);
            expect((await readRecoveries(copy)).map(record => record.ownerId)).toEqual([originalOwnerId]);
            expect(await readWindowLocks(copy)).toEqual({
                held: [
                    originalOwnerId,
                    copyOwnerId,
                ].sort(),
                pending: [],
            });
            await resumeOriginal();
            await openPdf(copy, 'copy.pdf');
            await addNote(copy, 'Copy note', {
                x: 200,
                y: 200,
            });
            await addNote(original, 'Second original note', {
                x: 300,
                y: 400,
            });
            await expect.poll(async () => (await readRecoveries(original)).flatMap(record => [...record.notes]), {timeout: 15_000})
                .toEqual(expect.arrayContaining([
                    'Copy note',
                    'Second original note',
                ]));
            const records = await readRecoveries(original);
            const ownerOf = (note: string) => records.find(record => record.notes.has(note))!.ownerId;
            // Each window id's lock is held, and no window waits for one.
            expect(await readWindowLocks(original)).toEqual({
                held: [
                    ownerOf('Copy note'),
                    ownerOf('Second original note'),
                ].sort(),
                pending: [],
            });
            expect(records.map(record => [...record.notes].sort().join(', ')).sort()).toEqual([
                'Copy note',
                'Original note, Second original note',
            ]);

            // Closing the copy releases its lock and only its lock, and its
            // record is recoverable at once.
            await copy.close();
            await expect.poll(async () => (await readWindowLocks(original)).held, {timeout: 15_000})
                .toEqual([ownerOf('Second original note')]);
            const [
                first,
                second,
            ] = await Promise.all([
                openWindow(),
                openWindow(),
            ]);
            await expect.poll(async () => Promise.all([
                first,
                second,
            ].map(page =>
                page.locator('.page_container--rendered canvas').count())), {timeout: 30_000})
                .toEqual(expect.arrayContaining([
                    1,
                    0,
                ]));
            const recovered = await first.locator('.page_container--rendered canvas').count() ? first : second;
            await recovered.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await expect.poll(
                () => recovered.locator('.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind="note"]').count(),
                {timeout: 15_000},
            ).toBe(1);
            expect(await recovered.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent()).toContain('copy.pdf');
            const download = recovered.waitForEvent('download');
            await recovered.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await recovered.getByRole('menuitem', {name: /^Save As/u}).click();
            const saved = await PDFDocument.load(readFileSync(await (await download).path()));
            expect(noteTexts(saved)).toEqual(new Set(['Copy note']));
            expect(consoleProblems.flat()).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it.each([
        'command',
        'toolbar',
    ])('keeps a dirty transferred document after its source window closes (%s)', async saveEntry => {
        const context = await lifecycle.browser.newContext();
        const source = await context.newPage();
        const target = await context.newPage();
        try {
            await source.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await target.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
            });
            await Promise.all([
                source.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'}),
                target.goto(`${lifecycle.origin}?evbWindowId=2`, {waitUntil: 'domcontentloaded'}),
            ]);
            await Promise.all([
                waitForOpenFileReady(source),
                target.waitForFunction(() => Boolean(Reflect.get(window, '__evbTestApi')), undefined, {timeout: 30_000}),
            ]);

            const chooserPromise = source.waitForEvent('filechooser');
            await source.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ));
            await source.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Source PDF did not settle');
            });
            const existingTextBox = source.locator('.pdf-annotation-editor-text-box').filter({hasText: 'Editable interoperability text'}).first();
            await existingTextBox.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await existingTextBox.dblclick();
            const noteEditor = source.locator('.pdf-annotation-editor-text-box__editor').last();
            await noteEditor.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await noteEditor.fill('durable transfer edit');
            await expect.poll(() => noteEditor.textContent()).toBe('durable transfer edit');
            await expect.poll(async () => source.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                    text?: string;
                    displayText?: string | null;
                    previewText?: string | null
                }>;}>(['annotationComments']);
                return state?.annotationComments?.some(comment => [
                    comment.text,
                    comment.displayText,
                    comment.previewText,
                ].includes('durable transfer edit')) ?? false;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => noteEditor.isVisible()).toBe(true);
            await noteEditor.blur();
            await expect.poll(async () => source.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{dirtyState?: {
                    annotationDirty: boolean;
                    hasAnnotationChanges: boolean;
                };}>(['dirtyState']);
                return state?.dirtyState?.annotationDirty === true
                    && state.dirtyState.hasAnnotationChanges === true;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => source.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).getAttribute('aria-description')).toMatch(/unsaved/i);
            const captured = await source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.callActiveWorkspaceCommand?.('captureSplitPayload');
            });
            expect(captured?.called).toBe(true);
            expect(captured?.value).toEqual(expect.objectContaining({kind: 'pdfSnapshot'}));

            await expect.poll(async () => source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return (await api.listTargetWindows?.())?.some(windowInfo => (
                    windowInfo.windowId === 2
                )) ?? false;
            }), {timeout: 30_000}).toBe(true);

            const transferPromise = source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.transferActiveTabToWindow?.(2);
            });
            const transferResult = await transferPromise;
            expect(transferResult).toMatchObject({
                success: true,
                targetWindowId: 2,
            });
            // The source window goes away; the target holds the moved document on its own.
            await source.close();

            await expect.poll(() => target.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent(), {timeout: 60_000}).toContain('synthetic-annotation-interoperability.pdf');
            await target.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Target PDF did not settle after transfer');
            });
            await expect.poll(async () => target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                    text?: string;
                    displayText?: string | null;
                    previewText?: string | null;
                }>;}>(['annotationComments']);
                return state?.annotationComments?.some(comment => [
                    comment.text,
                    comment.displayText,
                    comment.previewText,
                ].includes('durable transfer edit')) ?? false;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.()?.canSave ?? false;
            }), {timeout: 30_000}).toBe(true);

            const downloadPromise = target.waitForEvent('download');
            if (saveEntry === 'toolbar') {
                await target.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).click();
                await target.getByRole('menuitem', {name: /^Save As/u}).click();
            } else {
                const saveResult = await target.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    return api.callActiveWorkspaceCommand?.('handleSaveAs');
                });
                expect(saveResult?.called).toBe(true);
                expect(saveResult?.value).toBe(true);
            }
            const download = await downloadPromise;
            await expect.poll(async () => await target.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).getAttribute('aria-description') ?? '', {timeout: 30_000}).not.toMatch(/unsaved/i);
            const savedPath = resolve(process.cwd(), '.devkit/browser-transfer-save-reopen/transferred-edited.pdf');
            await download.saveAs(savedPath);

            // Fresh storage makes the reopen prove the downloaded PDF's bytes.
            const reopened = await lifecycle.browser.newPage();
            try {
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                const reopenChooserPromise = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenChooserPromise).setFiles(savedPath);
                await reopened.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                    state: 'visible',
                    timeout: 60_000,
                });
                await reopened.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Saved transfer PDF did not settle');
                });
                await expect.poll(async () => reopened.evaluate(() => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                        text?: string;
                        displayText?: string | null;
                        previewText?: string | null;
                    }>;}>(['annotationComments']);
                    return state?.annotationComments?.some(comment => [
                        comment.text,
                        comment.displayText,
                        comment.previewText,
                    ].includes('durable transfer edit')) ?? false;
                }), {timeout: 30_000}).toBe(true);
            } finally {
                await reopened.close();
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);

    // Sweep #845 item 8: Save As keeps each linked view's zoom.
    it('keeps each linked view zoom through a browser Save As', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_600,
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
            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            // Split Right from the tab menu shows the document in a second view.
            await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
            await page.getByRole('menuitem', {
                name: 'Split Right',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count(), {timeout: 20_000}).toBe(2);
            const [
                leftPane,
                rightPane,
            ] = await page.locator('.editor-pane').evaluateAll(panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
            await page.locator(`${paneSelector(rightPane!)} .page_container--rendered canvas`).first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            // Each view takes its own custom zoom.
            await clickCenter(page, `${paneSelector(leftPane!)} .tab.is-active[data-tab-id]`);
            await zoomActivePane(page, leftPane!, 'Zoom In', 2);
            await clickCenter(page, `${paneSelector(rightPane!)} .tab.is-active[data-tab-id]`);
            await zoomActivePane(page, rightPane!, 'Zoom Out', 2);
            const before = {
                left: await readPanePageWidth(page, leftPane!),
                right: await readPanePageWidth(page, rightPane!),
            };
            expect(before.left).not.toBe(before.right);

            // Save As from the right view's Save options menu.
            const readWorkingCopyPath = () => page.evaluate(() => (
                (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi)
                    .readActiveWorkspaceStateValues?.<{workingCopyPath?: string | null}>(['workingCopyPath']).workingCopyPath ?? null
            ));
            const workingCopyBefore = await readWorkingCopyPath();
            expect(workingCopyBefore).not.toBeNull();
            const pagesBeforeSaveAs = {
                [leftPane!]: await page.locator(`${paneSelector(leftPane!)} .page_container--rendered[data-page="1"]`).elementHandle(),
                [rightPane!]: await page.locator(`${paneSelector(rightPane!)} .page_container--rendered[data-page="1"]`).elementHandle(),
            };
            expect(pagesBeforeSaveAs[leftPane!]).not.toBeNull();
            expect(pagesBeforeSaveAs[rightPane!]).not.toBeNull();
            const downloadPromise = page.waitForEvent('download');
            await page.locator('button[aria-label="Save options"]:not([disabled])').first().click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            await downloadPromise;
            // The Save As has taken effect once the document moved to a new working copy.
            let workingCopyAfter: string | null = null;
            await expect.poll(async () => {
                workingCopyAfter = await readWorkingCopyPath();
                return workingCopyAfter !== null && workingCopyAfter !== workingCopyBefore;
            }, {timeout: 30_000}).toBe(true);
            // Wait for the replacement page, then read its readiness and width
            // in one browser observation. An outgoing page can detach between
            // separate readiness and geometry reads.
            const readCurrentPaintedPageWidth = async (paneId: string) => {
                await clickCenter(page, `${paneSelector(paneId)} .tab.is-active[data-tab-id]`);
                const observation = await page.waitForFunction(({
                    selector, previousPage, workingCopyPath,
                }) => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    const currentPage = document.querySelector<HTMLElement>(selector);
                    const canvas = currentPage?.querySelector('canvas');
                    const canvasRect = canvas?.getBoundingClientRect();
                    const canvasVisible = canvas && getComputedStyle(canvas).visibility === 'visible';
                    if (!currentPage?.isConnected || currentPage === previousPage
                        || !canvasVisible || !canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0
                        || api.getActiveToolbarSnapshot?.()?.initialVisualReady !== true
                        || api.readActiveWorkspaceStateValues?.<{workingCopyPath?: string | null}>(['workingCopyPath']).workingCopyPath !== workingCopyPath) {
                        return null;
                    }
                    return {width: Math.round(currentPage.getBoundingClientRect().width)};
                }, {
                    selector: `${paneSelector(paneId)} .page_container--rendered[data-page="1"]`,
                    previousPage: pagesBeforeSaveAs[paneId],
                    workingCopyPath: workingCopyAfter,
                }, {timeout: 30_000});
                const measured = await observation.jsonValue();
                if (!measured) {
                    throw new Error('Replacement page observation is unavailable');
                }
                return measured.width;
            };

            expect({
                right: await readCurrentPaintedPageWidth(rightPane!),
                left: await readCurrentPaintedPageWidth(leftPane!),
            }).toEqual(before);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    // T3 and T4: one file opened in two windows is two documents. The first Save writes the file; the
    // second finds it changed since its window opened it, is refused, and offers Save As.
    it('refuses the later of two windows\' Saves to one file and offers Save As', async () => {
        const fileName = 'two-windows.pdf';
        const book = await createReadingBook('Two windows', fileName);
        const context = await lifecycle.browser.newContext({viewport: {width: 1_280, height: 900}});
        try {
            await context.addInitScript(installPickerHandleFixture);
            await context.addInitScript((name) => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showOpenFilePicker', async () => [new File([], name)]);
            }, fileName);
            const windows: Page[] = [];
            for (const note of ['First window note', 'Second window note']) {
                const page = await context.newPage();
                await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
                if (windows.length === 0) {
                    await page.evaluate(async ({name, content}) => {
                        const output = await (await (await navigator.storage.getDirectory()).getFileHandle(name, {create: true})).createWritable();
                        await output.write(Uint8Array.from(content));
                        await output.close();
                    }, {name: fileName, content: Array.from(book.buffer)});
                }
                await page.getByRole('button', {name: 'Open File', exact: true}).first().click();
                await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe('Two windows page 1');
                await settleActiveOpen(page);
                await addNote(page, note, {x: 90, y: 100});
                windows.push(page);
            }
            const readFile = (page: Page) => page.evaluate(async (name) => {
                const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
                return Array.from(new Uint8Array(await file.arrayBuffer()));
            }, fileName).then(async bytes => noteTexts(await PDFDocument.load(Uint8Array.from(bytes))));
            const [first, second] = windows as [Page, Page];
            const firstSave = first.locator('.save-split-primary').first();
            await expect.poll(() => firstSave.isDisabled(), {timeout: 15_000}).toBe(false);
            await firstSave.click();
            await expect.poll(() => firstSave.getAttribute('aria-busy'), {timeout: 15_000}).toBe('false');
            await expect.poll(() => firstSave.isDisabled(), {timeout: 15_000}).toBe(true);
            expect(await readFile(first)).toEqual(new Set(['First window note']));

            const secondSave = second.locator('.save-split-primary').first();
            await expect.poll(() => secondSave.isDisabled(), {timeout: 15_000}).toBe(false);
            await secondSave.click();
            await expect.poll(() => secondSave.getAttribute('aria-busy'), {timeout: 15_000}).toBe('false');
            expect(await readFile(second)).toEqual(new Set(['First window note']));
            expect(await secondSave.isDisabled()).toBe(false);
            await second.getByRole('button', {name: 'Save options', exact: true}).click();
            const download = second.waitForEvent('download');
            await second.evaluate(() => Reflect.set(window, 'showSaveFilePicker', undefined));
            await second.getByRole('menuitem', {name: /^Save As/u}).click();
            // Save As overlays this window's unsaved edits on the file as it is now.
            const expectedNotes = new Set(['First window note', 'Second window note']);
            expect(noteTexts(await PDFDocument.load(readFileSync(await (await download).path())))).toEqual(expectedNotes);
            await second.getByRole('button', {name: 'Toggle Sidebar', exact: true}).click();
            await second.getByRole('tab', {name: 'Annotations', exact: true}).click();
            await expect.poll(async () => new Set(await second.locator('.notes-list .note-item-text').allTextContents()), {timeout: 15_000})
                .toEqual(expectedNotes);
        } finally {
            await context.close();
        }
    }, 120_000);
});
