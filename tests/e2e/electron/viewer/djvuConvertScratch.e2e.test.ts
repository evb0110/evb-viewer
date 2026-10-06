import {createHash} from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {readPdfAnnotationIndex} from '@tests/e2e/electron/helpers/readPdfAnnotationIndex';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {
    openDjvuInApp,
    waitForActiveDocumentSource,
    waitForDjvuLoaded,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';

// Thousands of sparse pages keep the conversion running long enough to end it midway.
const sourcePath = resolve('tests/fixtures/electron/djvu-fixtures/djvu-open-cancellation-5010-pages.djvu');
// Page 1 is encoded at 72 DPI and page 2 at 300 DPI.
const mixedDpiPath = resolve('tests/fixtures/djvu/sources/mixed-dpi.djvu');

// The scratch lives in the app's temp namespace below the temp root.
function listExportScratch(tempRoot: string) {
    return readdirSync(tempRoot, {
        recursive: true,
        encoding: 'utf8',
    })
        .filter(entry => basename(entry).startsWith('djvu-export-'));
}

// The conversion dialog's source resolution, found by its rendered label.
function readSourceResolution(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] .convert-info-row'))
        .find(row => row.querySelector('.convert-info-label')?.textContent?.trim() === 'Source resolution')
        ?.querySelector('.convert-info-value')?.textContent?.trim() ?? null);
}

async function startConversion(session: IElectronE2ESession, tempRoot: string) {
    await openDjvuInApp(session.page, sourcePath, 120_000);
    await waitForDjvuLoaded(session.page, 120_000);
    await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
    await clickFoundAsUser(session.page, () => Array.from(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
        .find(element => element.textContent?.includes('Convert DjVu to PDF'))
        ?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled), null, {
        description: 'Convert in the DjVu conversion dialog',
        timeoutMs: 60_000,
    });
    // The compact manifest marks a conversion past setup, with native page work running.
    await expect.poll(() => listExportScratch(tempRoot)
        .some(entry => existsSync(join(tempRoot, entry, 'compact-manifest.jsonl'))), {timeout: 120_000}).toBe(true);
}

describe('DjVu conversion scratch', () => {
    // Each test's app gets its own temp root, so one test's leftovers cannot
    // satisfy or fail the next. The fixture boots the first test's session.
    const suiteRoot = join(tmpdir(), `evb-e2e-djvu-scratch-${Date.now()}`);
    const cancelRoot = join(suiteRoot, 'cancel');
    const quitRoot = join(suiteRoot, 'quit');
    const resolutionRoot = join(suiteRoot, 'resolution');
    const longPathRoot = join(suiteRoot, 'long-path');
    const scratchEnv = (tempRoot: string) => ({
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
        EVB_E2E_SAVE_DIALOG_PATH: join(tempRoot, 'converted.pdf'),
        EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
    });
    beforeAll(() => {
        mkdirSync(cancelRoot, {recursive: true});
        mkdirSync(quitRoot, {recursive: true});
        mkdirSync(resolutionRoot, {recursive: true});
        mkdirSync(longPathRoot, {recursive: true});
    });
    const sessions = createElectronE2ESessionFixture({
        sessionName: () => `e2e-djvu-convert-scratch-${Date.now()}`,
        restartBeforeEach: false,
        extraEnv: scratchEnv(cancelRoot),
    });

    // The session's processes write to the temp root until they stop.
    afterAll(async () => {
        await sessions.stop();
        rmSync(suiteRoot, {
            recursive: true,
            force: true,
        });
    });

    it('removes the export scratch when the conversion is canceled', async () => {
        const session = sessions.getSession();
        await startConversion(session, cancelRoot);
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find(candidate => candidate.textContent?.trim() === 'Cancel' && !candidate.disabled), null, {
            description: 'Cancel of the running DjVu conversion',
            timeoutMs: 30_000,
        });
        await expect.poll(() => listExportScratch(cancelRoot), {timeout: 60_000}).toEqual([]);
    }, 300_000);

    it('removes the export scratch when the app quits during the conversion', async () => {
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-convert-scratch-${Date.now()}`,
            extraEnv: scratchEnv(quitRoot),
        });
        await startConversion(session, quitRoot);
        // A graceful quit that keeps the profile's app temp, as an installed app
        // does; a plain session stop wipes it and would hide what the quit left.
        await stopSingleSession(session.name, {preserveWorkspaceCheckpoint: true});
        expect(listExportScratch(quitRoot)).toEqual([]);
    }, 300_000);

    it('shows the first page\'s encoded resolution in the conversion dialog', async () => {
        const sourceHash = () => createHash('sha256').update(readFileSync(mixedDpiPath)).digest('hex');
        const hashBefore = sourceHash();
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-convert-resolution-${Date.now()}`,
            extraEnv: scratchEnv(resolutionRoot),
        });
        await openDjvuInApp(session.page, mixedDpiPath, 120_000);
        await waitForDjvuLoaded(session.page, 120_000);
        await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
        await expect.poll(() => readSourceResolution(session.page), {timeout: 60_000}).toMatch(/\d/u);
        expect(await readSourceResolution(session.page)).toBe('72 DPI');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
            .find(candidate => candidate.textContent?.trim() === 'Cancel'), null, {
            description: 'Cancel of the DjVu conversion dialog',
            timeoutMs: 30_000,
        });
        await expect.poll(() => session.page.evaluate(() => document.querySelector('[role="dialog"] .convert-info-row')), {timeout: 30_000}).toBeNull();
        expect(sourceHash()).toBe(hashBefore);
    }, 300_000);
    // Issue 987: DjVuLibre on Windows cannot read a source path of 260 or more characters.
    it('opens, converts and saves a DjVu whose path is longer than 260 characters', async () => {
        const longSourcePath = join(
            longPathRoot,
            ...Array.from({length: 4}, (_, index) => `long-djvu-source-folder-${index}-${'x'.repeat(40)}`),
            `mixed-dpi-${'y'.repeat(20)}.djvu`,
        );
        expect(longSourcePath.length).toBeGreaterThan(260);
        mkdirSync(join(longSourcePath, '..'), {recursive: true});
        copyFileSync(mixedDpiPath, longSourcePath);
        const sourceHash = () => createHash('sha256').update(readFileSync(longSourcePath)).digest('hex');
        const hashBefore = sourceHash();
        const savePath = join(longPathRoot, 'converted.pdf');
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-convert-long-path-${Date.now()}`,
            extraEnv: {
                ...scratchEnv(longPathRoot),
                EVB_E2E_OPEN_DIALOG_PATH: longSourcePath,
            },
        });
        await session.page.waitForFunction(() => document.querySelector('#evb-startup-overlay') === null, {timeout: 60_000});
        await session.page.waitForSelector('.start-open-panel .open-panel-cta', {visible: true});
        await clickAsUser(session.page, '.start-open-panel .open-panel-cta');
        await waitForActiveDocumentSource(session.page, longSourcePath, 120_000);
        await waitForDjvuLoaded(session.page, 120_000);
        expect((await readToolbarPageIndicator(session.page)).totalPagesText).toContain('2');

        await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
        await expect.poll(() => readSourceResolution(session.page), {timeout: 60_000}).toMatch(/\d/u);
        expect(await readSourceResolution(session.page)).toBe('72 DPI');
        await clickFoundAsUser(session.page, () => Array.from(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
            .find(element => element.textContent?.includes('Convert DjVu to PDF'))
            ?.querySelectorAll<HTMLButtonElement>('button') ?? [])
            .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled), null, {
            description: 'Convert in the DjVu conversion dialog',
            timeoutMs: 60_000,
        });

        // The tab adopts the saved PDF once the conversion finishes.
        await waitForActiveDocumentSource(session.page, savePath, 180_000);
        await waitForPdfLoaded(session.page, 120_000);
        expect((await readToolbarPageIndicator(session.page)).totalPagesText).toContain('2');
        const savedBytes = readFileSync(savePath);
        expect(savedBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect((await readPdfAnnotationIndex(savePath)).pageCount).toBe(2);
        expect(listExportScratch(longPathRoot)).toEqual([]);
        expect(sourceHash()).toBe(hashBefore);
    }, 300_000);
});
