import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFArray, PDFName, PDFString, PDFHexString, StandardFonts, rgb,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, openPdfFromChooser,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {

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
                    const image = document.querySelector<HTMLImageElement>('.browser-print-page img');
                    if (!image) throw new Error('No printed page');
                    const canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    canvas.getContext('2d')!.drawImage(image, 0, 0);
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

    // T3: printing hands the system dialog every page. The print document
    // once refused rasters above 256 MiB across pages and 64 Mi pixels on
    // one page. Here 41 sheets at 300 DPI need about 1.4 GB of RGBA, and the
    // 28-inch first page alone printed at its size needs 282 MB.
    it('prints every page of a document whose page rasters exceed the former print budgets', async () => {
        const evidence = resolve(process.cwd(), `.devkit/print-every-page/browser-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                window.print = () => {
                    // Each source page carries a black bar whose height on the page encodes its number.
                    const printed = Array.from(document.querySelectorAll<HTMLElement>('.browser-print-page'), (section) => {
                        const image = section.querySelector('img');
                        if (!image?.complete || image.naturalWidth === 0) return null;
                        const sample = document.createElement('canvas');
                        sample.width = 50;
                        sample.height = 400;
                        const context = sample.getContext('2d')!;
                        context.drawImage(image, 0, 0, sample.width, sample.height);
                        const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
                        const darkRows: number[] = [];
                        for (let row = 0; row < sample.height; row += 1) {
                            if (pixels[(row * sample.width + 25) * 4]! < 80) darkRows.push(row);
                        }
                        return {
                            width: image.naturalWidth,
                            height: image.naturalHeight,
                            barCenter: darkRows.length ? (darkRows[0]! + darkRows.at(-1)!) / 2 / sample.height : null,
                        };
                    });
                    Reflect.set(window.top!, '__printedPages', printed);
                };
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.create();
            const pageCount = 41;
            for (let index = 0; index < pageCount; index += 1) {
                const pdfPage = pdf.addPage(index === 0 ? [
                    28 * 72,
                    28 * 72,
                ] : [
                    612,
                    792,
                ]);
                const {
                    width, height,
                } = pdfPage.getSize();
                pdfPage.drawRectangle({
                    x: 0,
                    y: height * (1 - (index + 0.5) / pageCount) - height / 400,
                    width,
                    height: height / 200,
                    color: rgb(0, 0, 0),
                });
            }
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'print-every-page.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            const readPrinted = async () => {
                await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__printedPages'))), {timeout: 120_000}).toBe(true);
                return page.evaluate(() => {
                    const printed = Reflect.get(window, '__printedPages') as Array<{
                        width: number;
                        height: number;
                        barCenter: number | null;
                    } | null>;
                    Reflect.deleteProperty(window, '__printedPages');
                    return printed;
                });
            };

            const sheetsStartedAt = Date.now();
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            const sheets = await readPrinted();
            const sheetsElapsedMs = Date.now() - sheetsStartedAt;
            expect(sheets).toHaveLength(pageCount);
            const sheetBars = sheets.map(sheet => sheet?.barCenter ?? null);
            expect(sheetBars.every(bar => bar !== null)).toBe(true);
            // Every source page reached its own sheet, in order.
            expect(sheetBars.every((bar, index) => index < 2 || bar! > sheetBars[index - 1]!)).toBe(true);

            const currentPageStartedAt = Date.now();
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Print Current Page/u}).click();
            const currentPage = await readPrinted();
            const currentPageElapsedMs = Date.now() - currentPageStartedAt;
            expect(currentPage).toHaveLength(1);
            expect(currentPage[0]).toMatchObject({
                width: Math.ceil(28 * 72 * (300 / 72)),
                height: Math.ceil(28 * 72 * (300 / 72)),
            });
            expect(currentPage[0]!.barCenter).toBeCloseTo(0.5 / pageCount, 2);
            writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
                sheetsElapsedMs,
                currentPageElapsedMs,
                sheets,
                currentPage,
                problems,
            }, null, 2));
            expect(problems).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);

    // T6/T3: storage-backed browser PDFs print every sheet, including unsaved notes.
    it('prints a browser PDF above the in-memory limit, its current page and an unsaved note', async () => {
        const evidence = resolve(process.cwd(), `.devkit/browser-print-large-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        const observations: unknown[] = [];
        try {
            await page.addInitScript(() => {
                window.print = () => {
                    const sheets = Array.from(document.querySelectorAll<HTMLImageElement>('.browser-print-page img'), image => {
                        if (!image.complete || image.naturalWidth === 0) throw new Error('An unloaded sheet reached window.print');
                        const canvas = document.createElement('canvas');
                        canvas.width = image.naturalWidth;
                        canvas.height = image.naturalHeight;
                        const context = canvas.getContext('2d')!;
                        context.drawImage(image, 0, 0);
                        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                        let inkPixels = 0;
                        let yellowPixels = 0;
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index + 3]! > 8 && Math.min(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) < 245) inkPixels += 1;
                            if (pixels[index]! > 150 && pixels[index + 1]! > 100 && pixels[index + 2]! < 100) yellowPixels += 1;
                        }
                        return {
                            inkPixels,
                            yellowPixels,
                            image: canvas.toDataURL('image/png'),
                        };
                    });
                    Reflect.set(window.top!, '__largePdfPrintSheets', sheets);
                };
            });
            const pdf = await PDFDocument.create();
            const font = await pdf.embedFont(StandardFonts.Helvetica);
            for (let index = 0; index < 2; index += 1) {
                const sheet = pdf.addPage([
                    612,
                    792,
                ]);
                sheet.drawText(`Browser large PDF print page ${String(index + 1)}`, {
                    x: 48,
                    y: 710,
                    size: 24,
                    font,
                });
                sheet.drawRectangle({
                    x: 48,
                    y: 560,
                    width: 420,
                    height: 64,
                    color: rgb(0, 0, 0),
                });
            }
            // A referenced, uncompressed stream makes a valid 20 MB PDF rather
            // than trailing padding after EOF, above the 16 MiB in-memory limit.
            pdf.catalog.set(PDFName.of('PrintFixturePadding'), pdf.context.register(pdf.context.stream(Buffer.alloc(20_000_000, 0x20))));
            const bytes = Buffer.from(await pdf.save({useObjectStreams: false}));
            await openPdfFromChooser(page, {
                name: 'browser-print-20mb.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            const source = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.([
                    'pdfSourceState',
                    'totalPages',
                ]);
            });
            expect(source).toMatchObject({
                totalPages: 2,
                pdfSourceState: {
                    hasInMemoryData: false,
                    reloadKind: 'path',
                    reloadPath: expect.stringMatching(/^browser:\/\//u),
                },
            });
            observations.push({
                bytes: bytes.length,
                source,
            });
            const readSheets = async (action: string) => {
                await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__largePdfPrintSheets'))), {timeout: 15_000}).toBe(true);
                const sheets = await page.evaluate(() => {
                    const sheets = Reflect.get(window, '__largePdfPrintSheets') as Array<{
                        inkPixels: number;
                        yellowPixels: number;
                        image: string;
                    }>;
                    Reflect.deleteProperty(window, '__largePdfPrintSheets');
                    return sheets;
                });
                observations.push({
                    action,
                    sheets: sheets.map(({
                        inkPixels, yellowPixels,
                    }) => ({
                        inkPixels,
                        yellowPixels,
                    })),
                });
                for (const [
                    index,
                    sheet,
                ] of sheets.entries()) {
                    writeFileSync(resolve(evidence, `${action}-${String(index + 1)}.png`), Buffer.from(sheet.image.split(',')[1]!, 'base64'));
                    expect(sheet.inkPixels).toBeGreaterThan(1_000);
                }
                return sheets;
            };
            const printAll = async () => {
                await page.getByRole('button', {
                    name: 'Print',
                    exact: true,
                }).click();
                await page.getByRole('button', {
                    name: 'Print...',
                    exact: true,
                }).click();
            };
            await printAll();
            const clean = await readSheets('clean-all');
            expect(clean).toHaveLength(2);
            expect(clean[0]!.yellowPixels).toBe(0);
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Print Current Page/u}).click();
            expect(await readSheets('clean-current')).toHaveLength(1);

            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 200,
                y: 200,
            }});
            const note = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            await note.fill('Unsaved large PDF print note');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            await printAll();
            const dirty = await readSheets('dirty-all');
            expect(dirty).toHaveLength(2);
            expect(dirty[0]!.yellowPixels).toBeGreaterThan(50);
            expect(dirty[1]!.yellowPixels).toBe(0);
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
        } finally {
            await page.screenshot({path: resolve(evidence, 'workspace.png')});
            writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await page.context().close();
        }
    }, 90_000);
});
