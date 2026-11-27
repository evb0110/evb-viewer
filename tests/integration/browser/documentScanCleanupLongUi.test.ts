import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument, rgb} from 'pdf-lib';
import {describe, expect, it} from 'vitest';
import {collectConsoleProblems, lifecycle} from './documentLifecycleTestHelpers';
import {cleanedInkTop, evidenceRoot, installProbe, openWorkspace, sha256, waitForPixels} from './scanCleanupUiTestHelpers';

/** One more page than a renderer keeps results for in its detection state. */
const LONG_DOCUMENT_PAGES = 1025;
const PAGE_HEIGHT_PT = 81;
const INK_JITTER_PT = 2.25;

/**
 * A long document of small pages with rows of ink whose top edge moves from
 * page to page, so detection and ink placement measure real content.
 */
async function longFixture() {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    // The page box and all ink geometry are scaled to 75% to reduce the
    // raster work per page while still crossing the renderer's result window.
    for (let pageIndex = 0; pageIndex < LONG_DOCUMENT_PAGES; pageIndex += 1) {
        const page = pdf.addPage([54, PAGE_HEIGHT_PT]);
        const top = 69.75 - (pageIndex % 7) * INK_JITTER_PT;
        for (let row = 0; row < 9; row += 1) {
            page.drawRectangle({
                x: 6.75,
                y: top - row * 5.625,
                width: 39 - (row % 3) * 5.25,
                height: 1.875,
                color: rgb(0.1, 0.1, 0.1),
            });
        }
    }
    const bytes = Buffer.from(await pdf.save());
    await mkdir(evidenceRoot, {recursive: true});
    await writeFile(
        join(evidenceRoot, 'long-source.json'),
        JSON.stringify(
            {
                sha256: sha256(bytes),
                pages: LONG_DOCUMENT_PAGES,
            },
            null,
            2,
        ),
    );
    return {
        name: 'long-scan.pdf',
        mimeType: 'application/pdf',
        buffer: bytes,
    };
}

// A suite of its own: a thousand page analyses run beside the other
// workspace suites rather than after them.
describe('browser Scan Cleanup workspace, long document', () => {
    // T6: a document longer than the renderer's result window keeps its
    // detection evidence in the browser's store, calibrates ink placement
    // from it, and previews a page no renderer state still carries.
    it('detects a long document into kept evidence that calibrates ink placement and previews its last page', async () => {
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1440,
                height: 1000,
            },
        });
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            await installProbe(page);
            await openWorkspace(page, await longFixture());
            await expect
                .poll(() => page.locator('.scan-cleanup-surface').getAttribute('data-detection-status'), {
                    timeout: 240_000,
                    interval: 1_000,
                })
                .toBe('completed');
            // Every page's record is kept, including the first pages no
            // renderer state carries any more.
            expect(
                await page.evaluate(async () => {
                    const name = (await indexedDB.databases()).find((database) =>
                        database.name?.startsWith('evb-viewer-scan-cleanup-detection-'),
                    )?.name;
                    if (name === undefined) {
                        return null;
                    }
                    const database = await new Promise<IDBDatabase>((resolve, reject) => {
                        const open = indexedDB.open(name);
                        open.onsuccess = () => resolve(open.result);
                        open.onerror = () => reject(open.error);
                    });
                    try {
                        const rows = await new Promise<Array<{pageNumber: number}>>((resolve, reject) => {
                            const read = database.transaction('records', 'readonly').objectStore('records').getAll();
                            read.onsuccess = () => resolve(read.result as Array<{pageNumber: number}>);
                            read.onerror = () => reject(read.error);
                        });
                        const pageNumbers = new Set(rows.map((row) => row.pageNumber));
                        return {
                            pages: pageNumbers.size,
                            first: Math.min(...pageNumbers),
                            last: Math.max(...pageNumbers),
                        };
                    } finally {
                        database.close();
                    }
                }),
            ).toEqual({
                pages: LONG_DOCUMENT_PAGES,
                first: 1,
                last: LONG_DOCUMENT_PAGES,
            });
            await page
                .getByRole('radio', {
                    name: 'Keep where the ink is',
                    exact: true,
                })
                .click();
            // Calibration over the kept store settles: placement no longer
            // holds the run back, so Clean up is offered.
            await expect
                .poll(
                    () =>
                        page
                            .locator('.scan-cleanup-toolbar button')
                            .filter({hasText: /^Clean up/u})
                            .isDisabled(),
                    {timeout: 60_000},
                )
                .toBe(false);
            await page.locator('.scan-thumbnail-rail [data-thumbnail-page="1"]').click();
            await page.keyboard.press('End');
            await waitForPixels(page, LONG_DOCUMENT_PAGES, LONG_DOCUMENT_PAGES);
            await page.screenshot({path: join(evidenceRoot, 'case-long-last-page.png')});
            // The last page's ink starts 2.25 pt lower on its 81 pt page than
            // the page before it. Calibration over every kept page snaps that
            // jitter to one ink line; placement without it keeps the offset.
            const lastInkTop = (await cleanedInkTop(page))!;
            await page.locator(`.scan-thumbnail-rail [data-thumbnail-page="${String(LONG_DOCUMENT_PAGES - 1)}"]`).click();
            await waitForPixels(page, LONG_DOCUMENT_PAGES - 1, LONG_DOCUMENT_PAGES);
            const previousInkTop = (await cleanedInkTop(page))!;
            // The line stays inside the scaled ink band, 9.375 to 22.875 pt
            // from the top edge, where a top-aligned page would not put it.
            expect((lastInkTop.height * INK_JITTER_PT) / PAGE_HEIGHT_PT).toBeGreaterThan(3);
            expect(Math.abs(lastInkTop.row - previousInkTop.row)).toBeLessThanOrEqual(1);
            expect(lastInkTop.row / lastInkTop.height).toBeGreaterThanOrEqual(9 / PAGE_HEIGHT_PT);
            expect(lastInkTop.row / lastInkTop.height).toBeLessThanOrEqual(23.25 / PAGE_HEIGHT_PT);
            expect(problems).toEqual([]);
        } finally {
            await writeFile(join(evidenceRoot, 'case-long-console.json'), JSON.stringify(problems, null, 2));
            await context.close();
        }
    }, 360_000);
});
