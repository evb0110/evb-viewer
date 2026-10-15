import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, StandardFonts,
} from 'pdf-lib';
import type {loadBrowserWorkspaceRecovery} from '@app/platform/browser/browserWorkspaceRecoveryStore';
import type {Page} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, freezeWindow, addNote, noteTexts, readRecoveries, readLeaseOwnerLocks, clickCenter, paneSelector, readPanePageWidth, zoomActivePane,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
    // T2 (#1284): a frozen or throttled window is alive while it holds its
    // lease lock. A second window must not take its recovery record, or the
    // owner fences itself on resume and its later notes have no recovery copy.
    it.each([
        true,
        false,
    ])('leaves a frozen window its recovery and recovers its later notes after it closes (Web Locks: %s)', async hasLocks => {
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
            await context.addInitScript((enabled) => {
                if (!enabled) Object.defineProperty(navigator, 'locks', {value: undefined});
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            }, hasLocks);
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
            if (hasLocks) await expect.poll(async () => (await readLeaseOwnerLocks(owner)).held, {timeout: 15_000}).toContain(ownerId);

            const resumeOwner = await freezeWindow(context, owner);

            // The second window starts as if the owner had been silent for a
            // minute: its clock runs 60 s ahead, past the 30 s after which a
            // silent owner's heartbeat no longer protects its record.
            const second = await openWindow(page => page.addInitScript((aheadMs) => {
                const now = Date.now.bind(Date);
                Date.now = () => now() + aheadMs;
            }, 60_000));
            if (hasLocks) {
                expect((await readLeaseOwnerLocks(second)).held).toContain(ownerId);
                expect((await readRecoveries(second)).map(record => record.ownerId)).toEqual([ownerId]);
                expect(await second.locator('.page_container').count()).toBe(0);
            } else {
                await second.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            }

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
            // the owner is gone; its record is recoverable at once.
            await owner.close();
            if (hasLocks) await expect.poll(async () => (await readLeaseOwnerLocks(second)).held, {timeout: 15_000}).not.toContain(ownerId);
            if (!hasLocks) await second.close();
            const recovered = await openWindow(hasLocks ? undefined : page => page.addInitScript(() => {
                const now = Date.now.bind(Date);
                Date.now = () => now() + 60000;
            }));
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
    // with one owner id. If the window holding the owner's lease lock gave
    // up the id and kept the lock, the copy waited for that lock forever and
    // none of its notes reached recovery, and the lock outlived the copy, so
    // no other window could recover its record after it closed.
    it.each([
        true,
        false,
    ])('keeps a duplicated window\'s notes recoverable (Web Locks: %s)', async (hasWebLocks) => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-duplicate-${process.pid}-${hasWebLocks ? 'locks' : 'no-locks'}`);
        mkdirSync(evidenceDir, {recursive: true});
        const consoleProblems: string[][] = [];
        try {
            const context = await lifecycle.browser.newContext({viewport: {
                width: 1_280,
                height: 800,
            }});
            await context.addInitScript((hasLocks) => {
                if (!hasLocks) Object.defineProperty(navigator, 'locks', {value: undefined});
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            }, hasWebLocks);
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
            if (hasWebLocks) {
                await expect.poll(async () => (await readLeaseOwnerLocks(original)).held, {timeout: 15_000})
                    .toEqual([originalOwnerId]);
            }
            const readOriginalRecovery = (page: Page) => page.evaluate<Awaited<ReturnType<typeof loadBrowserWorkspaceRecovery>>>(`(async () => {
                const {loadBrowserWorkspaceRecovery} = await import('/_nuxt/platform/browser/browserWorkspaceRecoveryStore.ts');
                return loadBrowserWorkspaceRecovery(${JSON.stringify(originalOwnerId)});
            })()`);
            const frozenReader = await context.newPage();
            await frozenReader.goto(`${lifecycle.origin}/pdfjs/images/annotation-paperclip.svg`);
            const resumeOriginal = await freezeWindow(context, original);
            // A heartbeat already admitted before the pause can still commit.
            // Read from the future copy after the pause, behind that IDB write.
            const beforeFreeze = await readOriginalRecovery(frozenReader);
            if (!beforeFreeze) throw new Error('The original has no recovery record after freezing');
            expect(Date.now() - beforeFreeze.updatedAt).toBeLessThan(30_000);
            console.info('Frozen duplicate setup', JSON.stringify({
                originalOwnerId,
                heartbeatAt: beforeFreeze.updatedAt,
            }));

            // The copy's instance nonce sorts first, so the nonces alone would
            // make the original give up the id. It cannot answer discovery
            // while frozen: its lock, or its fresh heartbeat without Web Locks,
            // must keep the copy from taking over the original's journal.
            const copy = await openWindow(page => page.addInitScript((windowName) => {
                if (!window.name) window.name = windowName;
                Reflect.set(window, '__evbBrowserWindowTabsState', {recoveryInstanceNonce: '!'});
                if (!navigator.locks) {
                    // Reload at the first asynchronous discovery wait, before
                    // an unproven inherited owner could finish its claim.
                    const setWindowTimeout = window.setTimeout.bind(window);
                    Reflect.set(window, 'setTimeout', (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
                        if (timeout === 60 && !sessionStorage.getItem('evb-test:duplicate-reloaded')) {
                            sessionStorage.setItem('evb-test:duplicate-reloaded', '1');
                            window.location.reload();
                            return 0;
                        }
                        return setWindowTimeout(handler, timeout, ...args);
                    });
                }
            }, `evb-viewer-window:${originalOwnerId.slice('window:'.length)}`), frozenReader);
            if (!hasWebLocks) expect(await copy.evaluate(() => performance.getEntriesByType('navigation')
                .some(entry => 'type' in entry && entry.type === 'reload'))).toBe(true);
            const copyOwnerId = await copy.evaluate(() => `window:${window.name.slice('evb-viewer-window:'.length)}`);
            expect(copyOwnerId).not.toBe(originalOwnerId);
            expect(await copy.locator('.page_container').count()).toBe(0);
            expect(await readOriginalRecovery(copy)).toEqual(beforeFreeze);
            if (hasWebLocks) expect(await readLeaseOwnerLocks(copy)).toEqual({
                held: [
                    originalOwnerId,
                    copyOwnerId,
                ].sort(),
                pending: [],
            });
            console.info('Frozen duplicate started', JSON.stringify({
                originalOwnerId,
                copyOwnerId,
            }));
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
            // Each owner id's lock is held, and no window waits for one.
            if (hasWebLocks) expect(await readLeaseOwnerLocks(original)).toEqual({
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

            if (!hasWebLocks) {
                // Reload replaces this context, so it recovers its own fresh
                // journal while leaving the original window's work intact.
                await copy.reload({waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(copy);
                await copy.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
                expect(await copy.evaluate(() => `window:${window.name.slice('evb-viewer-window:'.length)}`)).toBe(copyOwnerId);
                const download = copy.waitForEvent('download');
                await copy.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).click();
                await copy.getByRole('menuitem', {name: /^Save As/u}).click();
                const savedPath = resolve(evidenceDir, 'reloaded-copy.pdf');
                await (await download).saveAs(savedPath);
                const saved = await PDFDocument.load(readFileSync(savedPath));
                expect(noteTexts(saved)).toEqual(new Set(['Copy note']));
                await expect.poll(async () => (await readRecoveries(original)).map(record => [...record.notes].sort()), {timeout: 15_000})
                    .toEqual([[
                        'Original note',
                        'Second original note',
                    ]]);
                writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify({
                    originalOwnerId,
                    copyOwnerId,
                    beforeFreeze,
                    afterOriginalEdit: await readOriginalRecovery(original),
                    savedCopyNotes: [...noteTexts(saved)],
                    problems: consoleProblems.flat(),
                }, null, 2));
                expect(consoleProblems.flat()).toEqual([]);
                return;
            }

            // Closing the copy releases its lock and only its lock, and its
            // record is recoverable at once.
            await copy.close();
            await expect.poll(async () => (await readLeaseOwnerLocks(original)).held, {timeout: 15_000})
                .toEqual([ownerOf('Second original note')]);
            // A collector can still be finishing admission for the closed copy.
            // It does not own that window and must not make its journal look live.
            void original.evaluate(`(async () => {
                const {withLeaseOwnerLock} = await import('/_nuxt/platform/browser/browserDocumentLeaseStore.ts');
                await withLeaseOwnerLock(${JSON.stringify(copyOwnerId)}, async lock => {
                    if (lock !== 'acquired') throw new Error('Closed copy admission was not acquired');
                    await new Promise(resolve => Reflect.set(window, '__releaseClosedCopyAdmission', resolve));
                });
            })()`).catch(() => undefined);
            await original.waitForFunction(() => typeof Reflect.get(window, '__releaseClosedCopyAdmission') === 'function');
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
            await original.evaluate(() => Reflect.get(window, '__releaseClosedCopyAdmission')());
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

    it('proves a dirty viewer transfer after source loss before target authority readback', async () => {
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
                Reflect.set(window, '__evbTransferAuthorityCommittedReadBarrier', () => new Promise<void>(resolveBarrier => {
                    Reflect.set(window, '__evbReleaseTransferAuthorityCommittedReadBarrier', resolveBarrier);
                }));
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
            await target.waitForFunction(() => typeof Reflect.get(
                window,
                '__evbReleaseTransferAuthorityCommittedReadBarrier',
            ) === 'function', undefined, {timeout: 60_000});
            const provisional = await target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.() ?? null;
            });
            expect(provisional?.canSave).toBe(false);
            // Until the target reads back authority it offers no way to edit:
            // its note tool is disabled, or absent while it has no document.
            expect(await target.getByRole('button', {
                name: /sticky note/i,
                disabled: false,
            }).count()).toBe(0);
            await source.close();
            await target.evaluate(() => {
                const release = Reflect.get(window, '__evbReleaseTransferAuthorityCommittedReadBarrier');
                if (typeof release !== 'function') throw new Error('Target authority read barrier was not installed');
                release();
            });
            const transferResult = await transferPromise;
            expect(transferResult).toMatchObject({
                success: true,
                targetWindowId: 2,
            });

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
            const saveResult = await target.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.callActiveWorkspaceCommand?.('handleSaveAs');
            });
            expect(saveResult?.called).toBe(true);
            expect(saveResult?.value).toBe(true);
            const download = await downloadPromise;
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
});
