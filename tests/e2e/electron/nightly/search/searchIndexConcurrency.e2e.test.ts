import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    createDenseTextFixturePdf,
    createNonEmbeddedCjkSearchFixturePdf,
    NON_EMBEDDED_CJK_SEARCH_FIXTURE_QUERY,
    DENSE_TEXT_FIXTURE_LINES_PER_PAGE,
} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    ensureSidebarOpen,
    openDocumentSidebarTab,
    openPdfInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    createNewWorkspaceTab, activateWorkspaceTab,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    readFile, writeFile,
} from 'node:fs/promises';
import {
    dirname, join, resolve,
} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {requireRequestId} from '@contracts/shared';
import type {IPdfSearchProgress} from '@contracts/search';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {
    APP_LOG_FILE_NAME, type ILogRecord,
} from '@contracts/logRecord';

interface IFallbackSearchWindow extends Window {__e2eFallbackProgress?: (progress: IPdfSearchProgress) => Promise<void>;}

// More documents than native commands may run at once (eight), each long
// enough to need several pdftotext windows.
const DOCUMENT_COUNT = 10;
const PAGE_COUNT = 1500;
const RESULT_TIMEOUT_MS = 180_000;
const SIDEBAR = '.workspace-host[data-workspace-active="true"] [data-testid="document-sidebar"]';

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-search-concurrency-${Date.now()}`,
    restartBeforeEach: false,
});

/** The word that only a complete index of document `documentNumber` holds. */
function lastWord(documentNumber: number) {
    return `d${documentNumber}p${PAGE_COUNT}l${DENSE_TEXT_FIXTURE_LINES_PER_PAGE - 1}w0`;
}

describe('Electron E2E - concurrent search indexes', () => {
    // #928 F2: more documents index at once than native commands may run.
    it('indexes more documents at once than native commands run, and finds their last pages', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const documentNumbers = Array.from({length: DOCUMENT_COUNT}, (_value, index) => index + 1);
        const workingCopies: string[] = [];
        for (const documentNumber of documentNumbers) {
            if (documentNumber > 1) {
                await createNewWorkspaceTab(session);
            }
            await openPdfInApp(page, createDenseTextFixturePdf(
                `search-concurrency-${documentNumber}.pdf`,
                PAGE_COUNT,
                (pageNumber, line, word) => `d${documentNumber}p${pageNumber}l${line}w${word}`,
            ), 120_000);
            workingCopies.push(await getActiveWorkspaceWorkingCopyPath(page));
        }

        // Each document warms its index the way it does after its OCR applies.
        const warmups = await page.evaluate(async (paths: string[]) => {
            const search = window.electronAPI?.search;
            if (!search) {
                throw new Error('search capability unavailable in the renderer');
            }
            const settled = await Promise.allSettled(paths.map(path => search.warmIndex(path)));
            return settled.map(outcome => (outcome.status === 'fulfilled'
                ? String(outcome.value)
                : String(outcome.reason)));
        }, workingCopies);
        expect(warmups).toEqual(documentNumbers.map(() => 'true'));

        // The last document answers a typed search for the word on its last page.
        await ensureSidebarOpen(page);
        await openDocumentSidebarTab(page, 'Search');
        const input = await page.waitForSelector(`${SIDEBAR} .document-search-bar input`, {visible: true});
        await clickAsUser(page, input!);
        await page.keyboard.type(lastWord(DOCUMENT_COUNT));
        await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, (root: string, word: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(`${root} .document-search-result`))
                .some(result => result.textContent?.includes(word))
        ), {timeout: RESULT_TIMEOUT_MS}, SIDEBAR, lastWord(DOCUMENT_COUNT));
    }, 600_000);

    it('bounds CJK and RTL fallback workers while real searches compete and a queued tab closes', async () => {
        const session = await sessionFixture.restart({
            hard: true,
            clean: true,
            extraEnv: {
                EVB_TEST_PERFORMANCE_MODE: 'low',
                ELECTRON_FILE_LOG_LEVEL: 'debug',
            },
        });
        const {page} = session;
        const profile = await page.evaluate(() => window.electronAPI!.host.getResourceProfile());
        expect(profile?.performanceMode).toBe('low');
        // Low mode admits two one-CPU PDF.js consumers; each also costs 256 MiB.
        const admitted = Math.min(2, Math.floor(Math.max(512 * 1024 ** 2, profile!.totalRamBytes * .85) / (256 * 1024 ** 2)));
        const count = admitted + 10;
        const cjkPath = await createNonEmbeddedCjkSearchFixturePdf('fallback-concurrency-cjk.pdf');
        const cjk = await PDFDocument.load(await readFile(cjkPath));
        const rtl = await PDFDocument.load(await readFile(resolve('tests/fixtures/electron/semtext/search.pdf')));
        const paths: string[] = [];
        const pageCounts: number[] = [];
        for (let i = 0; i < count; i++) {
            const document = await PDFDocument.create();
            const template = i % 2 === 0 ? cjk : rtl;
            for (let batch = 0; batch < 256; batch++) {
                for (const copied of await document.copyPages(template, template.getPageIndices())) document.addPage(copied);
            }
            document.getPages().at(-1)!.drawText(`fallbackfinaldoc${i}`, {
                x: 72,
                y: 100,
            });
            const path = join(dirname(cjkPath), `fallback-concurrency-${i}.pdf`);
            await writeFile(path, await document.save());
            pageCounts.push(document.getPageCount());
            if (i > 0) await createNewWorkspaceTab(session);
            await openPdfInApp(page, path, 120_000);
            paths.push(await getActiveWorkspaceWorkingCopyPath(page));
        }
        const logPath = join(electronFileLogDir(session.name), APP_LOG_FILE_NAME);
        const logOffset = (await readFile(logPath, 'utf8')).length;
        // Low mode unmounts cold workspaces, including their UI search state.
        // Own these real IPC search results in the test so every query stays
        // observable while its tab is cold. Closing still uses trusted input.
        const requests = paths.map((pdfPath, index) => ({
            pdfPath,
            query: `fallbackfinaldoc${index}`,
            requestId: requireRequestId(`fallback-concurrency-${index}`),
            pageCount: pageCounts[index]!,
        }));
        const queuedRequest = requests.at(-1)!;
        const progress = new Map<string, IPdfSearchProgress>();
        await page.exposeFunction('__e2eFallbackProgress', (next: IPdfSearchProgress) => {
            progress.set(next.requestId, next);
        });
        const searches = page.evaluate(async (batch: typeof requests) => {
            const search = window.electronAPI!.search;
            const unsubscribe = search.onProgress(next => {
                void (window as IFallbackSearchWindow).__e2eFallbackProgress!(next);
            });
            try {
                return await Promise.all(batch.map(request => search.run(request.pdfPath, request.query, {
                    requestId: request.requestId,
                    pageCount: request.pageCount,
                })));
            } finally {
                unsubscribe();
            }
        }, requests);
        // Observe extraction starting, rather than closing a debounced query
        // that has never reached main. More requests compete than can run.
        await expect.poll(() => progress.get(queuedRequest.requestId)?.processed ?? 0, {timeout: RESULT_TIMEOUT_MS}).toBeGreaterThan(0);
        await clickAsUser(page, '.tab.is-active .tab-close');
        const responses = await searches;
        await page.removeExposedFunction('__e2eFallbackProgress');
        expect(responses).toHaveLength(count);
        expect(responses.at(-1)).toMatchObject({
            canceled: true,
            results: [],
        });
        for (const [
            index,
            response,
        ] of responses.slice(0, -1).entries()) {
            expect(response.canceled).not.toBe(true);
            expect(response.truncated).toBe(false);
            expect(response.coverage).toMatchObject({
                pageCount: pageCounts[index],
                pagesScanned: pageCounts[index],
                truncated: false,
            });
            expect(response.results.some(result => result.pageNumber === pageCounts[index]
                && result.excerpt.match === `fallbackfinaldoc${index}`)).toBe(true);
        }
        await activateWorkspaceTab(session, 0);
        await ensureSidebarOpen(page);
        await openDocumentSidebarTab(page, 'Search');
        const input = await page.waitForSelector(`${SIDEBAR} .document-search-bar input`, {visible: true});
        await clickAsUser(page, input!);
        await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
        await page.keyboard.press('A'); await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
        await page.keyboard.type(NON_EMBEDDED_CJK_SEARCH_FIXTURE_QUERY); await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, (root: string, word: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(`${root} .document-search-result`)).some(result => result.textContent?.includes(word))
        ), {timeout: RESULT_TIMEOUT_MS}, SIDEBAR, NON_EMBEDDED_CJK_SEARCH_FIXTURE_QUERY);
        // Existing structured worker records provide lifetime evidence, with no new polling lane.
        const records = (await readFile(logPath, 'utf8')).slice(logOffset).split('\n').filter(Boolean).map(line => JSON.parse(line) as ILogRecord)
            .filter(record => record.data?.workerName === 'pdf-text-worker.js');
        let active = 0; let peak = 0; let started = 0;
        for (const record of records) {
            if (record.msg === 'Worker online') { active++; started++; peak = Math.max(peak, active); }
            if (record.msg === 'Worker completed') active--;
        }
        expect(started).toBeGreaterThan(admitted);
        expect(peak).toBeLessThanOrEqual(admitted);
        expect(active).toBe(0);
        // A queued close constructs no worker. An active cancellation lacks a
        // completion log and cannot establish this queued-cancellation scenario.
        expect(records.some(record => record.msg === 'Worker cancellation requested')).toBe(false);
        expect(records.some(record => record.level === 'error')).toBe(false);
    }, 600_000);

});
