import {
    mkdir, readFile, writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {encode} from 'fast-png';
import {PDFDocument} from 'pdf-lib';
import type {Page} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import {
    collectConsoleProblems, lifecycle, waitForOpenFileReady,
} from './documentLifecycleTestHelpers';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import type {IProbe} from './scanCleanupUiTestHelpers';
import {
    evidenceRoot, scanCleanupUiTimeoutMs, previewImage, cleanedImage, sha256, installProbe, openWorkspace, showWorkspace, waitForPixels, pixels, cleanedPixels, assertBrowserScope, select, drag, undoRedo,
} from './scanCleanupUiTestHelpers';

async function createFixture() {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const width = 1800;
        const height = 1200;
        const data = new Uint8Array(width * height * 3);
        // Distinct scans, with two text columns and a colored page marker.
        // Integer raster coordinates keep the fixture independent of fonts.
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const columnX = x % 900;
                const ink = y > 150 && y < 1000 && y % 54 < 12
                    && columnX > 100 && columnX < 760 - pageIndex * 70 && columnX % 43 < 28;
                const marker = y > 50 && y < 120 && x > 100 + pageIndex * 100 && x < 340 + pageIndex * 100;
                const paper = 230 + Math.floor(20 * x / width);
                const offset = (y * width + x) * 3;
                for (let channel = 0; channel < 3; channel += 1) {
                    data[offset + channel] = ink ? 28 + pageIndex * 12 : marker ? (channel === pageIndex ? 180 : 40) : paper;
                }
            }
        }
        const image = await pdf.embedPng(encode({
            width,
            height,
            data,
            channels: 3,
            depth: 8,
        }));
        pdf.addPage([
            432,
            288,
        ]).drawImage(image, {
            x: 0,
            y: 0,
            width: 432,
            height: 288,
        });
    }
    const bytes = Buffer.from(await pdf.save());
    await mkdir(evidenceRoot, {recursive: true});
    await writeFile(join(evidenceRoot, 'source.pdf'), bytes);
    await writeFile(join(evidenceRoot, 'fixture.json'), JSON.stringify({
        sha256: sha256(bytes),
        pages: 3,
        raster: [
            1800,
            1200,
        ],
        sourceDpi: 300,
    }, null, 2));
    return {
        name: 'sc3b-three-scans.pdf',
        mimeType: 'application/pdf',
        buffer: bytes,
    };
}

// Built once: every case scans the same three pages.
let fixtureOnce: ReturnType<typeof createFixture> | undefined;
const fixture = () => fixtureOnce ??= createFixture();

const documentRef = (page: Page) => page.evaluate(() => (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi)
    .readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath);
// The tab holds a document again, and not the one it held before.
const newDocumentRef = async (page: Page, previous: string | undefined) => {
    const ref = await documentRef(page);
    return typeof ref === 'string' && ref !== previous;
};



describe('browser Scan Cleanup workspace', () => {
    // T1/T6: Save As retains document settings and Recent reopens the saved identity.
    it('retains the page override after Save As and reopening the saved Recent document', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1440,
            height: 1000,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const observations: Array<{
            stage: string;
            pageNumber: number;
            outputMode: string;
            documentGrayscale: string | null;
            previewSha256: string;
        }> = [];
        const observePage = async (stage: string, pageNumber: number, expectedMode: string) => {
            await page.locator(`.scan-thumbnail-rail [data-thumbnail-page="${String(pageNumber)}"]`).click();
            await page.getByRole('radio', {
                name: `Page ${String(pageNumber)}`,
                exact: true,
            }).click();
            await waitForPixels(page, pageNumber);
            const outputMode = await page.getByRole('combobox', {
                name: 'Output mode',
                exact: true,
            }).innerText();
            const documentGrayscale = await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).getAttribute('aria-checked');
            const previewSha256 = await cleanedPixels(page);
            observations.push({
                stage,
                pageNumber,
                outputMode,
                documentGrayscale,
                previewSha256,
            });
            await page.screenshot({path: join(evidenceRoot, `${stage}-page-${String(pageNumber)}.png`)});
            for (const [
                index,
                image,
            ] of (await page.locator(cleanedImage).all()).entries()) {
                await writeFile(join(evidenceRoot, `${stage}-page-${String(pageNumber)}-preview-${String(index)}.png`), Buffer.from(await pixels(image), 'base64'));
            }
            expect(outputMode, `${stage}: Page ${String(pageNumber)} output mode`).toBe(expectedMode);
            expect(documentGrayscale, `${stage}: document output remains Grayscale`).toBe('true');
            return previewSha256;
        };
        try {
            await installProbe(page);
            const source = await fixture();
            await openWorkspace(page, source);
            const originalRef = await documentRef(page);
            expect(originalRef).toBeTypeOf('string');
            await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).click();
            await waitForPixels(page, 1);
            const grayscalePage1 = await cleanedPixels(page);
            await page.getByRole('radio', {
                name: 'Page 1',
                exact: true,
            }).click();
            await select(page, 'Output mode', 'Color');
            await waitForPixels(page, 1);
            const colorPage1 = await observePage('before-save', 1, 'Color');
            expect(colorPage1, 'the painted Color preview differs from Grayscale on the same scan').not.toBe(grayscalePage1);
            const grayscalePage2 = await observePage('before-save', 2, 'Follow document setting');
            await page.locator('.scan-thumbnail-rail [data-thumbnail-page="1"]').click();
            await waitForPixels(page, 1);
            // Finish editing as a person would, before using the reader's save controls.
            await page.getByRole('button', {
                name: 'Done',
                exact: true,
            }).click();
            const downloaded = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const download = await downloaded;
            expect(download.suggestedFilename()).toBe(source.name);
            const savedPath = join(evidenceRoot, 'saved.pdf');
            await download.saveAs(savedPath);
            const saved = await readFile(savedPath);
            expect((await PDFDocument.load(saved)).getPageCount()).toBe(3);
            expect(sha256(saved), 'Save As preserves the unedited scanned PDF bytes').toBe(sha256(source.buffer));
            await expect.poll(() => newDocumentRef(page, originalRef)).toBe(true);
            const savedRef = await documentRef(page);
            await writeFile(join(evidenceRoot, 'save-as.json'), JSON.stringify({
                mode: 'download',
                originalRef,
                savedRef,
                suggestedFilename: download.suggestedFilename(),
                sourceSha256: sha256(source.buffer),
                savedSha256: sha256(saved),
                savedBytes: saved.byteLength,
                pages: 3,
            }, null, 2));
            await showWorkspace(page);
            // The open view keeps the override under its new identity; the
            // reload below checks both pages against that saved identity.
            expect(await observePage('after-save', 1, 'Color')).toBe(colorPage1);

            await page.getByRole('button', {
                name: 'Done',
                exact: true,
            }).click();
            // Reload without closing/discarding. The newest Recent entry has
            // the same label as the imported original; verify its saved identity.
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.getByRole('button', {name: /sc3b-three-scans\.pdf/u}).first().click();
            await expect.poll(() => documentRef(page)).toBe(savedRef);
            await showWorkspace(page);
            expect(await observePage('after-reload', 1, 'Color')).toBe(colorPage1);
            expect(await observePage('after-reload', 2, 'Follow document setting')).toBe(grayscalePage2);
            await assertBrowserScope(page);
            expect(problems).toEqual([]);
        } finally {
            // Evidence is best-effort; it never hides the outcome or skips closing the context.
            try {
                await writeFile(join(evidenceRoot, 'save-as-observations.json'), JSON.stringify(observations, null, 2));
                await writeFile(join(evidenceRoot, 'save-as-console.json'), JSON.stringify(problems, null, 2));
                await writeFile(join(evidenceRoot, 'save-as-input.json'), JSON.stringify(await page.evaluate(() => (Reflect.get(window, '__sc3bProbe') as IProbe).inputs), null, 2));
            } catch (error) {
                console.warn('Save As evidence was not written', error);
            } finally {
                await context.close();
            }
        }
    }, scanCleanupUiTimeoutMs);

    // C2: a different document opened in the same tab stays isolated.
    it('opens a different document in the same tab with its own output setting', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1440,
            height: 1000,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            await installProbe(page);
            const source = await fixture();
            await openWorkspace(page, source);
            const originalRef = await documentRef(page);
            expect(originalRef).toBeTypeOf('string');
            await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).click();
            await waitForPixels(page, 1);
            await page.getByRole('button', {
                name: 'Done',
                exact: true,
            }).click();
            const activeTab = page.locator('.editor-pane.is-active .tab.is-active[data-tab-id]');
            const tabId = await activeTab.getAttribute('data-tab-id');
            expect(tabId).toBeTypeOf('string');
            const otherPdf = await PDFDocument.load(source.buffer);
            otherPdf.getPage(0).drawText('Different document', {
                x: 20,
                y: 260,
                size: 18,
            });
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await (await chooser).setFiles({
                name: 'cb3-different-scans.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await otherPdf.save()),
            });
            await expect.poll(() => activeTab.innerText()).toContain('cb3-different-scans.pdf');
            await expect.poll(() => page.locator('.page_container[data-page="1"] .textLayer').first().innerText()).toContain('Different document');
            expect(await activeTab.getAttribute('data-tab-id'), 'Open File replaces the current tab').toBe(tabId);
            await expect.poll(() => newDocumentRef(page, originalRef)).toBe(true);
            await showWorkspace(page);
            await waitForPixels(page, 1);
            await page.getByRole('radio', {
                name: 'Page 1',
                exact: true,
            }).click();
            await page.screenshot({path: join(evidenceRoot, 'replacement-page-1.png')});
            expect(await page.getByRole('combobox', {
                name: 'Output mode',
                exact: true,
            }).innerText(), 'the replacement has no page override').toBe('Follow document setting');
            expect(await page.getByRole('radio', {name: /^Auto.*recommended per page$/u}).getAttribute('aria-checked'), 'the replacement starts with its own document output setting').toBe('true');
            await assertBrowserScope(page);
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, scanCleanupUiTimeoutMs);

    it('opens without OCR and paints black and white, original, grayscale and zoomed detail pixels', async () => {
        const context = await lifecycle.browser.newContext({
            ...(process.env.SC3B_RECORD_VIDEO === '1' ? {recordVideo: {dir: join(evidenceRoot, 'case-1-views-video')}} : {}),
            viewport: {
                width: 1440,
                height: 1000,
            },
        });
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            await installProbe(page);
            await openWorkspace(page, await fixture());
            await page.getByRole('radio', {
                name: 'Black and white',
                exact: true,
            }).click();
            await waitForPixels(page, 1);
            await page.getByRole('radio', {
                name: 'Original',
                exact: true,
            }).click();
            await page.locator(previewImage).first().waitFor({state: 'visible'});
            expect(await page.locator(previewImage).first().getAttribute('alt')).toBe('Original scan preview for page 1');
            await page.screenshot({path: join(evidenceRoot, 'original.png')});
            await page.getByRole('radio', {
                name: 'Cleaned',
                exact: true,
            }).click();
            await waitForPixels(page, 1);
            await page.screenshot({path: join(evidenceRoot, 'cleaned.png')});
            await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.uniform-canvas[data-render-dpi]').first().getAttribute('data-render-dpi')).toBe('150');
            await waitForPixels(page, 1);
            for (let step = 0; step < 5; step += 1) await page.getByRole('button', {
                name: 'Zoom in',
                exact: true,
            }).click();
            await page.locator('.preview-detail-pixel').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            expect(await page.locator('.preview-detail-pixel').first().evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
            await page.screenshot({path: join(evidenceRoot, 'detail.png')});
            await assertBrowserScope(page);
            expect(problems).toEqual([]);
        } finally {
            await writeFile(join(evidenceRoot, 'case-1-views-console.json'), JSON.stringify(problems, null, 2));
            await context.close();
        }
    }, scanCleanupUiTimeoutMs);

    it('edits crop, cutter and zones with undo/redo, and reloads durable settings', async () => {
        const context = await lifecycle.browser.newContext({
            ...(process.env.SC3B_RECORD_VIDEO === '1' ? {recordVideo: {dir: join(evidenceRoot, 'case-1-video')}} : {}),
            viewport: {
                width: 1440,
                height: 1000,
            },
        });
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            await installProbe(page);
            await openWorkspace(page, await fixture());
            await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).click();
            await waitForPixels(page, 1);
            const content = page.locator('.content-overlay').first();
            const crop = () => content.getAttribute('style').then(value => value ?? '');
            const beforeCrop = await crop();
            await page.screenshot({path: join(evidenceRoot, 'crop-before.png')});
            const cropPixels = async () => sha256(Buffer.from(await pixels(page.locator(cleanedImage).first()), 'base64'));
            const beforeCropPixels = await cropPixels();
            await drag(page, page.getByRole('button', {name: /Resize the .* content box from the top-right corner/u}).first(), -20, 12);
            await expect.poll(crop).not.toBe(beforeCrop);
            await expect.poll(cropPixels).not.toBe(beforeCropPixels);
            await waitForPixels(page, 1);
            const afterCropPixels = await cropPixels();
            await undoRedo(page, 'crop', cropPixels, beforeCropPixels, afterCropPixels);
            await select(page, 'Page layout', 'Force two-page spreads');
            await waitForPixels(page, 1);
            await page.getByRole('radio', {
                name: 'Original',
                exact: true,
            }).click();
            const cutter = page.getByRole('button', {
                name: 'Spread cutter position',
                exact: true,
            });
            await cutter.waitFor({state: 'visible'});
            const split = () => cutter.getAttribute('style').then(value => value ?? '');
            const beforeSplit = await split();
            await drag(page, cutter, 30, 0);
            await expect.poll(split).not.toBe(beforeSplit);
            const afterSplit = await split();
            await undoRedo(page, 'cutter', split, beforeSplit, afterSplit);
            await page.getByRole('radio', {
                name: 'Cleaned',
                exact: true,
            }).click();
            await waitForPixels(page, 1);
            await page.getByRole('button', {
                name: 'Edit picture and fill zones',
                exact: true,
            }).click();
            await page.getByRole('radio', {
                name: 'Fill',
                exact: true,
            }).click();
            const editor = page.locator('.zone-editor-overlay svg');
            const box = await editor.boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.65);
            await page.mouse.down();
            await page.mouse.move(box!.x + box!.width * 0.82, box!.y + box!.height * 0.82, {steps: 8});
            await page.mouse.up();
            const zones = page.locator('.zone-editor-polygon:not(.is-draft)');
            await expect.poll(() => zones.count()).toBe(1);
            const zoneShape = () => zones.count().then(count => count ? zones.first().getAttribute('points').then(value => value ?? '') : '');
            const afterZone = await zoneShape();
            await undoRedo(page, 'zone', zoneShape, '', afterZone);
            await page.screenshot({path: join(evidenceRoot, 'edited.png')});
            await page.getByRole('button', {
                name: 'Edit picture and fill zones',
                exact: true,
            }).click();
            await page.getByRole('radio', {
                name: 'Page 1',
                exact: true,
            }).click();
            await select(page, 'Output mode', 'Color');
            await waitForPixels(page, 1);
            await page.screenshot({path: join(evidenceRoot, 'before-reload.png')});
            await writeFile(join(evidenceRoot, 'before-reload-storage.json'), JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => /scan.?cleanup/iu.test(key)))), null, 2));
            const persistedPixels = await cleanedPixels(page);
            await page.getByRole('radio', {
                name: 'Original',
                exact: true,
            }).click();
            const persistedSplit = await split();
            await page.getByRole('button', {
                name: 'Done',
                exact: true,
            }).click();
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            // Reopen the persisted source through Recent Files. Re-importing
            // bytes through the chooser creates a different browser document.
            await page.getByRole('button', {name: /sc3b-three-scans\.pdf/u}).first().click();
            await showWorkspace(page);
            await waitForPixels(page, 1);
            await page.screenshot({path: join(evidenceRoot, 'after-reload.png')});
            await writeFile(join(evidenceRoot, 'after-reload-storage.json'), JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.entries(window.localStorage).filter(([key]) => /scan.?cleanup/iu.test(key)))), null, 2));
            expect(await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).getAttribute('aria-checked')).toBe('true');
            expect(await page.getByRole('combobox', {
                name: 'Page layout',
                exact: true,
            }).innerText()).toBe('Force two-page spreads');
            await page.getByRole('radio', {
                name: 'Page 1',
                exact: true,
            }).click();
            expect(await page.getByRole('combobox', {
                name: 'Output mode',
                exact: true,
            }).innerText()).toBe('Color');
            await expect.poll(() => cleanedPixels(page)).toBe(persistedPixels);
            await page.getByRole('radio', {
                name: 'Original',
                exact: true,
            }).click();
            await expect.poll(split).toBe(persistedSplit);
            await page.getByRole('radio', {
                name: 'Cleaned',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Edit picture and fill zones',
                exact: true,
            }).click();
            await expect.poll(zoneShape).toBe(afterZone);
            await page.screenshot({path: join(evidenceRoot, 'reloaded.png')});
            await assertBrowserScope(page);
            expect(problems).toEqual([]);
        } finally {
            await page.screenshot({path: join(evidenceRoot, 'case-1-final.png')}).catch(() => undefined);
            await writeFile(join(evidenceRoot, 'case-1-console.json'), JSON.stringify(problems, null, 2));
            await writeFile(join(evidenceRoot, 'case-1-input.json'), JSON.stringify(await page.evaluate(() => (Reflect.get(window, '__sc3bProbe') as IProbe).inputs)));
            await context.close();
        }
    }, scanCleanupUiTimeoutMs);

    it('keeps latest navigation, settings and detail pixels across delayed preview cancellation and hidden-tab return', async () => {
        const context = await lifecycle.browser.newContext({
            ...(process.env.SC3B_RECORD_VIDEO === '1' ? {recordVideo: {dir: join(evidenceRoot, 'case-2-video')}} : {}),
            viewport: {
                width: 1440,
                height: 1000,
            },
        });
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            await installProbe(page);
            await openWorkspace(page, await fixture());
            await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).click();
            await waitForPixels(page, 1);
            // Navigate while adjacent preparation and the detail debounce can settle.
            for (let step = 0; step < 5; step += 1) await page.getByRole('button', {
                name: 'Zoom in',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Preview next page',
                exact: true,
            }).click();
            await page.getByRole('radio', {
                name: 'Color',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Preview next page',
                exact: true,
            }).click();
            await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).click();
            await waitForPixels(page, 3);
            await page.locator('.preview-detail-pixel').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.getByRole('button', {
                name: 'Fit whole page in view',
                exact: true,
            }).click();
            const latest = await cleanedPixels(page);
            // Keep the genuine engine reply in flight while the user cancels by
            // leaving the workspace. Deliver it after the replacement has painted.
            await page.evaluate(() => { (Reflect.get(window, '__sc3bProbe') as IProbe).holdNext = true; });
            await page.getByRole('radio', {
                name: 'Color',
                exact: true,
            }).click();
            await page.waitForFunction(() => (Reflect.get(window, '__sc3bProbe') as IProbe).held.length > 0);
            await page.screenshot({path: join(evidenceRoot, 'preview-in-flight.png')});
            await page.getByRole('button', {
                name: 'Done',
                exact: true,
            }).click();
            await page.locator('.scan-cleanup-surface').waitFor({state: 'detached'});
            await page.locator('#editor-global-toolbar-host').getByRole('button', {
                name: 'Scan cleanup',
                exact: true,
            }).click();
            await page.getByRole('radio', {
                name: 'Grayscale',
                exact: true,
            }).click();
            await page.locator('[data-document-thumbnail-item]').filter({has: page.locator('[data-page-number="3"]')}).click();
            await waitForPixels(page, 3);
            await page.evaluate(() => {
                const probe = Reflect.get(window, '__sc3bProbe') as IProbe;
                probe.held.splice(0).forEach(deliver => deliver());
            });
            await expect.poll(() => cleanedPixels(page)).toBe(latest);
            // Headless Chromium does not background tabs. Suspend rAF exactly as
            // the existing OCR lane does; workers and promise settlement continue.
            await page.evaluate(() => {
                const request = window.requestAnimationFrame.bind(window);
                const cancel = window.cancelAnimationFrame.bind(window);
                const suspended = new Map<number, FrameRequestCallback>();
                let id = 0;
                window.requestAnimationFrame = callback => { suspended.set(--id, callback); return id; };
                window.cancelAnimationFrame = frame => { if (!suspended.delete(frame)) cancel(frame); };
                Reflect.set(window, '__sc3bResume', () => {
                    window.requestAnimationFrame = request;
                    window.cancelAnimationFrame = cancel;
                    suspended.forEach(callback => request(callback));
                });
            });
            const previous = await page.getByRole('button', {
                name: 'Preview previous page',
                exact: true,
            }).boundingBox();
            expect(previous).not.toBeNull();
            await page.mouse.click(previous!.x + previous!.width / 2, previous!.y + previous!.height / 2);
            await page.waitForFunction(() => document.querySelector('.page-label')?.textContent?.includes('Page 2 of 3'), undefined, {polling: 100});
            await page.evaluate(() => Reflect.get(window, '__sc3bResume')());
            await waitForPixels(page, 2);
            expect(await cleanedPixels(page)).not.toBe(latest);
            await page.screenshot({path: join(evidenceRoot, 'latest-after-hidden-return.png')});
            await assertBrowserScope(page);
            expect(problems).toEqual([]);
        } finally {
            await page.screenshot({path: join(evidenceRoot, 'case-2-final.png')}).catch(() => undefined);
            await writeFile(join(evidenceRoot, 'case-2-console.json'), JSON.stringify(problems, null, 2));
            await writeFile(join(evidenceRoot, 'case-2-input.json'), JSON.stringify(await page.evaluate(() => (Reflect.get(window, '__sc3bProbe') as IProbe).inputs)));
            await context.close();
        }
    }, scanCleanupUiTimeoutMs);
});
