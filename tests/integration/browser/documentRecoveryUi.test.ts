import {createHash} from 'node:crypto';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString, StandardFonts,
} from 'pdf-lib';
import type {BrowserContext} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import {
    lifecycle, readPersistedDocumentBytes, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
    it('reuses dirty recovery bytes for reading changes and protects the next note edit', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        for (let number = 1; number <= 3; number += 1) {
            pdf.addPage([
                612,
                792,
            ]).drawText(`Recovery reading page ${String(number)}`, {
                x: 40,
                y: 740,
                font,
                size: 16,
            });
        }
        const source = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-b/core/w02/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), source);
        const observations: unknown[] = [];
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 800,
        }});
        let problems: string[] = [];
        try {
            const page = await context.newPage();
            problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'recovery-reading.pdf',
                mimeType: 'application/pdf',
                buffer: source,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 200,
                y: 200,
            }});
            const input = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            const acceptedText = 'Accepted note before reading';
            await input.fill(acceptedText);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();

            async function readRecovery() {
                const tab = await page.evaluate(async () => {
                    const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                        const request = indexedDB.open('evb-viewer-browser-documents');
                        request.onsuccess = () => resolveDb(request.result);
                        request.onerror = () => rejectDb(request.error);
                    });
                    try {
                        const records = await new Promise<Array<{checkpoint: {tabs: Array<{
                            isDirty: boolean;
                            currentPage: number | null;
                            zoom: number | null;
                            workingCopyRef: string | null;
                            annotationRecovery?: {payload?: {drafts: Array<{text: string}>}}
                        }>}}>>((resolveRows, rejectRows) => {
                            const request = db.transaction('workspace-recovery', 'readonly').objectStore('workspace-recovery').getAll();
                            request.onsuccess = () => resolveRows(request.result);
                            request.onerror = () => rejectRows(request.error);
                        });
                        const tab = records.flatMap(record => record.checkpoint.tabs).find(candidate => candidate.isDirty);
                        return tab;
                    } finally {db.close();}
                });
                return {
                    tab,
                    bytes: tab?.workingCopyRef ? await readPersistedDocumentBytes(page, tab.workingCopyRef) : [],
                };
            }
            async function savedNoteTexts(recovery: Awaited<ReturnType<typeof readRecovery>>) {
                if (!recovery.bytes.length) return [];
                const saved = await PDFDocument.load(Uint8Array.from(recovery.bytes));
                const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                return Array.from({length: annots?.size() ?? 0}, (_, index) =>
                    annots!.lookup(index, PDFDict).lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText());
            }
            let initial: Awaited<ReturnType<typeof readRecovery>> | undefined;
            await expect.poll(async () => {
                const recovery = await readRecovery();
                const texts = await savedNoteTexts(recovery);
                if (!texts.includes(acceptedText)) return false;
                initial = recovery;
                return true;
            }, {timeout: 15_000}).toBe(true);
            const initialHash = createHash('sha256').update(Uint8Array.from(initial!.bytes)).digest('hex');
            observations.push({
                event: 'accepted note',
                ref: initial!.tab?.workingCopyRef,
                hash: initialHash,
            });

            for (const number of [
                2,
                3,
            ]) {
                // Trusted reading input; the persisted page is the completion
                // boundary, so there is no negative observation delay.
                await page.locator('.page-controls-display').click();
                const pageInput = page.locator('.page-controls-inline-input');
                await pageInput.fill(String(number));
                await pageInput.press('Enter');
                await page.locator(`.page_container[data-page="${String(number)}"] .textLayer`).filter({hasText: `Recovery reading page ${String(number)}`}).waitFor({state: 'visible'});
                await expect.poll(async () => (await readRecovery()).tab?.currentPage, {timeout: 15_000}).toBe(number);
                const recovery = await readRecovery();
                const hash = createHash('sha256').update(Uint8Array.from(recovery.bytes)).digest('hex');
                observations.push({
                    event: `page ${String(number)}`,
                    ref: recovery.tab?.workingCopyRef,
                    hash,
                });
                expect(recovery.tab?.workingCopyRef).toBe(initial!.tab?.workingCopyRef);
                expect(hash).toBe(initialHash);
            }

            await page.locator('.page-controls-display').click();
            const pageInput = page.locator('.page-controls-inline-input');
            await pageInput.fill('1');
            await pageInput.press('Enter');
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            const draft = 'Protected newer draft after reading';
            await input.fill(draft);
            await expect.poll(async () => savedNoteTexts(await readRecovery()), {timeout: 15_000}).toContain(draft);
            const edited = await readRecovery();
            expect(edited.tab?.workingCopyRef).not.toBe(initial!.tab?.workingCopyRef);
            observations.push({
                event: 'new draft',
                ref: edited.tab?.workingCopyRef,
                drafts: edited.tab?.annotationRecovery?.payload?.drafts,
            });
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            await expect.poll(() => input.inputValue()).toBe(draft);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const savedPath = resolve(evidenceDir, 'restored.pdf');
            await (await download).saveAs(savedPath);
            const saved = await PDFDocument.load(readFileSync(savedPath));
            expect(saved.getPageCount()).toBe(3);
            const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            const texts = Array.from({length: annots.size()}, (_, index) =>
                annots.lookup(index, PDFDict).lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText());
            expect(texts).toContain(draft);
            expect(problems).toEqual([]);
            observations.push({
                event: 'recovered Save As',
                texts,
            });
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await context.close();
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('recovers the current note draft while document note updates keep rejecting', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([
            612,
            792,
        ]).drawText('Sustained note failure recovery', {
            x: 40,
            y: 740,
            font,
            size: 16,
        });
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-1108/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const observations: unknown[] = [];
        try {
            for (const retained of [
                false,
                true,
            ]) {
                const context = await lifecycle.browser.newContext({viewport: {
                    width: 1280,
                    height: 800,
                }});
                let problems: string[] = [];
                try {
                    const page = await context.newPage();
                    problems = collectConsoleProblems(page);
                    // Fault setup only; note input and restored Save As remain trusted.
                    await page.route('**/composables/useWorkspaceAnnotationSession.ts*', async route => {
                        const response = await route.fetch();
                        const body = await response.text();
                        const marker = 'const comment = resolveNoteComment(annotationId);';
                        if (!body.includes(marker)) throw new Error('Document note update fault seam was not found');
                        await route.fulfill({
                            response,
                            body: body.replace(marker,
                                'if (Reflect.get(window, "__noteRecoveryFailure")) throw new Error("1108 sustained note update rejection"); ' + marker),
                        });
                    });
                    await page.addInitScript(() => {
                        Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                        Reflect.set(window, '__noteRecoveryFailure', true);
                        Reflect.set(window, 'showSaveFilePicker', undefined);
                        sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                    });
                    await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                    await waitForOpenFileReady(page);
                    await page.evaluate(() => Reflect.set(window, '__noteRecoveryFailure', false));
                    keepFileChooserInterceptionEnabled(page);
                    const chooser = page.waitForEvent('filechooser');
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().click();
                    await (await chooser).setFiles({
                        name: 'sustained-note.pdf',
                        mimeType: 'application/pdf',
                        buffer: bytes,
                    });
                    await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
                    await page.getByRole('button', {
                        name: 'Place a sticky note on the page.',
                        exact: true,
                    }).click();
                    const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
                    if (!bounds) throw new Error('The first PDF page is not visible');
                    await page.mouse.click(bounds.x + 200, bounds.y + 200);
                    const input = page.getByRole('textbox', {
                        name: 'Write annotation note',
                        exact: true,
                    });
                    async function readCheckpoint() {
                        return page.evaluate(async () => {
                            const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                                const request = indexedDB.open('evb-viewer-browser-documents');
                                request.onsuccess = () => resolveDb(request.result);
                                request.onerror = () => rejectDb(request.error);
                            });
                            try {
                                return await new Promise<Array<{checkpoint: {tabs: Array<{
                                    isDirty: boolean;
                                    workingCopyRef: string | null;
                                    annotationRecovery?: {payload?: {drafts: Array<{text: string}>}}
                                }>}}>>((resolveRows, rejectRows) => {
                                    const request = db.transaction('workspace-recovery', 'readonly').objectStore('workspace-recovery').getAll();
                                    request.onsuccess = () => resolveRows(request.result);
                                    request.onerror = () => rejectRows(request.error);
                                });
                            } finally {db.close();}
                        });
                    }
                    if (retained) {
                        await input.fill('Previously accepted text');
                        await page.getByRole('button', {
                            name: 'Minimize note',
                            exact: true,
                        }).click();
                        await expect.poll(async () => {
                            const refs = (await readCheckpoint()).flatMap(record => record.checkpoint.tabs
                                .filter(tab => tab.isDirty && tab.workingCopyRef)
                                .map(tab => tab.workingCopyRef!));
                            const copies = await Promise.all(refs.map(ref => readPersistedDocumentBytes(page, ref)));
                            for (const copy of copies) {
                                if (!copy.length) continue;
                                const saved = await PDFDocument.load(Uint8Array.from(copy));
                                const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                                for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
                                    const annotation = annots!.lookup(index, PDFDict);
                                    if (annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Text') continue;
                                    const text = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText();
                                    if (text === 'Previously accepted text') {
                                        observations.push({
                                            retained,
                                            retainedSavedText: text,
                                        });
                                        writeFileSync(resolve(evidenceDir, 'retained-before-failure.pdf'), Uint8Array.from(copy));
                                        return true;
                                    }
                                }
                            }
                            return false;
                        }, {timeout: 15_000}).toBe(true);
                        await page.getByRole('button', {
                            name: 'Open Note',
                            exact: true,
                        }).click();
                    }
                    const draft = retained ? 'Protected newer draft over an older snapshot' : 'Protected draft without a previous snapshot';
                    await page.evaluate(() => Reflect.set(window, '__noteRecoveryFailure', true));
                    await input.fill(draft);
                    await page.waitForFunction(() => document.querySelector('.app-toast-failure')?.textContent?.includes('1108 sustained note update rejection'));
                    await page.screenshot({path: resolve(evidenceDir, `failure-${String(retained)}.png`)});
                    await expect.poll(async () => {
                        const records = await readCheckpoint();
                        observations.push({
                            retained,
                            records,
                        });
                        return records.some(record => record.checkpoint.tabs.some(tab => tab.isDirty && tab.workingCopyRef
                            && tab.annotationRecovery?.payload?.drafts.some(value => value.text === draft)));
                    }, {timeout: 15_000}).toBe(true);
                    await page.screenshot({path: resolve(evidenceDir, `protected-${String(retained)}.png`)});
                    // Renderer restart retains the durable browser owner and database.
                    // The fault remains active in the restarted renderer.
                    await page.reload({waitUntil: 'domcontentloaded'});
                    await waitForOpenFileReady(page);
                    await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
                    await expect.poll(() => input.inputValue()).toBe(draft);
                    await page.screenshot({path: resolve(evidenceDir, `restored-${String(retained)}.png`)});
                    await page.evaluate(() => Reflect.set(window, '__noteRecoveryFailure', false));
                    await page.getByRole('button', {
                        name: 'Minimize note',
                        exact: true,
                    }).click();
                    const download = page.waitForEvent('download');
                    await page.getByRole('button', {
                        name: 'Save options',
                        exact: true,
                    }).click();
                    await page.getByRole('menuitem', {name: /^Save As/u}).click();
                    const savedPath = resolve(evidenceDir, `restored-${String(retained)}.pdf`);
                    await (await download).saveAs(savedPath);
                    const saved = await PDFDocument.load(readFileSync(savedPath));
                    const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                    const texts: string[] = [];
                    for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
                        const annotation = annots!.lookup(index, PDFDict);
                        if (annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Text') continue;
                        const text = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
                        if (text) texts.push(text.decodeText());
                    }
                    expect(texts).toEqual([draft]);
                    expect(problems.filter(problem => !problem.includes('1108 sustained note update rejection'))).toEqual([]);
                    observations.push({
                        retained,
                        restoredDraft: draft,
                        savedTexts: texts,
                        problems,
                    });
                } finally {
                    observations.push({
                        retained,
                        problems,
                    });
                    await context.close();
                }
            }
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify(observations, null, 2));
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('retains the note draft and actionable cause when a note update rejects', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([
            612,
            792,
        ]).drawText('Note update failure fixture', {
            x: 40,
            y: 740,
            font,
            size: 16,
        });
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-1205/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        let context: BrowserContext | undefined;
        let problems: string[] = [];
        const observations: unknown[] = [];
        const reason = 'RUX06 note write rejected by document policy';
        try {
            context = await lifecycle.browser.newContext({
                viewport: {
                    width: 1280,
                    height: 800,
                },
                permissions: [
                    'clipboard-read',
                    'clipboard-write',
                ],
            });
            const page = await context.newPage();
            problems = collectConsoleProblems(page);
            // Setup rejects the document update boundary before it mutates. All
            // editing, Retry, minimize/reopen and Save As use trusted user input.
            await page.route('**/composables/useWorkspaceAnnotationSession.ts*', async route => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'const comment = resolveNoteComment(annotationId);';
                if (!body.includes(marker)) throw new Error('Document note update fault seam was not found');
                await route.fulfill({
                    response,
                    body: body.replace(marker, 'if (Reflect.get(window, "__noteUpdateFailure")) throw new Error("RUX06 note write rejected by document policy"); ' + marker),
                });
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, '__noteUpdateFailure', false);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'note-update.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state:'visible'});
            // Establish pane layout before note placement and geometry comparison.
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name:'Place a sticky note on the page.',
                exact:true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const note = page.locator('.note-window').first();
            const input = page.getByRole('textbox', {
                name:'Write annotation note',
                exact:true,
            });
            await input.fill('Initial accepted note');
            await page.getByRole('button',{
                name:'Minimize note',
                exact:true,
            }).click();
            await page.getByRole('button',{
                name:'Open Note',
                exact:true,
            }).click();
            await expect.poll(() => input.inputValue()).toBe('Initial accepted note');
            // The textarea echoes a draft before persistence. Arm rejection only
            // after the document's rendered list confirms the initial update,
            // so this fault targets one draft rather than two separate edits.
            await expect.poll(() => page.locator('.note-item-text').allTextContents()).toEqual(['Initial accepted note']);
            observations.push({
                step: 'initial-committed',
                text: await page.locator('.note-item-text').allTextContents(),
            });
            const initialRect = await note.boundingBox();
            const initialInputRect = await input.boundingBox();
            await page.evaluate(() => Reflect.set(window,'__noteUpdateFailure',true));
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
            const typingBounds = await input.boundingBox();
            if (!typingBounds) throw new Error('The note input is not visible');
            await page.mouse.move(typingBounds.x + 20, typingBounds.y + 20, {steps: 10});
            await input.fill('Retained RUX06 draft');
            // Either baseline's inline row or the operation toast acknowledges
            // completion, so a missing fault cannot masquerade as a red proof.
            await page.waitForFunction(() => Boolean(document.querySelector('.note-window__error') || Array.from(document.querySelectorAll('[role="alert"]')).some(element => element.textContent?.includes('Unable to update this note.'))));
            observations.push({
                step:'failure',
                text:await input.inputValue(),
                rect:await note.boundingBox(),
                inline:await note.locator('[role="alert"]').count(),
                alerts:await page.locator('[role="alert"]').allTextContents(),
            });
            await page.screenshot({path:resolve(evidenceDir,'failure.png')});
            expect(await input.inputValue()).toBe('Retained RUX06 draft');
            expect(await note.boundingBox()).toEqual(initialRect);
            expect(await input.boundingBox()).toEqual(initialInputRect);
            expect(await note.locator('[role="alert"]').count()).toBe(0);
            const toast = page.locator('.app-toast-failure:not([data-state="closed"])');
            await expect.poll(() => toast.count()).toBe(1);
            await expect.poll(() => toast.innerText()).toContain(reason);
            await expect.poll(() => toast.innerText()).toContain('Error ID');
            const originalErrorId = /Error ID: ([a-f0-9]{8})/u.exec(await toast.innerText())?.[1];
            expect(originalErrorId).toBeTruthy();
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).first().click();
            await expect.poll(() => toast.count()).toBe(1);
            await expect.poll(() => toast.innerText()).toContain(`Error ID: ${originalErrorId}`);
            observations.push({
                step: 'save-blocked',
                toast: await toast.innerText(),
                text: await input.inputValue(),
            });
            await toast.getByRole('button', {
                name: 'Copy details',
                exact: true,
            }).click();
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            expect(copied).toContain(reason);
            expect(copied).toContain(`Error ID: ${originalErrorId}`);
            writeFileSync(resolve(evidenceDir, 'copied.txt'), copied);

            await input.fill('Retained RUX06 draft plus newer typing');
            await page.waitForFunction(previousId => {
                const failure = document.querySelector('.app-toast-failure:not([data-state="closed"])');
                return failure?.textContent?.includes('RUX06 note write rejected by document policy')
                    && !failure.textContent.includes(`Error ID: ${previousId}`);
            }, originalErrorId);
            await expect.poll(() => toast.count()).toBe(1);
            await page.evaluate(() => Reflect.set(window, '__noteUpdateFailure', false));
            await toast.getByRole('button', {
                name: 'Retry',
                exact: true,
            }).click();
            await page.getByRole('button',{
                name:'Minimize note',
                exact:true,
            }).click();
            await page.getByRole('button',{
                name:'Open Note',
                exact:true,
            }).click();
            await expect.poll(() => input.inputValue()).toBe('Retained RUX06 draft plus newer typing');
            expect(await note.locator('[role="alert"]').count()).toBe(0);
            const download = page.waitForEvent('download');
            await page.getByRole('button',{
                name:'Save options',
                exact:true,
            }).click();
            await page.getByRole('menuitem',{name:/^Save As/u}).click();
            const savedPath=resolve(evidenceDir,'saved.pdf');
            await (await download).saveAs(savedPath);
            const saved=await PDFDocument.load(readFileSync(savedPath));
            const annots=saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'),PDFArray);
            const contents: string[]=[];
            for(let i=0;i<(annots?.size()??0);i++) {
                const annotation=annots!.lookup(i,PDFDict);
                if (annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Text') continue;
                const text=annotation.lookupMaybe(PDFName.of('Contents'),PDFString,PDFHexString);
                if(text) contents.push(text.decodeText());
            }
            expect(contents.filter(text=>text==='Retained RUX06 draft plus newer typing')).toHaveLength(1);
            observations.push({
                step:'retry-saved',
                contents,
            });
            const reopenedContext = await lifecycle.browser.newContext({viewport: {
                width: 1280,
                height: 800,
            }});
            try {
                const reopened = await reopenedContext.newPage();
                const reopenedProblems = collectConsoleProblems(reopened);
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                keepFileChooserInterceptionEnabled(reopened);
                const reopenedChooser = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenedChooser).setFiles(savedPath);
                await reopened.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
                await expect.poll(() => reopened.getByRole('button', {
                    name: 'Open Note',
                    exact: true,
                }).count()).toBe(1);
                await reopened.getByRole('button', {
                    name: 'Open Note',
                    exact: true,
                }).click();
                const reopenedInput = reopened.getByRole('textbox', {
                    name: 'Write annotation note',
                    exact: true,
                });
                await expect.poll(() => reopenedInput.inputValue()).toBe('Retained RUX06 draft plus newer typing');
                observations.push({
                    step: 'saved-reopened',
                    text: await reopenedInput.inputValue(),
                });
                expect(reopenedProblems).toEqual([]);
                await reopened.screenshot({path: resolve(evidenceDir, 'recovered.png')});
            } finally {
                await reopenedContext.close();
            }
            // The injected writer fault is the expected operation failure. Its
            // existing recovery preparation gate is tracked separately in #1108;
            // preserve those exact diagnostics in evidence rather than hiding them.
            const injectedDiagnostics = [
                reason,
                'Open annotation notes could not be prepared for crash recovery.',
                'did not produce a recovery snapshot; retrying without it',
                'Workspace save did not commit {planKind: null, status: not-saved, reason: note-persistence-failed, phase: pre-write}',
            ];
            expect(problems.filter(problem => !injectedDiagnostics.some(diagnostic => problem.includes(diagnostic)))).toEqual([]);

        } finally {
            writeFileSync(resolve(evidenceDir,'observations.json'),JSON.stringify(observations,null,2));
            writeFileSync(resolve(evidenceDir,'console.json'),JSON.stringify(problems,null,2));
            try {await context?.close();} finally {await Promise.all(lifecycle.browser.contexts().map(context => context.close()));}
        }
    }, 90_000);

    // T2/T3, issue #1027: accepted note text reaches recovery bytes, and its
    // icon reaches the printed canvas while the original remains unsaved.
    it('materializes an unsaved note for browser recovery and print without saving the original', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 800,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                // Observe the system-print boundary in every frame without
                // opening a native dialog. The canvas is the printed artifact.
                window.print = () => {
                    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.browser-print-page canvas')];
                    let yellowPixels = 0;
                    for (const canvas of canvases) {
                        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
                        if (!pixels) throw new Error('The print canvas has no pixels');
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index]! > 150 && pixels[index + 1]! > 100 && pixels[index + 2]! < 100) {
                                yellowPixels += 1;
                            }
                        }
                    }
                    Reflect.set(window.top!, '__printedNote', {
                        pages: canvases.length,
                        yellowPixels,
                    });
                };
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            // A clean document isolates a newly created /Text note from
            // foreign annotations whose missing appearances have other causes.
            const pdf = await PDFDocument.create();
            const font = await pdf.embedFont(StandardFonts.Helvetica);
            pdf.addPage([
                612,
                792,
            ]).drawText('Browser sticky-note print regression', {
                x: 72,
                y: 720,
                font,
                size: 18,
            });
            await (await chooser).setFiles({
                name: 'browser-note-print.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const text = 'Recovery descriptor regression note';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            expect(await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Reflect.get(window, '__printedNote')?.yellowPixels ?? 0), {timeout: 15_000}).toBeGreaterThan(50);
            expect(await page.evaluate(() => Reflect.get(window, '__printedNote').pages)).toBeGreaterThan(0);
            await expect.poll(async () => {
                const rows = await page.evaluate(async () => {
                    const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                        const request = indexedDB.open('evb-viewer-browser-documents');
                        request.onsuccess = () => resolveDb(request.result);
                        request.onerror = () => rejectDb(request.error);
                    });
                    try {
                        const rows = await new Promise<Array<{
                            ref: string;
                            fileName: string;
                            kind: string
                        }>>((resolveRows, rejectRows) => {
                            const request = db.transaction('documents', 'readonly').objectStore('documents').getAll();
                            request.onsuccess = () => resolveRows(request.result);
                            request.onerror = () => rejectRows(request.error);
                        });
                        return rows;
                    } finally {
                        db.close();
                    }
                });
                const bytes = await Promise.all(rows.map(row => readPersistedDocumentBytes(page, row.ref)));
                const encoded = [...text].map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
                return {
                    recovered: rows.some((row, index) => row.fileName.endsWith('.recovery.pdf') && new TextDecoder().decode(Uint8Array.from(bytes[index]!)).toLowerCase().includes(encoded)),
                    originalChanged: rows.some((row, index) => row.kind === 'source' && new TextDecoder().decode(Uint8Array.from(bytes[index]!)).toLowerCase().includes(encoded)),
                };
            }, {timeout: 15_000}).toEqual({
                recovered: true,
                originalChanged: false,
            });
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);
});
