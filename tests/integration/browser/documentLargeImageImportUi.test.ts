import {
    mkdir, readFile, writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import {
    lifecycle, openPdfFromChooser,
} from './documentLifecycleTestHelpers';

describe('browser large image import', () => {
    it('opens and saves a scan whose encoded image and combined PDF exceed 16 MiB', async () => {
        const evidence = process.env.EVB_LARGE_IMAGE_EVIDENCE_DIR;
        if (evidence) await mkdir(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1440,
            height: 900,
        }});
        try {
            const scan = await readFile(join(process.cwd(), 'tests/fixtures/electron/latin-ligatures/missale-1835-urbanus.jpg'));
            // Valid JPEG comment segments increase encoded size without changing
            // the real scan's pixels or requiring an enormous decoded raster.
            const comment = Buffer.alloc(65537, 65);
            comment.set([
                255,
                254,
                255,
                255,
            ]);
            const comments = Array.from({length: 270}, () => comment);
            const image = Buffer.concat([
                scan.subarray(0, 2),
                ...comments,
                scan.subarray(2),
            ]);
            expect(image.byteLength).toBeGreaterThan(16 * 1024 * 1024);
            await openPdfFromChooser(page, {
                name: 'large-missale-scan.jpg',
                mimeType: 'image/jpeg',
                buffer: image,
            });
            await page.waitForFunction(() => document.querySelector('.page_container--rendered canvas')
                || document.body.textContent?.includes('16MB'), undefined, {timeout: 30000});
            expect(await page.locator('.page_container--rendered canvas').count()).toBeGreaterThan(0);
            if (evidence) await page.screenshot({path: join(evidence, 'opened.png')});
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const path = await (await download).path();
            if (!path) throw new Error('Image import did not save a PDF');
            const saved = await readFile(path);
            expect(saved.byteLength).toBeGreaterThan(16 * 1024 * 1024);
            expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
            expect(saved.includes(image)).toBe(true);
        } finally {
            if (evidence) await page.screenshot({path: join(evidence, 'terminal.png')});
            if (evidence) await writeFile(join(evidence, 'terminal.txt'), await page.locator('body').innerText());
            await page.context().close();
        }
    }, 120000);
});
