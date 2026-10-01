import {writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {createFixturePath} from '@tests/e2e/electron/helpers/fixtures';
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
const LINES_PER_PAGE = 30;
const WORDS_PER_LINE = 6;
const RESULT_TIMEOUT_MS = 180_000;
const SIDEBAR = '.workspace-host[data-workspace-active="true"] [data-testid="document-sidebar"]';

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-search-concurrency-${Date.now()}`,
    restartBeforeEach: false,
});

/** The word that only a complete index of document `documentNumber` holds. */
function lastWord(documentNumber: number) {
    return `d${documentNumber}p${PAGE_COUNT}l${LINES_PER_PAGE - 1}w0`;
}

/**
 * Many pages of plain text, written directly so the fixture is quick to make;
 * indexing one takes several extraction windows.
 */
async function createDenseTextPdf(documentNumber: number) {
    const objects = new Map<number, Buffer>([[
        3,
        Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'),
    ]]);
    const pageIds: number[] = [];
    let nextId = 4;
    for (let page = 1; page <= PAGE_COUNT; page += 1) {
        const operations = ['BT /F1 10 Tf'];
        for (let line = 0; line < LINES_PER_PAGE; line += 1) {
            const words = Array.from({length: WORDS_PER_LINE}, (_value, word) => `d${documentNumber}p${page}l${line}w${word}`);
            operations.push(`1 0 0 1 36 ${760 - line * 24} Tm (${words.join(' ')}) Tj`);
        }
        operations.push('ET');
        const content = deflateSync(Buffer.from(operations.join('\n')));
        const contentId = nextId;
        const pageId = nextId + 1;
        nextId += 2;
        objects.set(contentId, Buffer.concat([
            Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`),
            content,
            Buffer.from('\nendstream'),
        ]));
        objects.set(pageId, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`));
        pageIds.push(pageId);
    }
    objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
    objects.set(2, Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`));
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
    let offset = parts[0]!.length;
    const offsets: number[] = [];
    for (let id = 1; id < nextId; id += 1) {
        const object = Buffer.concat([
            Buffer.from(`${id} 0 obj\n`),
            objects.get(id)!,
            Buffer.from('\nendobj\n'),
        ]);
        offsets[id] = offset;
        offset += object.length;
        parts.push(object);
    }
    const xref = [`xref\n0 ${nextId}\n0000000000 65535 f \n`];
    for (let id = 1; id < nextId; id += 1) {
        xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    }
    parts.push(Buffer.from(`${xref.join('')}trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
    const path = createFixturePath(`search-concurrency-${documentNumber}.pdf`);
    await writeFile(path, Buffer.concat(parts));
    return path;
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
            await openPdfInApp(page, await createDenseTextPdf(documentNumber), 120_000);
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
        await input!.click();
        await page.keyboard.type(lastWord(DOCUMENT_COUNT));
        await page.keyboard.press('Enter');
        await waitForFunctionInPage(page, (root: string, word: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(`${root} .document-search-result`))
                .some(result => result.textContent?.includes(word))
        ), {timeout: RESULT_TIMEOUT_MS}, SIDEBAR, lastWord(DOCUMENT_COUNT));
    }, 600_000);
});
