import {
    createHash, randomBytes,
} from 'node:crypto';
import {
    readFileSync, writeFileSync, rmSync, openSync, writeSync, closeSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFName,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    openPdfFromChooser, lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, addNote, noteTexts, clickCenter, paneSelector, zoomActivePane, settleActiveOpen,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {

    it('saves a note and rotation in a PDF over 16 MiB', async () => {
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1280,
                height: 900,
            },
            acceptDownloads: true,
        });
        try {
            const page = await context.newPage();
            const pdf = await PDFDocument.create();
            pdf.addPage([
                400,
                600,
            ]).drawText('Large PDF page one', {
                x: 40,
                y: 500,
                size: 24,
            });
            // A valid, incompressible stream crosses the old 16 MiB limit
            // without making the rendered page expensive or the fixture huge.
            pdf.catalog.set(PDFName.of('EvidencePadding'), pdf.context.register(
                pdf.context.stream(randomBytes(20 * 1024 * 1024)),
            ));
            const bytes = Buffer.from(await pdf.save({useObjectStreams: false}));
            expect(bytes.byteLength).toBeGreaterThan(20 * 1024 * 1024);
            await openPdfFromChooser(page, {
                name: 'large-note-and-rotation.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 60_000});
            await settleActiveOpen(page);
            await page.getByRole('button', {
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
            await expect.poll(async () => {
                const box = await page.locator('.page_container--rendered[data-page="1"]').first().boundingBox();
                return box ? box.width > box.height : false;
            }, {timeout: 60_000}).toBe(true);
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{isPageOperationInProgress: boolean}>(
                    ['isPageOperationInProgress'],
                ).isPageOperationInProgress === false;
            }, undefined, {timeout: 60_000});
            // Rotation can show its preview before the replacement page is interactive.
            await settleActiveOpen(page);
            await page.locator('.page_container[data-page="1"][data-page-raster="current"] [data-pdf-annotation-editor-ready="true"]').first().waitFor();
            await addNote(page, 'Large PDF note survives Save', {
                x: 120,
                y: 120,
            });
            const download = page.waitForEvent('download', {timeout: 60_000}).catch(() => null);
            const save = page.getByRole('button', {
                name: 'Save',
                exact: true,
            });
            await save.click();
            await expect.poll(() => save.getAttribute('aria-busy'), {timeout: 60_000}).toBe('false');
            expect(await page.locator('.app-toast-failure').allTextContents()).toEqual([]);
            const artifact = await download;
            expect(artifact).not.toBeNull();
            const savedPath = await artifact!.path();
            expect(savedPath).not.toBeNull();
            const saved = await PDFDocument.load(readFileSync(savedPath!));
            expect(saved.getPage(0).getRotation().angle).toBe(90);
            expect(Array.from(noteTexts(saved, '/Text'))).toContain('Large PDF note survives Save');
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
        } finally {
            await context.close();
        }
    }, 180_000);

    // T2, T3, C4: publication followed by a bookkeeping failure keeps the work
    // protected and reports what happened to the file, with a usable Save As.
    it('opens large PDFs through the chooser and Recent Files, keeps annotation editing available and explains invalid input', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const dropPath = resolve(process.cwd(), `.devkit/large-drop-${process.pid}.pdf`);
        const largePath = resolve(process.cwd(), `.devkit/billion-byte-${process.pid}.pdf`);
        const trace: string[] = [];
        page.on('console', message => trace.push(message.text()));
        page.on('crash', () => trace.push('PAGE CRASHED'));
        page.on('close', () => trace.push('PAGE CLOSED'));
        page.on('request', request => {
            if (request.isNavigationRequest()) trace.push(`NAVIGATION REQUEST ${request.url()}`);
        });
        page.on('response', response => {
            if (response.request().isNavigationRequest()) trace.push(`NAVIGATION RESPONSE ${response.status()} ${response.url()}`);
        });
        page.on('requestfailed', request => {
            if (request.isNavigationRequest()) trace.push(`NAVIGATION FAILED ${request.failure()?.errorText} ${request.url()}`);
        });
        page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) trace.push(`NAVIGATION COMMITTED ${frame.url()}`);
        });
        page.on('domcontentloaded', () => trace.push('DOM CONTENT LOADED'));
        let phase = 'chooser';
        try {
            const pdf = await PDFDocument.create();
            pdf.addPage([
                612,
                792,
            ]).drawText('A large document opens in the browser', {
                x: 40,
                y: 740,
            });
            // A real, uncompressed PDF stream exceeds the former 16 MiB open ceiling.
            pdf.catalog.set(pdf.context.obj('LargeFixture'), pdf.context.register(pdf.context.stream(new Uint8Array(18 * 1024 * 1024))));
            const buffer = Buffer.from(await pdf.save({useObjectStreams: false}));
            expect(buffer.byteLength).toBeGreaterThan(16 * 1024 * 1024);
            await openPdfFromChooser(page, {
                name: 'large-open.pdf',
                mimeType: 'application/pdf',
                buffer,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            await expect.poll(async () => (await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').allTextContents()).join(' ')).toContain('A large document opens in the browser');
            expect(problems).toEqual([]);
            phase = 'password prompt';
            const protectedChooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await (await protectedChooser).setFiles({
                name: 'protected-open.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(readFileSync(resolve('tests/fixtures/electron/password-protected.pdf.b64'), 'utf8').trim(), 'base64'),
            });
            await page.getByRole('textbox', {
                name: 'Password',
                exact: true,
            }).fill('frame-secret');
            await page.getByRole('button', {
                name: 'Open',
                exact: true,
            }).click();
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered canvas').first().waitFor({timeout: 30000});
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent()).toContain('protected-open.pdf');
            expect(problems).toEqual([]);
            phase = 'recent';
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            const recent = page.getByRole('button', {name: /large-open\.pdf/u}).first();
            await recent.click();
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            await expect.poll(async () => (await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').allTextContents()).join(' ')).toContain('A large document opens in the browser');
            expect(problems).toEqual([]);
            phase = 'drop';
            writeFileSync(dropPath, buffer);
            const drag = await context.newCDPSession(page);
            const dropTarget = await page.locator('.workspace-host').first().boundingBox();
            if (!dropTarget) throw new Error('The workspace has no drop target');
            for (const type of [
                'dragEnter',
                'dragOver',
                'drop',
            ] as const) {
                await drag.send('Input.dispatchDragEvent', {
                    type,
                    x: dropTarget.x + dropTarget.width / 2,
                    y: dropTarget.y + dropTarget.height / 2,
                    data: {
                        items: [],
                        files: [dropPath],
                        dragOperationsMask: 1,
                    },
                });
            }
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent()).toContain(`large-drop-${process.pid}.pdf`);
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered canvas').first().waitFor({timeout: 30000});
            await drag.detach();
            expect(problems).toEqual([]);

            // A sparse local file crosses the real chooser without allocating
            // its unused 1 GiB stream in the test process.
            phase = 'large local file';
            const length = 1024 * 1024 * 1024;
            const prefix = `%PDF-1.7\n1 0 obj\n<< /Length ${length} >>\nstream\n`;
            const offsets = [
                0,
                9,
            ];
            let tail = '\nendstream\nendobj\n';
            const add = (id: number, body: string) => {
                offsets[id] = prefix.length + length + tail.length;
                tail += `${id} 0 obj\n${body}\nendobj\n`;
            };
            add(2, '<< /Type /Catalog /Pages 3 0 R >>');
            add(3, '<< /Type /Pages /Count 1 /Kids [4 0 R] >>');
            add(4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>');
            const content = 'BT /F1 18 Tf 40 740 Td (A billion bytes can be viewed) Tj ET';
            add(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
            add(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
            const xref = prefix.length + length + tail.length;
            tail += 'xref\n0 7\n0000000000 65535 f \n';
            tail += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
            tail += `trailer\n<< /Size 7 /Root 2 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
            const descriptor = openSync(largePath, 'w');
            try {
                writeSync(descriptor, prefix);
                writeSync(descriptor, tail, prefix.length + length, 'utf8');
            } finally {
                closeSync(descriptor);
            }
            const largeChooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await (await largeChooser).setFiles(largePath);
            await expect.poll(async () => (await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').allTextContents()).join(' '), {timeout: 30000}).toContain('A billion bytes can be viewed');
            await settleActiveOpen(page);
            expect(await page.getByText('Existing annotation editing is unavailable', {exact: true}).count()).toBe(0);
            expect(await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).isEnabled()).toBe(true);
            expect(problems).toEqual([]);

            phase = 'invalid PDF';
            await page.evaluate(() => sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input'));
            const invalid = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await (await invalid).setFiles({
                name: 'invalid.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\nbroken'),
            });
            await page.locator('.app-toast-failure-reason').filter({hasText: 'The file is damaged or is not a supported document.'}).waitFor();
            expect(await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').first().textContent()).toContain('A billion bytes can be viewed');
        } catch (error) {
            console.info('LARGE_OPEN_FAILURE', JSON.stringify({
                phase,
                trace: trace.slice(-35),
                error: String(error),
                problems,
                url: page.url(),
                closed: page.isClosed(),
                serverOutput: lifecycle.serverOutput,
            }));
            throw error;
        } finally {
            await context.close();
            rmSync(dropPath, {force: true});
            rmSync(largePath, {force: true});
        }
    }, 120000);

    // T4: every accepted note belongs to the document's Save As frontier.
    it.each([
        'single',
        'split',
    ])('writes the accepted note through browser Save As from %s view', async (view) => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1600,
                height: 900,
            }});
            const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
            await openPdfFromChooser(page, fixture);
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const text = 'Accepted note survives information routes';
            await addNote(page, text, {
                x: 200,
                y: 200,
            });
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
            if (view === 'split') {
                await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
                await page.getByRole('menuitem', {
                    name: 'Split Right',
                    exact: true,
                }).click();
                await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
                const panes = await page.locator('.editor-pane').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorPaneId!));
                const right = panes[1]!;
                await page.locator(`${paneSelector(right)} .page_container--rendered canvas`).first().waitFor({timeout: 30000});
                await zoomActivePane(page, right, 'Zoom Out', 1);
            }
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            const savedContents: string[] = [];
            const downloads: Array<Promise<void>> = [];
            page.on('download', download => {
                const index = downloads.length;
                downloads.push((async () => {
                    const path = resolve(process.cwd(), `.devkit/browser-save-as-${process.pid}-${view}-${index}.pdf`);
                    await download.saveAs(path);
                    const bytes = readFileSync(path);
                    const pdf = await PDFDocument.load(bytes);
                    savedContents.push(...noteTexts(pdf));
                    console.info('SAVE_AS_BYTES', JSON.stringify({
                        view,
                        path,
                        byteLength: bytes.length,
                        originalChecksum: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
                        savedChecksum: createHash('sha256').update(bytes).digest('hex'),
                        savedContents,
                    }));
                })());
            });
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            try {
                await expect.poll(() => savedContents, {timeout: 30000}).toContain(text);
            } finally {
                await Promise.all(downloads);
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120000);

    it.each([
        'save',
        'save-as',
    ] as const)('retains a note accepted after the %s frontier for the next save', async mode => {
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1280,
                height: 900,
            },
            acceptDownloads: true,
        });
        let page: Awaited<ReturnType<typeof context.newPage>> | undefined;
        try {
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.create();
            pdf.addPage([
                612,
                792,
            ]).drawText('Accepted edits stay in their document', {
                x: 40,
                y: 740,
            });
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'save-frontier.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const save = async (as: boolean) => {
                const download = page!.waitForEvent('download');
                if (as) {
                    await page!.getByRole('button', {
                        name: 'Save options',
                        exact: true,
                    }).click();
                    await page!.getByRole('menuitem', {name: /^Save As/u}).click();
                } else await page!.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).click();
                const path = await (await download).path();
                if (!path) throw new Error('Save did not provide its downloaded bytes');
                return PDFDocument.load(readFileSync(path));
            };
            if (mode === 'save') {
                await save(true);
                await expect.poll(() => page!.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).isEnabled()).toBe(true);
                await page.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    await api.waitForActiveDocumentOpenSettled?.();
                });
                await page.locator('.editor-pane.is-active .page_container--rendered [data-pdf-annotation-editor-ready="true"]').first().waitFor();
            }
            await addNote(page, 'Before the save frontier', {
                x: 160,
                y: 180,
            });
            await expect.poll(() => page!.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues!<{annotationComments: Array<{text: string}>}>(['annotationComments']).annotationComments.map(note => note.text);
            })).toContain('Before the save frontier');
            await page.evaluate(`(async () => {
                const {getDocumentWorkingCopyCapability} = await import('/_nuxt/utils/platformDocuments.ts');
                const capability = getDocumentWorkingCopyCapability();
                const method = ${JSON.stringify(mode)} === 'save-as' ? 'createWorkingCopyFromPath' : 'parsePdfAnnotations';
                const original = capability[method].bind(capability);
                const held = new Promise(resolve => Reflect.set(window, '__releaseSaveFrontier', resolve));
                capability[method] = async (...args) => {
                    capability[method] = original;
                    const result = ${JSON.stringify(mode)} === 'save' ? await original(...args) : undefined;
                    Reflect.set(window, '__saveFrontierHeld', true);
                    await held;
                    return ${JSON.stringify(mode)} === 'save' ? result : original(...args);
                };
            })()`);
            const first = save(mode === 'save-as');
            await page.waitForFunction(() => Reflect.get(window, '__saveFrontierHeld') === true);
            await addNote(page, 'Accepted after the save frontier', {
                x: 260,
                y: 280,
            });
            expect(await page.locator('.pdf-annotation-editor-note').count()).toBe(2);
            await expect.poll(() => page!.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues!<{annotationComments: Array<{text: string}>}>(['annotationComments']).annotationComments.map(note => note.text);
            })).toContain('Accepted after the save frontier');
            await page.evaluate(() => Reflect.get(window, '__releaseSaveFrontier')());
            const published = noteTexts(await first);
            await expect.poll(() => page!.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).isEnabled()).toBe(true);
            expect(published).toContain('Before the save frontier');
            await expect.poll(() => page!.locator('.pdf-annotation-editor-note').count()).toBe(2);
            if (!published.has('Accepted after the save frontier')) {
                await expect.poll(() => page!.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).isEnabled()).toBe(true);
            }
            await page.locator('.pdf-annotation-editor-note').last().click();
            await expect.poll(() => page!.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe('Accepted after the save frontier');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(noteTexts(await save(published.has('Accepted after the save frontier')))).toEqual(new Set([
                'Before the save frontier',
                'Accepted after the save frontier',
            ]));
            await page.locator('.pdf-annotation-editor-note').last().click();
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Edited after Save As');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(noteTexts(await save(false))).toContain('Edited after Save As');
            expect(problems).toEqual([]);
        } finally {
            if (page && !page.isClosed()) await page.evaluate(() => Reflect.get(window, '__releaseSaveFrontier')?.()).catch(() => undefined);
            await context.close();
        }
    }, 120000);
});
