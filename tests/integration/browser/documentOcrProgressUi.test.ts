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
    it('shows completed page counts and finishes while tab animation frames are suspended', async () => {
        // I4: long work reports its step with a count that never moves backward.
        const evidence = process.env.EVB_OCR_PROGRESS_EVIDENCE_DIR;
        if (evidence) await mkdir(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({
            ...(evidence ? {recordVideo: {
                dir: evidence,
                size: {
                    width: 1440,
                    height: 900,
                },
            }} : {}),
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
            // Headless Chromium keeps every tab visible. Reproduce the hidden-tab
            // policy directly: animation callbacks stop, while worker messages,
            // promises and DOM updates can still run. OCR must finish before any
            // callbacks resume, as it must when the user works in another app.
            await page.evaluate(() => {
                const request = window.requestAnimationFrame.bind(window);
                const cancel = window.cancelAnimationFrame.bind(window);
                const suspended = new Map<number, FrameRequestCallback>();
                let frameId = 0;
                window.requestAnimationFrame = callback => {
                    suspended.set(--frameId, callback);
                    return frameId;
                };
                window.cancelAnimationFrame = id => {
                    if (!suspended.delete(id)) cancel(id);
                };
                Reflect.set(window, '__resumeOcrAnimationFrames', () => {
                    window.requestAnimationFrame = request;
                    window.cancelAnimationFrame = cancel;
                    suspended.forEach(callback => request(callback));
                });
            });
            if (evidence) {
                await page.screenshot({path: join(evidence, 'processing.png')});
            }
            await dialog.getByText('OCR complete - PDF is now searchable', {exact: true}).waitFor({timeout: 90_000});
            if (evidence) await page.screenshot({path: join(evidence, 'complete-without-animation-frames.png')});
            await page.evaluate(() => Reflect.get(window, '__resumeOcrAnimationFrames')());
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
            await dialog.getByRole('button', {
                name: 'Close',
                exact: true,
            }).last().click();
            if (await page.locator('[data-testid="document-sidebar"]:visible').count() === 0) {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).first().click();
            }
            await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            const searchInput = page.locator('.document-search-bar input:visible').first();
            await searchInput.fill('lantern');
            await searchInput.press('Enter');
            // Each scanned page has one lantern. Searching the applied PDF
            // independently confirms recognition finished on all eight pages.
            await expect.poll(() => page.locator('.document-search-result:visible .document-search-result-highlight').allTextContents())
                .toEqual(Array.from({length: 8}, () => 'lantern'));
            if (evidence) await page.screenshot({path: join(evidence, 'searchable.png')});
        } finally {
            await page.context().close();
        }
    }, 180_000);
});
