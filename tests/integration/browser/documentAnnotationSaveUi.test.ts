import {createHash} from 'node:crypto';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString, StandardFonts,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import {
    openPdfFromChooser, readRecoveries, lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {

    it('places a new note over an imported highlight without moving the highlight', async () => {
        const pdf = await PDFDocument.create();
        const pagePdf = pdf.addPage([
            612,
            792,
        ]);
        const highlight = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: [
                40,
                736,
                300,
                758,
            ],
            QuadPoints: [
                40,
                758,
                300,
                758,
                40,
                736,
                300,
                736,
            ],
            C: [
                1,
                1,
                0,
            ],
            Contents: PDFString.of('Foreign highlight'),
            F: 4,
        }));
        pagePdf.node.set(PDFName.of('Annots'), pdf.context.obj([highlight]));
        const context = await lifecycle.browser.newContext();
        try {
            const page = await context.newPage();
            await openPdfFromChooser(page, {
                name: 'note-over-highlight.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            if (!await page.getByTestId('document-sidebar').isVisible()) {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
            }
            await page.getByRole('tab', {name: /Annotations/}).click();
            await page.locator('.notes-panel [data-tool="note"]').click();
            const markup = page.locator('.page_container [data-annotation-kind="text-markup"]').first();
            await markup.waitFor({state: 'visible'});
            // Page fitting may change screen bounds without moving an annotation.
            const readMarkupBounds = () => markup.evaluate(element => {
                if (!(element instanceof SVGGraphicsElement)) throw new Error('The Highlight is not SVG markup');
                const {
                    x, y, width, height,
                } = element.getBBox();
                return {
                    x,
                    y,
                    width,
                    height,
                };
            });
            const original = await readMarkupBounds();
            await markup.click();
            const input = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            await input.waitFor({
                state: 'visible',
                timeout: 2_000,
            });
            await input.pressSequentially('Note over foreign highlight');
            expect(await input.inputValue()).toBe('Note over foreign highlight');
            expect(await page.locator('.page_container [data-annotation-kind="note"]').count()).toBe(1);
            expect(await readMarkupBounds()).toEqual(original);
            const placementError = await markup.evaluate((element, bounds) => {
                if (!(element instanceof SVGGraphicsElement)) throw new Error('The Highlight is not SVG markup');
                const matrix = element.getScreenCTM();
                const marker = element.closest('.pdf-annotation-editor-layer')
                    ?.querySelector('[data-annotation-kind="note"]')?.getBoundingClientRect();
                if (!matrix || !marker) throw new Error('The note placement is not rendered');
                const center = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(matrix);
                return {
                    x: marker.x + marker.width / 2 - center.x,
                    y: marker.y + marker.height / 2 - center.y,
                };
            }, original);
            expect(Math.abs(placementError.x)).toBeLessThan(1);
            expect(Math.abs(placementError.y)).toBeLessThan(1);
        } finally {
            await context.close();
        }
    }, 60_000);

    it('opens and saves a PDF after one initial window lock refusal', async () => {
        const context = await lifecycle.browser.newContext();
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                const locks = navigator.locks;
                const request = locks.request;
                locks.request = function (...args: [string, LockOptions | LockGrantedCallback<unknown>, LockGrantedCallback<unknown>?]) {
                    if (args[0].startsWith('evb-window:')) {
                        locks.request = request;
                        Reflect.set(window, '__initialClaimRefused', true);
                        return Promise.reject(new Error('Injected initial window lock refusal'));
                    }
                    return Reflect.apply(request, locks, args);
                };
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            expect(await page.evaluate(() => Reflect.get(window, '__initialClaimRefused'))).toBe(true);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf'));
            const textBox = page.locator('.pdf-annotation-editor-text-box').filter({hasText: 'Editable interoperability text'}).first();
            await textBox.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await textBox.dblclick();
            const editor = page.locator('.pdf-annotation-editor-text-box__editor').last();
            await editor.fill('Edit after window lock refusal');
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const saved = await PDFDocument.load(readFileSync(await (await download).path()));
            const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            expect(Array.from({length: annots.size()}, (_, index) => annots.lookup(index, PDFDict)
                .lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText()))
                .toContain('Edit after window lock refusal');
            expect(problems.filter(problem => !problem.includes('Injected initial window lock refusal'))).toEqual([]);
        } finally {
            await context.close();
        }
    }, 90_000);

    it('preserves a text-box replacement while the initial PDF text layer finishes publishing', async () => {
        const context = await lifecycle.browser.newContext();
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__heldTextLayerPublication', new Promise<void>(resolvePublication => {
                    Reflect.set(window, '__releaseTextLayerPublication', resolvePublication);
                }));
            });
            await page.route('**/*usePdfRendererTextLayerController.ts*', async route => {
                const response = await route.fetch();
                const source = await response.text();
                const publication = 'if (!publish()) {';
                const completed = 'if (!isTextLayerRendered) return failure ?? false;';
                if (!source.includes(publication) || !source.includes(completed)) {
                    throw new Error('Initial text-layer publication seam was not found');
                }
                await route.fulfill({
                    response,
                    body: source.replace(publication,
                        `document.body.dataset.textLayerPublication = 'held';
                        await Reflect.get(window, '__heldTextLayerPublication'); ${publication}`)
                        .replace(completed, `${completed} document.body.dataset.textLayerPublication = 'published';`),
                });
            });
            await openPdfFromChooser(page, resolve(process.cwd(), 'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf'));
            const original = 'Editable interoperability text';
            const replacement = 'Replacement survives text-layer publication';
            const textBox = page.locator('.pdf-annotation-editor-text-box').filter({hasText: original}).first();
            await textBox.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await textBox.dblclick();
            const editor = page.locator('.pdf-annotation-editor-text-box__editor').last();
            await page.waitForFunction(() => document.body.dataset.textLayerPublication === 'held');
            await editor.press('ControlOrMeta+A');
            expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(original);
            await page.evaluate(() => Reflect.get(window, '__releaseTextLayerPublication')());
            await page.waitForFunction(() => document.body.dataset.textLayerPublication === 'published');
            const selectedAfterPublication = await page.evaluate(() => window.getSelection()?.toString());
            await page.keyboard.insertText(replacement);
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const saved = await PDFDocument.load(readFileSync(await (await download).path()));
            const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            const contents = Array.from({length: annots.size()}, (_, index) => annots.lookup(index, PDFDict)
                .lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText());
            expect.soft(selectedAfterPublication).toBe(original);
            expect(contents, `Saved /Contents: ${JSON.stringify(contents)}`).toContain(replacement);
            expect(problems).toEqual([]);
        } finally {
            await page.evaluate(() => Reflect.get(window, '__releaseTextLayerPublication')?.()).catch(() => undefined);
            await context.close();
        }
    }, 90_000);

    it.each([
        'canvas-only',
        'hydrating',
    ])('opens a note editor while PDF.js layers remain %s', async (readiness) => {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([
            612,
            792,
        ]).drawText('Note placement before PDF.js layer hydration', {
            x: 40,
            y: 740,
            font,
            size: 16,
        });
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 800,
        }});
        try {
            const page = await context.newPage();
            // Fault setup only: retain the committed canvas while PDF.js's
            // text/link layers stay pending or fall back to canvas-only.
            await page.route('**/*usePdfAnnotationLayerRenderer.ts*', async (route) => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'const renderToken = ++annotationLayerRenderToken;';
                if (!body.includes(marker)) throw new Error('PDF.js layer hydration fault seam was not found');
                const hold = readiness === 'hydrating'
                    ? 'document.body.dataset.optionalHydrationFault = "held"; annotationLayerDiv.dataset.hydrationFault = "held"; try { await raceWithAnnotationAbort(new Promise(() => {}), pageNumber, options); } finally { annotationLayerDiv.dataset.hydrationFault = "settled"; }'
                    : 'document.body.dataset.optionalHydrationFault = "refused"; const refusal = new Error("Injected optional annotation hydration refusal"); refusal.name = "AbortError"; throw refusal;';
                await route.fulfill({
                    response,
                    body: body.replace(marker, `${hold} ${marker}`),
                });
            });
            await page.addInitScript(() => {
                Reflect.set(window, 'showSaveFilePicker', undefined);
            });
            await openPdfFromChooser(page, {
                name: 'pending-layers-note.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            const pageContainer = page.locator('.page_container[data-page="1"]').first();
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await page.waitForFunction(value => document.body.dataset.optionalHydrationFault === value, readiness === 'hydrating' ? 'held' : 'refused');
            if (readiness === 'hydrating') {
                await expect.poll(() => pageContainer.locator('.annotation-layer').getAttribute('data-hydration-fault')).toBe('held');
            }
            const placeNote = page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            });
            expect(await placeNote.isEnabled()).toBe(true);
            await placeNote.click();
            await page.getByRole('button', {
                name: 'Click inside the document to place a sticky note.',
                exact: true,
            }).waitFor({state: 'visible'});
            const bounds = await pageContainer.boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const input = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            const text = `Note placed while PDF.js layers remain ${readiness}`;
            await input.fill(text);
            expect(await input.inputValue()).toBe(text);
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const saved = await PDFDocument.load(readFileSync(await (await download).path()));
            const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            expect(Array.from({length: annots.size()}, (_, index) => annots.lookup(index, PDFDict)
                .lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText())).toContain(text);
            const heldLayer = readiness === 'hydrating'
                ? await pageContainer.locator('.annotation-layer[data-hydration-fault="held"]').elementHandle()
                : null;
            if (readiness === 'hydrating') expect(heldLayer).not.toBeNull();
            const canvas = page.locator('.page_container--rendered canvas').first();
            const readCanvasWidth = () => canvas.evaluate(element => {
                if (!(element instanceof HTMLCanvasElement)) throw new Error('The painted page is not a canvas');
                return element.width;
            });
            const width = await readCanvasWidth();
            await page.getByRole('button', {name: /^Zoom In/u}).first().click();
            await expect.poll(readCanvasWidth, {timeout: 15_000}).not.toBe(width);
            if (heldLayer) {
                expect(await heldLayer.evaluate(element => element.getAttribute('data-hydration-fault'))).toBe('settled');
            }
            await placeNote.click();
            const replacementBounds = await pageContainer.boundingBox();
            if (!replacementBounds) throw new Error('The replacement PDF page is not visible');
            await page.mouse.click(replacementBounds.x + 300, replacementBounds.y + 260);
            await input.fill('Draft retained until closing the replaced page');
            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await page.getByRole('button', {
                name: 'Discard changes',
                exact: true,
            }).click();
            await waitForOpenFileReady(page);
        } finally {
            await context.close();
        }
    }, 90_000);

    it('keeps the selected own-canvas picture during Save and cancels held replacements without a stage timeout', async () => {
        const pdf = await PDFDocument.create();
        const sheet = pdf.addPage([
            612,
            792,
        ]);
        sheet.drawText('Committed page pixels remain beside the original appearance', {
            x: 40,
            y: 740,
            size: 16,
        });
        const field = pdf.getForm().createTextField('required-own-canvas');
        field.setText('Required original appearance');
        field.enableReadOnly();
        field.addToPage(sheet, {
            x: 40,
            y: 650,
            width: 280,
            height: 40,
        });
        const source = Buffer.from(await pdf.save());
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 800,
        }});
        try {
            const page = await context.newPage();
            // Hold the actual producer only after an original picture exists.
            await page.route('**/*usePdfAnnotationLayerRenderer.ts*', async (route) => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'const renderToken = ++annotationLayerRenderToken;';
                if (!body.includes(marker)) throw new Error('Required annotation producer seam was not found');
                const hold = `const faultRoot = document.querySelector('.page_container[data-page="' + pageNumber + '"]');
                    const target = JSON.stringify([options?.documentVersion, viewport.width, viewport.height]);
                    if (faultRoot?.getAttribute('data-required-hydration-fault') === 'armed'
                        && viewport.width > Number(faultRoot.getAttribute('data-required-hydration-baseline-width'))) {
                        faultRoot.setAttribute('data-required-hydration-target', target);
                    }
                    if (faultRoot?.getAttribute('data-required-hydration-target') === target) {
                        faultRoot.setAttribute('data-required-hydration-fault', 'held');
                        try { await raceWithAnnotationAbort(new Promise(() => {}), pageNumber, options); }
                        finally { faultRoot.setAttribute('data-required-hydration-fault', 'settled'); }
                    }`;
                await route.fulfill({
                    response,
                    body: body.replace(marker, `${hold} ${marker}`),
                });
            });
            await page.route('**/*withPageStageTimeout.ts*', async (route) => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'onFire: () => {';
                if (!body.includes(marker)) throw new Error('Existing stage-deadline observation seam was not found');
                await route.fulfill({
                    response,
                    body: body.replace(marker, `${marker}
                    if (options.payload.stage === 'annotation-layer') {
                        document.body.dataset.requiredHydrationDeadlineFired = 'true';
                    }`),
                });
            });
            await openPdfFromChooser(page, {
                name: 'required-annotation-picture.pdf',
                mimeType: 'application/pdf',
                buffer: source,
            });
            const container = page.locator('.page_container[data-page="1"]').first();
            const annotationCanvas = container.locator('.annotation-layer canvas').first();
            await annotationCanvas.waitFor({state: 'visible'});
            const readCanvas = async (element: Element, selector: string) => {
                const canvas = element.querySelector(selector);
                if (!(canvas instanceof HTMLCanvasElement)) throw new Error('The appearance is not a painted canvas');
                const context = canvas.getContext('2d');
                if (!context) throw new Error('The painted canvas has no pixel reader');
                const width = canvas.width;
                const height = canvas.height;
                const rgba = context.getImageData(0, 0, width, height).data;
                const pixels = canvas.toDataURL();
                const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rgba));
                return {
                    width,
                    height,
                    rgbaSHA256: Array.from(digest, value => value.toString(16).padStart(2, '0')).join(''),
                    pixels,
                };
            };
            const signature = (paint: Awaited<ReturnType<typeof readCanvas>>) => ({
                width: paint.width,
                height: paint.height,
                rgbaSHA256: paint.rgbaSHA256,
            });
            const originalAppearance = await container.evaluate(readCanvas, '.annotation-layer canvas');
            expect(originalAppearance.width).toBeGreaterThan(0);
            expect(originalAppearance.height).toBeGreaterThan(0);
            const placeNote = page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            });
            await placeNote.click();
            const bounds = await container.boundingBox();
            if (!bounds) throw new Error('The original painted page is not visible');
            await page.mouse.click(bounds.x + 220, bounds.y + 240);
            const input = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            await input.fill('Selected picture survives a held producer');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            const selectedNote = container.locator('.pdf-annotation-editor-note.is-selected');
            expect(await selectedNote.count()).toBe(1);
            const originalRaster = await container.evaluate(readCanvas, '.page_canvas__render-layer canvas');
            // Setup-only arming; the replacement itself uses trusted zoom input.
            await container.evaluate(element => {
                element.setAttribute('data-required-hydration-baseline-width', String(element.getBoundingClientRect().width));
                element.removeAttribute('data-required-hydration-target');
                element.setAttribute('data-required-hydration-fault', 'armed');
            });
            await page.getByRole('button', {name: /^Zoom In/u}).first().click();
            await expect.poll(() => container.getAttribute('data-required-hydration-fault')).toBe('held');
            expect(signature(await container.evaluate(readCanvas, '.page_canvas__render-layer canvas'))).toEqual(signature(originalRaster));
            expect(signature(await container.evaluate(readCanvas, '.annotation-layer canvas'))).toEqual(signature(originalAppearance));
            expect(await selectedNote.count()).toBe(1);
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const savedBytes = readFileSync(await (await download).path());
            const saved = await PDFDocument.load(savedBytes);
            const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            expect(Array.from({length: annots.size()}, (_, index) => annots.lookup(index, PDFDict)
                .lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText()))
                .toContain('Selected picture survives a held producer');
            // Save may retire this producer through an accepted successor.
            // It must not depend on the stage deadline or lose the selection.
            await expect.poll(() => container.getAttribute('data-required-hydration-fault'), {timeout: 15_000}).toBe('settled');
            expect(await page.locator('body').getAttribute('data-required-hydration-deadline-fired')).toBeNull();
            await expect.poll(() => container.getAttribute('data-page-layer-readiness'), {timeout: 15_000}).toBe('ready');
            await expect.poll(async () => Number(await container.locator('canvas').first().getAttribute('width')), {timeout: 15_000}).toBeGreaterThan(originalRaster.width);
            expect(await selectedNote.count()).toBe(1);
            const savedRaster = await container.evaluate(readCanvas, '.page_canvas__render-layer canvas');
            const savedAppearance = await container.evaluate(readCanvas, '.annotation-layer canvas');
            await container.evaluate(element => {
                element.setAttribute('data-required-hydration-baseline-width', String(element.getBoundingClientRect().width));
                element.removeAttribute('data-required-hydration-target');
                element.setAttribute('data-required-hydration-fault', 'armed');
            });
            await page.getByRole('button', {name: /^Zoom In/u}).first().click();
            await expect.poll(() => container.getAttribute('data-required-hydration-fault')).toBe('held');
            expect(signature(await container.evaluate(readCanvas, '.page_canvas__render-layer canvas'))).toEqual(signature(savedRaster));
            expect(signature(await container.evaluate(readCanvas, '.annotation-layer canvas'))).toEqual(signature(savedAppearance));
            expect(await selectedNote.count()).toBe(1);
            await page.getByRole('button', {name: /^Zoom In/u}).first().click();
            await expect.poll(() => container.getAttribute('data-required-hydration-fault'), {timeout: 15_000}).toBe('settled');
            await expect.poll(async () => signature(await container.evaluate(readCanvas, '.page_canvas__render-layer canvas')), {timeout: 15_000}).not.toEqual(signature(savedRaster));
            expect(await page.locator('body').getAttribute('data-required-hydration-deadline-fired')).toBeNull();
            expect(await selectedNote.count()).toBe(1);
            const retiredContainer = await container.elementHandle();
            if (!retiredContainer) throw new Error('The replacement page is not mounted');
            await container.evaluate(element => {
                element.setAttribute('data-required-hydration-baseline-width', String(element.getBoundingClientRect().width));
                element.removeAttribute('data-required-hydration-target');
                element.setAttribute('data-required-hydration-fault', 'armed');
            });
            await page.getByRole('button', {name: /^Zoom In/u}).first().click();
            await expect.poll(() => container.getAttribute('data-required-hydration-fault')).toBe('held');
            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await container.waitFor({state: 'detached'});
            expect(await retiredContainer.evaluate(element => element.getAttribute('data-required-hydration-fault'))).toBe('settled');
            expect(await page.locator('body').getAttribute('data-required-hydration-deadline-fired')).toBeNull();
        } finally {
            await context.close();
        }
    }, 90_000);

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
            await openPdfFromChooser(page, {
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

            const readRecovery = async () => (await readRecoveries(page)).find(record => record.tab)
                ?? {
                    tab: undefined,
                    bytes: [],
                    notes: new Set<string>(),
                };
            let initial: Awaited<ReturnType<typeof readRecovery>> | undefined;
            await expect.poll(async () => {
                const recovery = await readRecovery();
                const texts = Array.from(recovery.notes);
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
            await expect.poll(async () => Array.from((await readRecovery()).notes), {timeout: 15_000}).toContain(draft);
            // The draft joins the same document's recovery: no new copy of its bytes.
            const edited = await readRecovery();
            expect(edited.tab?.workingCopyRef).toBe(initial!.tab?.workingCopyRef);
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
});
