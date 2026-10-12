import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
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
    ensureSidebarOpen,
    openDocumentSidebarTab,
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
    const suiteRoot = join(realpathSync(tmpdir()), `evb-e2e-djvu-scratch-${Date.now()}`);
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
        await expect.poll(() => readSourceResolution(session.page), {timeout: 60_000}).toBe('72 DPI');
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
        await expect.poll(() => readSourceResolution(session.page), {timeout: 60_000}).toBe('72 DPI');
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
    it('opens, searches, converts and reopens Unicode DjVu names with a Unicode temp root', async () => {
        const unicodeRoot = join(suiteRoot, 'Евгений-ספר-ܟܬܒܐ-كتاب');
        mkdirSync(unicodeRoot, {recursive: true});
        // Add searchable text to the ordinary two-page raster fixture. The
        // generator uses ASCII paths, independent of the filenames under test.
        const textSource = resolve('.devkit/tmp/djvuwin-text.djvu');
        const textPath = resolve('.devkit/tmp/djvuwin-text.txt');
        mkdirSync(join(textSource, '..'), {recursive: true});
        copyFileSync(mixedDpiPath, textSource);
        writeFileSync(textPath, '(page 0 0 256 256 (line 0 0 200 30 (word 0 0 200 30 "djvuwin")))');
        const toolRoot = resolve('resources/djvulibre', `${process.platform}-${process.arch}`);
        execFileSync(join(toolRoot, 'bin', process.platform === 'win32' ? 'djvused.exe' : 'djvused'), [
            textSource,
            '-s',
            '-e',
            `select 1; set-txt "${textPath.replaceAll('\\', '/')}"`,
        ], {
            cwd: join(toolRoot, 'bin'),
            env: {
                ...process.env,
                Path: `${join(toolRoot, 'bin')};${join(toolRoot, 'lib')};${process.env.Path ?? ''}`,
                LD_LIBRARY_PATH: join(toolRoot, 'lib'),
                DYLD_LIBRARY_PATH: join(toolRoot, 'lib'),
            },
            windowsHide: true,
        });
        const names = [
            'Гиргас Словарь',
            'ספר שלום',
            'ܟܬܒܐ ܫܠܡܐ',
            'كتاب عربي',
            'a\u0301 combining',
            'cafe\u0301 NFD',
            'ascii-control',
            'café NFC',
            'space name 100%20 literal',
        ];
        const tempRoot = process.env.DJVU_PROOF_ASCII_TEMP === '1' ? suiteRoot : unicodeRoot;
        const savePath = join(tempRoot, process.env.DJVU_PROOF_ASCII_TEMP === '1' ? 'converted.pdf' : 'converted-ספר.pdf');
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvuwin-${Date.now()}`,
            extraEnv: {
                ...scratchEnv(tempRoot),
                EVB_E2E_SAVE_DIALOG_PATH: savePath,
            },
        });
        const evidenceRoot = resolve('.devkit/djvuwin-r1', process.env.DJVU_PROOF_LABEL ?? process.platform);
        mkdirSync(evidenceRoot, {recursive: true});
        const cdp = await session.page.createCDPSession();
        const results: Array<{
            name: string;
            open: boolean;
            search: boolean;
            convert: boolean;
            recent: boolean;
            error?: string
        }> = [];
        for (const name of names) {
            const inputPath = join(suiteRoot, `${name}.djvu`);
            copyFileSync(textSource, inputPath);
            const hashBefore = createHash('sha256').update(readFileSync(inputPath)).digest('hex');
            const result: (typeof results)[number] = {
                name,
                open: false,
                search: false,
                convert: false,
                recent: false,
            };
            results.push(result);
            try {
                await clickAsUser(session.page, '.tab-new');
                const point = await session.page.evaluate(() => {
                    const bounds = document.querySelector('.editor-pane.is-active .workspace-host[data-workspace-active="true"]')!.getBoundingClientRect();
                    return {
                        x: bounds.x + bounds.width / 2,
                        y: bounds.y + bounds.height / 2,
                    };
                });
                const data = {
                    items: [],
                    files: [inputPath],
                    dragOperationsMask: 1,
                };
                await cdp.send('Input.dispatchDragEvent', {
                    type: 'dragEnter',
                    ...point,
                    data,
                });
                await cdp.send('Input.dispatchDragEvent', {
                    type: 'dragOver',
                    ...point,
                    data,
                });
                await cdp.send('Input.dispatchDragEvent', {
                    type: 'drop',
                    ...point,
                    data,
                });
                await waitForActiveDocumentSource(session.page, inputPath, 60_000);
                await waitForDjvuLoaded(session.page, 60_000);
                expect((await readToolbarPageIndicator(session.page)).totalPagesText).toContain('2');
                result.open = true;
                // Dismiss the view-only hint before using the sidebar tabs.
                await clickAsUser(session.page, '.editor-pane.is-active .djvu-banner-close');
                await ensureSidebarOpen(session.page);
                await openDocumentSidebarTab(session.page, 'Search');
                await clickAsUser(session.page, '.editor-pane.is-active .document-search-bar input', {count: 3});
                await session.page.keyboard.type('djvuwin');
                await session.page.keyboard.press('Enter');
                await session.page.waitForFunction(() => document.querySelector('.editor-pane.is-active .document-search-result')?.textContent?.includes('djvuwin'), {timeout: 30_000});
                result.search = true;
                await session.page.screenshot({path: join(evidenceRoot, `search-${names.indexOf(name)}.png`)});
                await clickAsUser(session.page, '.tab-list .tab.is-active .tab-close');
                await session.page.waitForFunction((fileName: string) => !document.querySelector('.tab.is-active')?.textContent?.includes(fileName), {timeout: 10_000}, `${name}.djvu`);
                await clickAsUser(session.page, '.tab-new');
                await clickFoundAsUser(session.page, (source: string) => Array.from(document.querySelector('.editor-pane.is-active .workspace-host[data-workspace-active="true"]')
                    ?.querySelectorAll<HTMLElement>('.recent-row--data') ?? [])
                    .find(row => row.dataset.recentSource === source)?.querySelector('button.recent-open'), inputPath, {
                    description: 'Reopen the exact Unicode DjVu from Recent',
                    timeoutMs: 30_000,
                });
                await waitForActiveDocumentSource(session.page, inputPath, 60_000);
                await waitForDjvuLoaded(session.page, 60_000);
                expect((await readToolbarPageIndicator(session.page)).totalPagesText).toContain('2');
                result.recent = true;
                rmSync(savePath, {force: true});
                await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
                await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
                    .find(button => button.textContent?.trim() === 'Convert' && !button.disabled), null, {
                    description: 'Convert the Unicode DjVu to PDF',
                    timeoutMs: 60_000,
                });
                await waitForActiveDocumentSource(session.page, savePath, 180_000);
                await waitForPdfLoaded(session.page, 60_000);
                expect((await readPdfAnnotationIndex(savePath)).pageCount).toBe(2);
                expect(readFileSync(savePath).subarray(0, 5).toString('latin1')).toBe('%PDF-');
                copyFileSync(savePath, join(evidenceRoot, `converted-${names.indexOf(name)}.pdf`));
                result.convert = true;
                expect(createHash('sha256').update(readFileSync(inputPath)).digest('hex')).toBe(hashBefore);
                expect(listExportScratch(tempRoot)).toEqual([]);
            } catch (error) {
                result.error = String(error);
                await session.page.screenshot({path: join(evidenceRoot, `failure-${names.indexOf(name)}.png`)}).catch(() => {});
            }
            writeFileSync(join(evidenceRoot, 'matrix.json'), JSON.stringify(results, null, 2));
            console.log(JSON.stringify(result));
        }
        rmSync(textSource, {force: true});
        rmSync(textPath, {force: true});
        expect(results.filter(result => result.error)).toEqual([]);
    }, 1_200_000);

});
