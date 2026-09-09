import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    openScanCleanupGeneratedPdf,
    recoverScanCleanupWorkspaceForDocument,
    resolveScanCleanupEntryViewState,
} from '@app/modules/workspace-shell/composables/useScanCleanupRunCoordinator';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';

const capabilities = vi.hoisted(() => ({
    cancelOpenDocumentDirectBatch: vi.fn(async (_requestId: string) => true) as
        | ((requestId: string) => Promise<boolean>)
        | undefined,
    cleanupFile: vi.fn(async (_path: string) => undefined),
    openDocumentDirect: vi.fn(async (_path: string) => null as TOpenFileResult | null),
    openDocumentDirectBatch: vi.fn(async (
        _paths: string[],
        _requestId?: string,
    ) => null as TOpenFileResult | null),
}));

vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentOpenCapability: () => ({
        openDocumentDirect: capabilities.openDocumentDirect,
        openDocumentDirectBatch: capabilities.openDocumentDirectBatch,
        cancelOpenDocumentDirectBatch: capabilities.cancelOpenDocumentDirectBatch,
    }),
    getDocumentWorkingCopyCapability: () => ({cleanupFile: capabilities.cleanupFile}),
}));

const generatedResult: TOpenFileResult = {
    kind: 'pdf',
    workingPath: requireDocumentRef('/tmp/pdf-work-1/book — cleaned.pdf'),
    originalPath: requireDocumentRef('/managed/book — cleaned.pdf'),
    isGenerated: true,
};

describe('openScanCleanupGeneratedPdf', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        capabilities.cancelOpenDocumentDirectBatch = vi.fn(async (_requestId: string) => true);
    });

    it('opens the generated output through the cancellable batch request and claims its result', async () => {
        capabilities.openDocumentDirectBatch.mockResolvedValueOnce(generatedResult);
        const handleOpenInNewTab = vi.fn(async () => true);

        await expect(openScanCleanupGeneratedPdf(
            '/managed/book — cleaned.pdf',
            new AbortController().signal,
            handleOpenInNewTab,
        )).resolves.toBe(true);

        expect(capabilities.openDocumentDirect).not.toHaveBeenCalled();
        const [
            paths,
            requestId,
        ] = capabilities.openDocumentDirectBatch.mock.calls[0]!;
        expect(paths).toEqual(['/managed/book — cleaned.pdf']);
        expect(requestId).toMatch(/^scan-cleanup-open-\S+$/u);
        expect(requestId!.length).toBeLessThanOrEqual(128);
        // The workspace claims the main-process result, not the path: that
        // result is the working copy's ownership handoff.
        expect(handleOpenInNewTab).toHaveBeenCalledWith(generatedResult);
        expect(capabilities.cleanupFile).not.toHaveBeenCalled();
    });

    it('cancels the in-flight request and never claims a tab once the handoff is abandoned', async () => {
        const open = Promise.withResolvers<TOpenFileResult | null>();
        capabilities.openDocumentDirectBatch.mockReturnValueOnce(open.promise);
        const handleOpenInNewTab = vi.fn(async () => true);
        const controller = new AbortController();

        const opening = openScanCleanupGeneratedPdf(
            '/managed/book — cleaned.pdf',
            controller.signal,
            handleOpenInNewTab,
        );
        const requestId = capabilities.openDocumentDirectBatch.mock.calls[0]![1];
        controller.abort(new Error('handoff deadline'));

        await expect(opening).resolves.toBe(false);
        expect(capabilities.cancelOpenDocumentDirectBatch).toHaveBeenCalledWith(requestId);
        expect(handleOpenInNewTab).not.toHaveBeenCalled();

        // The main process could not interrupt the copy in time, so the working
        // copy it hands back has no owner. Only that copy is released; the
        // generated output the run produced stays on disk.
        open.resolve(generatedResult);
        await vi.waitFor(() => expect(capabilities.cleanupFile)
            .toHaveBeenCalledWith('/tmp/pdf-work-1/book — cleaned.pdf'));
        expect(capabilities.cleanupFile).toHaveBeenCalledOnce();
        expect(handleOpenInNewTab).not.toHaveBeenCalled();
    });

    it('abandons the handoff locally when the platform cannot cancel the request', async () => {
        capabilities.cancelOpenDocumentDirectBatch = undefined;
        const open = Promise.withResolvers<TOpenFileResult | null>();
        capabilities.openDocumentDirectBatch.mockReturnValueOnce(open.promise);
        const handleOpenInNewTab = vi.fn(async () => true);
        const controller = new AbortController();

        const opening = openScanCleanupGeneratedPdf(
            '/managed/book — cleaned.pdf',
            controller.signal,
            handleOpenInNewTab,
        );
        controller.abort(new Error('handoff deadline'));

        await expect(opening).resolves.toBe(false);
        expect(handleOpenInNewTab).not.toHaveBeenCalled();

        // A late rejection from the uninterruptible request is consumed rather
        // than left to surface as an unhandled rejection: nobody is waiting for
        // this answer any more, and an escaping rejection would fail whichever
        // test happens to be running when the process notices it.
        const unhandledRejection = vi.fn();
        process.once('unhandledRejection', unhandledRejection);
        try {
            open.reject(new Error('open failed after abandonment'));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
            process.removeListener('unhandledRejection', unhandledRejection);
        }
        // A request that failed produced no working copy, so there is nothing
        // to release, and the abandoned handoff still claims no tab.
        expect(capabilities.cleanupFile).not.toHaveBeenCalled();
        expect(handleOpenInNewTab).not.toHaveBeenCalled();
    });

    it('never issues a request for an already-abandoned handoff', async () => {
        const controller = new AbortController();
        controller.abort(new Error('handoff deadline'));

        await expect(openScanCleanupGeneratedPdf(
            '/managed/book — cleaned.pdf',
            controller.signal,
            vi.fn(async () => true),
        )).resolves.toBe(false);

        expect(capabilities.openDocumentDirectBatch).not.toHaveBeenCalled();
    });

    it('reports an open failure to the coordinator instead of swallowing it', async () => {
        capabilities.openDocumentDirectBatch.mockRejectedValueOnce(new Error('Invalid or non-existent file'));

        await expect(openScanCleanupGeneratedPdf(
            '/managed/missing.pdf',
            new AbortController().signal,
            vi.fn(async () => true),
        )).rejects.toThrow('Invalid or non-existent file');
    });

    it('treats a non-PDF answer as a failed handoff', async () => {
        capabilities.openDocumentDirectBatch.mockResolvedValueOnce(null);
        const handleOpenInNewTab = vi.fn(async () => true);

        await expect(openScanCleanupGeneratedPdf(
            '/managed/book — cleaned.pdf',
            new AbortController().signal,
            handleOpenInNewTab,
        )).resolves.toBe(false);

        expect(handleOpenInNewTab).not.toHaveBeenCalled();
    });
});

function viewState(overrides: Partial<ITabViewSessionState> = {}): ITabViewSessionState {
    return {
        continuousScroll: true,
        effectiveZoom: 1,
        fitMode: 'width',
        showSidebar: false,
        surfaceMode: 'reader',
        viewMode: 'single',
        zoom: 1,
        zoomMode: 'custom',
        ...overrides,
    };
}

describe('resolveScanCleanupEntryViewState', () => {
    it('drops stale cleanup selection when entering from the reader', () => {
        expect(resolveScanCleanupEntryViewState(viewState({
            currentPage: 4,
            scanCleanup: {
                previewPage: 17,
                previewViewMode: 'cleaned',
            },
            surfaceMode: 'reader',
        }))).toEqual({
            continuousScroll: true,
            currentPage: 4,
            effectiveZoom: 1,
            fitMode: 'width',
            showSidebar: false,
            surfaceMode: 'scan-cleanup',
            viewMode: 'single',
            zoom: 1,
            zoomMode: 'custom',
        });
    });

    it('preserves the live cleanup session when merely activating its tab', () => {
        const state = viewState({
            currentPage: 4,
            scanCleanup: {
                previewPage: 17,
                previewViewMode: 'cleaned',
            },
            surfaceMode: 'scan-cleanup',
        });

        expect(resolveScanCleanupEntryViewState(state)).toBe(state);
    });

    it('recovers a hidden owner by preserving its cleanup state and activating its tab', async () => {
        const cleanupViewState = viewState({
            currentPage: 4,
            scanCleanup: {
                ownerId: 'stable-hidden-owner',
                previewPage: 17,
                previewViewMode: 'cleaned',
            },
            surfaceMode: 'scan-cleanup',
        });
        const applyViewState = vi.fn();
        const activateTab = vi.fn();
        const session = {
            applyViewState,
            snapshot: {value: {
                identity: {
                    documentRef: '/managed/book.pdf',
                    originalPath: '/source/book.pdf',
                    workingCopyPath: '/managed/book.pdf',
                },
                viewState: cleanupViewState,
            }},
        };

        await expect(recoverScanCleanupWorkspaceForDocument(
            '/source/book.pdf',
            {'hidden-tab': session as never},
            activateTab,
        )).resolves.toBe(true);

        expect(applyViewState).toHaveBeenCalledWith(cleanupViewState);
        expect(activateTab).toHaveBeenCalledWith('hidden-tab');
    });

    it('reports an owner as unrecoverable when its document session is gone', async () => {
        await expect(recoverScanCleanupWorkspaceForDocument(
            '/source/closed.pdf',
            {},
            vi.fn(),
        )).resolves.toBe(false);
    });
});
