import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { createPdfjsNodeDocumentOptions } from '@electron/features/search/createPdfjsNodeDocumentOptions';
import {adaptPdfjsDocument} from '@app/services/pdfjs/pdfjsCompatibility';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import {
    callWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const ASSISTANT_BOOKMARK_E2E_TIMEOUT_MS = 90_000;
const ASSISTANT_BOOKMARK_STEP_TIMEOUT_MS = 30_000;
interface IAgentActionResult extends Record<string, unknown> {
    bookmarks?: IPdfBookmarkEntry[];
    canSave?: boolean;
    dirty?: boolean;
    ok?: boolean;
    saved?: boolean;
}

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: 'assistant-bookmarks-persistence',
    timeoutMs: ASSISTANT_BOOKMARK_E2E_TIMEOUT_MS,
});

async function withStepTimeout<T>(label: string, operation: Promise<T>) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ASSISTANT_BOOKMARK_STEP_TIMEOUT_MS}ms`));
        }, ASSISTANT_BOOKMARK_STEP_TIMEOUT_MS);
    });
    try {
        return await Promise.race([
            operation,
            timeout,
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

async function readPdfOutlineTitles(filePath: string) {
    const task = pdfjs.getDocument({
        data: new Uint8Array(readFileSync(filePath)),
        ...createPdfjsNodeDocumentOptions(pdfjs),
    });
    const document = adaptPdfjsDocument(await task.promise, () => task.destroy());
    try {
        const outline = await document.getOutline();
        const titles: string[] = [];
        const stack = [...(outline ?? [])].reverse();
        while (stack.length > 0) {
            const item = stack.pop();
            if (!item) {
                continue;
            }
            titles.push(String(item.title));
            for (let index = (item.items?.length ?? 0) - 1; index >= 0; index -= 1) {
                const child = item.items?.[index];
                if (child) {
                    stack.push(child);
                }
            }
        }
        return titles;
    } finally {
        await document.destroy();
    }
}

describe('assistant bookmark persistence', () => {
    it('applies assistant bookmarks and saves them to the PDF file', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }

        const pdfPath = await createMultiPageTextFixturePdf('assistant-bookmarks-persistence.pdf', 3);
        await openPdfInApp(session.page, pdfPath, ASSISTANT_BOOKMARK_E2E_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, ASSISTANT_BOOKMARK_E2E_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, ASSISTANT_BOOKMARK_E2E_TIMEOUT_MS);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                hasPdf: true,
                minTotalPages: 3,
            },
            {timeoutMs: ASSISTANT_BOOKMARK_E2E_TIMEOUT_MS},
        );

        await expect(withStepTimeout(
            'ui.open_sidebar_tab',
            callWorkspaceCommand<IAgentActionResult>(
                session.page,
                'runAgentAction',
                [
                    'ui.open_sidebar_tab',
                    {tab: 'bookmarks'},
                ],
            ),
        )).resolves.toMatchObject({
            called: true,
            value: {
                ok: true,
                sidebarTab: 'bookmarks',
            },
        });

        const bookmarkPlanInput = {entries: [
            {
                level: 1,
                title: 'Assistant Chapter',
                page: 1,
            },
            {
                level: 2,
                title: 'Assistant Section',
                page: 2,
            },
        ]};
        const applyResult = await withStepTimeout(
            'bookmarks.apply_plan',
            callWorkspaceCommand<IAgentActionResult>(
                session.page,
                'runAgentAction',
                [
                    'bookmarks.apply_plan',
                    bookmarkPlanInput,
                ],
            ),
        );
        expect(applyResult, JSON.stringify(applyResult.value)).toMatchObject({
            called: true,
            value: {
                ok: true,
                dirty: true,
                bookmarks: [expect.objectContaining({
                    title: 'Assistant Chapter',
                    items: [expect.objectContaining({title: 'Assistant Section'})],
                })],
            },
        });

        await withStepTimeout(
            'bookmark DOM update',
            waitForFunctionInPage(session.page, () => {
                return Array.from(document.querySelectorAll<HTMLElement>('.pdf-bookmarks')).some((bookmarkPanel) => {
                    const text = bookmarkPanel.textContent ?? '';
                    return text.includes('Assistant Chapter')
                        && text.includes('Assistant Section')
                        && !text.includes('No bookmarks available');
                });
            }, {timeout: ASSISTANT_BOOKMARK_STEP_TIMEOUT_MS}),
        );

        const saveResult = await withStepTimeout(
            'file.save',
            callWorkspaceCommand<IAgentActionResult>(
                session.page,
                'runAgentAction',
                ['file.save'],
            ),
        );
        expect(saveResult, JSON.stringify(saveResult.value)).toMatchObject({
            called: true,
            value: {
                ok: true,
                canSave: false,
            },
        });

        await expect(withStepTimeout('read saved PDF outline', readPdfOutlineTitles(pdfPath))).resolves.toEqual([
            'Assistant Chapter',
            'Assistant Section',
        ]);
    }, ASSISTANT_BOOKMARK_E2E_TIMEOUT_MS);
});
