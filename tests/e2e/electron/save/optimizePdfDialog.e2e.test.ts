import {execFile} from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
} from 'node:fs';
import {
    basename, join, resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {PDFDocument} from 'pdf-lib';
import {
    afterEach, describe, expect, it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {buildPopplerEnv} from '@electron/native-tools/buildPopplerEnv';
import {readPdfMetadataWithQpdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {
    activateMenuItemAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
const SCAN_FIXTURE = resolve('tests/fixtures/optimize-searchable-ccitt.pdf');
const COLOR_FIXTURE = resolve('landing/recorder/documents/noldeke-1880-raw-scan.pdf');
const TYPESET_PHOTO_FIXTURE = resolve('tests/fixtures/optimize-typeset-photo.pdf');

async function optimizeAsUser(page: Page, preset: string) {
    await activateMenuItemAsUser(page, {id: 'optimize-pdf'});
    await page.waitForSelector('[role="dialog"]', {visible: true});
    await saveWithPresetAsUser(page, preset);
}

async function saveWithPresetAsUser(page: Page, preset: string) {
    await clickFoundAsUser(page, (label: string) => Array.from(document.querySelectorAll<HTMLElement>(
        '[role="dialog"] label, [role="dialog"] [role="radio"]',
    )).find(radio => radio.getAttribute('aria-label') === label || radio.textContent?.trim() === label), preset, {description: `Optimize PDF preset ${preset}`});
    await clickFoundAsUser(page, () => Array.from(document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"] button',
    )).find(button => button.textContent?.trim() === 'Save Optimized Copy' && !button.disabled), null, {description: 'Save Optimized Copy in Optimize PDF'});
    // Either published UI outcome settles the operation, including the wrong
    // success outcome on pre-fix code. A missing notice must not mask a bad save.
    await page.waitForFunction(() => (
        document.querySelector('[data-testid="optimize-pdf-notice"]')?.textContent?.includes('No copy was saved:')
        || Array.from(document.querySelectorAll('.app-toast')).some(toast => (
            toast.textContent?.includes('Optimized PDF saved') || toast.classList.contains('app-toast-failure')
        ))
    ), {timeout: TIMEOUT_MS});
}

function expectDisplayedBytes(label: string, bytes: number) {
    const match = label.match(/([\d.]+)\s*(B|KB|MB|GB|TB)\b/u);
    expect(match, `a readable byte size in ${JSON.stringify(label)}`).not.toBeNull();
    const [
        , value = '',
        unit = '',
    ] = match!;
    const divisor = 1024 ** [
        'B',
        'KB',
        'MB',
        'GB',
        'TB',
    ].indexOf(unit);
    const precision = value.split('.')[1]?.length ?? 0;
    expect(Number(value), `displayed size ${label} must describe the saved bytes`).toBeCloseTo(bytes / divisor, precision);
}

const readStatusSize = (page: Page) => page.$eval('#editor-global-status-host .status-bar-metrics', element => (
    Array.from(element.querySelectorAll('.status-bar-item')).find(item => item.textContent?.trim().startsWith('Size:'))
        ?.textContent?.trim() ?? ''
));

describe('Optimize PDF saves only smaller copies', () => {
    let session: IElectronE2ESession | null = null;
    let scratch: string | null = null;

    afterEach(async (context) => {
        if (context.task.result?.state === 'fail') {
            await session?.captureFailureArtifacts(context.task.name);
        }
        await session?.stop();
        session = null;
        if (scratch && context.task.result?.state !== 'fail') rmSync(scratch, {
            recursive: true,
            force: true,
        });
        else if (scratch) console.log(`[Optimize PDF evidence] ${scratch}`);
        scratch = null;
    });

    async function openFixture(source: string) {
        scratch = mkdtempSync(resolve('.devkit/optimize-dialog-'));
        const inputPath = join(scratch, basename(source));
        const outputPath = join(scratch, 'document-optimized.pdf');
        copyFileSync(source, inputPath);
        session = await startElectronE2ESession(`e2e-optimize-dialog-${Date.now()}`, {
            clean: true,
            extraEnv: {
                EVB_E2E_SAVE_DIALOG_PATH: outputPath,
                EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
            },
        });
        await openPdfInApp(session.page, inputPath, TIMEOUT_MS);
        await waitForViewerInteractive(session.page, TIMEOUT_MS);
        return {
            page: session.page,
            inputPath,
            outputPath,
        };
    }

    // T3: emitted PDF bytes remain usable. I1: a no-op gives defined feedback.
    // A plausible wrong implementation writes its larger raster result and
    // closes the dialog; the output and still-open-notice assertions reject it.
    it('keeps the searchable CCITT original open and explains why no smaller copy was saved', async () => {
        const {
            page, inputPath, outputPath,
        } = await openFixture(SCAN_FIXTURE);
        const original = readFileSync(inputPath);
        const tools = getPdfNativeToolPaths();
        const {stdout: text} = await execFileAsync(tools.pdftotext, [
            inputPath,
            '-',
        ], {env: {
            ...process.env,
            ...buildPopplerEnv(tools),
        }});
        for (const number of [
            1,
            2,
            3,
        ]) expect(text).toContain(`Synthetic searchable scan page ${number}`);
        const initialStatus = await readStatusSize(page);
        expectDisplayedBytes(initialStatus, original.length);
        const initialPage = await readToolbarPageIndicator(page);

        await optimizeAsUser(page, 'Smaller scanned PDF');

        const outputBytes = existsSync(outputPath) ? statSync(outputPath).size : 0;
        console.log(`[Optimize PDF] original=${original.length} output=${outputBytes}`);
        expect(existsSync(outputPath), `No copy may be written when it is not smaller: original=${original.length}, output=${outputBytes} bytes`).toBe(false);
        await page.waitForSelector('[role="dialog"] [data-testid="optimize-pdf-notice"]', {visible: true});
        const notice = await page.$eval('[data-testid="optimize-pdf-notice"]', element => element.textContent?.trim() ?? '');
        expect(notice).toBe('No copy was saved: this PDF is already as compact as this preset can make it.');
        await waitForActiveDocumentSource(page, inputPath);
        expect(await readStatusSize(page)).toBe(initialStatus);
        expect((await readToolbarPageIndicator(page)).totalPagesText).toBe(initialPage.totalPagesText);
        expect((await readToolbarPageIndicator(page)).renderedPage).toBe(initialPage.renderedPage);
        expect(await page.$eval('.editor-pane.is-active .tab.is-active', element => element.textContent)).toContain(basename(inputPath));
        expect(readFileSync(inputPath)).toEqual(original);

        // The dialog stays open for another preset. Black and white re-encodes
        // these pages, and the copy keeps their hidden OCR text.
        await saveWithPresetAsUser(page, 'Black and white scan');
        expect(await page.$eval('.app-toast', element => element.textContent ?? '')).toContain('Optimized PDF saved');
        expect(existsSync(outputPath), 'the Black and white copy is written').toBe(true);
        expect(statSync(outputPath).size).toBeLessThan(original.length);
        const {stdout: optimizedText} = await execFileAsync(tools.pdftotext, [
            outputPath,
            '-',
        ], {env: {
            ...process.env,
            ...buildPopplerEnv(tools),
        }});
        for (const number of [
            1,
            2,
            3,
        ]) expect(optimizedText).toContain(`Synthetic searchable scan page ${number}`);
        await waitForActiveDocumentSource(page, outputPath, TIMEOUT_MS);
        expect(readFileSync(inputPath)).toEqual(original);
    }, TIMEOUT_MS * 2);

    // T3: optimizing photos on typeset pages preserves searchable text and
    // emits a useful smaller copy. Keeping every text page's image unchanged
    // must fail even if a structural rewrite saves a few bytes.
    it('recompresses a typeset page photo with Balanced scanned PDF while preserving its text', async () => {
        const {
            page, inputPath, outputPath,
        } = await openFixture(TYPESET_PHOTO_FIXTURE);
        const original = readFileSync(inputPath);
        const tools = getPdfNativeToolPaths();
        const env = {
            ...process.env,
            ...buildPopplerEnv(tools),
        };
        const {stdout: originalText} = await execFileAsync(tools.pdftotext, [
            inputPath,
            '-',
        ], {env});
        expect(originalText).toContain('A typeset book with a photograph');
        expect(tools.pdfimages, 'the PDF image inspector must run').toBeTruthy();
        const imageDimensions = async (path: string) => {
            const {stdout} = await execFileAsync(tools.pdfimages!, [
                '-list',
                path,
            ], {env});
            return stdout.split('\n').filter(line => /^\s*\d+\s+\d+\s+image\s/u.test(line)).map((line) => {
                const fields = line.trim().split(/\s+/u);
                return [
                    Number(fields[3]),
                    Number(fields[4]),
                ];
            });
        };
        expect(await imageDimensions(inputPath)).toEqual([[
            1200,
            900,
        ]]);

        await optimizeAsUser(page, 'Balanced scanned PDF');

        const notice = await page.$eval('body', element => (
            element.querySelector('[data-testid="optimize-pdf-notice"]')?.textContent?.trim()
            || element.querySelector('.app-toast')?.textContent?.trim()
            || ''
        ));
        console.log(`[Optimize typeset photo] original=${original.length} output=${existsSync(outputPath) ? statSync(outputPath).size : 0}; ${notice}`);
        expect(existsSync(outputPath), `Balanced scanned PDF must save a smaller typeset-photo copy; UI: ${notice}`).toBe(true);
        const optimized = readFileSync(outputPath);
        expect(optimized.length).toBeLessThanOrEqual(original.length * 0.6);
        const {stdout: optimizedText} = await execFileAsync(tools.pdftotext, [
            outputPath,
            '-',
        ], {env});
        expect(optimizedText).toBe(originalText);
        expect(await imageDimensions(outputPath)).toEqual([[
            400,
            300,
        ]]);
        await readPdfMetadataWithQpdf(outputPath);
        const toast = await page.$eval('.app-toast', element => element.textContent ?? '');
        expect(toast).toContain('Optimized PDF saved');
        expect(toast).toMatch(/→.*\(\d+% smaller\)/u);
        const sizes = toast.split('→');
        expect(sizes).toHaveLength(2);
        expectDisplayedBytes(sizes[0]!, original.length);
        expectDisplayedBytes(sizes[1]!, optimized.length);
        await waitForActiveDocumentSource(page, outputPath, TIMEOUT_MS);
        await waitForPdfLoaded(page, TIMEOUT_MS);
        expect(readFileSync(inputPath)).toEqual(original);
    }, TIMEOUT_MS * 2);

    it('saves a smaller four-page 1-bit scan and displays the optimized copy size', async () => {
        const {
            page, inputPath, outputPath,
        } = await openFixture(COLOR_FIXTURE);
        const original = readFileSync(inputPath);
        const initialStatus = await readStatusSize(page);
        expectDisplayedBytes(initialStatus, original.length);

        await optimizeAsUser(page, 'Black and white scan');

        const toast = await page.$eval('.app-toast', element => element.textContent ?? '');
        expect(toast).toContain('Optimized PDF saved');
        expect(toast).toMatch(/→.*\(\d+% smaller\)/u);
        expect(existsSync(outputPath), 'the selected optimized-copy path is written').toBe(true);
        const optimized = readFileSync(outputPath);
        expect(optimized.length).toBeLessThan(original.length);
        expect((await PDFDocument.load(optimized)).getPageCount()).toBe(4);
        await readPdfMetadataWithQpdf(outputPath);
        const tools = getPdfNativeToolPaths();
        expect(tools.pdfimages, 'the PDF image inspector must run').toBeTruthy();
        const {stdout} = await execFileAsync(tools.pdfimages!, [
            '-list',
            outputPath,
        ], {env: {
            ...process.env,
            ...buildPopplerEnv(tools),
        }});
        const images = stdout.split('\n').filter(line => /^\s*\d+\s+\d+\s+image\s/u.test(line)).map(line => line.trim().split(/\s+/u));
        expect(images.map(image => Number(image[0])), 'all four pages retain their scan image').toEqual([
            1,
            2,
            3,
            4,
        ]);
        expect(images.map(image => Number(image[7])), 'every saved page image is 1-bit').toEqual([
            1,
            1,
            1,
            1,
        ]);
        console.log(`[Optimize PDF] original=${original.length} optimized=${optimized.length}; ${stdout}`);
        await waitForActiveDocumentSource(page, outputPath, TIMEOUT_MS);
        await waitForPdfLoaded(page, TIMEOUT_MS);
        await expect.poll(async () => {
            const label = await readStatusSize(page);
            expectDisplayedBytes(label, optimized.length);
            return label;
        }, {timeout: 15_000}).not.toBe(initialStatus);
        expect(await page.$eval('#editor-global-status-host .status-bar-path', element => element.textContent)).toContain(basename(outputPath));
        expect((await readToolbarPageIndicator(page)).totalPagesText).toContain('4');
        expect(readFileSync(inputPath)).toEqual(original);
    }, TIMEOUT_MS * 2);
});
