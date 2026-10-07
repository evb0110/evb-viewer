import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
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
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {getDjvuNativeToolPaths} from '@electron/features/djvu/main/nativeToolPaths';
import {buildDjvuRuntimeEnv} from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {readPdfAnnotationIndex} from '@tests/e2e/electron/helpers/readPdfAnnotationIndex';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    openDjvuInApp,
    setTabMemoryPolicyForE2E,
    waitForActiveDocumentSource,
    waitForDjvuLoaded,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activateWorkspaceTab,
    createNewWorkspaceTab,
} from '@tests/e2e/electron/helpers/workspaceTabs';

// Thousands of blank pages keep the conversion running long enough to leave it midway.
const sourcePath = resolve('tests/fixtures/electron/djvu-fixtures/djvu-open-cancellation-5010-pages.djvu');
const SOURCE_PAGE_COUNT = 5010;
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceSha = sha256(sourcePath);

// The export replaces the chosen PDF inside the job's `djvu-export-` scratch,
// so the scratch leaving the app's temp root marks the job's end.
function listExportScratch(tempRoot: string) {
    return readdirSync(tempRoot, {
        recursive: true,
        encoding: 'utf8',
    })
        .filter(entry => basename(entry).startsWith('djvu-export-'));
}

function readActiveTabId(page: Page) {
    return page.$eval('.editor-pane.is-active .tab.is-active[data-tab-id]', tab => (tab as HTMLElement).dataset.tabId ?? '');
}

// Returns once native page work runs and the progress overlay is painted over the DjVu.
async function startConversion(session: IElectronE2ESession, tempRoot: string) {
    await openDjvuInApp(session.page, sourcePath, 120_000);
    await waitForDjvuLoaded(session.page, 120_000);
    expect((await readToolbarPageIndicator(session.page)).totalPagesText).toContain(String(SOURCE_PAGE_COUNT));
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
    await waitForFunctionInPage(session.page, () => Array.from(document.querySelectorAll<HTMLElement>('.app-progress-overlay')).some((overlay) => {
        const rect = overlay.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return rect.height > 0 && hit !== null && overlay.contains(hit);
    }), {timeout: 30_000});
}

describe('DjVu conversion lifecycle', () => {
    // Each test's app gets its own temp root and save path.
    const suiteRoot = join(tmpdir(), `evb-e2e-djvu-lifecycle-${Date.now()}`);
    const switchRoot = join(suiteRoot, 'switch');
    const closeRoot = join(suiteRoot, 'close');
    const conversionEnv = (tempRoot: string) => ({
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
        EVB_E2E_SAVE_DIALOG_PATH: join(tempRoot, 'converted.pdf'),
        EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
    });
    beforeAll(() => {
        mkdirSync(switchRoot, {recursive: true});
        mkdirSync(closeRoot, {recursive: true});
    });
    const sessions = createElectronE2ESessionFixture({
        sessionName: () => `e2e-djvu-lifecycle-switch-${Date.now()}`,
        restartBeforeEach: false,
        extraEnv: conversionEnv(switchRoot),
    });

    afterAll(async () => {
        await sessions.stop();
        rmSync(suiteRoot, {
            recursive: true,
            force: true,
        });
    });

    // Issue 979: a New Tab that makes the converting tab cold must not discard its conversion.
    it('saves the conversion of a tab made cold by New Tab and shows it when the tab returns', async () => {
        const session = sessions.getSession();
        const savePath = join(switchRoot, 'converted.pdf');
        // Warm cap 0: the inactive DjVu tab's viewer unmounts.
        await setTabMemoryPolicyForE2E(session.page, 'aggressive');
        await startConversion(session, switchRoot);
        const djvuTabId = await readActiveTabId(session.page);

        await createNewWorkspaceTab(session);
        const newTabId = await readActiveTabId(session.page);
        expect(newTabId).not.toBe(djvuTabId);
        await waitForFunctionInPage(session.page, (tabId: string) => (
            document.querySelector(`.workspace-host[data-workspace-tab-id="${CSS.escape(tabId)}"]`) === null
        ), {timeout: 30_000}, djvuTabId);

        await expect.poll(() => listExportScratch(switchRoot), {
            timeout: 420_000,
            interval: 1_000,
        }).toEqual([]);
        expect(existsSync(savePath), 'the finished conversion left a PDF at the chosen path').toBe(true);
        const savedBytes = readFileSync(savePath);
        expect(savedBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(savedBytes.subarray(-1024).toString('latin1')).toContain('%%EOF');
        expect((await readPdfAnnotationIndex(savePath)).pageCount).toBe(SOURCE_PAGE_COUNT);
        expect(sha256(sourcePath)).toBe(sourceSha);
        // The cold tab adopts the saved PDF, its title naming it, while the new tab stays selected.
        await waitForFunctionInPage(session.page, (args: {
            tabId: string;
            newTabId: string;
            fileName: string
        }) => {
            const tab = document.querySelector<HTMLElement>(`.tab-list .tab[data-tab-id="${CSS.escape(args.tabId)}"]`);
            const newTab = document.querySelector<HTMLElement>(`.tab-list .tab[data-tab-id="${CSS.escape(args.newTabId)}"]`);
            return tab?.querySelector('.tab-label')?.textContent?.trim() === args.fileName
                && tab.getAttribute('aria-selected') !== 'true'
                && newTab?.getAttribute('aria-selected') === 'true';
        }, {timeout: 30_000}, {
            tabId: djvuTabId,
            newTabId,
            fileName: basename(savePath),
        });
        // Finishing in the background does not take the reader away from the new tab.
        expect(await readActiveTabId(session.page)).toBe(newTabId);

        await activateWorkspaceTab(session, 0);
        expect(await readActiveTabId(session.page)).toBe(djvuTabId);
        await waitForActiveDocumentSource(session.page, savePath, 120_000);
        await waitForPdfLoaded(session.page, 120_000);
        expect((await readToolbarPageIndicator(session.page)).totalPagesText).toContain(String(SOURCE_PAGE_COUNT));
        expect(await session.page.$('.editor-pane.is-active .djvu-banner')).toBeNull();
    }, 600_000);

    // Issue 980: closing the last tab during a conversion ends the conversion with the document.
    it('ends the conversion when its last tab closes to an empty tab', async () => {
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-lifecycle-close-${Date.now()}`,
            extraEnv: conversionEnv(closeRoot),
        });
        await startConversion(session, closeRoot);
        const tabId = await readActiveTabId(session.page);

        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        // The last tab stays in place as an empty New Tab.
        await waitForFunctionInPage(session.page, (id: string) => {
            const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
            return tabs.length === 1
                && tabs[0]!.dataset.tabId === id
                && tabs[0]!.getAttribute('aria-selected') === 'true'
                && tabs[0]!.textContent?.trim() === 'New Tab'
                && document.querySelector('[data-testid="document-page-source-page"], .djvu-banner') === null;
        }, {timeout: 30_000}, tabId);

        // Once the close shows, the closed document's conversion is over.
        expect(listExportScratch(closeRoot), 'native export scratch when the closed tab shows New Tab').toEqual([]);
        expect(await session.page.$('.app-progress-overlay')).toBeNull();
        expect(existsSync(join(closeRoot, 'converted.pdf'))).toBe(false);
        expect(sha256(sourcePath)).toBe(sourceSha);
    }, 600_000);

    it('reports omitted source text on compact success, leaving empty and direct exports quiet', async () => {
        const initialSession = sessions.getSession();
        writeFileSync(resolve('.devkit/sessions', initialSession.name, 'source-text-session.json'), JSON.stringify(getSessionInfo(initialSession.name)));
        const notice = 'Source text was not included. This compact PDF contains page images. Run OCR to add searchable text for search and copy.';
        const directory = join(suiteRoot, 'text-notice');
        mkdirSync(directory, {recursive: true});
        const textSource = join(directory, 'text.djvu');
        const emptySource = join(directory, 'empty.djvu');
        const textFile = join(directory, 'zones.txt');
        const corpusSource = resolve('tests/fixtures/djvu/sources/mixed-dpi.djvu');
        copyFileSync(corpusSource, textSource);
        copyFileSync(corpusSource, emptySource);
        // DjVuLibre writes a real source text layer; the page images are the
        // tracked mixed-DPI corpus. Words, a coarse line and page-only text
        // all mean that a compact export must report the omitted source text.
        writeFileSync(textFile, '(page 0 0 640 480 (line 50 350 570 400 '
            + '(word 50 350 200 400 "Latin") (word 220 350 390 400 "Предисловие") '
            + '(word 410 350 570 400 "ܐܪܡܝܐ")) (line 50 270 570 320 "Ελληνικά 漢字 📖"))');
        const djvused = getDjvuNativeToolPaths().djvused;
        const runDjvused = promisify(execFile);
        await runDjvused(djvused, [
            textSource,
            '-s',
            '-e',
            `select 1; set-txt "${textFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
        ], {env: buildDjvuRuntimeEnv()});
        writeFileSync(textFile, '(page 0 0 512 512 "Page-only source text")');
        await runDjvused(djvused, [
            textSource,
            '-s',
            '-e',
            `select 2; set-txt "${textFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
        ], {env: buildDjvuRuntimeEnv()});
        const {stdout} = await runDjvused(djvused, [
            textSource,
            '-e',
            'print-pure-txt',
        ], {env: buildDjvuRuntimeEnv()});
        expect(stdout).toContain('Предисловие');
        expect(stdout).toContain('Page-only source text');
        const sourceHashes = [
            sha256(textSource),
            sha256(emptySource),
        ];

        for (const kind of [
            'text',
            'empty',
            'direct',
        ] as const) {
            const savePath = join(directory, `${kind}.pdf`);
            const session = await sessions.start({
                clean: true,
                sessionName: () => `e2e-djvu-text-notice-${kind}-${Date.now()}`,
                extraEnv: {
                    ...conversionEnv(directory),
                    EVB_E2E_SAVE_DIALOG_PATH: savePath,
                },
            });
            const artifactRoot = resolve('.devkit/sessions', session.name);
            writeFileSync(join(artifactRoot, 'source-text-session.json'), JSON.stringify(getSessionInfo(session.name)));
            await openDjvuInApp(session.page, kind === 'empty' ? emptySource : textSource, 120_000);
            await waitForDjvuLoaded(session.page, 120_000);
            await session.page.screenshot({path: join(artifactRoot, 'source-text-notice.png')});
            await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
            if (kind === 'direct') {
                await clickAsUser(session.page, '.convert-advanced-toggle');
                await waitForFunctionInPage(session.page, () => {
                    const radio = document.querySelector<HTMLButtonElement>('[role="radio"][value="direct-1"]');
                    return Boolean(radio && !radio.disabled);
                }, {timeout: 30_000});
                await clickAsUser(session.page, '[role="radio"][value="direct-1"]');
                await waitForFunctionInPage(session.page, () => (
                    document.querySelector('[role="radio"][value="direct-1"]')?.getAttribute('aria-checked') === 'true'
                ), {timeout: 5_000});
            }
            await clickFoundAsUser(session.page, () => Array.from(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
                .find(element => element.textContent?.includes('Convert DjVu to PDF'))
                ?.querySelectorAll<HTMLButtonElement>('button') ?? [])
                .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled), null, {
                description: 'Convert to PDF and read the result notice',
                timeoutMs: 60_000,
            });
            await waitForPdfLoaded(session.page, 120_000);
            const visibleNotices = await session.page.$$eval('[role="status"], [role="alert"]', elements => elements
                .map(element => (element as HTMLElement).innerText).join('\n'));
            expect(visibleNotices.includes(notice)).toBe(kind === 'text');
            await session.page.screenshot({path: join(artifactRoot, 'result-text-notice.png')});
            copyFileSync(kind === 'empty' ? emptySource : textSource, join(artifactRoot, 'source.djvu'));
            copyFileSync(savePath, join(artifactRoot, 'saved.pdf'));
            const loadingTask = getDocument({data: new Uint8Array(readFileSync(savePath))});
            try {
                const savedPdf = await loadingTask.promise;
                expect(savedPdf.numPages).toBe(2);
                if (kind !== 'direct') {
                    expect((await (await savedPdf.getPage(1)).getTextContent()).items).toEqual([]);
                    expect((await (await savedPdf.getPage(2)).getTextContent()).items).toEqual([]);
                }
            } finally {
                await loadingTask.destroy();
            }
            expect([
                sha256(textSource),
                sha256(emptySource),
            ]).toEqual(sourceHashes);
        }

        // Corrupt only the compressed text chunk written by DjVuLibre. Page
        // images remain readable, but failed source text is not known empty.
        const sourceBytes = readFileSync(textSource);
        const textChunk = sourceBytes.indexOf('TXTz');
        expect(textChunk).toBeGreaterThan(0);
        const textLength = sourceBytes.readUInt32BE(textChunk + 4);
        expect(textChunk + 8 + textLength).toBeLessThanOrEqual(sourceBytes.length);
        sourceBytes.fill(0, textChunk + 8, textChunk + 8 + textLength);
        writeFileSync(textSource, sourceBytes);
        const boundedSourceSha = sha256(textSource);
        const savePath = join(directory, 'text-read-failure.pdf');
        const previousBytes = '%PDF-1.4\nprevious destination bytes\n';
        writeFileSync(savePath, previousBytes);
        const session = await sessions.start({
            clean: true,
            sessionName: () => `e2e-djvu-text-read-failure-${Date.now()}`,
            extraEnv: {
                ...conversionEnv(directory),
                EVB_E2E_SAVE_DIALOG_PATH: savePath,
            },
        });
        const artifactRoot = resolve('.devkit/sessions', session.name);
        writeFileSync(join(artifactRoot, 'source-text-session.json'), JSON.stringify(getSessionInfo(session.name)));
        await openDjvuInApp(session.page, textSource, 120_000);
        await waitForDjvuLoaded(session.page, 120_000);
        await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
        await clickFoundAsUser(session.page, () => Array.from(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
            .find(element => element.textContent?.includes('Convert DjVu to PDF'))
            ?.querySelectorAll<HTMLButtonElement>('button') ?? [])
            .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled), null, {
            description: 'Convert a source with an unreadable text chunk',
            timeoutMs: 60_000,
        });
        const readNotices = () => session.page.$$eval('[role="status"], [role="alert"]', elements => elements
            .map(element => (element as HTMLElement).innerText).join('\n'));
        await expect.poll(readNotices, {timeout: 30_000}).toContain('Corrupted decoder input');
        expect(await readNotices()).not.toContain(notice);
        expect(readFileSync(savePath, 'utf8')).toBe(previousBytes);
        expect(sha256(textSource)).toBe(boundedSourceSha);
        await session.page.screenshot({path: join(artifactRoot, 'source-text-read-failure.png')});
        copyFileSync(textSource, join(artifactRoot, 'source.djvu'));
        copyFileSync(savePath, join(artifactRoot, 'destination.pdf'));
    });
});
