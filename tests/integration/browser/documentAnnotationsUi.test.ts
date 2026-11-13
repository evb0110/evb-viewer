import {createHash} from 'node:crypto';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString, StandardFonts,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import {resolveAnnotationCommentRowMetrics} from '@app/utils/pdfAnnotationCommentRowMetrics';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, readRecoveries, openPdfFromChooser,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {

    it('retains an editable text draft when native appearance fails after a pointer move', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-refused-text-pointer-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const fixture = resolve(process.cwd(), 'tests/fixtures/electron/semtext/unfilled-black-c.pdf');
        const originalText = 'Foreign bordered label';
        const draft = 'Recoverable refused move café';
        const refusal = 'Controlled text appearance refusal';
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_200,
            height: 900,
        }});
        const problems = collectConsoleProblems(page);
        try {
            // Hold one real appearance request, then deliver the worker's normal
            // failure envelope after trusted pointerup has joined its completion.
            await page.addInitScript((message: string) => {
                const held: Array<() => void> = [];
                const responses: Array<{
                    id: unknown;
                    type: unknown;
                    ok: unknown
                }> = [];
                const state = {
                    armed: false,
                    appearances: 0,
                    failures: 0,
                    held,
                    responses,
                };
                Reflect.set(window, '__refusedTextPointerAppearance', state);
                const NativeWorker = window.Worker;
                window.Worker = new Proxy(NativeWorker, {construct(Target, args) {
                    const worker: Worker = Reflect.construct(Target, args);
                    if (!String(args[0]).includes('browserPageOps')) return worker;
                    worker.addEventListener('message', (event) => {
                        const response: unknown = event.data;
                        if (typeof response !== 'object' || response === null) return;
                        responses.push({
                            id: Reflect.get(response, 'id'),
                            type: Reflect.get(response, 'type'),
                            ok: Reflect.get(response, 'ok'),
                        });
                    });
                    const post = worker.postMessage.bind(worker);
                    worker.postMessage = (request: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
                        if (typeof request === 'object' && request !== null
                            && Reflect.get(request, 'type') === 'textBoxAppearance') {
                            state.appearances += 1;
                            if (state.armed) {
                                state.armed = false;
                                held.push(() => {
                                    state.failures += 1;
                                    worker.dispatchEvent(new MessageEvent('message', {data: {
                                        id: Reflect.get(request, 'id'),
                                        ok: false,
                                        error: message,
                                    }}));
                                });
                                return;
                            }
                        }
                        if (Array.isArray(transfer)) post(request, transfer);
                        else post(request, transfer);
                    };
                    return worker;
                }});
            }, refusal);
            await openPdfFromChooser(page, fixture);
            const box = page.locator('.editor-pane.is-active .pdf-annotation-editor-text-box');
            await box.waitFor({state: 'visible'});
            expect(await box.getAttribute('aria-label')).toBe(originalText);
            await box.dblclick();
            const editor = box.locator('[contenteditable="true"]');
            await editor.waitFor({state: 'visible'});
            // Control+A selects all only off macOS; on a Mac it moves to the line start.
            await editor.press('ControlOrMeta+A');
            await page.keyboard.type(draft);
            expect(await editor.textContent()).toBe(draft);
            await page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
            });
            await page.waitForFunction(() => {
                const state = Reflect.get(window, '__refusedTextPointerAppearance');
                return state.appearances === state.responses.filter((response: {type: unknown}) => response.type === 'textBoxAppearance').length;
            });
            await page.evaluate(() => { Reflect.get(window, '__refusedTextPointerAppearance').armed = true; });
            await page.keyboard.press('Control+Enter');
            await page.waitForFunction(() => Reflect.get(window, '__refusedTextPointerAppearance').held.length === 1);
            const before = await box.boundingBox();
            if (!before) throw new Error('The pending text frame is not visible');
            const grip = page.locator('.editor-pane.is-active [data-pdf-annotation-move-handle]');
            const start = await grip.evaluate(element => {
                const rect = element.getBoundingClientRect();
                const x = rect.x + rect.width / 2;
                const y = rect.y + rect.height / 2;
                if (!element.contains(document.elementFromPoint(x, y))) throw new Error('The move grip is obstructed');
                return {
                    x,
                    y,
                };
            });
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(start.x + 34, start.y + 22, {steps: 6});
            const preview = await box.boundingBox();
            expect(preview!.x - before.x).toBeCloseTo(34, 1);
            expect(preview!.y - before.y).toBeCloseTo(22, 1);
            await page.mouse.up();
            expect(await box.getAttribute('aria-label')).toBe(originalText);
            await page.screenshot({path: resolve(evidenceDir, 'pointerup-held.png')});
            await page.evaluate(() => {
                Reflect.get(window, '__refusedTextPointerAppearance').held.splice(0).forEach((fail: () => void) => fail());
            });
            await page.waitForFunction(() => Reflect.get(window, '__refusedTextPointerAppearance').responses.some(
                (response: {ok: unknown}) => response.ok === false,
            ));
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            await page.screenshot({path: resolve(evidenceDir, 'appearance-refused.png')});
            expect(await page.getByRole('alert').filter({hasText: 'Unable to load the document workspace'}).count(),
                'Native appearance refusal must not escape into the workspace crash boundary').toBe(0);
            expect(await editor.textContent()).toBe(draft);
            expect(await box.getAttribute('class')).toContain('is-editing');
            expect(await box.getAttribute('aria-label')).toBe(originalText);
            const refused = await box.boundingBox();
            expect(refused!.x).toBeCloseTo(before.x, 1);
            expect(refused!.y).toBeCloseTo(before.y, 1);
            expect(problems.filter(problem => !problem.includes('[pdf-renderer] Failed to render canvas for page 1'))).toEqual([]);
            expect(problems.filter(problem => problem.includes('[pdf-renderer] Failed to render canvas for page 1'))).toHaveLength(1);

            await editor.click();
            await editor.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
            await page.keyboard.type('!');
            expect(await editor.textContent()).toBe(`${draft}!`);
            const download = page.waitForEvent('download');
            await page.locator('.save-split-primary:visible').first().click();
            const savedPath = resolve(evidenceDir, 'recovered.pdf');
            await (await download).saveAs(savedPath);
            const readTextBox = async (path: string) => {
                const pdf = await PDFDocument.load(readFileSync(path));
                const annotation = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).asArray()
                    .map(ref => pdf.context.lookup(ref, PDFDict))
                    .find(value => value.get(PDFName.of('Subtype'))?.toString() === '/FreeText')!;
                return {
                    text: annotation.lookup(PDFName.of('Contents'), PDFString, PDFHexString).decodeText(),
                    rect: annotation.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString())),
                };
            };
            const source = await readTextBox(fixture);
            const saved = await readTextBox(savedPath);
            expect(saved.text).toBe(`${draft}!`);
            expect(saved.rect[0]).toBe(source.rect[0]);
            expect(saved.rect[3]).toBe(source.rect[3]);
            const reopened = await lifecycle.browser.newPage({viewport: {
                width: 1_200,
                height: 900,
            }});
            const reopenedProblems = collectConsoleProblems(reopened);
            await openPdfFromChooser(reopened, savedPath);
            const reopenedBox = reopened.locator('.pdf-annotation-editor-text-box');
            await reopenedBox.waitFor({state: 'visible'});
            expect(await reopenedBox.getAttribute('aria-label')).toBe(`${draft}!`);
            await reopened.screenshot({path: resolve(evidenceDir, 'reopened.png')});
            expect(reopenedProblems).toEqual([]);
            expect(problems.filter(problem => !problem.includes('[pdf-renderer] Failed to render canvas for page 1'))).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('retains the readable page and retries failed annotation interaction', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const firstPage = pdf.addPage([
            612,
            792,
        ]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        firstPage.drawText('First page for annotation recovery proof', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        pdfPage.drawText('Readable page with an interactive link', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [
                72,
                690,
                390,
                720,
            ],
            Dest: [
                firstPage.ref,
                PDFName.of('XYZ'),
                null,
                null,
                null,
            ],
        }))]));
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-rux3/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        try {
            // Setup injects a persistent PDF.js render rejection. The document and
            // all Open/Retry/link interactions still use the normal user path.
            await page.route('**/services/pdfjs/pdfViewerFacade.ts*', async route => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'return layer.render({';
                if (!body.includes(marker)) throw new Error('PDF.js annotation render fault seam was not found');
                await route.fulfill({
                    response,
                    body: body.replace(marker,
                        'if (Reflect.get(window, "__annotationLayerFailure") && options.page.pageNumber === 2) throw new Error("RUX03 injected annotation stage failure"); ' + marker),
                });
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, '__annotationLayerFailure', false);
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
                name: 'annotation-interaction.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state: 'visible'});
            // Slow only the interactions under test: a throttled dev-server
            // startup alone can outlast the open-ready wait on CI runners.
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
            await page.evaluate(() => Reflect.set(window, '__annotationLayerFailure', true));
            await page.getByRole('button', {
                name: 'Next Page',
                exact: true,
            }).first().click();
            const container = page.locator('.page_container[data-page="2"]').first();
            const canvas = container.locator('.page_canvas canvas').first();
            await canvas.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => problems.some(problem => problem.includes('Failed to render annotation layer for page 2'))).toBe(true);
            await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
            await page.screenshot({path: resolve(evidenceDir, 'failed.png')});
            const failed = await container.evaluate(element => ({
                readiness: (element as HTMLElement).dataset.pageLayerReadiness,
                canvases: Array.from(element.querySelectorAll('canvas')).map(item => ({
                    width: item.width,
                    height: item.height,
                })),
                links: element.querySelectorAll('.annotation-layer a').length,
            }));
            writeFileSync(resolve(evidenceDir, 'failed.json'), JSON.stringify({
                failed,
                problems,
            }, null, 2));
            expect(failed.canvases.some(item => item.width > 0 && item.height > 0)).toBe(true);
            expect(failed.links).toBe(0);
            expect(failed.readiness).not.toBe('ready');
            const toast = page.locator('.app-toast-failure:not([data-state="closed"])').first();
            await expect.poll(() => toast.textContent()).toContain('Page 2 links and annotation interactions could not be loaded.');
            const oldWidth = await canvas.evaluate(element => (element as HTMLCanvasElement).width);
            await page.getByRole('button', {
                name: 'Zoom Out',
                exact: true,
            }).first().click();
            await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width)).not.toBe(oldWidth);
            await expect.poll(() => problems.filter(problem => problem.includes('Failed to render annotation layer for page 2')).length).toBe(2);
            await expect.poll(() => container.getAttribute('data-page-layer-readiness')).toBe('failed');
            await page.evaluate(() => Reflect.set(window, '__annotationLayerFailure', false));
            await toast.getByRole('button', {
                name: 'Retry',
                exact: true,
            }).click();
            const link = container.locator('.pdf-link-overlay[role="link"]').first();
            await link.waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            await expect.poll(() => container.getAttribute('data-page-layer-readiness')).toBe('ready');
            writeFileSync(resolve(evidenceDir, 'recovered-dom.json'), JSON.stringify(await container.evaluate(element => ({
                readiness: (element as HTMLElement).dataset.pageLayerReadiness,
                links: Array.from(element.querySelectorAll('a')).map(item => item.outerHTML),
            })), null, 2));
            await page.screenshot({path: resolve(evidenceDir, 'layer-recovered.png')});
            await link.click();
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.getByRole('button', {
                name: 'Next Page',
                exact: true,
            }).first().click();
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('2');
            await link.waitFor({state: 'visible'});
            await link.focus();
            await page.keyboard.press('Enter');
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.screenshot({path: resolve(evidenceDir, 'recovered.png')});
            expect(problems.filter(problem => !problem.includes('Failed to render annotation layer for page 2'))).toEqual([]);
            expect(problems.filter(problem => problem.includes('Failed to render annotation layer for page 2'))).toHaveLength(2);
        } finally {
            try {
                writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
                await page.context().close();
            } finally {
                await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
            }
        }
    }, 90_000);

    // C2/L2/A1: foreign icons paint beside the app's single canonical note marker.
    it('loads a foreign attachment icon from the packaged PDF.js image directory', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        const file = pdf.context.register(pdf.context.flateStream('Foreign attachment', {Type: 'EmbeddedFile'}));
        const fileSpec = pdf.context.register(pdf.context.obj({
            Type: 'Filespec',
            F: PDFString.of('foreign.txt'),
            EF: {F: file},
        }));
        const attachment = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'FileAttachment',
            Rect: [
                100,
                600,
                124,
                624,
            ],
            Name: 'Paperclip',
            FS: fileSpec,
            Contents: PDFString.of('Foreign attachment icon'),
        }));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const foreignText = 'Foreign commented highlight text';
        const ownText = 'Own saved highlight text';
        pdfPage.drawText(foreignText, {
            x: 100,
            y: 700,
            size: 14,
            font,
        });
        pdfPage.drawText(ownText, {
            x: 100,
            y: 550,
            size: 14,
            font,
        });
        const highlightWidth = font.widthOfTextAtSize(foreignText, 14);
        const highlight = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: [
                100,
                697,
                100 + highlightWidth,
                714,
            ],
            QuadPoints: [
                100,
                714,
                100 + highlightWidth,
                714,
                100,
                697,
                100 + highlightWidth,
                697,
            ],
            C: [
                1,
                1,
                0,
            ],
            CA: 0.3,
            T: PDFString.of('evb'),
            Contents: PDFString.of('Genealogical Classification of Semitic'),
        }));
        const ink = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Ink',
            Rect: [
                100,
                640,
                180,
                670,
            ],
            InkList: [[
                100,
                650,
                140,
                660,
                180,
                650,
            ]],
            C: [
                0,
                0,
                1,
            ],
            BS: {W: 3},
            Contents: PDFString.of('Foreign ink popup'),
        }));
        pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([
            attachment,
            highlight,
            ink,
        ]));
        const fixtureBytes = Buffer.from(await pdf.save());
        writeFileSync(resolve(process.cwd(), `.devkit/browser-foreign-attachment-${process.pid}.pdf`), fixtureBytes);
        let releaseCapture: (() => Promise<void>) | undefined;
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 800,
            }});
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const responsePromise = page.waitForResponse(response => response.url().endsWith('/annotation-paperclip.svg'));
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'foreign-attachment.pdf',
                mimeType: 'application/pdf',
                buffer: fixtureBytes,
            });
            const response = await responsePromise;
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const icon = page.locator('.page_container--rendered .fileAttachmentAnnotation img').first();
            await icon.waitFor({state: 'attached'});
            await expect.poll(() => icon.evaluate(image => (image as HTMLImageElement).complete)).toBe(true);
            const nativePopups = page.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible');
            const popupObservations: Array<{
                label: string;
                hover: number;
                click: number
            }> = [];
            const hoverAndClick = async (x: number, y: number, label: string) => {
                const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
                if (!bounds) throw new Error(`${label} page is not visible`);
                const px = bounds.x + x * bounds.width / 612;
                const py = bounds.y + (792 - y) * bounds.height / 792;
                await page.mouse.move(px, py);
                await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
                const hover = await nativePopups.count();
                await page.mouse.click(px, py);
                await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
                const click = await nativePopups.count();
                popupObservations.push({
                    label,
                    hover,
                    click,
                });
                await page.mouse.click(px, py);
                await page.mouse.move(0, 0);
            };
            await hoverAndClick(140, 705, 'foreign Highlight');
            await hoverAndClick(140, 660, 'foreign Ink');
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await page.locator('.tool-button[data-tool="select"]').click();
            await hoverAndClick(140, 705, 'foreign Highlight in edit mode');
            await hoverAndClick(140, 660, 'foreign Ink in edit mode');
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.sidebar-wrapper').evaluate(
                element => element.getBoundingClientRect().width,
            )).toBe(0);
            const foreignMarkerCount = await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).count();
            // Hold the window's first dirty recovery record, so ordinary Save
            // As supersedes it at normal CPU speed.
            await page.evaluate(`(async () => {
                const {getWindowTabsCapability} = await import('/_nuxt/utils/platformWindowTabs.ts');
                const recovery = getWindowTabsCapability().browserRecovery;
                if (!recovery) throw new Error('Browser recovery is unavailable');
                const save = recovery.save.bind(recovery);
                let release;
                let released = false;
                let holding = false;
                const held = new Promise(resolve => { release = resolve; });
                Reflect.set(window, '__releaseForeignCapture', () => {
                    released = true;
                    release();
                });
                Reflect.set(window, '__restoreForeignCapture', () => {
                    recovery.save = save;
                    release();
                });
                recovery.save = async (checkpoint) => {
                    const api = Reflect.get(window, '__evbTestApi');
                    if (!holding && api.getActiveToolbarSnapshot()?.canSave) {
                        holding = true;
                        Reflect.set(window, '__foreignCaptureHeld', {dirtyTabs: checkpoint.tabs.filter(tab => tab.isDirty).length});
                        await held;
                    }
                    const result = await save(checkpoint);
                    if (released && !checkpoint.tabs.some(tab => tab.isDirty)) {
                        recovery.save = save;
                        Reflect.set(window, '__foreignCaptureRetired', true);
                    }
                    return result;
                };
            })()`);
            releaseCapture = async () => {
                if (!page.isClosed()) await page.evaluate(() => Reflect.get(window, '__restoreForeignCapture')?.());
            };
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.toolbar-group-item--quick-note button')
                .getAttribute('aria-pressed')).toBe('true');
            // Resolve the click from the settled page, rather than a copied bounding box.
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 300,
                y: 300,
            }});
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Canonical note beside a foreign attachment');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await expect.poll(() => page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).count()).toBe(foreignMarkerCount + 1);
            expect(await page.locator('.textAnnotation img:visible').count()).toBe(0);
            // Set up an EVB-authored highlight, then exercise its persisted
            // surface through real clicks and text dragging after Save As.
            const createdHighlight = await page.evaluate(async (text) => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                await api.callActiveWorkspaceCommand?.('handleDisableDragMode');
                const span = Array.from(document.querySelectorAll('.text-layer span'))
                    .find(element => element.textContent === text);
                if (!span?.firstChild) throw new Error('Own highlight text is missing');
                const range = document.createRange();
                range.selectNodeContents(span);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return api.callActiveWorkspaceCommand?.('highlightSelection');
            }, ownText);
            expect(createdHighlight?.value).toBe(true);
            await page.locator('[data-markup-subtype="Highlight"]').last()
                .locator('[data-annotation-hit-target]').first().click({button: 'right'});
            await page.getByRole('menuitem', {
                name: 'Open Pop-up Note',
                exact: true,
            }).click();
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            })
                .fill('Own saved highlight comment');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.waitForFunction(() => Boolean(Reflect.get(window, '__foreignCaptureHeld')));
            expect(await page.evaluate(() => Reflect.get(window, '__foreignCaptureHeld').dirtyTabs)).toBe(1);
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            const downloadPromise = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const savedPath = resolve(process.cwd(), `.devkit/browser-foreign-attachment-saved-${process.pid}.pdf`);
            await (await downloadPromise).saveAs(savedPath);
            const savedPdf = await PDFDocument.load(readFileSync(savedPath));
            const savedAnnots = savedPdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            expect(Array.from({length: savedAnnots.size()}, (_, index) =>
                savedAnnots.lookup(index, PDFDict).lookup(PDFName.of('Subtype'), PDFName).toString(),
            ).filter(subtype => subtype === '/Highlight')).toHaveLength(2);
            expect(Array.from({length: savedAnnots.size()}, (_, index) => {
                const annotation = savedAnnots.lookup(index, PDFDict);
                const contents = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
                return contents?.decodeText();
            })).toContain('Own saved highlight comment');
            await expect.poll(() => page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).isEnabled()).toBe(true);
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(false);
            await page.evaluate(() => Reflect.get(window, '__releaseForeignCapture')());
            await page.waitForFunction(() => Reflect.get(window, '__foreignCaptureRetired') === true);
            expect(await readRecoveries(page)).toEqual([]);
            writeFileSync(resolve(process.cwd(), `.devkit/browser-foreign-capture-${process.pid}.json`), JSON.stringify({
                held: await page.evaluate(() => Reflect.get(window, '__foreignCaptureHeld')),
                retired: await page.evaluate(() => Reflect.get(window, '__foreignCaptureRetired')),
                recoveryRecords: await readRecoveries(page),
            }, null, 2));
            // Opening the actual downloaded bytes in a fresh browser page
            // proves this is the saved surface, not the unsaved overlay.
            const reopened = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 800,
            }});
            try {
                const reopenedProblems = collectConsoleProblems(reopened);
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                keepFileChooserInterceptionEnabled(reopened);
                const reopenChooser = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenChooser).setFiles(savedPath);
                await reopened.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
                await expect.poll(() => reopened.locator('[data-markup-subtype="Highlight"]').count()).toBe(2);
                const savedHighlight = reopened.locator('[data-markup-subtype="Highlight"]').last();
                const hit = savedHighlight.locator('[data-annotation-hit-target]').first();
                const ownLineBounds = await reopened.locator('.text-layer span').filter({hasText: ownText}).first().boundingBox();
                const savedHitBounds = await hit.boundingBox();
                if (!ownLineBounds || !savedHitBounds) throw new Error('Saved highlight is not visible over its text');
                expect(savedHitBounds.x).toBeLessThan(ownLineBounds.x + ownLineBounds.width / 2);
                expect(savedHitBounds.x + savedHitBounds.width).toBeGreaterThan(ownLineBounds.x + ownLineBounds.width / 2);
                expect(savedHitBounds.y).toBeLessThan(ownLineBounds.y + ownLineBounds.height / 2);
                expect(savedHitBounds.y + savedHitBounds.height).toBeGreaterThan(ownLineBounds.y + ownLineBounds.height / 2);
                await hit.click();
                await expect.poll(() => savedHighlight.getAttribute('class')).toContain('is-selected');
                expect(await reopened.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible').count()).toBe(0);
                await reopened.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await reopened.getByRole('tab', {
                    name: 'Annotations',
                    exact: true,
                }).click();
                await reopened.locator('.tool-button[data-tool="select"]').click();
                const selectTool = reopened.locator('.tool-button[data-tool="select"]');
                await expect.poll(() => selectTool.getAttribute('aria-pressed')).toBe('true');
                // The sidebar toolbar occupies (100, 200); deselect on blank PDF space.
                await reopened.locator('.page_container[data-page="1"]').first().click({position: {
                    x: 12,
                    y: 12,
                }});
                await expect.poll(() => selectTool.getAttribute('aria-pressed')).toBe('true');
                await expect.poll(() => savedHighlight.getAttribute('class')).not.toContain('is-selected');
                await hit.click();
                await expect.poll(() => savedHighlight.getAttribute('class')).toContain('is-selected');
                // The live sidebar must paint the same stride it virtualizes,
                // and its delete targets must follow UI scale and real resizing.
                for (const scale of [0.85, 0.9, 1, 1.1, 1.25]) {
                    await reopened.evaluate(value => document.documentElement.style.setProperty('--app-ui-scale', String(value)), scale);
                    const metrics = resolveAnnotationCommentRowMetrics(16 * scale);
                    const rows = reopened.locator('.note-item');
                    await expect.poll(() => rows.first().evaluate(element => element.getBoundingClientRect().height)).toBe(metrics.rowHeightPx);
                    for (const width of [200, 240, 320, 480]) {
                        const resizer = reopened.locator('.sidebar-resizer');
                        const handle = await resizer.boundingBox();
                        const currentWidth = await reopened.locator('.sidebar-wrapper__content').evaluate(element => element.getBoundingClientRect().width);
                        if (!handle) throw new Error('Sidebar resize handle is missing');
                        await reopened.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
                        await reopened.mouse.down();
                        await reopened.mouse.move(handle.x + handle.width / 2 + width - currentWidth, handle.y + handle.height / 2);
                        await reopened.mouse.up();
                        const geometry = await rows.evaluateAll(elements => {
                            const rects = elements.map(element => element.getBoundingClientRect());
                            const list = elements[0]!.closest('.notes-list')!;
                            const wrapper = list.firstElementChild as HTMLElement;
                            return {
                                heights: rects.map(rect => rect.height),
                                strides: rects.slice(1).map((rect, index) => rect.top - rects[index]!.top),
                                firstTop: rects[0]!.top,
                                wrapperTop: wrapper.getBoundingClientRect().top,
                                extent: wrapper.getBoundingClientRect().height + Number.parseFloat(wrapper.style.marginTop),
                                count: Number(list.closest('.notes-list-section')!.querySelector('.notes-count')!.textContent!.replace(/\D/gu, '')),
                                active: list.querySelectorAll('.note-item.is-active').length,
                                cards: elements.map(element => {
                                    const header = element.querySelector('.note-item-top')!;
                                    const chip = element.querySelector('.note-item-color-chip');
                                    const preview = element.querySelector('.note-item-text');
                                    const meta = element.querySelector('.note-item-meta')!;
                                    const style = preview ? getComputedStyle(preview) : null;
                                    return {
                                        headerHeight: header.getBoundingClientRect().height,
                                        headerLine: Number.parseFloat(getComputedStyle(header).lineHeight),
                                        chipInside: !chip || chip.getBoundingClientRect().top < header.getBoundingClientRect().bottom,
                                        lines: preview && style ? (preview.getBoundingClientRect().height - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)) / Number.parseFloat(style.lineHeight) : null,
                                        previewInside: !preview || preview.getBoundingClientRect().bottom <= meta.getBoundingClientRect().top,
                                        metaHeight: meta.getBoundingClientRect().height,
                                        metaLine: Number.parseFloat(getComputedStyle(meta).lineHeight),
                                        author: meta.firstElementChild!.textContent?.trim(),
                                        authorClipped: meta.firstElementChild!.scrollWidth > meta.firstElementChild!.clientWidth,
                                    };
                                }),
                            };
                        });
                        expect(geometry.heights.length).toBeGreaterThan(1);
                        expect(new Set(geometry.heights)).toEqual(new Set([metrics.rowHeightPx]));
                        expect(new Set(geometry.strides)).toEqual(new Set([metrics.rowStridePx]));
                        expect(geometry.firstTop).toBeCloseTo(geometry.wrapperTop, 5);
                        expect(geometry.extent).toBe(geometry.count * metrics.rowStridePx);
                        expect(geometry.active).toBe(1);
                        expect(geometry.cards.some(card => card.author === 'evb')).toBe(true);
                        for (const card of geometry.cards) {
                            expect(card.headerHeight).toBeCloseTo(card.headerLine, 1);
                            expect(card.chipInside).toBe(true);
                            if (card.lines !== null) {
                                expect(card.lines).toBeGreaterThanOrEqual(1);
                                expect(card.lines).toBeCloseTo(Math.round(card.lines), 2);
                            }
                            expect(card.previewInside).toBe(true);
                            expect(card.metaHeight).toBeCloseTo(card.metaLine, 1);
                            if (card.author === 'evb') expect(card.authorClipped).toBe(false);
                        }
                        const button = reopened.locator('.note-item-delete').first();
                        await button.scrollIntoViewIfNeeded();
                        const box = await button.boundingBox();
                        if (!box) throw new Error('Sidebar delete target is missing');
                        expect(box.width).toBeCloseTo(box.height, 1);
                        for (const point of [
                            {x: box.x + 2, y: box.y + 2},
                            {x: box.x + box.width - 2, y: box.y + box.height - 2},
                            {x: box.x + box.width / 2, y: box.y + box.height / 2},
                        ]) {
                            await reopened.mouse.move(point.x, point.y);
                            expect(await button.evaluate((element, point) => ({
                                hit: element.contains(document.elementFromPoint(point.x, point.y)),
                                hovered: element.matches(':hover'),
                            }), point)).toEqual({hit: true, hovered: true});
                        }
                    }
                }
                await reopened.evaluate(() => document.documentElement.style.removeProperty('--app-ui-scale'));
                await reopened.getByRole('button', {
                    name: 'Text Select',
                    exact: true,
                }).click();
                const line = reopened.locator('.text-layer span').filter({hasText: foreignText}).first();
                const lineBounds = await line.boundingBox();
                if (!lineBounds) throw new Error('Commented highlight text is not visible');
                await reopened.mouse.move(lineBounds.x + 1, lineBounds.y + lineBounds.height / 2);
                await reopened.mouse.down();
                await reopened.mouse.move(lineBounds.x + lineBounds.width - 1, lineBounds.y + lineBounds.height / 2, {steps: 12});
                await reopened.mouse.up();
                await expect.poll(() => reopened.evaluate(() => document.getSelection()?.toString())).toBe(foreignText);
                expect(await reopened.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible').count()).toBe(0);
                // A markup tool selects through the existing highlight to create
                // a stacked markup, while ordinary selection still hits markup.
                await reopened.locator('.tool-button[data-tool="highlight"]').click();
                const stackedLine = reopened.locator('.text-layer span').filter({hasText: ownText}).first();
                const stackedBounds = await stackedLine.boundingBox();
                if (!stackedBounds) throw new Error('Existing markup text is not visible');
                expect(await stackedLine.evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    return document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2) === element;
                })).toBe(true);
                await reopened.mouse.move(stackedBounds.x + 1, stackedBounds.y + stackedBounds.height / 2);
                await reopened.mouse.down();
                await reopened.mouse.move(stackedBounds.x + stackedBounds.width - 1, stackedBounds.y + stackedBounds.height / 2, {steps: 20});
                await reopened.mouse.up();
                await expect.poll(() => reopened.locator('[data-markup-subtype="Highlight"]').count()).toBe(3);
                await reopened.screenshot({path: resolve(process.cwd(), `.devkit/browser-annotation-saved-selection-${process.pid}.png`)});
                expect(reopenedProblems).toEqual([]);
            } finally {
                await reopened.close();
            }
            console.info('Popup observations', JSON.stringify(popupObservations));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-popups-${process.pid}.json`), JSON.stringify(popupObservations, null, 2));
            for (const observation of popupObservations) {
                expect(observation.hover, `${observation.label} hover`).toBe(0);
                expect(observation.click, `${observation.label} click`).toBe(0);
            }
            // Resolve and measure in one browser task: a locator's element
            // handle can be retired by annotation-layer replacement before
            // its later evaluate call runs.
            const readDimensions = () => page.evaluate(() => {
                const image = Array.from(document.querySelectorAll<HTMLImageElement>(
                    '.page_container--rendered .annotation-layer .fileAttachmentAnnotation img',
                )).find(candidate => {
                    const layer = candidate.closest<HTMLElement>('.annotation-layer');
                    const bounds = layer?.getBoundingClientRect();
                    return candidate.isConnected && layer?.isConnected
                        && bounds && bounds.width > 0 && bounds.height > 0
                        && getComputedStyle(layer).visibility !== 'hidden';
                });
                if (!image) return null;
                const rect = image.getBoundingClientRect();
                return {
                    naturalWidth: image.naturalWidth,
                    width: rect.width,
                    height: rect.height,
                    imageStyle: image.getAttribute('style'),
                    containerStyle: image.parentElement?.getAttribute('style'),
                    containerDisplay: image.parentElement && getComputedStyle(image.parentElement).display,
                    scaleFactor: getComputedStyle(image).getPropertyValue('--total-scale-factor'),
                };
            });
            let dimensions!: NonNullable<Awaited<ReturnType<typeof readDimensions>>>;
            await expect.poll(async () => {
                const current = await readDimensions();
                if (!current) return false;
                dimensions = current;
                return true;
            }).toBe(true);
            const bytes = await response.body();
            const observation = {
                url: new URL(response.url()).pathname,
                status: response.status(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
                ...dimensions,
            };
            console.info('Foreign annotation image', JSON.stringify(observation));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-icon-${process.pid}.json`), JSON.stringify(observation, null, 2));
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-annotation-icon-${process.pid}.png`)});
            const [pdfjsAssetIdentity] = JSON.parse(readFileSync(resolve('public/pdf/assets.json'), 'utf8')) as string[];
            expect(new URL(response.url()).pathname).toBe(`/pdf/${pdfjsAssetIdentity}/images/annotation-paperclip.svg`);
            expect(response.status()).toBe(200);
            expect(bytes).toEqual(readFileSync(resolve(process.cwd(), 'node_modules/pdfjs-dist/web/images/annotation-paperclip.svg')));
            expect(dimensions.naturalWidth).toBeGreaterThan(0);
            expect(dimensions.width).toBeGreaterThan(0);
            expect(dimensions.height).toBeGreaterThan(0);
            expect(await icon.isVisible()).toBe(true);
            const paintedIcon = await loadImage(Buffer.from(await icon.screenshot()));
            const iconContext = createCanvas(paintedIcon.width, paintedIcon.height).getContext('2d');
            iconContext.drawImage(paintedIcon, 0, 0);
            const pixels = iconContext.getImageData(0, 0, paintedIcon.width, paintedIcon.height).data;
            let inkPixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index]! < 128 && pixels[index + 1]! < 128 && pixels[index + 2]! < 128) {
                    inkPixels += 1;
                }
            }
            expect(inkPixels).toBeGreaterThan(0);
            expect(consoleProblems).toEqual([]);
        } finally {
            try {
                await releaseCapture?.();
            } finally {
                await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
            }
        }
    }, 90_000);

    it('imports every note when the annotation parse output exceeds 16 MiB', async () => {
        // Desktop reads its parse output without a total byte limit, so the
        // browser lists all 2,500 notes whose parse output is about 21 MB.
        const noteCount = 2_500;
        const pdf = await PDFDocument.create();
        const text = 'Long imported note text. '.repeat(320);
        for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
            const pdfPage = pdf.addPage([
                612,
                792,
            ]);
            pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj(Array.from({length: noteCount / 10}, (_, index) => {
                const x = 20 + (index % 25) * 22;
                const y = 20 + Math.floor(index / 25) * 70;
                return pdf.context.register(pdf.context.obj({
                    Type: 'Annot',
                    Subtype: 'Text',
                    Rect: [
                        x,
                        y,
                        x + 18,
                        y + 18,
                    ],
                    Contents: PDFHexString.fromText(`Note ${pageIndex * (noteCount / 10) + index + 1}. ${text}`),
                    T: PDFString.of('Importer'),
                    NM: PDFString.of(`imported-note-${pageIndex}-${index}`),
                    M: PDFString.of('D:20260101000000Z'),
                    Open: false,
                }));
            })));
        }
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

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles({
                name: 'many-long-notes.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save({useObjectStreams: true})),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.notes-list-header .notes-count:visible').first().textContent(), {timeout: 120_000})
                .toBe(`(${noteCount})`);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);
});
