import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { requireDocumentRef } from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';
import {
    invalidateTrustedPdfOpenGeometry,
    rememberValidatedTrustedPdfOpenGeometry,
} from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';

const mocks = vi.hoisted(() => ({
    hasElectronApi: vi.fn(() => true),
    picker: vi.fn(),
    direct: vi.fn(),
    batch: vi.fn(),
    read: vi.fn(),
    readRange: vi.fn(),
    stat: vi.fn(),
    write: vi.fn(),
    cleanup: vi.fn(),
    cloneWorkingCopy: vi.fn(),
    analyzeConformance: vi.fn(),
    validatePdfData: vi.fn(),
    getRevision: vi.fn(),
    getOpeningGeometry: vi.fn(),
    repair: vi.fn(),
    optimize: vi.fn(),
    optimizeAsCopy: vi.fn(),
}));

const electronApi = createElectronPlatformApiFixture({
    documentFiles: {
        analyzePdfConformance: mocks.analyzeConformance,
        getDocumentRevision: mocks.getRevision,
        getPdfOpeningGeometry: mocks.getOpeningGeometry,
        optimizePdfAsCopy: mocks.optimizeAsCopy,
        optimizePdfForInteraction: mocks.optimize,
        readFile: mocks.read,
        readFileRange: mocks.readRange,
        repairPdf: mocks.repair,
        saveFileStructured: vi.fn(async () => ({
            ok: true as const,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: null,
        })),
        statFile: mocks.stat,
        validatePdfData: mocks.validatePdfData,
        writeFile: mocks.write,
    },
    documentOpen: {
        openDocumentDirect: mocks.direct,
        openDocumentDirectBatch: mocks.batch,
    },
    documentPicker: {openDocumentDialog: mocks.picker},
    documentPdf: {
        analyzePdfConformance: mocks.analyzeConformance,
        validatePdfData: mocks.validatePdfData,
    },
    documentWorkingCopy: {
        cleanupFile: mocks.cleanup,
        createWorkingCopyFromPath: mocks.cloneWorkingCopy,
    },
});

vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: () => electronApi,
    hasElectronAPI: () => mocks.hasElectronApi(),
    isDesktopPlatformActive: () => mocks.hasElectronApi(),
    isBrowserPlatformActive: () => !mocks.hasElectronApi(),
    isElectronRoutePath: (path: string | null | undefined) =>
        path === '/electron' || path?.startsWith('/electron/') === true,
    resolveInitialDesktopRuntime: () => mocks.hasElectronApi(),
    shouldPreferDesktopPlatform: () => mocks.hasElectronApi(),
}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({clearCache: vi.fn()})}));

vi.stubGlobal('useI18n', () => ({t: (key: string) => key}));
vi.stubGlobal('window', {
    ...globalThis,
    electronAPI: electronApi,
});

const { usePdfFile } = await import('@app/modules/workspace-shell/composables/usePdfFile');

type IPdfFileFacade = ReturnType<typeof usePdfFile>;

const PDF_BYTES = Uint8Array.from([
    37,
    80,
    68,
    70,
]);

function createFacade(options: Parameters<typeof usePdfFile>[0] = {}) {
    return usePdfFile(options) as IPdfFileFacade & {
        optimizeWorkingCopy?: unknown;
        optimizeWorkingCopyAsCopy?: unknown;
        repairWorkingCopy?: unknown;
    };
}

function pdfResult(name: string): TOpenFileResult {
    return {
        kind: 'pdf',
        originalPath: requireDocumentRef(`/${name}.pdf`),
        workingPath: requireDocumentRef(`/tmp/${name}.pdf`),
    };
}

type TOpenEntryPoint = 'picker' | 'direct' | 'batch';

function invokeOpen(file: IPdfFileFacade, entryPoint: TOpenEntryPoint, name: string) {
    if (entryPoint === 'picker') {
        return file.openFile();
    }
    if (entryPoint === 'direct') {
        return file.openFileDirect(requireDocumentRef(`/${name}.pdf`));
    }
    return file.openFileDirectBatch([requireDocumentRef(`/${name}.pdf`)]);
}

function installRacingResults(entryPoint: TOpenEntryPoint) {
    const stale = Promise.withResolvers<TOpenFileResult>();
    const fresh = pdfResult('fresh');
    const implementation = async (value?: string | string[]) => {
        const path = Array.isArray(value) ? value[0] : value;
        return path?.includes('fresh') ? fresh : stale.promise;
    };
    if (entryPoint === 'picker') {
        mocks.picker
            .mockImplementationOnce(() => stale.promise)
            .mockResolvedValueOnce(fresh);
    } else if (entryPoint === 'direct') {
        mocks.direct.mockImplementation(implementation);
    } else {
        mocks.batch.mockImplementation(implementation);
    }
    return stale;
}

describe('usePdfFile façade', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.hasElectronApi.mockReturnValue(true);
        mocks.stat.mockResolvedValue({size: PDF_BYTES.byteLength});
        mocks.read.mockResolvedValue(PDF_BYTES);
        mocks.readRange.mockResolvedValue(new Uint8Array());
        mocks.write.mockResolvedValue(true);
        mocks.cleanup.mockResolvedValue(undefined);
        mocks.cloneWorkingCopy.mockResolvedValue('/tmp/history-baseline.pdf');
        mocks.getRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/work.pdf',
            authority: 'electron-working-copy',
            contentRevision: 1,
            mintedAt: 1,
            token: 'revision-token',
        });
        mocks.getOpeningGeometry.mockResolvedValue({
            pageNumber: requirePageNumber(1),
            pageCount: 1,
            width: 612,
            height: 792,
            rotation: 0,
            size: PDF_BYTES.byteLength,
            modifiedAt: 1,
        });
        mocks.analyzeConformance.mockResolvedValue({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
        mocks.validatePdfData.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
    });

    it('exposes optional file operations from the split file capability', () => {
        const file = createFacade();

        expect(file).toMatchObject({
            repairWorkingCopy: expect.any(Function),
            optimizeWorkingCopy: expect.any(Function),
            optimizeWorkingCopyAsCopy: expect.any(Function),
        });
    });

    it('threads the workspace open surface into PDF open geometry', async () => {
        const result = pdfResult('surface');
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: result.originalPath,
            documentRevision: 'open-intent:1',
        });
        rememberValidatedTrustedPdfOpenGeometry({
            documentId: result.originalPath,
            pageNumber: requirePageNumber(1),
            pageCount: 7,
            width: 640,
            height: 900,
            rotation: 0,
            size: PDF_BYTES.byteLength,
            modifiedAt: 1,
            savedAt: 2,
        });
        mocks.getOpeningGeometry.mockReturnValue(new Promise(() => undefined));
        const file = createFacade({openSurface});

        await expect(file.openFile(result)).resolves.toMatchObject({status: 'opened'});

        expect(openSurface.snapshot.value.openingPageGeometry).toMatchObject({
            documentId: result.originalPath,
            pageCount: 7,
            width: 640,
            height: 900,
        });
        invalidateTrustedPdfOpenGeometry(result.originalPath, requirePageNumber(1));
    });

    it('rejects an empty PDF before it can claim the document session', async () => {
        mocks.stat.mockImplementation(async (path: string) => path === '/tmp/empty.pdf'
            ? {size: 0}
            : {size: PDF_BYTES.byteLength});
        const file = createFacade();

        await expect(file.openFile(pdfResult('empty'))).resolves.toEqual({
            status: 'failed',
            error: 'errors.file.emptyPdf',
        });

        expect(file.error.value).toBe('errors.file.emptyPdf');
        expect(file.workingCopyPath.value).toBeNull();
        expect(file.pdfSrc.value).toBeNull();
        expect(mocks.read).not.toHaveBeenCalled();
    });

    it('keeps the active working copy when its replacement fails to load', async () => {
        const file = createFacade();
        await file.openFile(pdfResult('active'));
        mocks.stat.mockImplementation(async (path: string) => {
            if (path === '/tmp/failed.pdf') {
                throw new Error('read failed');
            }
            return {size: PDF_BYTES.byteLength};
        });

        await expect(file.openFile(pdfResult('failed'))).resolves.toMatchObject({status: 'failed'});
        expect(file.workingCopyPath.value).toBe('/tmp/active.pdf');
        expect(mocks.cleanup).not.toHaveBeenCalledWith('/tmp/active.pdf');
    });

    it.each([
        [
            'picker',
            mocks.picker,
        ],
        [
            'direct',
            mocks.direct,
        ],
        [
            'batch',
            mocks.batch,
        ],
    ] as const)('routes %s opens through the split capability', async (
        entryPoint,
        splitMethod,
    ) => {
        splitMethod.mockResolvedValue(pdfResult(entryPoint));

        const file = createFacade();
        await expect(invokeOpen(file, entryPoint, entryPoint)).resolves.toMatchObject({status: 'opened'});

        expect(splitMethod).toHaveBeenCalledOnce();
        expect(file.workingCopyPath.value).toBe(`/tmp/${entryPoint}.pdf`);
    });

    it.each([
        'picker',
        'direct',
        'batch',
    ] as const)(
        'fences a stale %s result behind the newest open epoch',
        async (entryPoint) => {
            const stale = installRacingResults(entryPoint);
            const file = createFacade();

            const staleOpen = invokeOpen(file, entryPoint, 'stale');
            await expect(invokeOpen(file, entryPoint, 'fresh')).resolves.toMatchObject({status: 'opened'});
            stale.resolve(pdfResult('stale'));
            await expect(staleOpen).resolves.toMatchObject({status: 'stale'});

            expect(file.workingCopyPath.value).toBe('/tmp/fresh.pdf');
            expect(file.originalPath.value).toBe('/fresh.pdf');
            expect(file.pdfData.value).toEqual(PDF_BYTES);
            expect(mocks.cleanup).toHaveBeenCalledWith('/tmp/stale.pdf');
            expect(mocks.cleanup).not.toHaveBeenCalledWith('/tmp/fresh.pdf');
        },
    );

    it.each([
        true,
        false,
    ])('cleans the owned working copy and resets projections on close (desktop=%s)', async (desktop) => {
        mocks.hasElectronApi.mockReturnValue(desktop);
        const file = createFacade();
        await file.openFile(pdfResult('owned'));
        file.isDirty.value = true;
        file.error.value = 'old error';

        file.closeFile();

        expect(mocks.cleanup).toHaveBeenCalledWith('/tmp/owned.pdf');
        expect(file).toMatchObject({
            error: {value: null},
            fileName: {value: null},
            isDirty: {value: false},
            originalPath: {value: null},
            pdfConformanceProfile: {value: null},
            pdfData: {value: null},
            pdfSrc: {value: null},
            pendingDjvu: {value: null},
            workingCopyPath: {value: null},
        });
    });

    it('does not attach a history restore after the document closes', async () => {
        const write = Promise.withResolvers<undefined>();
        const file = createFacade();
        await file.openFile(pdfResult('active'));
        await file.loadPdfFromData(Uint8Array.from([
            1,
            2,
            3,
        ]));
        mocks.write.mockImplementationOnce(() => write.promise);

        const undo = file.undo();
        file.closeFile();
        write.resolve(undefined);

        await expect(undo).resolves.toBe(false);
        expect(file.workingCopyPath.value).toBeNull();
        expect(file.pdfData.value).toBeNull();
    });

    it('cleans a staged first-mutation baseline when the document closes', async () => {
        const size = (16 * 1024 * 1024) + 1;
        const staging = Promise.withResolvers<string>();
        mocks.stat.mockResolvedValue({size});
        mocks.cloneWorkingCopy.mockReturnValue(staging.promise);
        const file = createFacade();
        await file.openFile(pdfResult('large'));

        const baseline = file.ensureHistoryBaselineForMutation();
        await vi.waitFor(() => {
            expect(mocks.cloneWorkingCopy).toHaveBeenCalledOnce();
        });
        file.closeFile();
        staging.resolve('/tmp/staged-baseline.pdf');

        await expect(baseline).resolves.toBe(false);
        expect(mocks.cleanup).toHaveBeenCalledWith('/tmp/staged-baseline.pdf');
        expect(file.workingCopyPath.value).toBeNull();
        expect(file.canUndo.value).toBe(false);
    });
});
