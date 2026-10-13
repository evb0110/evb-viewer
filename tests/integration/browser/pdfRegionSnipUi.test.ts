import {
    PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    addNote, keepFileChooserInterceptionEnabled, lifecycle, readPersistedDocumentBytes, waitForOpenFileReady,
} from './documentLifecycleTestHelpers';

describe('browser PDF region screenshot', () => {
    // I1 and A4: accepted overlapping markup must not block Screenshot or Save.
    it.each([
        'named',
        'unnamed',
    ])('saves edited %s foreign markup and opens region selection after an overlap', async (identity) => {
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1280,
            height: 800,
        }});
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            const fixture = await PDFDocument.create();
            const font = await fixture.embedFont(StandardFonts.Helvetica);
            const pdfPage = fixture.addPage([
                612,
                792,
            ]);
            pdfPage.drawText('Hydration review selectable highlighted text', {
                x: 40,
                y: 740,
                font,
                size: 16,
            });
            const foreign = fixture.context.register(fixture.context.obj({
                Type: 'Annot',
                Subtype: 'Highlight',
                Rect: [
                    40,
                    736,
                    354,
                    758,
                ],
                QuadPoints: [
                    40,
                    758,
                    354,
                    758,
                    40,
                    736,
                    354,
                    736,
                ],
                C: [
                    1,
                    1,
                    0,
                ],
                Contents: PDFString.of('Foreign highlight'),
                NM: PDFString.of('foreign-highlight'),
                F: 4,
            }));
            if (identity === 'unnamed') fixture.context.lookup(foreign, PDFDict).delete(PDFName.of('NM'));
            pdfPage.node.set(PDFName.of('Annots'), fixture.context.obj([foreign]));
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'overlapping-markup.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await fixture.save()),
            });
            const renderedPage = page.locator('.page_container[data-page="1"]');
            await renderedPage.locator('canvas').first().waitFor({
                state: 'visible',
                timeout: 30000,
            });
            await renderedPage.locator('.text-layer span').first().waitFor({state: 'visible'});
            if (identity === 'unnamed') {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await page.getByRole('tab', {name: /Annotations/u}).click();
                await page.locator('.notes-panel [data-tool="select"]').click();
                await renderedPage.locator('[data-annotation-kind="text-markup"] [data-annotation-hit-target]').click();
                await page.locator('[data-annotation-inspector][data-target="selection"] .swatch[aria-label="#ef4444"]').click();
                await page.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).click();
                const source = await page.evaluate(() => (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi).readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath);
                await expect.poll(async () => {
                    const saved = await PDFDocument.load(Uint8Array.from(await readPersistedDocumentBytes(page, source!)));
                    const annotations = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
                    const highlight = annotations.lookup(0, PDFDict);
                    return highlight.lookup(PDFName.of('C'), PDFArray).asArray().map(value => Math.round(Number(value.toString()) * 255));
                }, {timeout: 15000}).toEqual([
                    239,
                    68,
                    68,
                ]);
            } else {
                await addNote(page, 'Accepted note before Screenshot', {
                    x: 250,
                    y: 200,
                });
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
            }
            await page.getByRole('tab', {name: /Annotations/u}).click();
            await page.locator('.notes-panel [data-tool="highlight"]').click();
            await page.locator('.notes-panel [data-tool="highlight"][aria-pressed="true"]').waitFor();
            await page.locator('#pdf-viewer').hover();
            await page.mouse.wheel(0, -5000);
            await page.waitForFunction(() => document.querySelector('#pdf-viewer')!.scrollTop === 0);
            const bounds = await renderedPage.boundingBox();
            if (!bounds) throw new Error('The annotation page is not visible');
            const y = bounds.y + 46 * bounds.height / 792;
            await page.mouse.move(bounds.x + 42 * bounds.width / 612, y);
            await page.mouse.down();
            await page.mouse.move(bounds.x + 300 * bounds.width / 612, y, {steps: 15});
            await page.mouse.up();
            await expect.poll(() => renderedPage.locator('[data-annotation-kind="text-markup"]').count()).toBe(2);
            await page.getByRole('button', {
                name: 'Screenshot',
                exact: true,
            }).click();
            await page.locator('.snip-overlay.is-active').waitFor({
                state: 'visible',
                timeout: 15000,
            });
            await page.keyboard.press('Escape');
            const save = page.getByRole('button', {
                name: 'Save',
                exact: true,
            });
            if (await save.isEnabled()) await save.click();
            const sourceRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
            });
            await expect.poll(async () => {
                const saved = await PDFDocument.load(Uint8Array.from(await readPersistedDocumentBytes(page, sourceRef!)));
                const annotations = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
                const names = annotations.asArray().map(ref => saved.context.lookup(ref, PDFDict))
                    .filter(annotation => annotation.lookup(PDFName.of('Subtype'), PDFName).asString() === '/Highlight')
                    .map(annotation => annotation.lookupMaybe(PDFName.of('NM'), PDFString, PDFHexString)?.decodeText());
                return {
                    names,
                    count: names.length,
                    distinct: new Set(names).size,
                };
            }, {timeout: 15000}).toEqual({
                names: expect.arrayContaining(identity === 'named' ? [
                    'foreign-highlight',
                    expect.stringMatching(/^anno_/u),
                ] : [
                    expect.any(String),
                    expect.stringMatching(/^anno_/u),
                ]),
                count: 2,
                distinct: 2,
            });
        } finally {
            await page.close();
        }
    }, 120000);
});
