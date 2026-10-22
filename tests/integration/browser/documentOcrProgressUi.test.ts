import {
    readFile, mkdir, writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import {
    lifecycle, openPdfFromChooser,
} from './documentLifecycleTestHelpers';

describe('browser OCR progress', () => {
    it('shows completed page counts instead of a parallel worker page number', async () => {
        // I4: long work reports its step with a count that never moves backward.
        const evidence = process.env.EVB_OCR_PROGRESS_EVIDENCE_DIR;
        if (evidence) await mkdir(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({
            ...(evidence ? {recordVideo: {dir: evidence}} : {}),
            viewport: {
                width: 1440,
                height: 900,
            },
        });
        try {
            // Serve the bundled, hash-verified English model without a network download.
            await page.route('**/eng.traineddata', route => route.fulfill({path: join(process.cwd(), 'resources/tesseract/tessdata/eng.traineddata')}));
            const source = await PDFDocument.load(await readFile(join(
                process.cwd(), 'tests/fixtures/release/packaged-core-ocr-smoke.pdf',
            )));
            const fixturePdf = await PDFDocument.create();
            for (let index = 0; index < 8; index += 1) {
                const [copy] = await fixturePdf.copyPages(source, [0]);
                fixturePdf.addPage(copy!);
            }
            await openPdfFromChooser(page, {
                name: 'ocr-progress-counts.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await fixturePdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.getByRole('button', {
                name: 'OCR',
                exact: true,
            }).click();
            const dialog = page.getByRole('dialog');
            await dialog.getByText('All pages (8)', {exact: true}).click();
            await page.evaluate(() => {
                const samples: string[] = [];
                Reflect.set(window, '__ocrProgressSamples', samples);
                const observer = new MutationObserver(() => {
                    const text = document.querySelector('[role="dialog"] .progress-text')?.textContent?.trim();
                    if (text && samples.at(-1) !== text) samples.push(text);
                });
                observer.observe(document.body, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                });
            });
            await dialog.getByRole('button', {name: /^(Download and start OCR|Start OCR)$/u}).click();
            await page.waitForFunction(() => document.querySelector('[role="dialog"] .progress-text')
                ?.textContent?.startsWith('Processing page'), undefined, {timeout: 90_000});
            if (evidence) {
                await page.screenshot({path: join(evidence, 'processing.png')});
            }
            await dialog.getByText('OCR complete - PDF is now searchable', {exact: true}).waitFor({timeout: 90_000});
            const samples = await page.evaluate(() => Reflect.get(window, '__ocrProgressSamples') as string[]);
            if (evidence) await writeFile(join(evidence, 'samples.json'), JSON.stringify(samples, null, 2));
            const processing = samples.filter(text => text.startsWith('Processing page'));
            expect(processing.length).toBeGreaterThan(1);
            const counts = processing.map(text => {
                expect(text).toMatch(/^Processing pages: \d+\/8 completed$/u);
                return Number(text.match(/: (\d+)\//u)?.[1]);
            });
            expect(counts[0]).toBe(0);
            expect(counts.some(count => count > 0)).toBe(true);
            expect(counts).toEqual([...counts].sort((left, right) => left - right));
        } finally {
            await page.context().close();
        }
    }, 180_000);
});
