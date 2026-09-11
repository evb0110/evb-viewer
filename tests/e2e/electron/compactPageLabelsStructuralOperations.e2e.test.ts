import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import type {TLegacyDocumentRef} from '@contracts/documentRef';
import type {TRequestId} from '@contracts/shared';
import type {IEvbTestApi} from '@app/types/evbTestApi';
import {
    createCompactPageLabelsFixturePdf,
    createMultiPageTextFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';

const PAGE_COUNT = 201;
const TEST_TIMEOUT_MS = 10 * 60 * 1_000;

const initialRanges: IPdfPageLabelRange[] = [
    {
        startPage: 1,
        style: 'r',
        prefix: '',
        startNumber: 1,
    },
    {
        startPage: 41,
        style: 'D',
        prefix: 'Main-',
        startNumber: 1,
    },
    {
        startPage: 101,
        style: 'R',
        prefix: '',
        startNumber: 1,
    },
    {
        startPage: 151,
        style: 'a',
        prefix: 'Appendix-',
        startNumber: 1,
    },
];

function toRoman(value: number) {
    const parts: Array<[number, string]> = [
        [
            1000,
            'M',
        ],
        [
            900,
            'CM',
        ],
        [
            500,
            'D',
        ],
        [
            400,
            'CD',
        ],
        [
            100,
            'C',
        ],
        [
            90,
            'XC',
        ],
        [
            50,
            'L',
        ],
        [
            40,
            'XL',
        ],
        [
            10,
            'X',
        ],
        [
            9,
            'IX',
        ],
        [
            5,
            'V',
        ],
        [
            4,
            'IV',
        ],
        [
            1,
            'I',
        ],
    ];
    let remaining = value;
    let result = '';
    for (const [
        unit,
        symbol,
    ] of parts) {
        while (remaining >= unit) {
            result += symbol;
            remaining -= unit;
        }
    }
    return result;
}

function toAlpha(value: number) {
    if (value < 1) {
        return '';
    }
    const letter = String.fromCharCode(65 + ((value - 1) % 26));
    const repeatCount = Math.floor((value - 1) / 26) + 1;
    return letter.repeat(repeatCount);
}

function labelForPage(page: number, ranges: readonly IPdfPageLabelRange[]) {
    const range = ranges.reduce((current, candidate) => (
        candidate.startPage <= page ? candidate : current
    ));
    const number = range.startNumber + page - range.startPage;
    const value = range.style === 'r'
        ? toRoman(number).toLowerCase()
        : range.style === 'R'
            ? toRoman(number)
            : range.style === 'a'
                ? toAlpha(number).toLowerCase()
                : range.style === 'A'
                    ? toAlpha(number)
                    : String(number);
    return `${range.prefix}${value}`;
}

function labelsFromRanges(totalPages: number, ranges: readonly IPdfPageLabelRange[]) {
    return Array.from({length: totalPages}, (_, index) => labelForPage(index + 1, ranges));
}

async function waitForLabels(session: IElectronE2ESession, expected: readonly string[]) {
    await expect.poll(async () => {
        let state: {
            pageLabels?: string[] | Record<string, string> | null;
            pageLabelRanges?: IPdfPageLabelRange[];
            pageLabelsResolved?: boolean;
        };
        try {
            state = await readWorkspaceStateValues<{
                pageLabels?: string[] | Record<string, string> | null;
                pageLabelRanges?: IPdfPageLabelRange[];
                pageLabelsResolved?: boolean;
            }>(session.page, [
                'pageLabels',
                'pageLabelRanges',
                'pageLabelsResolved',
            ]);
        } catch {
            return null;
        }
        if (state.pageLabelsResolved !== true || state.pageLabels !== null) {
            return null;
        }
        const ranges = state.pageLabelRanges ?? [];
        return labelsFromRanges(expected.length, ranges);
    }, {timeout: 60_000}).toEqual(expected);
}

async function waitForSemanticLabels(session: IElectronE2ESession, expected: readonly string[]) {
    await expect.poll(async () => {
        try {
            const state = await readWorkspaceStateValues<{
                pageLabels?: string[] | Record<string, string> | null;
                pageLabelRanges?: IPdfPageLabelRange[];
                totalPages?: number;
                pageLabelsResolved?: boolean;
            }>(session.page, [
                'pageLabels',
                'pageLabelRanges',
                'totalPages',
                'pageLabelsResolved',
            ]);
            if (state.pageLabelsResolved !== true) {
                return false;
            }
            if (state.pageLabels === null) {
                return labelsFromRanges(expected.length, state.pageLabelRanges ?? []);
            }
            const labels = Array.isArray(state.pageLabels)
                ? state.pageLabels
                : Object.values(state.pageLabels as Record<string, string>);
            return labels.length === expected.length
                && state.totalPages === expected.length
                ? labels
                : false;
        } catch {
            return false;
        }
    }, {timeout: 60_000}).toEqual(expected);
}

async function waitForPageOperation(session: IElectronE2ESession) {
    const readProgress = async () => {
        try {
            return (await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(
                session.page,
                ['isPageOperationInProgress'],
            )).isPageOperationInProgress;
        } catch {
            return undefined;
        }
    };
    await expect.poll(readProgress, {timeout: 20_000}).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10_000));
}

async function waitForPageOperationComplete(session: IElectronE2ESession) {
    await expect.poll(async () => {
        try {
            return (await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(
                session.page,
                ['isPageOperationInProgress'],
            )).isPageOperationInProgress;
        } catch {
            return undefined;
        }
    }, {timeout: 60_000}).toBe(false);
}

async function runCommand<T>(session: IElectronE2ESession, name: string, args: unknown[]) {
    if ([
        'handleSave',
        'handlePageDelete',
        'handlePageReorder',
        'handlePageMove',
    ].includes(name)) {
        const result = await callWorkspaceCommand<T>(session.page, name, args);
        expect(result.called, `${name} should be exposed`).toBe(true);
        if (name === 'handleSave') {
            return result.value;
        }
        await waitForPageOperation(session);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        return result.value;
    }
    const called = await session.page.evaluate((payload: {
        args: unknown[];
        name: string
    }) => {
        const api = (window as Window & {__evbTestApi?: IEvbTestApi}).__evbTestApi;
        if (!api) {
            return false;
        }
        void api.callActiveWorkspaceCommand(payload.name, payload.args).catch(() => undefined);
        return true;
    }, {
        args,
        name,
    });
    expect(called, `${name} should be exposed`).toBe(true);
    if (name !== 'handleSave') {
        await waitForPageOperation(session);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
    }
    return null as T | null;
}

async function insertOnePageThroughGrantedNative(
    session: IElectronE2ESession,
    sourcePath: string,
) {
    const granted = await session.page.evaluate(async path => {
        const grant = (window as IE2EWindow & {__allowRendererFileOpenForAutomation?: (value: TLegacyDocumentRef) => Promise<boolean>;}).__allowRendererFileOpenForAutomation;
        return typeof grant === 'function' && await grant(path as TLegacyDocumentRef);
    }, sourcePath);
    expect(granted, 'insert source path automation grant').toBe(true);

    const afterPage = 200;
    const result = await session.page.evaluate(async ({
        source, after,
    }) => {
        const api = (window as IE2EWindow).electronAPI;
        if (!api) {
            throw new Error('electronAPI is unavailable');
        }
        const state = (window as IE2EWindow).__evbTestApi?.readActiveWorkspaceStateValues(['workingCopyPath']);
        const path = state && typeof state.workingCopyPath === 'string' ? state.workingCopyPath : null;
        if (!path) {
            throw new Error('active working copy path is unavailable');
        }
        const revision = await api.documentFiles.getDocumentRevision(path as TLegacyDocumentRef);
        return api.pageOps.insertFile(path, 200, after, [source], 'compact-label-positive-insert' as TRequestId, {expectedDocumentRevisionToken: revision?.token});
    }, {
        source: sourcePath,
        after: afterPage,
    });
    expect(result.success, 'positive page insertion must complete').toBe(true);
    return afterPage;
}

describe('Electron E2E, compact page labels through structural operations', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('keeps every compact label through mutations, save, and reopen', async () => {
        const pdfPath = await createCompactPageLabelsFixturePdf(
            `compact-page-labels-${Date.now()}.pdf`,
            PAGE_COUNT,
        );
        const insertionSourcePath = await createMultiPageTextFixturePdf(
            `compact-page-labels-insert-${Date.now()}.pdf`,
            1,
        );
        let expected = labelsFromRanges(PAGE_COUNT, initialRanges);
        session = await startElectronE2ESession(`e2e-compact-page-labels-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await waitForLabels(session, expected);

        await runCommand(session, 'handlePageRotate', [
            [1],
            90,
        ]);
        await waitForPageOperationComplete(session);

        await runCommand(session, 'handlePageDelete', [[20]]);
        expected = expected.filter((_, index) => index !== 19);
        await waitForSemanticLabels(session, expected);
        const denseCheckpoint = await readWorkspaceStateValues<{
            pageLabels?: string[] | Record<string, string> | null;
            totalPages?: number;
        }>(session.page, [
            'pageLabels',
            'totalPages',
        ]);
        expect(denseCheckpoint.totalPages).toBe(200);
        expect(denseCheckpoint.pageLabels).not.toBeNull();

        const reorder = Array.from({length: expected.length}, (_, index) => index + 1);
        [
            reorder[29],
            reorder[30],
        ] = [
            reorder[30]!,
            reorder[29]!,
        ];
        expected = reorder.map(page => expected[page - 1]!);
        await runCommand(session, 'handlePageReorder', [reorder]);

        await runCommand(session, 'handleCropPages', [
            [40],
            {
                top: 5,
                bottom: 5,
                left: 5,
                right: 5,
            },
        ]);

        const move = {
            pageCount: expected.length,
            startPage: 50,
            endPage: 50,
            insertAt: 120,
        };
        const moved = expected.splice(move.startPage - 1, 1)[0]!;
        expected.splice(move.insertAt - 1, 0, moved);
        await runCommand(session, 'handlePageMove', [move]);

        const insertionAfterPage = await insertOnePageThroughGrantedNative(session, insertionSourcePath);
        expected.splice(insertionAfterPage, 0, '1');

        await runCommand(session, 'handleSave', []);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-compact-page-labels-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await waitForSemanticLabels(session, expected);
        const finalState = await readWorkspaceStateValues<{
            pageLabels?: string[] | Record<string, string> | null;
            totalPages?: number;
        }>(session.page, [
            'pageLabels',
            'totalPages',
        ]);
        expect(finalState.totalPages).toBe(201);
        expect(finalState.pageLabels).toBeNull();
    }, TEST_TIMEOUT_MS);
});
