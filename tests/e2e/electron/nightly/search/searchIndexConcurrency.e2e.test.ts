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
    DENSE_TEXT_FIXTURE_LINES_PER_PAGE,
} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    ensureSidebarOpen,
    openDocumentSidebarTab,
    openPdfInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import {createNewWorkspaceTab} from '@tests/e2e/electron/helpers/workspaceTabs';

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
});
