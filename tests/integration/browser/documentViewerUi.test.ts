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
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
    it('retains a fully visible short indicator page while the center enters a tall page', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        for (const [
            index,
            height,
        ] of [
                120,
                1_000,
                600,
            ].entries()) {
            pdf.addPage([
                400,
                height,
            ]).drawText(`Mixed-size reading page ${String(index + 1)}`, {
                x: 24,
                y: height - 40,
                size: 16,
                font,
            });
        }
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), '.devkit/lane-a-rux2', `app-${String(process.pid)}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const page = await lifecycle.browser.newPage({viewport: {
            width: 900,
            height: 700,
        }});
        const problems = collectConsoleProblems(page);
        const observations: unknown[] = [];
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
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
                name: 'mixed-size-reading.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state: 'visible'});
            const readPosition = () => page.evaluate(() => {
                const first = document.querySelector<HTMLElement>('.page_container[data-page="1"]')!;
                const second = document.querySelector<HTMLElement>('.page_container[data-page="2"]')!;
                const viewport = first.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                const view = viewport.getBoundingClientRect();
                const rects = [
                    first,
                    second,
                ].map(element => {
                    const rect = element.getBoundingClientRect();
                    const width = Math.max(0, Math.min(rect.right, view.left + viewport.clientWidth) - Math.max(rect.left, view.left));
                    const height = Math.max(0, Math.min(rect.bottom, view.top + viewport.clientHeight) - Math.max(rect.top, view.top));
                    return {
                        top: rect.top,
                        bottom: rect.bottom,
                        height: rect.height,
                        fraction: width * height / (rect.width * rect.height),
                        fullyVisible: width >= rect.width && height >= rect.height,
                    };
                });
                return {
                    indicator: document.querySelector('.page-controls-current-primary')!.textContent!.trim(),
                    top: viewport.scrollTop,
                    centerY: view.top + viewport.clientHeight / 2,
                    rects,
                };
            });
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            const before = await readPosition();
            observations.push({
                step: 'open',
                ...before,
            });
            const viewer = page.locator('[data-document-viewer-chassis-viewport]').first();
            await viewer.hover();
            await page.mouse.wheel(0, 10);
            await expect.poll(async () => (await readPosition()).top).toBeGreaterThan(before.top);
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            const after = await readPosition();
            observations.push({
                step: 'trusted-wheel',
                ...after,
            });
            await page.screenshot({path: resolve(evidenceDir, 'retained.png')});
            expect(after.rects[0]!.fullyVisible).toBe(true);
            expect(after.centerY).toBeGreaterThan(after.rects[1]!.top);
            expect(after.rects[0]!.fraction).toBeGreaterThan(after.rects[1]!.fraction);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.mouse.wheel(0, 80);
            await expect.poll(async () => (await readPosition()).top).toBeGreaterThan(after.top);
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            const partial = await readPosition();
            observations.push({
                step: 'greatest-fraction',
                ...partial,
            });
            expect(partial.rects[0]!.fullyVisible).toBe(false);
            expect(partial.rects[0]!.fraction).toBeGreaterThan(partial.rects[1]!.fraction);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.mouse.wheel(0, 300);
            await expect.poll(async () => (await readPosition()).rects[0]!.fraction).toBe(0);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('2');
            observations.push({
                step: 'short-page-left-viewport',
                ...await readPosition(),
            });
            await page.screenshot({path: resolve(evidenceDir, 'advanced.png')});
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify(observations, null, 2));
            writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
            try {await page.context().close();} finally {await Promise.all(lifecycle.browser.contexts().map(context => context.close()));}
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
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
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
            Contents: PDFString.of('Foreign highlight popup'),
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
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 800,
            }});
            const cpu = await page.context().newCDPSession(page);
            await cpu.send('Emulation.setCPUThrottlingRate', {rate: 6});
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
            // Opening the actual downloaded bytes in a fresh browser page
            // proves this is the saved surface, not the unsaved overlay.
            const reopened = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 800,
            }});
            try {
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
                await reopened.mouse.click(100, 200);
                await expect.poll(() => savedHighlight.getAttribute('class')).not.toContain('is-selected');
                await hit.click();
                await expect.poll(() => savedHighlight.getAttribute('class')).toContain('is-selected');
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
                await reopened.screenshot({path: resolve(process.cwd(), `.devkit/browser-annotation-saved-selection-${process.pid}.png`)});
            } finally {
                await reopened.close();
            }
            console.info('Popup observations', JSON.stringify(popupObservations));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-popups-${process.pid}.json`), JSON.stringify(popupObservations, null, 2));
            for (const observation of popupObservations) {
                expect(observation.hover, `${observation.label} hover`).toBe(0);
                expect(observation.click, `${observation.label} click`).toBe(0);
            }
            const dimensions = await icon.evaluate((image) => {
                const rect = image.getBoundingClientRect();
                return {
                    naturalWidth: (image as HTMLImageElement).naturalWidth,
                    width: rect.width,
                    height: rect.height,
                    imageStyle: image.getAttribute('style'),
                    containerStyle: image.parentElement?.getAttribute('style'),
                    containerDisplay: image.parentElement && getComputedStyle(image.parentElement).display,
                    scaleFactor: getComputedStyle(image).getPropertyValue('--total-scale-factor'),
                };
            });
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
            expect(new URL(response.url()).pathname).toBe('/pdfjs/images/annotation-paperclip.svg');
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
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('keeps the performance restart notice through Settings remount until reload', async () => {
        try {
            const page = await lifecycle.browser.newPage();
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            const settings = page.locator('nav[aria-label="Workspace"]').getByRole('button', {
                name: 'Settings',
                exact: true,
            });
            const notice = page.locator('.settings-performance-restart-notice');
            const chooseMode = async (label: string, mode: string) => {
                await page.getByRole('button', {
                    name: 'Performance mode',
                    exact: true,
                }).click();
                await page.getByRole('option', {
                    name: label,
                    exact: true,
                }).click();
                await page.waitForFunction(value => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').performanceMode === value, mode);
            };
            await settings.click();
            expect(await notice.count()).toBe(0);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.textContent()).toBe('Restart to apply this change.');
            await page.getByRole('button', {
                name: 'Recent Files',
                exact: true,
            }).click();
            await settings.click();
            await page.getByRole('button', {
                name: 'Performance mode',
                exact: true,
            }).click();
            await page.keyboard.press('Escape');
            await page.getByRole('listbox').waitFor({state: 'hidden'});
            await page.screenshot({path: resolve(process.cwd(), '.devkit/lane-b/evidence/op-03-remount.png')});
            expect(await notice.count()).toBe(1);
            expect(await notice.textContent()).toBe('Restart to apply this change.');
            expect(await notice.isVisible()).toBe(true);
            await chooseMode('Auto (recommended)', 'auto');
            await expect.poll(() => notice.count()).toBe(0);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.count()).toBe(1);
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await settings.click();
            expect(await notice.count()).toBe(0);
            await chooseMode('Auto (recommended)', 'auto');
            await expect.poll(() => notice.count()).toBe(1);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.count()).toBe(0);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    // T3/C2, issue #1037: foreign FreeText is printable when its viewer supplies
    // the appearance. Explicit /AP remains authoritative (ADR 0003).
    it('prints existing FreeText without AP and preserves explicit appearances', async () => {
        const evidence = resolve(process.cwd(), `.devkit/1037/browser-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        let printStartedAt: number | undefined;
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                window.print = () => {
                    const canvas = document.querySelector<HTMLCanvasElement>('.browser-print-page canvas');
                    if (!canvas) throw new Error('No printed page');
                    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
                    const red: number[][] = [];
                    const cyan: number[][] = [];
                    for (let index = 0; index < pixels.length; index += 4) {
                        const point = [
                            (index / 4) % canvas.width / canvas.width,
                            Math.floor(index / 4 / canvas.width) / canvas.height,
                        ];
                        if (pixels[index]! > 150 && pixels[index + 1]! < 100 && pixels[index + 2]! < 100) red.push(point);
                        if (pixels[index]! < 100 && pixels[index + 1]! > 150 && pixels[index + 2]! > 150) cyan.push(point);
                    }
                    Reflect.set(window.top!, '__freeTextPrint', {
                        red,
                        cyan,
                        image: canvas.toDataURL(),
                    });
                };
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.load(readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')));
            const first = pdf.getPage(0);
            const annotations = first.node.lookup(PDFName.of('Annots'), PDFArray);
            annotations.push(pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'FreeText',
                F: 4,
                Rect: [
                    72,
                    550,
                    350,
                    630,
                ],
                Contents: PDFHexString.fromText('Foreign FreeText\nПривет мир'),
                DA: PDFString.of('/Helvetica 18 Tf 1 0 0 rg'),
            })));
            const appearance = pdf.context.register(pdf.context.flateStream('0 1 1 rg 0 0 80 80 re f', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    80,
                    80,
                ],
                Resources: {},
            }));
            annotations.push(pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'FreeText',
                F: 4,
                Rect: [
                    400,
                    550,
                    480,
                    630,
                ],
                Contents: PDFString.of('Explicit AP overrides this red text'),
                DA: PDFString.of('/Helvetica 18 Tf 1 0 0 rg'),
                AP: {N: appearance},
            })));
            const input = Buffer.from(await pdf.save());
            writeFileSync(resolve(evidence, 'input.pdf'), input);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'foreign-freetext-print.pdf',
                mimeType: 'application/pdf',
                buffer: input,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.screenshot({path: resolve(evidence, 'opened.png')});
            printStartedAt = Date.now();
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__freeTextPrint'))), {timeout: 15_000}).toBe(true);
            const output = await page.evaluate(() => Reflect.get(window, '__freeTextPrint') as {
                red: number[][];
                cyan: number[][];
                image: string;
            });
            writeFileSync(resolve(evidence, 'printed.png'), Buffer.from(output.image.split(',')[1]!, 'base64'));
            writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
                elapsedMs: Date.now() - printStartedAt,
                red: output.red.length,
                cyan: output.cyan.length,
                problems,
            }));
            expect(output.red.length).toBeGreaterThan(200);
            expect(output.cyan.length).toBeGreaterThan(1_000);
            // A4 fit centers the letter page vertically. Both appearances keep
            // their source rectangles, and the explicit AP never becomes text.
            expect(output.red.every(([
                x,
                y,
            ]) => x! >= 72 / 612 && x! < 350 / 612 && y! > 0.2 && y! < 0.34)).toBe(true);
            expect(output.cyan.every(([
                x,
                y,
            ]) => x! > 0.65 && x! < 0.79 && y! > 0.2 && y! < 0.34)).toBe(true);
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidence, 'console.json'), JSON.stringify(problems));
            await page.screenshot({path: resolve(evidence, 'final.png')});
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('opens URI destinations by pointer and Enter with no opener or console failure', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-external-url-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const destination = `${lifecycle.origin}/privacy-policy`;
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const sourcePage = pdf.addPage([
            612,
            792,
        ]);
        sourcePage.drawText('Open privacy policy', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        sourcePage.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [
                72,
                694,
                260,
                722,
            ],
            Border: [
                0,
                0,
                0,
            ],
            A: {
                S: 'URI',
                URI: PDFString.of(destination),
            },
        }))]));
        const bytes = Buffer.from(await pdf.save());
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const observations: Array<{
            input: string;
            url: string;
            opener: boolean
        }> = [];
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
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
                name: 'external-uri.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const link = page.locator('.pdf-link-overlay').first();
            await link.waitFor({state: 'visible'});
            for (const input of [
                'pointer',
                'Enter',
            ]) {
                const openedPage = context.waitForEvent('page');
                if (input === 'pointer') {
                    await link.click();
                } else {
                    await link.focus();
                    await link.press('Enter');
                }
                const destinationPage = await openedPage;
                await destinationPage.waitForURL(destination);
                await destinationPage.waitForLoadState('domcontentloaded');
                const opener = await destinationPage.evaluate(() => window.opener !== null);
                observations.push({
                    input,
                    url: destinationPage.url(),
                    opener,
                });
                expect(destinationPage.url()).toBe(destination);
                expect(opener).toBe(false);
                await destinationPage.close();
            }
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'result.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('starts and opens a PDF without desktop diagnostics or recovery warnings under an Electron-shaped user agent', async () => {
        try {
            // Embedded Electron-based browsers report this user agent without
            // installing the EVB preload bridge.
            const page = await lifecycle.browser.newPage({
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Nightly)/0.0.44 Chrome/146.0.0.0 Electron/44.4.2 Safari/537.36',
                viewport: {
                    width: 1_280,
                    height: 900,
                },
            });
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            expect(await page.evaluate(() => 'electronAPI' in window)).toBe(false);
            expect(await page.locator('.app-toast-failure').count()).toBe(0);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            // The reported tab opened in the background. Headless Chromium
            // keeps every page visible, so emulate the tab being hidden and
            // shown again; showing it heartbeats the recovery lease.
            for (const visibilityState of [
                'hidden',
                'visible',
            ]) {
                await page.evaluate(nextState => new Promise<void>((resolveVisibility) => {
                    Object.defineProperty(document, 'visibilityState', {
                        configurable: true,
                        get: () => nextState,
                    });
                    document.dispatchEvent(new Event('visibilitychange'));
                    setTimeout(resolveVisibility, 0);
                }), visibilityState);
            }

            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(consoleProblems).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('opens the Start file chooser in the click while the workspace chunk is still loading', async () => {
        const workspaceModuleRequested = Promise.withResolvers<undefined>();
        const releaseWorkspaceModule = Promise.withResolvers<undefined>();
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            // Start paints from the tab while the workspace chunk loads. Holding
            // the workspace module keeps that state for as long as the test needs.
            await page.route((url) => url.pathname.endsWith('/workspace-shell/components/DocumentWorkspace.vue')
                && !url.searchParams.has('vue'), async (route) => {
                workspaceModuleRequested.resolve(undefined);
                await releaseWorkspaceModule.promise;
                await route.continue();
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await workspaceModuleRequested.promise;
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            // A browser shows a file chooser only within the click's 5 s user
            // activation.
            const chooserPromise = page.waitForEvent('filechooser', {timeout: 5_000});
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            releaseWorkspaceModule.resolve(undefined);
            await chooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');
            expect(consoleProblems).toEqual([]);
        } finally {
            releaseWorkspaceModule.resolve(undefined);
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('shows a literal percent sequence in a browser file name exactly on its tab', async () => {
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
            const chooser = await chooserPromise;
            await chooser.setFiles({
                name: 'report%20final.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });

            await page.locator('.page_container--rendered canvas').first().waitFor({
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
            await expect.poll(() => activeTab.textContent()).toContain('report%20final.pdf');
            await expect.poll(() => activeTab.getAttribute('aria-label')).toBe('report%20final.pdf');
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('explains the missing components when an indirect DjVu index is picked alone', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-index-only-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.deleteProperty(window, 'showOpenFilePicker');
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.locator('.start-open-panel .open-panel-cta').click();
            await (await chooserPromise).setFiles({
                name: 'café-index.djvu',
                mimeType: 'image/vnd.djvu',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/djvu/sources/indirect/index.djvu')),
            });
            const toast = page.locator('.app-toast-failure');
            await toast.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const text = await toast.innerText();
            writeFileSync(resolve(evidenceDir, 'visible.json'), JSON.stringify({
                text,
                pageErrors,
            }, null, 2));
            await page.screenshot({path: resolve(evidenceDir, 'toast.png')});

            // C4: the failure itself explains why and gives the usable alternatives.
            expect(text).toContain('This DjVu index needs separate component files. Open a bundled DjVu file or use the desktop app.');
            expect(text).not.toContain('The file could not be opened.');
            expect(await toast.count()).toBe(1);
            expect(pageErrors).toEqual([]);
        } finally {
            await context.close();
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('renders a DjVu open, conversion, and generated PDF reopen in the viewer', async () => {
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
            const chooser = await chooserPromise;
            await chooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu',
            ));

            const sourceImage = page.locator('[data-testid="document-page-source-image"]').first();
            await sourceImage.waitFor({
                state: 'visible',
                timeout: 90_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('DjVu viewer open did not settle');
                }
            });
            const sourceEvidence = await page.evaluate(() => ({
                bodyText: document.body.innerText,
                sourceImages: document.querySelectorAll('[data-testid="document-page-source-image"]').length,
                sourcePages: document.querySelectorAll('[data-testid="document-page-source-page"]').length,
            }));
            expect(sourceEvidence.sourceImages).toBeGreaterThan(0);
            expect(sourceEvidence.sourcePages).toBeGreaterThan(0);
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-open.png'),
                fullPage: true,
            });

            await page.getByRole('button', {name: /Convert to PDF/}).filter({visible: true}).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const conversionButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await page.waitForFunction(() => {
                const button = Array.from(document.querySelectorAll('[role="dialog"] button'))
                    .find(candidate => candidate.textContent?.trim() === 'Convert');
                return button instanceof HTMLButtonElement && !button.disabled;
            }, null, {timeout: 90_000});
            await conversionButton.click();
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-after-convert.png'),
                fullPage: true,
            });

            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Generated PDF reopen did not settle');
                }
            });
            const renderedPdf = page.locator('.page_container--rendered .page_canvas canvas').first();
            await renderedPdf.waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            const pdfEvidence = await page.evaluate(() => ({
                bodyText: document.body.innerText,
                renderedCanvases: document.querySelectorAll('.page_container--rendered .page_canvas canvas').length,
            }));
            expect(pdfEvidence.renderedCanvases).toBeGreaterThan(0);
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-pdf-reopen.png'),
                fullPage: true,
            });
            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await page.reload({waitUntil: 'domcontentloaded'});
            const recentPdf = page.locator('[data-recent-open-actionable="true"] .recent-open')
                .filter({hasText: 'bitonal-faint-pencil.pdf'});
            await recentPdf.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await recentPdf.click();
            await renderedPdf.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent())
                .toContain('bitonal-faint-pencil.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-reloaded.png'),
                fullPage: true,
            });
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);
});
