import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';
import type * as TViMockOriginalModule2 from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { effectScope } from 'vue';
import { retry } from 'es-toolkit/function';
import { withTimeout } from 'es-toolkit/promise';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import {requireDocumentRef} from '@contracts/documentRef';
import type {IDocxExportFileCapability} from '@contracts/docxExport';
import {requireSessionId} from '@contracts/shared';

const loadDocumentTextCatalogPagesMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
const extractPdfTextMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const createDocxFromTextMock = vi.hoisted(() => vi.fn(() => new Uint8Array([
    7,
    8,
    9,
])));
const createDocxFromTextChunksMock = vi.hoisted(() => vi.fn(() => (async function* () {
    yield new Uint8Array([
        7,
        8,
        9,
    ]);
})()));
const toastAddMock = vi.hoisted(() => vi.fn());
const loggerDebugMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
const loggerInfoMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());
const mockOcr = {
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    createSearchablePdf: vi.fn(),
    cancel: vi.fn(),
    getLanguages: vi.fn(),
    acknowledgeResultFile: vi.fn(),
};
const mockDocuments = {
    saveDocxAs: vi.fn(),
    writeDocxFile: vi.fn(),
    beginDocxFileStream: vi.fn<IDocxExportFileCapability['beginDocxFileStream']>(async () => ({sessionId: requireSessionId('docx-session')})),
    writeDocxFileStreamChunk: vi.fn<IDocxExportFileCapability['writeDocxFileStreamChunk']>(async () => true),
    commitDocxFileStream: vi.fn<IDocxExportFileCapability['commitDocxFileStream']>(async () => true),
    cancelDocxFileStream: vi.fn<IDocxExportFileCapability['cancelDocxFileStream']>(async () => true),
    cleanupFile: vi.fn(),
    cleanupOcrTemp: vi.fn(),
    getDocumentRevision: vi.fn(),
};
const mockElectronAPI = createElectronPlatformApiFixture({
    ocr: mockOcr,
    documentFiles: mockDocuments,
    documentWorkingCopy: mockDocuments,
});
const WORKING_COPY_PATH = requireDocumentRef('/tmp/work.pdf');

vi.mock('@app/utils/getOcrCapability', () => ({ getOcrCapability: () => mockElectronAPI.ocr }));
vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/utils/platformDocuments', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    getDocumentFilesCapability: () => mockElectronAPI.documentFiles,
    getDocumentWorkingCopyCapability: () => mockElectronAPI.documentWorkingCopy,
}));
vi.mock('@app/utils/ocr/loadOcrText', () => ({loadDocumentTextCatalogPages: loadDocumentTextCatalogPagesMock}));
vi.mock('@app/utils/ocr/extractPdfText', () => ({ extractPdfText: extractPdfTextMock }));
vi.mock('@app/utils/docx', () => ({createDocxFromTextAsync: createDocxFromTextMock}));
vi.mock('@app/utils/docxStreaming', () => ({createDocxFromTextChunks: createDocxFromTextChunksMock}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    debug: loggerDebugMock,
    error: loggerErrorMock,
    info: loggerInfoMock,
    warn: loggerWarnMock,
}}));
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
});

const { useOcr } = await import('@app/composables/useOcr');

async function waitForCondition(
    condition: () => boolean,
    timeoutMs = 500,
) {
    const intervalMs = 5;
    try {
        await retry(async () => {
            if (!condition()) {
                throw new Error('Condition not met');
            }
        }, {
            retries: Math.max(0, Math.ceil(timeoutMs / intervalMs) - 1),
            delay: intervalMs,
        });
    } catch {
        throw new Error('Timed out waiting for condition');
    }
}

describe('useOcr', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.clearAllMocks();
        mockOcr.onProgress.mockReturnValue(vi.fn());
        mockOcr.onComplete.mockReturnValue(vi.fn());
        mockOcr.createSearchablePdf.mockResolvedValue({
            started: true,
            jobId: 'job-1',
        });
        mockOcr.cancel.mockResolvedValue({ canceled: true });
        mockOcr.getLanguages.mockResolvedValue([]);
        mockDocuments.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/work.pdf',
            authority: 'electron-working-copy',
            contentRevision: 1,
            mintedAt: 1,
            token: 'revision-token',
        });
    });

    it('does not publish languages after its scope is disposed during IPC', async () => {
        const languages = Promise.withResolvers<Array<{
            code: string;
            script: 'latin';
        }>>();
        mockOcr.getLanguages.mockReturnValueOnce(languages.promise);
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        const load = ocr.loadLanguages();
        scope.stop();
        languages.resolve([{
            code: 'eng',
            script: 'latin',
        }]);
        await load;

        expect(ocr.availableLanguages.value).toEqual([]);
        expect(ocr.error.value).toBeNull();
    });

    it('settles runOcr when canceled before completion', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            sourceDocumentRevisionToken?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const progressUnsubscribe = vi.fn();
        const completeUnsubscribe = vi.fn();
        mockOcr.onProgress.mockReturnValue(progressUnsubscribe);
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return completeUnsubscribe;
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            void ocr.cancelOcr();

            const settled = await withTimeout(
                () => runPromise.then(() => 'resolved' as const),
                100,
            ).catch((error: unknown) => {
                if (error instanceof Error && error.name === 'TimeoutError') {
                    return 'timeout' as const;
                }
                throw error;
            });

            expect(settled).toBe('resolved');
            expect(mockOcr.cancel).toHaveBeenCalledTimes(1);
            expect(progressUnsubscribe).toHaveBeenCalledTimes(1);
            expect(completeUnsubscribe).not.toHaveBeenCalled();
            expect(ocr.progress.value.isRunning).toBe(true);
            expect(ocr.progress.value.status).toBe('cancel-requested');
            expect(ocr.error.value).toBeNull();

            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: false,
                errors: ['OCR canceled'],
            });
            expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
        } finally {
            scope.stop();
        }
    });

    it('keeps ownership and reports an unconfirmed manual cancellation', async () => {
        vi.useFakeTimers();
        let completeHandler: ((result: {
            requestId: string;
            success: boolean;
            errors: string[];
        }) => void) | null = null;
        const completeUnsubscribe = vi.fn();
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return completeUnsubscribe;
        });
        mockOcr.cancel
            .mockRejectedValueOnce(new Error('cancel transport down'))
            .mockResolvedValueOnce({canceled: true});

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);
            await vi.waitFor(() => {
                expect(mockOcr.createSearchablePdf).toHaveBeenCalledTimes(1);
            });

            await expect(ocr.cancelOcr()).resolves.toMatchObject({
                canceled: false,
                reason: 'failed',
                error: 'cancel transport down',
            });
            expect(ocr.progress.value.isRunning).toBe(true);
            expect(ocr.progress.value.status).toBe('cancel-requested');
            expect(ocr.error.value).toBe('cancel transport down');

            await vi.advanceTimersByTimeAsync(5_000);
            expect(ocr.progress.value.isRunning).toBe(true);
            expect(ocr.progress.value.status).toBe('cancel-requested');
            expect(completeUnsubscribe).not.toHaveBeenCalled();

            await expect(ocr.cancelOcr()).resolves.toEqual({canceled: true});
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: false,
                errors: ['OCR canceled'],
            });
            await runPromise;

            expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
            expect(ocr.progress.value.status).toBe('cancelled');
        } finally {
            scope.stop();
            vi.useRealTimers();
        }
    });

    it('acknowledges late canceled OCR results that require cleanup', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            sourceDocumentRevisionToken?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const completeUnsubscribe = vi.fn();
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return completeUnsubscribe;
        });
        mockOcr.cancel.mockResolvedValueOnce({
            canceled: false,
            reason: 'not-found',
        });
        mockOcr.acknowledgeResultFile.mockResolvedValueOnce({ cleaned: true });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            const cancelResult = await ocr.cancelOcr();

            expect(cancelResult).toMatchObject({
                canceled: false,
                reason: 'not-found',
            });
            expect(completeUnsubscribe).not.toHaveBeenCalled();

            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: true,
                pdfPath: '/tmp/late-ocr-result.pdf',
                requiresCleanupAck: true,
                errors: [],
            });

            await waitForCondition(() => mockOcr.acknowledgeResultFile.mock.calls.length > 0);
            await runPromise;

            expect(mockOcr.acknowledgeResultFile).toHaveBeenCalledWith(requestId, '/tmp/late-ocr-result.pdf');
            expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
            expect(ocr.results.value.searchablePdfResult).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('keeps the late completion watcher when backend cancel succeeds', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const completeUnsubscribe = vi.fn();
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return completeUnsubscribe;
        });
        mockOcr.cancel.mockResolvedValueOnce({ canceled: true });
        mockOcr.acknowledgeResultFile.mockResolvedValueOnce({ cleaned: true });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            const cancelResult = await ocr.cancelOcr();

            expect(cancelResult).toEqual({ canceled: true });
            expect(completeUnsubscribe).not.toHaveBeenCalled();

            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: true,
                pdfPath: '/tmp/success-before-cancel-returned.pdf',
                requiresCleanupAck: true,
                errors: [],
            });

            await waitForCondition(() => mockOcr.acknowledgeResultFile.mock.calls.length > 0);
            await runPromise;

            expect(mockOcr.acknowledgeResultFile).toHaveBeenCalledWith(
                requestId,
                '/tmp/success-before-cancel-returned.pdf',
            );
            expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
            expect(ocr.results.value.searchablePdfResult).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('clears previous searchable PDF results when a later OCR run fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            sourceDocumentRevisionToken?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const emitComplete = (result: IOcrCompleteTestResult) => {
            const handler = completeHandler;
            if (!handler) {
                throw new Error('OCR completion handler was not registered');
            }
            handler(result);
        };
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const firstRunPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);
            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const firstRequestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            emitComplete({
                requestId: firstRequestId,
                success: true,
                pdfPath: '/tmp/ocr-result.pdf',
                sourceDocumentRevisionToken: 'source-revision-token',
                requiresCleanupAck: true,
                errors: [],
            });
            await firstRunPromise;
            expect(ocr.hasResults.value).toBe(true);
            expect(ocr.results.value.searchablePdfResult).toEqual({
                requestId: firstRequestId,
                pdfPath: '/tmp/ocr-result.pdf',
                sourceDocumentRevisionToken: 'source-revision-token',
                requiresCleanupAck: true,
            });
            expect(mockOcr.acknowledgeResultFile).not.toHaveBeenCalled();

            const secondRunPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);
            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 1);
            expect(ocr.hasResults.value).toBe(false);
            const secondRequestId = mockOcr.createSearchablePdf.mock.calls[1]?.[2] as string;
            emitComplete({
                requestId: secondRequestId,
                success: false,
                errors: ['OCR job idle timed out after 15000ms without worker activity'],
            });
            await secondRunPromise;

            expect(ocr.hasResults.value).toBe(false);
            expect(ocr.error.value).toContain('OCR job idle timed out');
        } finally {
            scope.stop();
        }
    });

    it('freezes run languages for backend dispatch and result metadata', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            sourceDocumentRevisionToken?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const emitComplete = (result: IOcrCompleteTestResult) => {
            const handler = completeHandler;
            if (!handler) {
                throw new Error('OCR completion handler was not registered');
            }
            handler(result);
        };
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            ocr.settings.value = {
                ...ocr.settings.value,
                selectedLanguages: ['eng'],
            };
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            expect(ocr.activeRunSettings.value?.selectedLanguages).toEqual(['eng']);

            ocr.settings.value = {
                ...ocr.settings.value,
                selectedLanguages: ['rus'],
            };

            const call = mockOcr.createSearchablePdf.mock.calls[0] ?? [];
            const pageRequests = call[1];
            const requestId = call[2];
            const options = call[3];
            expect(pageRequests).toEqual([{
                pageNumber: 1,
                languages: ['eng'],
            }]);
            expect(options).toEqual({
                qualityProfile: 'balanced',
                preprocessingMode: 'off',
                supersessionPolicy: 'missing-only',
            });
            emitComplete({
                requestId: requestId as string,
                success: true,
                pdfPath: '/tmp/ocr-result.pdf',
                sourceDocumentRevisionToken: 'source-revision-token',
                requiresCleanupAck: true,
                errors: [],
            });
            await runPromise;

            expect(ocr.results.value.languages).toEqual(['eng']);
            expect(ocr.lastCompletedRunSettings.value?.selectedLanguages).toEqual(['eng']);
            expect(ocr.lastCompletedRunSettings.value?.qualityProfile).toBe('balanced');
            expect(ocr.activeRunSettings.value).toBeNull();
            expect(mockOcr.getLanguages).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });

    it('passes explicit OCR tuning options to searchable PDF creation', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
        mockOcr.onComplete.mockImplementation((handler) => {
            queueMicrotask(() => handler({
                requestId: 'ocr-00000000-0000-4000-8000-000000000001',
                success: true,
                pdfPath: '/tmp/ocr-result.pdf',
                sourceDocumentRevisionToken: 'source-revision-token',
                requiresCleanupAck: true,
                errors: [],
            }));
            return vi.fn();
        });
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            ocr.settings.value = {
                ...ocr.settings.value,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 6,
            };

            await ocr.runOcr(1, 1, WORKING_COPY_PATH);

            expect(mockOcr.createSearchablePdf.mock.calls[0]?.[3]).toEqual({
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                supersessionPolicy: 'missing-only',
                pageSegmentationMode: 6,
            });
        } finally {
            scope.stop();
            vi.unstubAllGlobals();
        }
    });

    it('dispatches a million-page all selection as a scalar and cancels before expansion', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            ocr.settings.value = {
                ...ocr.settings.value,
                pageRange: 'all',
            };
            const runPromise = ocr.runOcr(1, 1_000_001, WORKING_COPY_PATH);
            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);

            const call = mockOcr.createSearchablePdf.mock.calls[0] ?? [];
            const pageSelection = call[1];
            const requestId = call[2] as string;
            expect(pageSelection).toEqual({
                kind: 'all',
                pageCount: 1_000_001,
                languages: ['eng'],
            });
            expect(Array.isArray(pageSelection)).toBe(false);
            expect(ocr.progress.value.totalPages).toBe(1_000_001);

            await expect(ocr.cancelOcr()).resolves.toMatchObject({canceled: true});
            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: false,
                errors: ['OCR canceled'],
            });
            await runPromise;
        } finally {
            scope.stop();
        }
    });

    it('rejects runs with no selected languages before dispatching to the backend', async () => {
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            ocr.settings.value = {
                ...ocr.settings.value,
                selectedLanguages: [],
            };

            await ocr.runOcr(1, 1, WORKING_COPY_PATH);

            expect(mockOcr.createSearchablePdf).not.toHaveBeenCalled();
            expect(ocr.error.value).toBe('errors.ocr.noLanguages');
            expect(ocr.progress.value.isRunning).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('clears previous OCR results when a new run fails local validation', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            sourceDocumentRevisionToken?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }

        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const emitComplete = (result: IOcrCompleteTestResult) => {
            const handler = completeHandler;
            if (!handler) {
                throw new Error('OCR completion handler was not registered');
            }
            handler(result);
        };
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);
            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            emitComplete({
                requestId,
                success: true,
                pdfPath: '/tmp/ocr-result.pdf',
                sourceDocumentRevisionToken: 'source-revision-token',
                requiresCleanupAck: true,
                errors: [],
            });
            await runPromise;
            expect(ocr.hasResults.value).toBe(true);

            ocr.settings.value = {
                ...ocr.settings.value,
                selectedLanguages: [],
            };
            await ocr.runOcr(1, 1, WORKING_COPY_PATH);

            expect(ocr.error.value).toBe('errors.ocr.noLanguages');
            expect(ocr.hasResults.value).toBe(false);
            expect(mockOcr.createSearchablePdf).toHaveBeenCalledTimes(1);
        } finally {
            scope.stop();
        }
    });

    it('cancels the active backend job when OCR times out', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.useFakeTimers();
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
        mockOcr.onComplete.mockReturnValue(vi.fn());

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);

            await vi.waitFor(() => {
                expect(mockOcr.createSearchablePdf).toHaveBeenCalledTimes(1);
            });
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;

            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
            await runPromise;

            expect(mockOcr.cancel).toHaveBeenCalledWith(requestId);
            expect(ocr.progress.value.isRunning).toBe(true);
            expect(ocr.progress.value.status).toBe('cancel-requested');
            expect(ocr.error.value).not.toBeNull();
        } finally {
            scope.stop();
            vi.useRealTimers();
        }
    });

    it('preserves searchable PDF start envelopes as start failures', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mockOcr.createSearchablePdf.mockResolvedValueOnce({
            started: false,
            jobId: 'job-start-failure',
            error: 'fallback start failure',
            errorEnvelope: {
                code: 'OCR_QUEUE_BACKPRESSURE',
                message: 'OCR queue is full',
                retryable: true,
                timestamp: 123,
            },
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            await ocr.runOcr(1, 1, WORKING_COPY_PATH);

            expect(ocr.error.value).toBe('errors.ocr.errorCode.queueBackpressure: OCR queue is full');
            expect(loggerErrorMock).not.toHaveBeenCalled();
            expect(loggerWarnMock).toHaveBeenCalledWith(
                'ocr',
                'OCR run was not started',
                expect.objectContaining({error: expect.stringContaining('queueBackpressure')}),
            );
        } finally {
            scope.stop();
        }
    });

    it('reports an unexpected OCR run failure once with a closed diagnostic code', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mockOcr.createSearchablePdf.mockRejectedValueOnce(new Error('native OCR failed'));

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            await ocr.runOcr(1, 1, WORKING_COPY_PATH);

            expect(loggerErrorMock).toHaveBeenCalledTimes(1);
            expect(loggerErrorMock).toHaveBeenCalledWith(
                'ocr',
                'OCR run failed',
                expect.objectContaining({error: 'native OCR failed'}),
                {
                    code: 'RENDERER_OCR_RUN_FAILED',
                    context: {},
                },
            );
        } finally {
            scope.stop();
        }
    });

    it('prefers terminal completion envelopes over plain OCR error strings', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
            errorEnvelope?: {
                code: 'OCR_WORKER_UNAVAILABLE';
                message: string;
                retryable: boolean;
                timestamp: number;
            };
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, WORKING_COPY_PATH);

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: false,
                errors: ['low-level worker detail'],
                errorEnvelope: {
                    code: 'OCR_WORKER_UNAVAILABLE',
                    message: 'OCR worker unavailable',
                    retryable: true,
                    timestamp: 123,
                },
            });
            await runPromise;

            expect(ocr.error.value).toBe('errors.ocr.errorCode.workerUnavailable: OCR worker unavailable');
            expect(loggerErrorMock).not.toHaveBeenCalled();
            expect(loggerWarnMock).toHaveBeenCalledWith(
                'ocr',
                'OCR backend reported an expected outcome',
                expect.objectContaining({errorCode: 'OCR_WORKER_UNAVAILABLE'}),
            );
        } finally {
            scope.stop();
        }
    });

    it('opens the DOCX save dialog before gathering canonical catalog text for export', async () => {
        const callOrder: string[] = [];
        mockDocuments.saveDocxAs.mockImplementationOnce(async () => {
            callOrder.push('saveDocxAs');
            return '/tmp/export.docx';
        });
        mockDocuments.writeDocxFileStreamChunk.mockResolvedValueOnce(true);
        mockDocuments.cleanupFile.mockResolvedValueOnce(undefined);
        loadDocumentTextCatalogPagesMock.mockImplementationOnce(async () => {
            callOrder.push('loadOcrText');
            return [{
                pageNumber: 1,
                text: 'pdf text',
                source: 'pdf-native',
            }];
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            await expect(ocr.exportDocx(WORKING_COPY_PATH, {} as never)).resolves.toBe(true);

            expect(callOrder).toEqual([
                'saveDocxAs',
                'loadOcrText',
            ]);
            expect(loadDocumentTextCatalogPagesMock).toHaveBeenCalledWith(
                WORKING_COPY_PATH,
                'revision-token',
                undefined,
                expect.any(AbortSignal),
            );
            expect(createDocxFromTextChunksMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(Function),
                expect.any(AbortSignal),
            );
            expect(extractPdfTextMock).not.toHaveBeenCalled();
            expect(mockDocuments.beginDocxFileStream).toHaveBeenCalledWith('/tmp/export.docx');
            expect(mockDocuments.writeDocxFileStreamChunk).toHaveBeenCalledWith(
                'docx-session',
                expect.any(Uint8Array),
            );
            expect(mockDocuments.commitDocxFileStream).toHaveBeenCalledWith('docx-session');
            expect(mockDocuments.writeDocxFile).not.toHaveBeenCalled();
            expect(mockDocuments.cleanupFile).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'success',
                title: expect.any(String),
                description: expect.any(String),
            }));
        } finally {
            scope.stop();
        }
    });

    it('cancels the serial DOCX export path without committing output', async () => {
        const writeStarted = Promise.withResolvers<boolean>();
        const writeRelease = Promise.withResolvers<boolean>();
        mockDocuments.saveDocxAs.mockResolvedValueOnce('/tmp/export.docx');
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce([{
            pageNumber: 1,
            text: 'pdf text',
            source: 'pdf-native',
        }]);
        mockDocuments.writeDocxFileStreamChunk.mockImplementationOnce(async (
            _session,
            _chunks,
        ) => {
            writeStarted.resolve(true);
            await writeRelease.promise;
            return true;
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            expect(ocr.cancelDocxExport).toEqual(expect.any(Function));
            const exportPromise = ocr.exportDocx(WORKING_COPY_PATH, {} as never);
            await writeStarted.promise;

            ocr.cancelDocxExport();
            await waitForCondition(() => mockDocuments.cancelDocxFileStream.mock.calls.length > 0);
            expect(mockDocuments.cancelDocxFileStream).toHaveBeenCalledWith('docx-session');
            writeRelease.resolve(true);

            await expect(exportPromise).resolves.toBe(false);
            expect(ocr.isExporting.value).toBe(false);
            expect(ocr.error.value).toBeNull();
            expect(toastAddMock).not.toHaveBeenCalled();
            expect(mockDocuments.writeDocxFile).not.toHaveBeenCalled();
        } finally {
            writeRelease.resolve(true);
            scope.stop();
        }
    });
});
