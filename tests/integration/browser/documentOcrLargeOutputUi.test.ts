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

describe('browser OCR output admission', () => {
    it('applies, repeats and saves OCR when the text layer crosses the former 16 MiB ceiling', async () => {
        const evidence = process.env.EVB_OCR_LARGE_OUTPUT_EVIDENCE_DIR;
        if (evidence) await mkdir(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({
            viewport: {
                width: 1440,
                height: 900,
            },
            ...(evidence ? {recordVideo: {dir: evidence}} : {}),
        });
        try {
            await page.route('**/eng.traineddata', route => route.fulfill({path: join(process.cwd(), 'resources/tesseract/tessdata/eng.traineddata')}));
            const fixture = await PDFDocument.load(await readFile(join(
                process.cwd(), 'tests/fixtures/release/packaged-core-ocr-smoke.pdf',
            )));
            const formerCeiling = 16 * 1024 * 1024;
            const originalLength = (await fixture.save({useObjectStreams: false})).byteLength;
            // A valid unused stream places the scan just above the old ceiling;
            // the real OCR and undo baseline must both accept it, without a long book run.
            fixture.catalog.set(fixture.context.obj('AdmissionFixture'), fixture.context.register(
                fixture.context.stream(new Uint8Array(formerCeiling - originalLength + 2048)),
            ));
            const original = Buffer.from(await fixture.save({useObjectStreams: false}));
            expect(original.byteLength).toBeGreaterThan(formerCeiling);
            expect(original.byteLength).toBeLessThan(formerCeiling + 4096);
            await openPdfFromChooser(page, {
                name: 'ocr-output-admission.pdf',
                mimeType: 'application/pdf',
                buffer: original,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            for (const repeat of [
                false,
                true,
            ]) {
                await page.getByRole('button', {
                    name: 'OCR',
                    exact: true,
                }).click();
                const dialog = page.getByRole('dialog');
                if (repeat) await dialog.getByText('Recognize scanned text again', {exact: true}).click();
                await dialog.getByRole('button', {name: /^(Download and start OCR|Start OCR)$/u}).click();
                await page.waitForFunction(() => {
                    const dialog = document.querySelector('[role="dialog"]');
                    return dialog?.querySelector('[role="alert"]')
                        || dialog?.textContent?.includes('OCR complete - PDF is now searchable');
                }, undefined, {timeout: 90_000});
                const terminal = await dialog.innerText();
                if (evidence) {
                    await page.screenshot({path: join(evidence, repeat ? 'repeat.png' : 'first.png')});
                    await writeFile(join(evidence, repeat ? 'repeat.txt' : 'first.txt'), terminal);
                }
                expect(terminal).toContain('OCR complete - PDF is now searchable');
                await dialog.getByRole('button', {
                    name: 'Close',
                    exact: true,
                }).last().click();
                await expect.poll(async () => (await page.locator('.textLayer').allTextContents()).join(' '))
                    .toContain('lantern');
            }
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const path = await (await download).path();
            if (!path) throw new Error('Save did not provide downloaded PDF bytes');
            const saved = await readFile(path);
            expect(saved.byteLength).toBeGreaterThan(formerCeiling);
            expect(saved.subarray(0, original.byteLength).equals(original)).toBe(true);
            expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
        } finally {
            await page.context().close();
        }
    }, 240_000);
});
