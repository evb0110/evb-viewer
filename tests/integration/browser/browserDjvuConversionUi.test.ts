import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFString, PDFHexString,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, readPersistedDocumentBytes,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {

    it('explains the missing components of an indirect DjVu index, then opens it with them', async () => {
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
            const indirectDir = resolve(process.cwd(), 'tests/fixtures/djvu/sources/indirect');
            const indexFile = {
                name: 'café-index.djvu',
                mimeType: 'image/vnd.djvu',
                buffer: readFileSync(resolve(indirectDir, 'index.djvu')),
            };

            const chooserPromise = page.waitForEvent('filechooser');
            await page.locator('.start-open-panel .open-panel-cta').click();
            await (await chooserPromise).setFiles(indexFile);
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

            // C4: the failure itself explains why and how to open the document.
            expect(text).toContain('This DjVu index keeps its pages in separate files. Open it again and select the index together with the files next to it.');
            expect(text).not.toContain('The file could not be opened.');
            expect(await toast.count()).toBe(1);

            // Selecting the index with the files beside it opens its pages from them.
            const componentChooser = page.waitForEvent('filechooser');
            await page.locator('.start-open-panel .open-panel-cta').click();
            await (await componentChooser).setFiles([
                indexFile,
                ...[
                    'low-dpi.djvu',
                    'high-dpi.djvu',
                ].map(name => ({
                    name,
                    mimeType: 'image/vnd.djvu',
                    buffer: readFileSync(resolve(indirectDir, name)),
                })),
            ]);
            const sourceImage = page.locator('[data-testid="document-page-source-image"]').first();
            await sourceImage.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await expect.poll(() => sourceImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
            await expect.poll(() => page.locator('.page-controls').first().innerText()).toMatch(/\b2\b/u);
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent())
                .toContain('café-index.djvu');
            await page.screenshot({path: resolve(evidenceDir, 'opened-with-components.png')});
            expect(pageErrors).toEqual([]);
        } finally {
            await context.close();
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('opens and converts DjVu documents above the former browser limits', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-former-limits-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const openFixture = async (name: string) => {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
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
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources', name));
            return {
                page,
                problems,
            };
        };
        try {
            // A 10000x8001 page: 80 million pixels, above the former 45-megapixel open limit.
            const huge = await openFixture('huge-page.djvu');
            const sourceImage = huge.page.locator('[data-testid="document-page-source-image"]').first();
            await sourceImage.waitFor({
                state: 'visible',
                timeout: 90_000,
            });
            await expect.poll(() => sourceImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
            await huge.page.screenshot({path: resolve(evidenceDir, 'huge-page.png')});
            expect(huge.problems).toEqual([]);

            // 501 pages, above the former 500-page conversion limit.
            const many = await openFixture('browser-boundary-501-pages.djvu');
            const pageControls = many.page.locator('.page-controls').first();
            await expect.poll(() => pageControls.innerText(), {timeout: 90_000}).toMatch(/\b501\b/u);
            await many.page.getByRole('button', {name: /Convert to PDF/u}).filter({visible: true}).first().click();
            const dialog = many.page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const convertButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await expect.poll(() => convertButton.isEnabled(), {timeout: 90_000}).toBe(true);
            await convertButton.click();
            await many.page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            await expect.poll(() => many.page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent())
                .toContain('browser-boundary-501-pages.pdf');
            await expect.poll(() => pageControls.innerText()).toMatch(/\b501\b/u);
            await many.page.screenshot({path: resolve(evidenceDir, 'converted-501.png')});
            expect(many.problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 300_000);

    it('keeps the DjVu outline in a compact PDF at source detail', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-compact-outline-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
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
            // Three 96x96 pages; the outline names pages by component id and by number.
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bookmark-component-ids.djvu'));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {name: /Convert to PDF/u}).filter({visible: true}).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const convertButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await expect.poll(() => convertButton.isEnabled(), {timeout: 60_000}).toBe(true);
            // The recommended method is the compact one; bookmarks are kept by default.
            expect(await dialog.getByRole('checkbox', {name: 'Preserve bookmarks'}).isChecked()).toBe(true);
            await convertButton.click();
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            const pdfRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                return api?.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath ?? null;
            });
            expect(pdfRef).toMatch(/\.pdf$/u);
            const bytes = Uint8Array.from(await readPersistedDocumentBytes(page, pdfRef!));
            writeFileSync(resolve(evidenceDir, 'compact.pdf'), bytes);
            const pdf = await PDFDocument.load(bytes, {updateMetadata: false});
            const pageRefs = pdf.getPages().map(pdfPage => pdfPage.ref.toString());
            const outline: string[] = [];
            let node = pdf.context.lookup(pdf.context.lookup(pdf.catalog.get(PDFName.of('Outlines')), PDFDict).get(PDFName.of('First')));
            while (node instanceof PDFDict) {
                const title = node.get(PDFName.of('Title'));
                const destination = node.get(PDFName.of('Dest'));
                const target = destination instanceof PDFArray ? destination.get(0) : null;
                outline.push(`${title instanceof PDFHexString || title instanceof PDFString ? title.decodeText() : ''} -> ${target instanceof PDFRef ? pageRefs.indexOf(target.toString()) + 1 : 0}`);
                node = pdf.context.lookup(node.get(PDFName.of('Next')));
            }
            expect(outline).toEqual([
                'Page one -> 1',
                'Page two component target -> 2',
                'Page three numeric control -> 3',
            ]);
            // Source detail: each page keeps its 96 pixels across.
            const imageWidths = [...pdf.context.enumerateIndirectObjects()]
                .map(([
                    , object,
                ]) => object)
                .filter((object): object is PDFRawStream => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image')
                .map(image => image.dict.get(PDFName.of('Width'))?.toString());
            expect(imageWidths).toEqual([
                '96',
                '96',
                '96',
            ]);
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 240_000);

    it('keeps a bitonal DjVu as bilevel masks in a compact PDF', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-compact-masks-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
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
            // Page 1 is a JB2 mask; page 2 is an IW44 background only.
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {name: /Convert to PDF/u}).filter({visible: true}).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const convertButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await expect.poll(() => convertButton.isEnabled(), {timeout: 60_000}).toBe(true);
            await convertButton.click();
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            const pdfRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                return api?.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath ?? null;
            });
            expect(pdfRef).toMatch(/\.pdf$/u);
            const bytes = Uint8Array.from(await readPersistedDocumentBytes(page, pdfRef!));
            writeFileSync(resolve(evidenceDir, 'compact.pdf'), bytes);
            const pdf = await PDFDocument.load(bytes, {updateMetadata: false});
            // As desktop writes it: page 1, a JB2 mask, stays a bilevel image
            // mask at the source resolution; page 2, background only, is a photo.
            const pageImages = pdf.getPages().map((pdfPage) => {
                const xObjects = pdfPage.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
                const image = xObjects?.values().map(value => pdf.context.lookup(value)).find(value => value instanceof PDFRawStream);
                return image instanceof PDFRawStream
                    ? {
                        width: image.dict.get(PDFName.of('Width'))?.toString(),
                        mask: image.dict.get(PDFName.of('ImageMask'))?.toString() ?? null,
                        filter: image.dict.get(PDFName.of('Filter'))?.toString() ?? null,
                    }
                    : null;
            });
            expect(pageImages).toEqual([
                expect.objectContaining({
                    width: '512',
                    mask: 'true',
                }),
                {
                    width: '512',
                    mask: null,
                    filter: '/DCTDecode',
                },
            ]);
            expect(pageImages[0]?.filter).not.toBe('/DCTDecode');
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 240_000);

    it('prints a DjVu document through the browser print dialog', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-print-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                // The print dialog's sheets, as the browser would print them.
                window.print = () => {
                    const sheets = Array.from(document.querySelectorAll<HTMLImageElement>('.browser-print-page img')).map((image) => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.naturalWidth;
                        canvas.height = image.naturalHeight;
                        canvas.getContext('2d')!.drawImage(image, 0, 0);
                        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
                        let ink = 0;
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index]! < 128 && pixels[index + 1]! < 128 && pixels[index + 2]! < 128) ink += 1;
                        }
                        return {
                            ink,
                            image: canvas.toDataURL(),
                        };
                    });
                    Reflect.set(window.top!, '__djvuPrint', sheets);
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
            // Page 1 is a JB2 mask of four black lines; page 2 is faint pencil.
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__djvuPrint'))), {timeout: 60_000}).toBe(true);
            const sheets = await page.evaluate(() => Reflect.get(window, '__djvuPrint') as Array<{
                ink: number;
                image: string;
            }>);
            for (const [
                index,
                sheet,
            ] of sheets.entries()) {
                writeFileSync(resolve(evidenceDir, `printed-${index + 1}.png`), Buffer.from(sheet.image.split(',')[1]!, 'base64'));
            }
            expect(sheets).toHaveLength(2);
            expect(sheets[0]!.ink).toBeGreaterThan(1_000);
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 180_000);

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
            const recentPdf = page.locator('[data-recent-open-actionable="true"] .recent-open')
                .filter({hasText: 'bitonal-faint-pencil.pdf'});
            // The converted PDF is the conversion's output, not unsaved work: a reload, with its tab open or
            // closed a moment before, restores no tab to recover, whether or not the close finished.
            const reloadToStartPage = async () => {
                await page.reload({waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
                expect(await page.locator('[data-tab-list] [role="tab"]').evaluateAll(tabs => tabs.map(tab => ({
                    name: tab.textContent?.trim(),
                    state: tab.getAttribute('aria-description'),
                })))).toEqual([{
                    name: 'New Tab',
                    state: null,
                }]);
                await recentPdf.waitFor({
                    state: 'visible',
                    timeout: 60_000,
                });
            };
            await reloadToStartPage();
            await recentPdf.click();
            await renderedPdf.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await reloadToStartPage();
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

            // A real edit of the converted PDF is unsaved work: committed, it comes back after a reload.
            const committed = () => page.evaluate(async () => {
                const revisions: Record<string, number | null> = {};
                const documents = await (await navigator.storage.getDirectory()).getDirectoryHandle('documents');
                for await (const [id, dir] of (documents as unknown as {entries(): AsyncIterable<[string, FileSystemDirectoryHandle]>}).entries()) {
                    const manifest = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text()) as {current?: {id: number}};
                    revisions[id] = manifest.current?.id ?? null;
                }
                return revisions;
            });
            const opened = await committed();
            await page.getByRole('button', {name: 'Toggle Sidebar', exact: true}).click();
            await page.getByRole('tab', {name: 'Pages', exact: true}).click();
            await page.locator('[data-thumbnail-page="1"]').first().click({button: 'right'});
            await page.getByRole('menuitem', {name: 'Rotate Clockwise', exact: true}).click();
            await expect.poll(committed, {timeout: 60_000}).not.toEqual(opened);
            const readWorkingCopy = () => page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                return api?.readActiveWorkspaceStateValues?.<{workingCopyPath: string | null}>(['workingCopyPath']).workingCopyPath ?? null;
            });
            const editedCopy = await readWorkingCopy();
            // A reload restores the tabs the window's workspace record names, which it writes shortly after a tab opens.
            await expect.poll(() => page.evaluate(async (ref) => {
                const workspaces = await (await navigator.storage.getDirectory()).getDirectoryHandle('workspaces');
                for await (const [, handle] of (workspaces as unknown as {entries(): AsyncIterable<[string, FileSystemFileHandle]>}).entries()) {
                    const record = await (await handle.getFile()).text().catch(() => '');
                    if (record.includes(JSON.stringify(ref).slice(1, -1))) return true;
                }
                return false;
            }, editedCopy), {timeout: 30_000}).toBe(true);
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').evaluate(tab => ({
                name: tab.textContent?.trim(),
                state: tab.getAttribute('aria-description'),
            })), {timeout: 30_000}).toEqual({
                name: 'bitonal-faint-pencil.pdf',
                state: 'Unsaved changes',
            });
            // The pages are square, so the rotation shows in the recovered working copy's bytes rather than its shape.
            const workingCopy = await readWorkingCopy();
            expect(workingCopy).toMatch(/\.pdf$/u);
            const recovered = await PDFDocument.load(Uint8Array.from(await readPersistedDocumentBytes(page, workingCopy!)));
            expect(recovered.getPage(0).getRotation().angle).toBe(90);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);
});
