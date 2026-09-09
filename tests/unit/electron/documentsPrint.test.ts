import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    basename,
    join,
} from 'path';
import { pathToFileURL } from 'url';
import type * as NodeCrypto from 'crypto';
import type * as FsPromises from 'fs/promises';
import {cancelMainOperationsForOwner} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    requireRequestId,
    PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES,
} from '@contracts/shared';

const mocks = vi.hoisted(() => {
    const browserWindowInstances: MockBrowserWindow[] = [];
    const paintedBitmap = Buffer.alloc(4 * 4 * 4, 255);
    const printHandler = vi.fn((
        _options: unknown,
        callback: (success: boolean, failureReason?: string) => void,
    ) => callback(true));

    class MockBrowserWindow {
        public static emitReadyToShowByDefault = true;
        public static emitPdfReadyToPrintByDefault = true;
        public static rejectLoadURLByDefault = false;

        private readonly eventHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
        private readonly webContentsEventHandlers = new Map<string, Set<(...args: unknown[]) => void>>();

        public autoEmitReadyToShow = MockBrowserWindow.emitReadyToShowByDefault;
        public autoEmitPdfReadyToPrint = MockBrowserWindow.emitPdfReadyToPrintByDefault;
        public rejectLoadURL = MockBrowserWindow.rejectLoadURLByDefault;

        public readonly close = vi.fn();
        public readonly hide = vi.fn();
        public readonly isDestroyed = vi.fn(() => false);
        public readonly loadURL = vi.fn(async () => {
            if (this.rejectLoadURL) {
                throw new Error('PDF load failed');
            }
            if (this.autoEmitReadyToShow) {
                this.emit('ready-to-show');
            }
            if (this.autoEmitPdfReadyToPrint) {
                this.emitWebContents('-pdf-ready-to-print');
            }
        });
        public readonly once = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            const handlers = this.eventHandlers.get(event) ?? new Set();
            handlers.add(handler);
            this.eventHandlers.set(event, handlers);
        });
        public readonly removeListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            this.eventHandlers.get(event)?.delete(handler);
        });
        public readonly setTitle = vi.fn();
        public readonly setOpacity = vi.fn();
        public readonly showInactive = vi.fn();
        public readonly webContents = {
            capturePage: vi.fn(async () => ({
                getSize: () => ({
                    width: 4,
                    height: 4,
                }),
                toBitmap: () => mocks.printSurfaceBitmap,
            })),
            executeJavaScript: vi.fn(async () => true),
            on: vi.fn(),
            print: vi.fn(printHandler),
            printToPDF: vi.fn(async () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')),
            once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                const handlers = this.webContentsEventHandlers.get(event) ?? new Set();
                handlers.add(handler);
                this.webContentsEventHandlers.set(event, handlers);
            }),
            removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                this.webContentsEventHandlers.get(event)?.delete(handler);
            }),
        };

        public constructor(public readonly options: Record<string, unknown>) {
            browserWindowInstances.push(this);
        }

        public emit(event: string, ...args: unknown[]) {
            const handlers = [...(this.eventHandlers.get(event) ?? [])];
            this.eventHandlers.delete(event);
            for (const handler of handlers) {
                handler(...args);
            }
        }

        public emitWebContents(event: string, ...args: unknown[]) {
            const handlers = [...(this.webContentsEventHandlers.get(event) ?? [])];
            this.webContentsEventHandlers.delete(event);
            for (const handler of handlers) {
                handler(...args);
            }
        }

        public static fromWebContents = vi.fn(() => null);
    }

    return {
        MockBrowserWindow,
        appGetPath: vi.fn(() => '/tmp'),
        browserWindowInstances,
        openPath: vi.fn(async () => ''),
        runtimePlatform: 'linux' as NodeJS.Platform,
        printSurfaceBitmap: paintedBitmap,
        printHandler,
        openMacOsPdfPrintDialog: vi.fn(async (
            _path: string,
            options?: {onNativeDialogOpened?: () => void},
        ) => {
            options?.onNativeDialogOpened?.();
            return {success: true};
        }),
        buildPrintablePdfPath: vi.fn(async () => ({bytes: 1})),
        copyFile: vi.fn<(sourcePath: string, outputPath: string) => Promise<void>>(async (_sourcePath, _outputPath) => {}),
        pdfPageCount: 1,
        pdfPageSize: {
            width: 612,
            height: 792,
        },
        pdfDocumentLoad: vi.fn(),
        open: vi.fn(),
        readdir: vi.fn<() => Promise<string[]>>(async () => []),
        mkdtemp: vi.fn(async () => '/tmp/evb-viewer-test-profile/raster-work'),
        readFile: vi.fn(async () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')),
        rm: vi.fn(async () => {}),
        runNativeToolCommand: vi.fn<(command: string, args: string[]) => Promise<{stdout?: string}>>(
            async (_command: string, _args: string[]) => ({}),
        ),
        cancelNativeCommandGroup: vi.fn(),
        randomUUID: vi.fn(() => 'print-job-id'),
        ensuredReadablePaths: new Set<string>(),
        ownedReadablePathsBySender: new Map<number, Set<string>>(),
        findWorkingCopyPathByOriginalPath: vi.fn<(path: string, senderId?: number) => string | null>(() => null),
        ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
        ensureWorkingCopyMaterialized: vi.fn(),
        resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(async (path: string) => path),
        extractPages: vi.fn(async (..._args: unknown[]) => {}),
        stat: vi.fn<(path: string) => Promise<{
            ctimeMs: number;
            isFile: () => boolean;
            mtimeMs: number;
            size?: number;
        }>>(async () => ({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: 1,
        })),
        unlink: vi.fn(async () => {}),
        writeFile: vi.fn(async () => {}),
    };
});

vi.mock('electron', () => ({
    app: { getPath: mocks.appGetPath },
    BrowserWindow: mocks.MockBrowserWindow,
    shell: { openPath: mocks.openPath },
}));

vi.mock('fs/promises', async (importOriginal) => ({
    ...await importOriginal<typeof FsPromises>(),
    // Resolve existence on a microtask: settleNativePrint pumps promises under
    // fake timers, so a real event-loop-bound access() would never settle.
    access: async (path: string) => {
        if (!existsSync(path)) {
            throw new Error(`ENOENT: ${path}`);
        }
    },
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readdir: mocks.readdir,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
    copyFile: mocks.copyFile,
}));

vi.mock('crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeCrypto>();
    return {
        ...actual,
        randomUUID: mocks.randomUUID,
    };
});
vi.mock('pdf-lib', () => ({ PDFDocument: { load: (...args: unknown[]) => mocks.pdfDocumentLoad(...args) } }));

vi.mock('@electron/utils/pathValidator', () => ({
    getManagedTempPathAccessDecision: vi.fn(() => undefined),
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    setManagedTempPathAccessValidator: vi.fn(),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
    getWorkingCopyBackingEntry: () => null,
    getWorkingCopyOwnerWebContentsId: () => undefined,
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args)}));
vi.mock('@electron/features/page-ops/main/qpdf', () => ({extractPages: mocks.extractPages}));
vi.mock('@electron/features/page-ops/public', () => ({extractPages: mocks.extractPages}));
vi.mock('@electron/features/documents/main/buildPrintablePdfPath', () => ({buildPrintablePdfPath: mocks.buildPrintablePdfPath}));
vi.mock('@electron/utils/openMacOsPdfPrintDialog', () => ({openMacOsPdfPrintDialog: mocks.openMacOsPdfPrintDialog}));
vi.mock('@electron/utils/getPrintRuntimePlatform', () => ({getPrintRuntimePlatform: () => mocks.runtimePlatform}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({
    pdfinfo: '/mock/pdfinfo',
    pdftoppm: '/mock/pdftoppm',
})}));
vi.mock('@electron/native-tools/buildPopplerEnv', () => ({buildPopplerEnv: () => undefined}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({
    cancelNativeCommandGroup: mocks.cancelNativeCommandGroup,
    runNativeToolCommand: mocks.runNativeToolCommand,
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: mocks.cancelNativeCommandGroup}));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}) }));

const {
    handleCancelPdfPrint,
    handleOpenPdfInDefaultAppData,
    handleOpenPdfInDefaultAppPath,
    handlePrintPdfData,
    handlePrintPdfPath,
    sweepStaleDefaultAppTempPdfs,
} = await import('@electron/features/documents/main/print');
const {
    isCapturedPrintSurfaceBitmap,
    printManagedTempPdfPath,
} = await import('@electron/utils/printHandoff');

const tempRoot = '/tmp/evb-viewer-test-profile';
const validPdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const multiPagePdfBytes = Buffer.from([
    '%PDF-1.7',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    'endobj',
    '4 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    'endobj',
    '%%EOF',
    '',
].join('\n'));
const senderId = 72;
const windowContext = {
    senderId,
    window: null,
};
const sourcePdfWorkDir = join(tempRoot, 'pdf-work-print-test');
const sourcePdfPath = join(sourcePdfWorkDir, 'source.pdf');

describe('documents print', () => {
    beforeEach(() => {
        process.env.EVB_APP_TEMP_NAMESPACE = 'test-profile';
        vi.clearAllMocks();
        mocks.browserWindowInstances.length = 0;
        mocks.runtimePlatform = 'linux';
        mocks.MockBrowserWindow.emitReadyToShowByDefault = true;
        mocks.MockBrowserWindow.emitPdfReadyToPrintByDefault = true;
        mocks.MockBrowserWindow.rejectLoadURLByDefault = false;
        mocks.printSurfaceBitmap = Buffer.alloc(4 * 4 * 4, 255);
        mocks.appGetPath.mockReturnValue('/tmp');
        mocks.randomUUID.mockReturnValue('print-job-id');
        mocks.openMacOsPdfPrintDialog.mockImplementation(async (
            _path: string,
            options?: {onNativeDialogOpened?: () => void},
        ) => {
            options?.onNativeDialogOpened?.();
            return {success: true};
        });
        mocks.buildPrintablePdfPath.mockResolvedValue({bytes: validPdfBytes.byteLength});
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.pdfPageCount = 1;
        mocks.pdfPageSize = {
            width: 612,
            height: 792,
        };
        mocks.pdfDocumentLoad.mockImplementation(async () => ({
            getPageCount: () => mocks.pdfPageCount,
            getPage: () => ({getSize: () => mocks.pdfPageSize}),
        }));
        mocks.ensuredReadablePaths.clear();
        mocks.ownedReadablePathsBySender.clear();
        mocks.ownedReadablePathsBySender.set(senderId, new Set([sourcePdfPath]));
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.ensureWorkingCopyMaterialized.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        mocks.ensureWorkingCopyDirectory.mockImplementation(async (path: string, requestedSenderId?: number) => {
            if (typeof requestedSenderId !== 'number' || !mocks.ownedReadablePathsBySender.get(requestedSenderId)?.has(path)) {
                return false;
            }
            mocks.ensuredReadablePaths.add(path);
            return true;
        });
        mocks.readdir.mockResolvedValue([]);
        mocks.mkdtemp.mockResolvedValue('/tmp/evb-viewer-test-profile/raster-work');
        mocks.readFile.mockResolvedValue(validPdfBytes);
        mocks.open.mockImplementation(async () => ({
            close: vi.fn(async () => {}),
            read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
                const range = position === 0
                    ? validPdfBytes
                    : Buffer.from('%%EOF\n');
                const bytesRead = length;
                range.copy(buffer, offset, 0, Math.min(length, range.byteLength));
                return {
                    bytesRead,
                    buffer,
                };
            }),
        }));
        mocks.rm.mockResolvedValue(undefined);
        mocks.runNativeToolCommand.mockImplementation(async (_command: string, args: string[]) => (
            args[0] === '-jpeg'
                ? {}
                : {stdout: [
                    `Pages: ${mocks.pdfPageCount}`,
                    ...Array.from({length: Math.min(mocks.pdfPageCount, 100)}, (_, index) => [
                        `Page ${index + 1} size: ${mocks.pdfPageSize.width} x ${mocks.pdfPageSize.height} pts`,
                        `Page ${index + 1} CropBox: 0 0 ${mocks.pdfPageSize.width} ${mocks.pdfPageSize.height}`,
                        `Page ${index + 1} rot: 0`,
                    ]).flat(),
                ].join('\n')}
        ));
        mocks.printHandler.mockImplementation((
            _options: unknown,
            callback: (success: boolean, failureReason?: string) => void,
        ) => callback(true));
        rmSync(sourcePdfWorkDir, {
            force: true,
            recursive: true,
        });
        mkdirSync(sourcePdfWorkDir, {recursive: true});
        writeFileSync(sourcePdfPath, validPdfBytes);
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => (
            mocks.ensuredReadablePaths.has(path) ? path : null
        ));
        mocks.stat.mockResolvedValue({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: validPdfBytes.byteLength,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.EVB_PRINT_DIALOG_TEST_MODE;
        delete process.env.EVB_PRINT_DIALOG_TEST_OUTPUT_PATH;
        delete process.env.EVB_APP_TEMP_NAMESPACE;
        rmSync(sourcePdfWorkDir, {
            force: true,
            recursive: true,
        });
    });

    async function settleNativePrint<T>(promise: Promise<T>) {
        await flushPrintPromises();
        if (mocks.browserWindowInstances.length > 0) {
            expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_000);
        }
        return promise;
    }

    async function flushPrintPromises() {
        for (let index = 0; index < 40; index += 1) {
            await Promise.resolve();
        }
    }

    it('creates the native print window with PDF plugins enabled', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledWith(sourcePdfPath, {
            ownerWebContentsId: senderId,
            reason: 'print-external',
            signal: expect.any(AbortSignal),
        });
        expect(mocks.browserWindowInstances).toHaveLength(1);
        expect(mocks.browserWindowInstances[0]?.options).toEqual(expect.objectContaining({
            show: false,
            title: 'source',
            webPreferences: expect.objectContaining({
                backgroundThrottling: false,
                plugins: true,
            }),
        }));
        expect(mocks.browserWindowInstances[0]?.setTitle).toHaveBeenCalledWith('source');
        expect(mocks.browserWindowInstances[0]?.webContents.on).toHaveBeenCalledWith(
            'page-title-updated',
            expect.any(Function),
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(sourcePdfPath).toString(),
        );
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledTimes(1);
        expect(mocks.browserWindowInstances[0]?.close).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('waits for the PDF viewer ready-to-print signal before dispatching native print', async () => {
        vi.useFakeTimers();
        mocks.MockBrowserWindow.emitPdfReadyToPrintByDefault = false;

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        await flushPrintPromises();

        const printWindow = mocks.browserWindowInstances[0];
        expect(printWindow?.loadURL).toHaveBeenCalledWith(pathToFileURL(sourcePdfPath).toString());
        await vi.advanceTimersByTimeAsync(2_000);
        expect(printWindow?.webContents.print).not.toHaveBeenCalled();

        printWindow?.emitWebContents('-pdf-ready-to-print');
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(resultPromise).resolves.toEqual({success: true});
        expect(printWindow?.webContents.print).toHaveBeenCalledTimes(1);
    });

    it('does not require ready-to-show after the PDF viewer signals readiness', async () => {
        vi.useFakeTimers();
        mocks.MockBrowserWindow.emitReadyToShowByDefault = false;

        let observedResult: unknown;
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        ).then((result) => {
            observedResult = result;
            return result;
        });
        await flushPrintPromises();

        const printWindow = mocks.browserWindowInstances[0];
        await vi.advanceTimersByTimeAsync(2_000);
        const printCallsBeforeReadyToShow = printWindow?.webContents.print.mock.calls.length ?? 0;

        // Keep the old implementation's unbounded promise from leaking into
        // the test while asserting that it did not gate dispatch.
        printWindow?.emit('ready-to-show');
        await expect(resultPromise).resolves.toEqual({success: true});
        expect(observedResult).toEqual({success: true});
        expect(printCallsBeforeReadyToShow).toBe(1);
    });

    it('fails closed when the PDF viewer never signals readiness', async () => {
        vi.useFakeTimers();
        mocks.MockBrowserWindow.emitPdfReadyToPrintByDefault = false;

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        await flushPrintPromises();

        const printWindow = mocks.browserWindowInstances[0];
        await vi.advanceTimersByTimeAsync(15_001);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'PDF viewer did not become ready to print within 15000ms',
        });
        expect(printWindow?.webContents.print).not.toHaveBeenCalled();
        expect(printWindow?.close).toHaveBeenCalledTimes(1);
        expect(printWindow?.webContents.removeListener).toHaveBeenCalledWith(
            '-pdf-ready-to-print',
            expect.any(Function),
        );
        expect(printWindow?.removeListener).toHaveBeenCalledWith(
            'ready-to-show',
            expect.any(Function),
        );
    });

    it('keeps the PDF readiness deadline effective when ready-to-show never fires', async () => {
        vi.useFakeTimers();
        mocks.MockBrowserWindow.emitReadyToShowByDefault = false;
        mocks.MockBrowserWindow.emitPdfReadyToPrintByDefault = false;

        let observedResult: unknown;
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        ).then((result) => {
            observedResult = result;
            return result;
        });
        await flushPrintPromises();

        const printWindow = mocks.browserWindowInstances[0];
        await vi.advanceTimersByTimeAsync(15_001);
        await flushPrintPromises();
        const resultBeforeReadyToShow = observedResult;

        // The old implementation waited on ready-to-show after the PDF
        // timeout. Emit it only as cleanup for that implementation so this
        // regression can fail without leaving a pending promise behind.
        if (resultBeforeReadyToShow === undefined) {
            printWindow?.emit('ready-to-show');
        }
        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'PDF viewer did not become ready to print within 15000ms',
        });
        expect(resultBeforeReadyToShow).toEqual({
            success: false,
            error: 'PDF viewer did not become ready to print within 15000ms',
        });
        expect(printWindow?.webContents.print).not.toHaveBeenCalled();
        expect(printWindow?.close).toHaveBeenCalledTimes(1);
    });

    it('cancels the PDF readiness wait without dispatching native print', async () => {
        vi.useFakeTimers();
        mocks.MockBrowserWindow.emitPdfReadyToPrintByDefault = false;

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        await flushPrintPromises();

        const printWindow = mocks.browserWindowInstances[0];
        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');

        await expect(resultPromise).resolves.toMatchObject({
            success: false,
            canceled: true,
        });
        expect(printWindow?.webContents.print).not.toHaveBeenCalled();
        expect(printWindow?.close).toHaveBeenCalledTimes(1);
        expect(printWindow?.webContents.removeListener).toHaveBeenCalledWith(
            '-pdf-ready-to-print',
            expect.any(Function),
        );
    });

    it('cleans the PDF readiness listener when loading the source fails', async () => {
        mocks.MockBrowserWindow.rejectLoadURLByDefault = true;

        const result = await handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        const printWindow = mocks.browserWindowInstances[0];

        expect(result).toEqual({
            success: false,
            error: 'PDF load failed',
        });
        expect(printWindow?.webContents.print).not.toHaveBeenCalled();
        expect(printWindow?.close).toHaveBeenCalledTimes(1);
        expect(printWindow?.webContents.removeListener).toHaveBeenCalledWith(
            '-pdf-ready-to-print',
            expect.any(Function),
        );
    });

    it.each([
        [
            'render-process-gone',
            'Print renderer exited before the PDF viewer became ready',
        ],
        [
            'destroyed',
            'Print web contents destroyed before the PDF viewer became ready',
        ],
    ] as const)('fails immediately when PDF readiness ends with %s', async (event, error) => {
        vi.useFakeTimers();
        mocks.MockBrowserWindow.emitPdfReadyToPrintByDefault = false;

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        await flushPrintPromises();

        const printWindow = mocks.browserWindowInstances[0];
        printWindow?.emitWebContents(event);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            error,
        });
        expect(printWindow?.webContents.print).not.toHaveBeenCalled();
        expect(printWindow?.close).toHaveBeenCalledTimes(1);
        expect(printWindow?.webContents.removeListener).toHaveBeenCalledWith(
            '-pdf-ready-to-print',
            expect.any(Function),
        );
        expect(printWindow?.webContents.removeListener).toHaveBeenCalledWith(
            event,
            expect.any(Function),
        );
    });

    it('uses the macOS PDFKit helper without creating a BrowserWindow', async () => {
        mocks.runtimePlatform = 'darwin';
        const onNativePrintDialogOpened = vi.fn();

        await expect(handlePrintPdfPath(
            {
                ...windowContext,
                onNativePrintDialogOpened,
            },
            sourcePdfPath,
            'source.pdf',
            {
                requestId: requireRequestId('mac-print-request'),
                viewMode: 'single',
                orientation: 'auto',
            },
        )).resolves.toEqual({success: true});

        expect(mocks.openMacOsPdfPrintDialog).toHaveBeenCalledWith(
            sourcePdfPath,
            expect.objectContaining({
                onNativeDialogOpened: expect.any(Function),
                signal: expect.any(AbortSignal),
            }),
        );
        expect(onNativePrintDialogOpened).toHaveBeenCalledWith('mac-print-request');
        expect(mocks.browserWindowInstances).toHaveLength(0);
    });

    it('returns the native macOS helper error without opening a BrowserWindow', async () => {
        mocks.runtimePlatform = 'darwin';
        mocks.openMacOsPdfPrintDialog.mockRejectedValue(new Error('Native print helper failed'));

        await expect(handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        )).resolves.toEqual({
            success: false,
            error: 'Native print helper failed',
        });
        expect(mocks.browserWindowInstances).toHaveLength(0);
    });

    it('accepts captured print pixels regardless of page color', () => {
        const dark = Buffer.alloc(4 * 4 * 4, 20);
        const light = Buffer.alloc(4 * 4 * 4, 255);
        for (let offset = 3; offset < light.byteLength; offset += 4) {
            light[offset] = 0;
        }

        expect(isCapturedPrintSurfaceBitmap(Buffer.alloc(0), 4, 4)).toBe(false);
        expect(isCapturedPrintSurfaceBitmap(dark, 4, 4)).toBe(true);
        expect(isCapturedPrintSurfaceBitmap(light, 4, 4)).toBe(true);
    });

    it('dispatches a path larger than 2 GiB without applying the byte handoff cap', async () => {
        vi.useFakeTimers();
        mocks.stat.mockResolvedValue({
            ctimeMs: 0,
            isFile: () => true,
            mtimeMs: 0,
            size: 3 * 1024 * 1024 * 1024,
        });

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'large-source.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.pdfDocumentLoad).not.toHaveBeenCalled();
        if (mocks.runtimePlatform === 'darwin') {
            expect(mocks.openMacOsPdfPrintDialog).toHaveBeenCalledWith(
                sourcePdfPath,
                expect.objectContaining({signal: expect.any(AbortSignal)}),
            );
            expect(mocks.browserWindowInstances).toHaveLength(0);
        } else {
            expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
                pathToFileURL(sourcePdfPath).toString(),
            );

            await vi.runOnlyPendingTimersAsync();
            expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        }
    });

    it('fails closed before composing an oversized advanced-layout path', async () => {
        mocks.stat
            .mockResolvedValueOnce({
                ctimeMs: 0,
                isFile: () => true,
                mtimeMs: 0,
                size: validPdfBytes.byteLength,
            })
            .mockResolvedValueOnce({
                ctimeMs: 0,
                isFile: () => true,
                mtimeMs: 0,
                size: PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES + 1,
            });

        await expect(handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'oversized-layout.pdf',
            {
                viewMode: 'facing',
                orientation: 'auto',
            },
        )).rejects.toThrow('PDF is too large for advanced print layout');

        expect(mocks.buildPrintablePdfPath).not.toHaveBeenCalled();
        expect(mocks.openMacOsPdfPrintDialog).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances).toHaveLength(0);
    });

    it('composes facing-page layout before printing one transformed page per sheet', async () => {
        vi.useFakeTimers();
        mocks.runtimePlatform = 'darwin';
        const onNativePrintDialogOpened = vi.fn();
        const resultPromise = handlePrintPdfPath(
            {
                ...windowContext,
                onNativePrintDialogOpened,
            },
            sourcePdfPath,
            'facing.pdf',
            {
                viewMode: 'facing',
                orientation: 'landscape',
                requestId: requireRequestId('facing-print-request'),
            },
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});
        expect(mocks.extractPages).not.toHaveBeenCalled();
        const transformedPath = `${tempRoot}/print-layout-print-job-id.pdf`;
        expect(mocks.buildPrintablePdfPath).toHaveBeenCalledWith({
            inputPath: sourcePdfPath,
            outputPath: transformedPath,
            printOptions: {
                viewMode: 'facing',
                orientation: 'landscape',
                requestId: requireRequestId('facing-print-request'),
            },
            signal: expect.any(AbortSignal),
        });
        if (mocks.runtimePlatform === 'darwin') {
            expect(mocks.openMacOsPdfPrintDialog).toHaveBeenCalledWith(
                transformedPath,
                expect.objectContaining({
                    onNativeDialogOpened: expect.any(Function),
                    signal: expect.any(AbortSignal),
                }),
            );
            expect(mocks.browserWindowInstances).toHaveLength(0);
        } else {
            expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
                pathToFileURL(transformedPath).toString(),
            );
            expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledWith(
                expect.not.objectContaining({pagesPerSheet: expect.anything()}),
                expect.any(Function),
            );
        }
        expect(onNativePrintDialogOpened).toHaveBeenCalledOnce();
        expect(onNativePrintDialogOpened).toHaveBeenCalledWith('facing-print-request');

        await vi.runOnlyPendingTimersAsync();
        expect(mocks.unlink).toHaveBeenCalledWith(transformedPath);
    });

    it('supports first-page-single layout through the printable PDF compositor', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'first-single.pdf',
            {
                viewMode: 'facing-first-single',
                orientation: 'auto',
            },
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});
        const transformedPath = `${tempRoot}/print-layout-print-job-id.pdf`;
        expect(mocks.buildPrintablePdfPath).toHaveBeenCalledWith({
            inputPath: sourcePdfPath,
            outputPath: transformedPath,
            printOptions: {
                viewMode: 'facing-first-single',
                orientation: 'auto',
            },
            signal: expect.any(AbortSignal),
        });
        if (mocks.runtimePlatform === 'darwin') {
            expect(mocks.openMacOsPdfPrintDialog).toHaveBeenCalledWith(
                transformedPath,
                expect.objectContaining({signal: expect.any(AbortSignal)}),
            );
            expect(mocks.browserWindowInstances).toHaveLength(0);
        } else {
            expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
                pathToFileURL(transformedPath).toString(),
            );
            expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledWith(
                expect.not.objectContaining({pagesPerSheet: expect.anything()}),
                expect.any(Function),
            );
        }

        await vi.runOnlyPendingTimersAsync();
        expect(mocks.unlink).toHaveBeenCalledWith(transformedPath);
    });

    it('uses the env-gated print-to-PDF smoke mode without opening the native dialog', async () => {
        process.env.EVB_PRINT_DIALOG_TEST_MODE = 'print-to-pdf';
        const smokeOutputPath = join(sourcePdfWorkDir, 'print-smoke-output.pdf');
        process.env.EVB_PRINT_DIALOG_TEST_OUTPUT_PATH = smokeOutputPath;
        writeFileSync(sourcePdfPath, multiPagePdfBytes);
        mocks.copyFile.mockImplementationOnce(async (sourcePath: string, outputPath: string) => {
            copyFileSync(sourcePath, outputPath);
        });

        const result = await handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.copyFile).toHaveBeenCalledWith(sourcePdfPath, smokeOutputPath);
        expect(readFileSync(smokeOutputPath)).toEqual(multiPagePdfBytes);
        expect(mocks.writeFile).not.toHaveBeenCalledWith(smokeOutputPath, expect.anything());
        expect(mocks.openMacOsPdfPrintDialog).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances).toHaveLength(0);
    });

    it('prints managed DjVu PDFs through a rasterized HTML surface', async () => {
        vi.useFakeTimers();
        mocks.pdfPageCount = 2;
        mocks.pdfPageSize = {
            width: 420,
            height: 594,
        };
        mocks.readdir.mockResolvedValue([
            'page-00001-2.jpg',
            'page-00001-1.jpg',
            'unrelated.jpg',
        ]);

        const resultPromise = printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'book.djvu',
            { surface: 'rasterized-html' },
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.pdfDocumentLoad).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '1',
                '-l',
                '100',
                sourcePdfPath,
            ],
            expect.objectContaining({
                commandLabel: 'pdfinfo(print-raster)',
                maxStdoutBytes: 64 * 1024,
                rejectOnStdoutTruncation: true,
            }),
        );
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdftoppm',
            [
                '-cropbox',
                '-jpeg',
                '-r',
                '180',
                '-f',
                '1',
                '-l',
                '2',
                sourcePdfPath,
                '/tmp/evb-viewer-test-profile/raster-work/page-00001',
            ],
            expect.objectContaining({
                commandLabel: 'pdftoppm(print-raster)',
                timeoutMs: 180_000,
            }),
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/evb-viewer-test-profile/raster-work/print.html',
            expect.stringContaining('data-page-number="2"'),
            'utf8',
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL('/tmp/evb-viewer-test-profile/raster-work/print.html').toString(),
        );
        expect(mocks.browserWindowInstances[0]?.showInactive).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.webContents.capturePage).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledWith(
            expect.objectContaining({ printBackground: true }),
            expect.any(Function),
        );
        expect(mocks.unlink).not.toHaveBeenCalledWith(sourcePdfPath);

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.rm).toHaveBeenCalledWith('/tmp/evb-viewer-test-profile/raster-work', {
            force: true,
            recursive: true,
        });
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('falls back to the PDF plugin when raster decoded pixels exceed the aggregate budget', async () => {
        vi.useFakeTimers();
        mocks.pdfPageCount = 100;
        mocks.pdfPageSize = {
            width: 612,
            height: 792,
        };

        const resultPromise = printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'large-book.djvu',
            {surface: 'rasterized-html'},
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '1',
                '-l',
                '100',
                sourcePdfPath,
            ],
            expect.any(Object),
        );
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(sourcePdfPath).toString(),
        );

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('falls back to the PDF plugin when raster metadata exceeds the raster page window', async () => {
        vi.useFakeTimers();
        mocks.pdfPageCount = 101;

        const resultPromise = printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'large-book.djvu',
            {surface: 'rasterized-html'},
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});
        expect(mocks.pdfDocumentLoad).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '1',
                '-l',
                '100',
                sourcePdfPath,
            ],
            expect.any(Object),
        );
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalledWith(
            '/mock/pdftoppm',
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
            pathToFileURL(sourcePdfPath).toString(),
        );

        await vi.runOnlyPendingTimersAsync();

        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('cleans up managed temp PDFs when bounded path validation fails before handoff', async () => {
        mocks.open.mockImplementationOnce(async () => ({
            close: vi.fn(async () => {}),
            read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
                const invalidPdfBytes = Buffer.from('not a PDF');
                const bytesRead = Math.min(length, invalidPdfBytes.byteLength);
                invalidPdfBytes.copy(buffer, offset, 0, bytesRead);
                return {
                    bytesRead,
                    buffer,
                };
            }),
        }));

        await expect(printManagedTempPdfPath(
            windowContext,
            sourcePdfPath,
            'oversized.pdf',
        )).rejects.toThrow('Invalid PDF path');

        expect(mocks.browserWindowInstances).toHaveLength(0);
        expect(mocks.unlink).toHaveBeenCalledWith(sourcePdfPath);
    });

    it('writes temporary PDF bytes before opening the native print dialog', async () => {
        vi.useFakeTimers();
        const onNativePrintDialogOpened = vi.fn();
        const resultPromise = handlePrintPdfData(
            {
                ...windowContext,
                onNativePrintDialogOpened,
            },
            validPdfBytes,
            'document.pdf',
            {requestId: requireRequestId('print-data-request')},
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            `${tempRoot}/print-data-print-job-id-document.pdf`,
            Buffer.from(validPdfBytes),
        );
        if (mocks.runtimePlatform === 'darwin') {
            expect(mocks.openMacOsPdfPrintDialog).toHaveBeenCalledWith(
                `${tempRoot}/print-data-print-job-id-document.pdf`,
                expect.objectContaining({
                    onNativeDialogOpened: expect.any(Function),
                    signal: expect.any(AbortSignal),
                }),
            );
            expect(mocks.browserWindowInstances).toHaveLength(0);
        } else {
            expect(mocks.browserWindowInstances[0]?.options).toEqual(expect.objectContaining({title: 'document'}));
        }
        expect(onNativePrintDialogOpened).toHaveBeenCalledOnce();
        expect(onNativePrintDialogOpened).toHaveBeenCalledWith('print-data-request');
        expect(mocks.unlink).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        if (mocks.runtimePlatform !== 'darwin') {
            expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        }
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
    });

    it('cancels a data print before opening the native dialog', async () => {
        const write = Promise.withResolvers<undefined>();
        mocks.writeFile.mockImplementationOnce(() => write.promise);
        const printPromise = handlePrintPdfData(
            windowContext,
            validPdfBytes,
            'document.pdf',
            {requestId: requireRequestId('cancel-data-print')},
        );
        await vi.waitFor(() => expect(mocks.writeFile).toHaveBeenCalledOnce());

        await expect(handleCancelPdfPrint(
            {senderId},
            'cancel-data-print',
        )).resolves.toEqual({canceled: true});
        write.resolve(undefined);

        await expect(printPromise).rejects.toMatchObject({message: 'PDF print canceled'});
        expect(mocks.browserWindowInstances).toHaveLength(0);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
        await expect(handleCancelPdfPrint(
            {senderId},
            'cancel-data-print',
        )).resolves.toEqual({canceled: false});
    });

    it('extracts requested pages to a temporary PDF before opening the native print dialog', async () => {
        vi.useFakeTimers();
        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            {
                pageNumbers: [requirePageNumber(4)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({ success: true });
        expect(mocks.extractPages).toHaveBeenCalledWith(
            sourcePdfPath,
            `${tempRoot}/print-pages-print-job-id.pdf`,
            [4],
            expect.objectContaining({
                cancelGroup: expect.any(String),
                signal: expect.any(AbortSignal),
            }),
        );
        const selectedPagesPath = `${tempRoot}/print-pages-print-job-id.pdf`;
        if (mocks.runtimePlatform === 'darwin') {
            expect(mocks.openMacOsPdfPrintDialog).toHaveBeenCalledWith(
                selectedPagesPath,
                expect.objectContaining({signal: expect.any(AbortSignal)}),
            );
            expect(mocks.browserWindowInstances).toHaveLength(0);
        } else {
            expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
                pathToFileURL(selectedPagesPath).toString(),
            );
            expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledWith(
                expect.objectContaining({pageRanges: [{
                    from: 0,
                    to: 0,
                }]}),
                expect.any(Function),
            );
        }
        expect(mocks.unlink).not.toHaveBeenCalled();

        await vi.runOnlyPendingTimersAsync();

        if (mocks.runtimePlatform !== 'darwin') {
            expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        }
        expect(mocks.unlink).toHaveBeenCalledWith(selectedPagesPath);
    });

    it('cancels selected-page print when the renderer ends during materialization', async () => {
        const materialization = Promise.withResolvers<undefined>();
        mocks.ensureWorkingCopyMaterialized.mockImplementationOnce(async (path: string, options: {signal?: AbortSignal}) => {
            await materialization.promise;
            if (options.signal?.aborted) {
                throw options.signal.reason;
            }
            return {
                logicalRef: path,
                physicalWorkingCopyPath: path,
                sourceFingerprint: '',
            };
        });

        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            {
                pageNumbers: [requirePageNumber(4)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );
        await vi.waitFor(() => expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledOnce());

        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');
        materialization.resolve(undefined);

        await expect(printPromise).rejects.toMatchObject({message: 'Renderer lifecycle ended'});
        expect(mocks.extractPages).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances).toHaveLength(0);
    });

    it('cancels a direct path print by its sender-scoped request ID', async () => {
        const materialization = Promise.withResolvers<undefined>();
        mocks.ensureWorkingCopyMaterialized.mockImplementationOnce(async (path: string, options: {signal?: AbortSignal}) => {
            await materialization.promise;
            options.signal?.throwIfAborted();
            return {
                logicalRef: path,
                physicalWorkingCopyPath: path,
                sourceFingerprint: '',
            };
        });
        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            {
                viewMode: 'single',
                orientation: 'auto',
                requestId: requireRequestId('cancel-path-print'),
            },
        );
        await vi.waitFor(() => expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledOnce());

        await expect(handleCancelPdfPrint(
            {senderId},
            'cancel-path-print',
        )).resolves.toEqual({canceled: true});
        materialization.resolve(undefined);

        await expect(printPromise).rejects.toMatchObject({message: 'PDF print canceled'});
        expect(mocks.browserWindowInstances).toHaveLength(0);
        expect(mocks.cancelNativeCommandGroup).not.toHaveBeenCalled();
    });

    it('cancels selected-page extraction when the renderer ends during qpdf work', async () => {
        const extraction = Promise.withResolvers<undefined>();
        let extractionCancelGroup: string | null = null;
        mocks.extractPages.mockImplementationOnce(async (...args: unknown[]) => {
            const options = args[3] as {
                cancelGroup: string;
                signal: AbortSignal;
            };
            extractionCancelGroup = options.cancelGroup;
            options.signal.addEventListener('abort', () => extraction.reject(options.signal.reason), {once: true});
            await extraction.promise;
        });

        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            {
                pageNumbers: [requirePageNumber(4)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );
        await vi.waitFor(() => expect(mocks.extractPages).toHaveBeenCalledOnce());

        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');

        await expect(printPromise).rejects.toMatchObject({message: 'Renderer lifecycle ended'});
        await vi.waitFor(() => expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledOnce());
        expect(extractionCancelGroup).toEqual(expect.any(String));
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(extractionCancelGroup);
        expect(mocks.browserWindowInstances).toHaveLength(0);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-pages-print-job-id.pdf`);
    });

    it('keeps selected-page staging names opaque and within the filesystem byte limit', async () => {
        vi.useFakeTimers();
        const userFileName = `${'документ-'.repeat(300)}.pdf`;
        let selectedPagesPath: string | undefined;
        mocks.extractPages.mockImplementationOnce(async (...args: unknown[]) => {
            const outputPath = args[1] as string;
            selectedPagesPath = outputPath;
            writeFileSync(outputPath, validPdfBytes);
        });

        const resultPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            userFileName,
            {
                pageNumbers: [requirePageNumber(4)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({success: true});
        expect(selectedPagesPath).toBeDefined();
        const selectedPagesName = basename(selectedPagesPath!);
        expect(Buffer.byteLength(selectedPagesName, 'utf8')).toBeLessThanOrEqual(255);
        expect(selectedPagesName).toMatch(/^print-pages-[A-Za-z0-9-]+\.pdf$/u);
        expect(selectedPagesName).not.toContain('документ');
        expect(existsSync(selectedPagesPath!)).toBe(true);
        expect(mocks.browserWindowInstances[0]?.options).toEqual(expect.objectContaining({title: userFileName.slice(0, -4)}));

        await vi.runOnlyPendingTimersAsync();
        rmSync(selectedPagesPath!, {force: true});
    });

    it('uses distinct operation-owned staging names for concurrent selected-page prints', async () => {
        vi.useFakeTimers();
        let operationIndex = 0;
        mocks.randomUUID.mockImplementation(() => `operation-${++operationIndex}`);

        const firstPrint = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'first user document.pdf',
            {
                pageNumbers: [requirePageNumber(1)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );
        const secondPrint = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'second user document.pdf',
            {
                pageNumbers: [requirePageNumber(2)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );

        await flushPrintPromises();
        const stagedPaths = mocks.extractPages.mock.calls.map(call => call[1] as string);
        expect(stagedPaths).toHaveLength(2);
        expect(new Set(stagedPaths).size).toBe(2);
        for (const stagedPath of stagedPaths) {
            const stagedName = basename(stagedPath);
            expect(stagedName).toMatch(/^print-pages-operation-[0-9]+\.pdf$/u);
            expect(Buffer.byteLength(stagedName, 'utf8')).toBeLessThanOrEqual(255);
        }

        await vi.runOnlyPendingTimersAsync();
        await expect(firstPrint).resolves.toEqual({success: true});
        await expect(secondPrint).resolves.toEqual({success: true});
    });

    it('cleans up an advanced-layout staging file when composition fails', async () => {
        mocks.buildPrintablePdfPath.mockRejectedValueOnce(new Error('composition failed'));

        await expect(handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'a very long user-facing print title '.repeat(100),
            {
                viewMode: 'facing',
                orientation: 'landscape',
            },
        )).rejects.toThrow('composition failed');

        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-layout-print-job-id.pdf`);
    });

    it('cancels the selected-page native handoff while the plugin surface is still dark', async () => {
        vi.useFakeTimers();
        mocks.printSurfaceBitmap = Buffer.alloc(0);
        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
            {
                pageNumbers: [requirePageNumber(4)],
                viewMode: 'single',
                orientation: 'auto',
            },
        );
        await flushPrintPromises();
        // The paint probe only runs where the plugin window is compositor-visible (macOS).
        expect(mocks.browserWindowInstances[0]?.webContents.capturePage)
            .toHaveBeenCalledTimes(mocks.runtimePlatform === 'darwin' ? 1 : 0);

        cancelMainOperationsForOwner(senderId, 'Renderer lifecycle ended');
        await vi.advanceTimersByTimeAsync(250);

        await expect(printPromise).resolves.toMatchObject({
            success: false,
            canceled: true,
        });
        expect(mocks.browserWindowInstances[0]?.webContents.print).not.toHaveBeenCalled();
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('opens the native dialog after the bounded paint probe times out', async () => {
        vi.useFakeTimers();
        mocks.printSurfaceBitmap = Buffer.alloc(0);
        const resultPromise = handlePrintPdfPath(windowContext, sourcePdfPath, 'source.pdf');
        await flushPrintPromises();

        await vi.advanceTimersByTimeAsync(17_000);

        await expect(resultPromise).resolves.toEqual({success: true});
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalledTimes(1);
    });

    it('cleans up print resources immediately when native printing fails', async () => {
        vi.useFakeTimers();
        mocks.printHandler.mockImplementationOnce((
            _options: unknown,
            callback: (success: boolean, failureReason?: string) => void,
        ) => callback(false, 'printer unavailable'));

        const resultPromise = handlePrintPdfData(
            windowContext,
            validPdfBytes,
            'document.pdf',
        );
        const result = await settleNativePrint(resultPromise);

        expect(result).toEqual({
            success: false,
            error: 'printer unavailable',
        });
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
    });

    it('fails and cleans up when the native print callback never arrives', async () => {
        vi.useFakeTimers();
        mocks.printHandler.mockImplementationOnce(() => undefined);

        const resultPromise = handlePrintPdfData(
            windowContext,
            validPdfBytes,
            'document.pdf',
        );
        for (let index = 0; index < 12; index += 1) {
            await Promise.resolve();
        }
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mocks.browserWindowInstances[0]?.webContents.print).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync((5 * 60 * 1000) + 1);
        const result = await resultPromise;

        expect(result).toEqual({
            success: false,
            error: 'Print dialog timed out after 300000ms',
        });
        expect(mocks.browserWindowInstances[0]?.close).toHaveBeenCalledTimes(1);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-print-job-id-document.pdf`);
    });

    it('opens an existing PDF path in the default desktop app', async () => {
        const result = await handleOpenPdfInDefaultAppPath(
            {senderId},
            sourcePdfPath,
            'source.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.openPath).toHaveBeenCalledWith(sourcePdfPath);
        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledWith(sourcePdfPath, {
            ownerWebContentsId: senderId,
            reason: 'print-external',
        });
    });

    it('materializes lazy-original paths before print and default-app handoff', async () => {
        const materializedPath = `${sourcePdfWorkDir}/materialized.pdf`;
        mocks.ensureWorkingCopyMaterialized.mockResolvedValue({
            logicalRef: sourcePdfPath,
            physicalWorkingCopyPath: materializedPath,
            sourceFingerprint: 'source-fingerprint',
        });

        vi.useFakeTimers();
        const printPromise = handlePrintPdfPath(
            windowContext,
            sourcePdfPath,
            'source.pdf',
        );
        await expect(settleNativePrint(printPromise)).resolves.toEqual({success: true});
        await expect(handleOpenPdfInDefaultAppPath(
            {senderId},
            sourcePdfPath,
            'source.pdf',
        )).resolves.toEqual({success: true});

        if (mocks.runtimePlatform === 'darwin') {
            expect(mocks.openMacOsPdfPrintDialog).toHaveBeenCalledWith(
                materializedPath,
                expect.objectContaining({signal: expect.any(AbortSignal)}),
            );
            expect(mocks.browserWindowInstances).toHaveLength(0);
        } else {
            expect(mocks.browserWindowInstances[0]?.loadURL).toHaveBeenCalledWith(
                pathToFileURL(materializedPath).toString(),
            );
        }
        expect(mocks.openPath).toHaveBeenCalledWith(materializedPath);
    });

    it('writes PDF bytes to a temp file before opening the default desktop app', async () => {
        const result = await handleOpenPdfInDefaultAppData(
            validPdfBytes,
            'document.pdf',
        );

        expect(result).toEqual({ success: true });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            `${tempRoot}/open-in-default-app-print-job-id-document.pdf`,
            Buffer.from(validPdfBytes),
        );
        expect(mocks.openPath).toHaveBeenCalledWith(`${tempRoot}/open-in-default-app-print-job-id-document.pdf`);
        expect(mocks.unlink).not.toHaveBeenCalled();
    });

    it('sweeps only stale PDF handoff temp files', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        mocks.readdir.mockResolvedValue([
            'open-in-default-app-stale.pdf',
            'open-in-default-app-fresh.pdf',
            'open-in-default-app-note.txt',
            'print-data-stale.pdf',
            'print-pages-stale.pdf',
            'other.pdf',
        ]);
        mocks.stat.mockImplementation(async (path: string) => ({
            ctimeMs: path.includes('fresh') ? 9_900 : 0,
            isFile: () => true,
            mtimeMs: path.includes('fresh') ? 9_900 : 0,
        }));

        await sweepStaleDefaultAppTempPdfs(5_000);

        expect(mocks.stat).toHaveBeenCalledTimes(4);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/open-in-default-app-stale.pdf`);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-data-stale.pdf`);
        expect(mocks.unlink).toHaveBeenCalledWith(`${tempRoot}/print-pages-stale.pdf`);
        expect(mocks.unlink).not.toHaveBeenCalledWith(`${tempRoot}/open-in-default-app-fresh.pdf`);
        expect(mocks.unlink).not.toHaveBeenCalledWith(`${tempRoot}/other.pdf`);
    });
});
