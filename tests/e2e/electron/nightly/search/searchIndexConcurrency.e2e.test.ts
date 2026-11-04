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
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {
    APP_LOG_FILE_NAME, type ILogRecord,
} from '@contracts/logRecord';

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
            await writeFile(path, await document.save()); paths.push(path);
            if (i > 0) await createNewWorkspaceTab(session);
            await openPdfInApp(page, path, 120_000);
        }
        const logPath = join(electronFileLogDir(session.name), APP_LOG_FILE_NAME);
        const logOffset = (await readFile(logPath, 'utf8')).length;
        // Start, then switch away before waiting for a result; all searches use trusted input.
        for (let i = 0; i < count; i++) {
            await activateWorkspaceTab(session, i);
            await ensureSidebarOpen(page); await openDocumentSidebarTab(page, 'Search');
            const input = await page.waitForSelector(`${SIDEBAR} .document-search-bar input`, {visible: true});
            await clickAsUser(page, input!); await page.keyboard.type(`fallbackfinaldoc${i}`); await page.keyboard.press('Enter');
        }
        // The last request competes with more documents than the available fallback vector.
        await clickAsUser(page, '.tab.is-active .tab-close');
        for (let i = 0; i < count - 1; i++) {
            await activateWorkspaceTab(session, i);
            await waitForFunctionInPage(page, (root: string, word: string) => (
                Array.from(document.querySelectorAll<HTMLElement>(`${root} .document-search-result`)).some(result => result.textContent?.includes(word))
            ), {timeout: RESULT_TIMEOUT_MS}, SIDEBAR, `fallbackfinaldoc${i}`);
        }
        await activateWorkspaceTab(session, 0);
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
