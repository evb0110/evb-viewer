import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';
import type * as TViMockOriginalModule2 from '@app/utils/platformDocuments';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type * as TVueModule from 'vue';
import {
    clearRegisteredPdfRasterDisplayProfilesForTests,
    getRegisteredPdfRasterDisplayProfileCountForTests,
} from '@app/types/pdfRasterDisplayProfile';
import type {
    IDjvuConvertOptions,
    IDjvuConvertResult,
    IDjvuOpenResult,
    IDjvuProgress,
} from '@contracts/electronApiDjvu';
import {requireDocumentRef} from '@contracts/documentRef';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {
    TJobId,
    TRequestId,
} from '@contracts/shared';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import {requirePageNumber} from '@contracts/pageNumbers';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

vi.mock('vue', async (importOriginal) => {
    const actual = await importOriginal<typeof TVueModule>();
    return {
        ...actual,
        onUnmounted: vi.fn(),
    };
});

const mockDocumentFilesCapability = vi.hoisted(() => ({savePdfDialog: vi.fn()}));
const mockDocumentWorkingCopyCapability = vi.hoisted(() => ({cleanupFile: vi.fn()}));
const mockOpenJobResult = vi.hoisted(() => vi.fn<(path: string) => Promise<IDjvuOpenResult>>());
const mockConvertJobResult = vi.hoisted(() => vi.fn<(
    path: string,
    outputPath: string,
    options: IDjvuConvertOptions,
) => Promise<IDjvuConvertResult>>());
const mockElectronAPI = createElectronPlatformApiFixture({
    djvu: {
        startOpenForViewing: vi.fn(),
        awaitOpenJob: vi.fn(),
        onProgress: vi.fn((_callback: (progress: IDjvuProgress) => void) => vi.fn()),
        releaseViewingPath: vi.fn(),
        startConvertToPdf: vi.fn(),
        awaitConvertJob: vi.fn(),
        getJobState: vi.fn(),
        subscribeJob: vi.fn(),
        getPageSizes: vi.fn(),
        cancel: vi.fn(),
        cleanupTemp: vi.fn(),
    },
    documentFiles: mockDocumentFilesCapability,
    documentWorkingCopy: mockDocumentWorkingCopyCapability,
});
const pendingOpenJobs = new Map<string, Promise<unknown>>();
const pendingConvertJobs = new Map<string, Promise<unknown>>();
const toastAddMock = vi.hoisted(() => vi.fn());
const browserLoggerMock = vi.hoisted(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));
const conversionFailureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    occurredAt: 1,
    severity: 'error',
} as FailureReceipt;

const mockDjvuModeState = {
    activationGeneration: 0,
    activeActivation: null as {
        generation: number;
        kind: 'djvu';
        documentRef: string;
    } | null,
    isDjvuMode: ref(false),
    djvuSourcePath: ref<string | null>(null),
    djvuTempPdfPath: ref<string | null>(null),
};

vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => mockElectronAPI}));
vi.mock('@app/composables/useTypedI18n', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: browserLoggerMock}));
vi.mock('@app/utils/platformDocuments', async (importOriginal_2) => ({
    ...(await importOriginal_2<typeof TViMockOriginalModule2>()),
    getDocumentFilesCapability: () => mockElectronAPI.documentFiles,
    getDocumentWorkingCopyCapability: () => mockElectronAPI.documentWorkingCopy,
}));
vi.stubGlobal('useToast', () => ({add: toastAddMock}));

vi.mock('@app/modules/workspace-shell/document-sessions/useDocumentSourceSession', () => {
    const activateDocumentSource = vi.fn((_kind: 'pdf' | 'djvu', source: string, temp: string | null = null) => {
        mockDjvuModeState.activationGeneration += 1;
        mockDjvuModeState.activeActivation = {
            generation: mockDjvuModeState.activationGeneration,
            kind: 'djvu',
            documentRef: source,
        };
        mockDjvuModeState.isDjvuMode.value = true;
        mockDjvuModeState.djvuSourcePath.value = source;
        mockDjvuModeState.djvuTempPdfPath.value = temp;
        return mockDjvuModeState.activeActivation;
    });
    const clearDocumentSource = vi.fn((expected?: {generation: number}) => {
        if (expected && expected.generation !== mockDjvuModeState.activeActivation?.generation) {
            return false;
        }
        mockDjvuModeState.activationGeneration += 1;
        mockDjvuModeState.activeActivation = null;
        mockDjvuModeState.isDjvuMode.value = false;
        mockDjvuModeState.djvuSourcePath.value = null;
        mockDjvuModeState.djvuTempPdfPath.value = null;
        return true;
    });

    return {useDocumentSourceSession: () => ({
        isDjvuSource: mockDjvuModeState.isDjvuMode,
        sourceRef: mockDjvuModeState.djvuSourcePath,
        projectionRef: mockDjvuModeState.djvuTempPdfPath,
        activateDocumentSource,
        captureDocumentSourceActivation: () => mockDjvuModeState.activeActivation,
        clearDocumentSource,
    })};
});

const { useDjvu } = await import('@app/composables/useDjvu');

function createUnusedConvertedPdfOpen() {
    return vi.fn(async () => ({status: 'cancelled' as const}));
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

describe('useDjvu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearRegisteredPdfRasterDisplayProfilesForTests();
        mockDjvuModeState.isDjvuMode.value = false;
        mockDjvuModeState.activationGeneration = 0;
        mockDjvuModeState.activeActivation = null;
        mockDjvuModeState.djvuSourcePath.value = null;
        mockDjvuModeState.djvuTempPdfPath.value = null;
        mockElectronAPI.djvu.onProgress.mockReturnValue(vi.fn());
        pendingOpenJobs.clear();
        pendingConvertJobs.clear();
        browserLoggerMock.error.mockReturnValue(conversionFailureReceipt);
        mockElectronAPI.djvu.startOpenForViewing.mockImplementation(async (path: string, requestId: string) => {
            const jobId = requireJobId(`djvu-open-${requestId}`);
            pendingOpenJobs.set(jobId, mockOpenJobResult(path));
            return {
                jobId,
                requestId: requireRequestId(requestId),
            };
        });
        mockElectronAPI.djvu.awaitOpenJob.mockImplementation(async (jobId: string) => pendingOpenJobs.get(jobId));
        mockElectronAPI.djvu.startConvertToPdf.mockImplementation(async (
            path: string,
            outputPath: string,
            options: IDjvuConvertOptions,
        ) => {
            const requestId = options.requestId ?? 'request';
            const jobId = requireJobId(`djvu-convert-${requestId}`);
            pendingConvertJobs.set(jobId, mockConvertJobResult(path, outputPath, {
                ...options,
                jobId,
            }));
            return {
                jobId,
                requestId: requireRequestId(requestId),
            };
        });
        mockElectronAPI.djvu.awaitConvertJob.mockImplementation(async (jobId: string) => pendingConvertJobs.get(jobId));
        mockElectronAPI.djvu.getPageSizes.mockResolvedValue([]);
        mockElectronAPI.djvu.subscribeJob.mockImplementation(async (jobId: string) => ({
            jobId: requireJobId(jobId),
            operation: 'djvu-convert' as const,
            status: 'completed' as const,
            progress: {
                jobId: requireJobId(jobId),
                phase: 'converting' as const,
                percent: 100,
            },
            updatedAtMs: requireEpochMs(Date.now()),
        }));
        mockDocumentWorkingCopyCapability.cleanupFile.mockResolvedValue(undefined);
        toastAddMock.mockClear();
    });

    describe('openDjvuFile', () => {
        it('opens a single-page DjVu file', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('job-1'),
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/path/to/doc.djvu');
            expect(djvu.isLoadingPages.value).toBe(false);
        });

        it('retains trusted source size for the active DjVu until that activation exits', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('job-sized'),
                pageSourceInfo: {
                    pageCount: 1,
                    pageNumber: requirePageNumber(1),
                    pageSize: {
                        width: 1200,
                        height: 1800,
                        dpi: 300,
                    },
                    sourceSize: 14_712_313,
                    sourceModifiedAt: requireEpochMs(1_700_000_000_000),
                },
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/path/to/sized.djvu');

            expect(djvu.sourceSizeBytes.value).toBe(14_712_313);
            const activation = djvu.captureDjvuActivation();
            expect(activation).not.toBeNull();
            expect(djvu.exitDjvuMode(activation!)).toBe(true);
            expect(djvu.sourceSizeBytes.value).toBeNull();
        });

        it('leaves window title sync to the workspace shell', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('job-encoded'),
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile(
                'browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.djvu',
            );

        });

        it('throws when the durable open job fails', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mockOpenJobResult.mockResolvedValue({
                success: false,
                error: 'File corrupted',
            });

            const djvu = useDjvu();

            await expect(
                djvu.openDjvuFile('/bad.djvu'),
            ).rejects.toThrow('File corrupted');
        });

        it('sets loading state for multi-page files', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 10,
                jobId: requireJobId('job-multi'),
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/multi.djvu');
            expect(djvu.isLoadingPages.value).toBe(false);
            expect(djvu.loadingProgress.value.total).toBe(0);
        });

        it('tracks the opening path until DjVu mode is fully entered', async () => {
            let resolveOpen: ((value: {
                success: boolean;
                pageCount: number;
                jobId: TJobId;
            }) => void) | null = null;
            mockOpenJobResult.mockImplementation(() => new Promise((resolve) => {
                resolveOpen = resolve;
            }));

            const djvu = useDjvu();
            const openPromise = djvu.openDjvuFile('/pending.djvu');

            expect(djvu.openingPath.value).toBe('/pending.djvu');

            expect(resolveOpen).not.toBeNull();
            resolveOpen!({
                success: true,
                pageCount: 3,
                jobId: requireJobId('job-pending'),
            });
            await openPromise;

            expect(djvu.openingPath.value).toBeNull();
        });

        it('accepts the DjVu candidate before closing the active document', async () => {
            const accepted = createDeferred<IDjvuOpenResult>();
            mockOpenJobResult.mockReturnValue(accepted.promise);

            const djvu = useDjvu();
            const closeActiveDocument = vi.fn(async () => undefined);

            const opening = djvu.openDjvuFile('/handoff.djvu', {closeActiveDocument});
            await Promise.resolve();
            await Promise.resolve();

            expect(mockElectronAPI.djvu.startOpenForViewing).toHaveBeenCalledTimes(1);
            expect(closeActiveDocument).not.toHaveBeenCalled();
            expect(djvu.isDjvuMode.value).toBe(false);

            accepted.resolve({
                success: true,
                pageCount: 100,
                jobId: requireJobId('job-source-handoff'),
            });
            await opening;

            expect(closeActiveDocument).toHaveBeenCalledTimes(1);
            expect(djvu.djvuSourcePath.value).toBe('/handoff.djvu');
        });

        it('does not close the active PDF when the DjVu candidate is rejected', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mockOpenJobResult.mockResolvedValue({
                success: false,
                error: 'DjVu directory is corrupt',
            });
            const closeActiveDocument = vi.fn(async () => undefined);
            const djvu = useDjvu();

            await expect(djvu.openDjvuFile(
                '/corrupt.djvu',
                {closeActiveDocument},
            )).rejects.toThrow('DjVu directory is corrupt');

            expect(closeActiveDocument).not.toHaveBeenCalled();
            expect(djvu.isDjvuMode.value).toBe(false);
            expect(djvu.djvuSourcePath.value).toBeNull();
        });

        it('releases the previous DjVu viewing path when switching files', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 2,
                jobId: requireJobId('job-next'),
            });
            mockDjvuModeState.isDjvuMode.value = true;
            mockDjvuModeState.djvuSourcePath.value = '/existing.djvu';

            const djvu = useDjvu();

            await djvu.openDjvuFile('/next.djvu');

            expect(mockElectronAPI.djvu.releaseViewingPath).toHaveBeenCalledWith('/existing.djvu');
        });

        it('does not let a stale open overwrite or clear a newer open state', async () => {
            const first = createDeferred<{
                success: boolean;
                pageCount: number;
                jobId: TJobId;
            }>();
            mockOpenJobResult
                .mockImplementationOnce(() => first.promise)
                .mockResolvedValueOnce({
                    success: true,
                    pageCount: 2,
                    jobId: requireJobId('newer-job'),
                });

            const djvu = useDjvu();
            const staleOpen = djvu.openDjvuFile('/old.djvu');
            const currentOpen = djvu.openDjvuFile('/new.djvu');
            await currentOpen;

            first.resolve({
                success: false,
                pageCount: 0,
                jobId: requireJobId('older-job'),
            });
            await expect(staleOpen).resolves.toBe(false);

            expect(djvu.djvuSourcePath.value).toBe('/new.djvu');
            expect(djvu.openingPath.value).toBeNull();
            expect(djvu.isLoadingPages.value).toBe(false);
        });
    });

    describe('cancelActiveJobs', () => {
        it('does not claim cancellation without an admitted job handle', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('v-1'),
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/a.djvu');

            djvu.conversionState.value = {
                isConverting: true,
                phase: 'converting',
                percent: 50,
            };

            const result = await djvu.cancelActiveJobs();

            expect(result).toBe(false);
            expect(mockElectronAPI.djvu.cancel).not.toHaveBeenCalled();
        });
    });

    describe('convertToPdf', () => {
        it('suggests a PDF name from the DjVu source file without using localized fallback text', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue(null);

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(mockDocumentFilesCapability.savePdfDialog).toHaveBeenCalledWith('input.pdf');
        });

        it('turns the DjVu fallback into a PDF suggestion only when the source has no basename', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue(null);

            const djvu = useDjvu();
            await djvu.openDjvuFile('browser://documents/source/');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(mockDocumentFilesCapability.savePdfDialog).toHaveBeenCalledWith('djvu.documentFallback.pdf');
        });

        it('shows a conversion toast without poisoning the DjVu viewing error', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: false,
                error: 'Windows converter failed',
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(djvu.sourceError.value).toBeNull();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                description: 'Windows converter failed\nError ID: 01234567',
                actions: expect.arrayContaining([expect.objectContaining({label: 'Copy details'})]),
            }));
            expect(browserLoggerMock.error).toHaveBeenCalledWith(
                'djvu',
                'Conversion failed',
                'Windows converter failed',
                {
                    code: 'RENDERER_DJVU_OPERATION_FAILED',
                    context: {},
                },
            );
            expect(djvu.conversionState.value.isConverting).toBe(false);
            expect(mockDocumentWorkingCopyCapability.cleanupFile).not.toHaveBeenCalled();
        });

        it('reuses a main conversion receipt in the red toast without recapturing', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: false,
                error: 'Native conversion failed',
                failure: conversionFailureReceipt,
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(browserLoggerMock.error).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                description: 'Native conversion failed\nError ID: 01234567',
            }));
        });

        it('keeps expected conversion refusals warning-only and receipt-free', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: false,
                error: 'Selected DjVu quality is blocked',
                expected: {
                    kind: 'expected',
                    code: 'validation-rejected',
                },
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(browserLoggerMock.error).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'warning',
                description: 'Selected DjVu quality is blocked',
            }));
        });

        it('does not present or capture canceled conversion results', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: false,
                error: 'DjVu conversion canceled',
                expected: {
                    kind: 'expected',
                    code: 'canceled',
                },
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(browserLoggerMock.error).not.toHaveBeenCalled();
            expect(toastAddMock).not.toHaveBeenCalled();
        });

        it('reuses a receipt attached to a conversion rejection', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockRejectedValue(Object.assign(
                new Error('Browser worker conversion failed'),
                {failure: conversionFailureReceipt},
            ));

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(browserLoggerMock.error).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                description: 'Browser worker conversion failed\nError ID: 01234567',
            }));
        });

        it('does not misclassify an abort-related conversion fault as cancellation', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockRejectedValue(new Error('Failed to abort PDF output cleanup'));

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(browserLoggerMock.error).toHaveBeenCalledWith(
                'djvu',
                'Conversion crashed',
                expect.objectContaining({
                    path: '/tmp/input.djvu',
                    error: expect.any(Error),
                }),
                {
                    code: 'RENDERER_DJVU_OPERATION_FAILED',
                    context: {},
                },
            );
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                description: 'Failed to abort PDF output cleanup\nError ID: 01234567',
            }));
        });

        it('cancels a conversion whose native handle arrives after cancellation', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            const admission = createDeferred<{
                jobId: TJobId;
                requestId: TRequestId;
            }>();
            mockElectronAPI.djvu.startConvertToPdf.mockImplementationOnce(() => admission.promise);

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            const conversion = djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());
            await vi.waitFor(() => expect(djvu.conversionState.value.isConverting).toBe(true));

            await expect(djvu.cancelActiveJobs()).resolves.toBe(false);
            admission.resolve({
                jobId: requireJobId('late-admitted-job'),
                requestId: requireRequestId('late-request'),
            });
            await conversion;

            expect(mockElectronAPI.djvu.cancel).toHaveBeenCalledWith('late-admitted-job');
            expect(djvu.conversionState.value.isConverting).toBe(false);
        });

        it('does not let a stale conversion completion clear a newer conversion', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog
                .mockResolvedValueOnce('/tmp/old.pdf')
                .mockResolvedValueOnce('/tmp/new.pdf');
            const oldResult = createDeferred<IDjvuConvertResult>();
            const newResult = createDeferred<IDjvuConvertResult>();
            mockConvertJobResult
                .mockImplementationOnce(() => oldResult.promise)
                .mockImplementationOnce(() => newResult.promise);

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            const oldConversion = djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());
            await vi.waitFor(() => expect(mockConvertJobResult).toHaveBeenCalledTimes(1));
            await djvu.cancelActiveJobs();

            const newConversion = djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());
            await vi.waitFor(() => expect(mockConvertJobResult).toHaveBeenCalledTimes(2));
            oldResult.resolve({
                success: true,
                pdfPath: requireDocumentRef('/tmp/old.pdf'),
                jobId: mockConvertJobResult.mock.calls[0]![2]!.jobId!,
            });
            await oldConversion;

            expect(djvu.conversionState.value.isConverting).toBe(true);
            newResult.resolve({
                success: false,
                pdfPath: requireDocumentRef('/tmp/new.pdf'),
                jobId: mockConvertJobResult.mock.calls[1]![2]!.jobId!,
            });
            await newConversion;
            expect(djvu.conversionState.value.isConverting).toBe(false);
        });

        it('cleans up browser conversion output refs after conversion errors', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('browser://documents/output/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: false,
                error: 'Browser converter failed',
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', createUnusedConvertedPdfOpen());

            expect(djvu.sourceError.value).toBeNull();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                description: 'Browser converter failed\nError ID: 01234567',
            }));
            expect(mockDocumentWorkingCopyCapability.cleanupFile)
                .toHaveBeenCalledWith('browser://documents/output/out.pdf');
        });

        it('opens the converted PDF through the workspace direct-open flow', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: true,
                pdfPath: requireDocumentRef('/tmp/out.pdf'),
                jobId: requireJobId('convert-1'),
            });
            const openConvertedPdf = vi.fn(async () => ({
                status: 'opened' as const,
                result: {
                    kind: 'pdf' as const,
                    originalPath: requireDocumentRef('/tmp/out.pdf'),
                    workingPath: requireDocumentRef('/tmp/out-working.pdf'),
                },
            }));

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', openConvertedPdf);

            expect(openConvertedPdf).toHaveBeenCalledWith('/tmp/out.pdf');
            expect(djvu.conversionState.value.isConverting).toBe(false);
        });

        it('opens trusted raster DjVu PDFs with source page pixel caps', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: true,
                pdfPath: requireDocumentRef('/tmp/out.pdf'),
                jobId: requireJobId('convert-1'),
            });
            mockElectronAPI.djvu.getPageSizes.mockResolvedValue([{
                width: 1293,
                height: 1966,
                dpi: 300,
            }]);
            const openConvertedPdf = vi.fn(async () => ({
                status: 'opened' as const,
                result: {
                    kind: 'pdf' as const,
                    originalPath: requireDocumentRef('/tmp/out.pdf'),
                    workingPath: requireDocumentRef('/tmp/out-working.pdf'),
                },
            }));

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', openConvertedPdf);

            expect(openConvertedPdf).toHaveBeenCalledWith('/tmp/out.pdf', {rasterDisplayProfile: {
                kind: 'trusted-raster-djvu',
                sourcePagePixels: [{
                    width: 1293,
                    height: 1966,
                }],
            }});
            expect(getRegisteredPdfRasterDisplayProfileCountForTests()).toBe(0);
        });

        it('passes the selected PDF strategy through to the DjVu capability', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: true,
                pdfPath: requireDocumentRef('/tmp/out.pdf'),
                jobId: requireJobId('convert-1'),
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(4, false, 'compact-djvu-aware', vi.fn(async () => ({
                status: 'opened' as const,
                result: {
                    kind: 'pdf' as const,
                    originalPath: requireDocumentRef('/tmp/out.pdf'),
                    workingPath: requireDocumentRef('/tmp/out-working.pdf'),
                },
            })));

            expect(mockConvertJobResult).toHaveBeenCalledWith(
                '/tmp/input.djvu',
                '/tmp/out.pdf',
                expect.objectContaining({
                    subsample: 4,
                    preserveBookmarks: false,
                    pdfStrategy: 'compact-djvu-aware',
                    requestId: expect.any(String),
                    documentRef: '/tmp/input.djvu',
                }),
            );
        });

        it('reuses the persistent PDF projection for repeated PDF-only actions', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: true,
                pdfPath: requireDocumentRef('/tmp/out.pdf'),
                jobId: requireJobId('convert-1'),
            });
            const openConvertedPdf = vi.fn(async () => ({
                status: 'opened' as const,
                result: {
                    kind: 'pdf' as const,
                    originalPath: requireDocumentRef('/tmp/out.pdf'),
                    workingPath: requireDocumentRef('/tmp/out-working.pdf'),
                },
            }));
            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');

            await expect(djvu.ensurePdfProjectionForAction(
                'edit',
                openConvertedPdf,
                new AbortController().signal,
            )).resolves.toBe(true);
            await expect(djvu.ensurePdfProjectionForAction(
                'ocr',
                openConvertedPdf,
                new AbortController().signal,
            )).resolves.toBe(true);

            expect(mockConvertJobResult).toHaveBeenCalledTimes(1);
            expect(mockConvertJobResult).toHaveBeenCalledWith(
                '/tmp/input.djvu',
                '/tmp/out.pdf',
                expect.objectContaining({
                    pdfStrategy: 'direct',
                    preserveBookmarks: true,
                    subsample: 1,
                }),
            );
        });

        it('ignores conversion progress from another request before claiming the job id', async () => {
            let progressCallback: ((progress: IDjvuProgress) => void) | null = null;
            mockElectronAPI.djvu.onProgress.mockImplementation((callback) => {
                progressCallback = callback;
                return vi.fn();
            });
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            const conversionResult = createDeferred<IDjvuConvertResult>();
            mockConvertJobResult.mockImplementation((_source, _output, options) => {
                progressCallback?.({
                    jobId: requireJobId('foreign-job'),
                    requestId: requireRequestId('foreign-request'),
                    documentRef: requireDocumentRef('/tmp/input.djvu'),
                    phase: 'converting',
                    percent: 80,
                });
                progressCallback?.({
                    jobId: options.jobId!,
                    requestId: options.requestId!,
                    documentRef: requireDocumentRef('/tmp/input.djvu'),
                    phase: 'converting',
                    percent: 25,
                });
                return conversionResult.promise;
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            const convertPromise = djvu.convertToPdf(1, true, 'direct', vi.fn(async () => ({
                status: 'opened' as const,
                result: {
                    kind: 'pdf' as const,
                    originalPath: requireDocumentRef('/tmp/out.pdf'),
                    workingPath: requireDocumentRef('/tmp/out-working.pdf'),
                },
            })));

            for (let attempt = 0; attempt < 5 && mockConvertJobResult.mock.calls.length === 0; attempt += 1) {
                await Promise.resolve();
            }
            expect(mockConvertJobResult).toHaveBeenCalledTimes(1);
            await Promise.resolve();
            await Promise.resolve();
            const admittedOptions = mockConvertJobResult.mock.calls[0]![2]!;
            (progressCallback as ((progress: IDjvuProgress) => void) | null)?.({
                jobId: admittedOptions.jobId!,
                requestId: admittedOptions.requestId!,
                documentRef: requireDocumentRef('/tmp/input.djvu'),
                phase: 'converting',
                percent: 25,
            });
            expect(djvu.conversionState.value.percent).toBe(25);
            expect(conversionResult.promise).not.toBeNull();
            const requestId = mockConvertJobResult.mock.calls[0]?.[2]?.requestId;
            conversionResult.resolve({
                success: true,
                pdfPath: requireDocumentRef('/tmp/out.pdf'),
                jobId: mockConvertJobResult.mock.calls[0]![2]!.jobId!,
                requestId: requestId!,
            });
            await convertPromise;
        });

        it('shows the direct-open error when a converted PDF cannot be opened', async () => {
            mockOpenJobResult.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: requireJobId('view-1'),
            });
            mockDocumentFilesCapability.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockConvertJobResult.mockResolvedValue({
                success: true,
                pdfPath: requireDocumentRef('/tmp/out.pdf'),
                jobId: requireJobId('convert-1'),
            });
            const openConvertedPdf = vi.fn(async () => ({
                status: 'failed' as const,
                error: 'Converted PDF could not be opened',
            }));

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu');
            await djvu.convertToPdf(1, true, 'direct', openConvertedPdf);

            expect(openConvertedPdf).toHaveBeenCalledWith('/tmp/out.pdf');
            expect(djvu.sourceError.value).toBe('Converted PDF could not be opened');
        });
    });

    describe('openConvertDialog', () => {
        it('does not open the convert dialog outside DjVu mode', () => {
            const djvu = useDjvu();

            expect(mockDjvuModeState.isDjvuMode.value).toBe(false);

            djvu.openConvertDialog();

            expect(djvu.showConvertDialog.value).toBe(false);
        });

        it('opens the convert dialog while in DjVu mode', () => {
            mockDjvuModeState.isDjvuMode.value = true;
            const djvu = useDjvu();

            djvu.openConvertDialog();

            expect(djvu.showConvertDialog.value).toBe(true);
        });
    });
});
