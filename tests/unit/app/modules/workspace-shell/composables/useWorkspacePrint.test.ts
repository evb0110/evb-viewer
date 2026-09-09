import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { uniq } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import { useWorkspacePrint } from '@app/modules/workspace-shell/composables/useWorkspacePrint';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { requireDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import { PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES } from '@contracts/shared';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';
import {
    createRangePageSelection,
    type TPageSelection,
} from '@contracts/pageNumbers';

type TShouldPrintPageMetricsDirectly = (
    metrics: Array<{
        width: number;
        height: number;
    }>,
    options: {
        viewMode: string;
        orientation: string;
        pageNumbers?: number[];
    },
) => boolean | null;

const buildBrowserPrintFrameMarkupMock = vi.hoisted(() => vi.fn(() => '<html><body><main data-browser-print-root></main></body></html>'));
const buildPrintablePdfDataMock = vi.hoisted(() => vi.fn());
const renderPdfPagesForBrowserPrintMock = vi.hoisted(() => vi.fn(async () => {}));
const shouldPrintPageMetricsDirectlyMock = vi.hoisted(() => vi.fn<TShouldPrintPageMetricsDirectly>(() => null));
const shouldPrintSourcePdfDirectlyMock = vi.hoisted(() => vi.fn(async () => true));
const waitForPrintPaintMock = vi.hoisted(() => vi.fn(async () => {}));
const createObjectURLMock = vi.hoisted(() => vi.fn(() => 'blob:print-pdf'));
const revokeObjectURLMock = vi.hoisted(() => vi.fn());
const documentsCapabilityMock = vi.hoisted(() => {
    let nativePrintDialogOpenedListener: ((event: {requestId: string}) => void) | null = null;
    const unsubscribeNativePrintDialogOpened = vi.fn(() => {
        nativePrintDialogOpenedListener = null;
    });
    return {
        cancelPdfPrint: vi.fn(),
        emitNativePrintDialogOpened: (event: {requestId: string}) => nativePrintDialogOpenedListener?.(event),
        onNativePrintDialogOpened: vi.fn((listener: (event: {requestId: string}) => void) => {
            nativePrintDialogOpenedListener = listener;
            return unsubscribeNativePrintDialogOpened;
        }),
        openPdfInDefaultAppData: vi.fn(),
        openPdfInDefaultAppPath: vi.fn(),
        printPdfData: vi.fn(),
        printPdfPath: vi.fn(),
        resetNativePrintDialogOpened: () => {
            nativePrintDialogOpenedListener = null;
        },
        unsubscribeNativePrintDialogOpened,
    };
});
const toastAddMock = vi.hoisted(() => vi.fn());
const toastRemoveMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/pdfPrint', () => ({
    buildPrintablePdfData: buildPrintablePdfDataMock,
    canPrintSourcePdfDirectly: (options: {
        pageNumbers?: number[];
        viewMode: string;
        orientation: string;
    }) => (
        options.viewMode === 'single'
        && options.orientation === 'auto'
        && (!options.pageNumbers || options.pageNumbers.length === 0)
    ),
    renderPdfPagesForBrowserPrint: renderPdfPagesForBrowserPrintMock,
    shouldPrintPageMetricsDirectly: shouldPrintPageMetricsDirectlyMock,
    shouldPrintSourcePdfDirectly: shouldPrintSourcePdfDirectlyMock,
    waitForPrintPaint: waitForPrintPaintMock,
}));

vi.mock('@app/utils/pdfPrintShared', () => ({
    buildBrowserPrintFrameMarkup: buildBrowserPrintFrameMarkupMock,
    normalizePrintPageNumbers: (pageNumbers: number[] | undefined, totalPages: number) => {
        if (!pageNumbers?.length) {
            return range(1, totalPages + 1);
        }

        return uniq(pageNumbers)
            .filter(pageNumber => Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= totalPages)
            .sort((left, right) => left - right);
    },
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentPdfCapability: () => documentsCapabilityMock,
    isNativePrintCapabilityUnavailable: (result: {
        success: boolean;
        canceled?: boolean;
        error?: string;
    }) => (
        result.success !== true
        && result.canceled !== true
        && result.error === 'Printing via the native desktop dialog is unavailable in the browser capability'
    ),
}));

interface IFakeFrameWindow {
    addEventListener: ReturnType<typeof vi.fn>;
    document: { querySelector: ReturnType<typeof vi.fn>; };
    removeEventListener: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    print: ReturnType<typeof vi.fn>;
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
}

interface IFakeFrame {
    style: Record<string, string>;
    tabIndex: number;
    src: string;
    srcdoc: string;
    setAttribute: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    contentWindow: IFakeFrameWindow | null;
    trigger: (eventName: string) => void;
    waitForListener: (eventName: string) => Promise<void>;
}

function createFakeFrame() {
    const listeners = new Map<string, EventListener>();
    const listenerWaiters = new Map<string, Set<() => void>>();
    const frameDocument = { querySelector: vi.fn(() => ({
        replaceChildren: vi.fn(),
        append: vi.fn(),
    })) };
    const frameWindow: IFakeFrameWindow = {
        addEventListener: vi.fn(),
        document: frameDocument,
        removeEventListener: vi.fn(),
        focus: vi.fn(),
        print: vi.fn(),
        requestAnimationFrame: (callback) => {
            callback(0);
            return 1;
        },
    };
    const frame: IFakeFrame = {
        style: {},
        tabIndex: 0,
        src: '',
        srcdoc: '',
        setAttribute: vi.fn(),
        remove: vi.fn(),
        addEventListener: vi.fn((eventName: string, listener: EventListener) => {
            listeners.set(eventName, listener);
            for (const resolve of listenerWaiters.get(eventName) ?? []) {
                resolve();
            }
            listenerWaiters.delete(eventName);
        }),
        removeEventListener: vi.fn((eventName: string) => {
            listeners.delete(eventName);
        }),
        contentWindow: frameWindow,
        trigger: (eventName) => {
            listeners.get(eventName)?.(new Event(eventName));
        },
        waitForListener: (eventName) => {
            if (listeners.has(eventName)) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                const waiters = listenerWaiters.get(eventName) ?? new Set();
                waiters.add(resolve);
                listenerWaiters.set(eventName, waiters);
            });
        },
    };

    return {
        frame,
        frameWindow,
    };
}

function stubDocumentWithFrame(appFrame = createFakeFrame()) {
    vi.stubGlobal('document', {
        body: { append: vi.fn() },
        createElement: vi.fn((tag: string) => {
            if (tag !== 'iframe') {
                throw new Error(`Unexpected element: ${tag}`);
            }
            return appFrame.frame;
        }),
    });

    return appFrame;
}

function stubDocumentWithFrames(frames: Array<ReturnType<typeof createFakeFrame>>) {
    let frameCreateCount = 0;
    vi.stubGlobal('document', {
        body: { append: vi.fn() },
        createElement: vi.fn((tag: string) => {
            if (tag !== 'iframe') {
                throw new Error(`Unexpected element: ${tag}`);
            }
            const frame = frames[frameCreateCount];
            frameCreateCount += 1;
            return frame?.frame ?? frames.at(-1)!.frame;
        }),
    });
}

async function flushMicrotasks(iterations = 6) {
    for (let index = 0; index < iterations; index += 1) {
        await Promise.resolve();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let index = 0; index < iterations; index += 1) {
        await Promise.resolve();
    }
}

function createState(options?: {
    totalPages?: number;
    sourcePdf?: TPdfSource | null;
    workingCopyPath?: string | null;
    fileName?: string | null;
    hasPendingUnsavedChanges?: boolean;
    hasPendingPrintSerializationChanges?: boolean;
    selectedPageSelection?: TPageSelection;
    getQuickPrintPageMetrics?: () => Promise<Array<{
        width: number;
        height: number;
    }> | null>;
    getPrintableSourceData?: (options?: { signal?: AbortSignal }) => Promise<Uint8Array | null>;
    ensurePrintReady?: () => Promise<boolean>;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean | string | null>;
    getLastFailurePresentation?: () => FailurePresentation | null;
    getCurrentPrintPage?: () => number | null | undefined;
    printDjvuSource?: (
        payload: {
            pageNumbers?: number[];
            viewMode: string;
            orientation: string;
        },
        options?: {
            onNativePrintHandoffStart?: () => void;
            signal?: AbortSignal;
        },
    ) => Promise<void>;
    renderLoadedPdfPagesForBrowserPrint?: (
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        options?: { signal?: AbortSignal },
    ) => Promise<void>;
}) {
    const getQuickPrintPageMetrics = options?.getQuickPrintPageMetrics ?? vi.fn(async () => null);
    const getPrintableSourceData = options?.getPrintableSourceData ?? vi.fn(async () => Uint8Array.of(9, 8, 7));
    const scope = effectScope();
    const state = scope.run(() => useWorkspacePrint({
        totalPages: ref(options?.totalPages ?? 10),
        currentPage: ref(4),
        selectedPages: ref([
            3,
            1,
            3,
        ]),
        ...(options?.selectedPageSelection
            ? {selectedPageSelection: ref(options.selectedPageSelection)}
            : {}),
        sourcePdf: ref(options?.sourcePdf ?? null),
        workingCopyPath: ref(options?.workingCopyPath === undefined
            ? '/tmp/document.pdf'
            : options.workingCopyPath),
        fileName: ref(options?.fileName ?? 'document.pdf'),
        hasPendingUnsavedChanges: ref(options?.hasPendingUnsavedChanges ?? false),
        ...(options?.hasPendingPrintSerializationChanges !== undefined
            ? { hasPendingPrintSerializationChanges: ref(options.hasPendingPrintSerializationChanges) }
            : {}),
        ...(options?.getCurrentPrintPage
            ? { getCurrentPrintPage: options.getCurrentPrintPage }
            : {}),
        getQuickPrintPageMetrics,
        ...(options?.ensurePrintReady ? {ensurePrintReady: options.ensurePrintReady} : {}),
        ...(options?.ensureWorkingCopyFreshForRead
            ? {ensureWorkingCopyFreshForRead: options.ensureWorkingCopyFreshForRead}
            : {}),
        ...(options?.getLastFailurePresentation
            ? {getLastFailurePresentation: options.getLastFailurePresentation}
            : {}),
        getPrintableSourceData,
        ...(options?.printDjvuSource
            ? {preparePrintSource: async (payload, printOptions) => {
                await options.printDjvuSource!(payload, printOptions);
                return {status: 'completed' as const};
            }}
            : {}),
        ...(options?.renderLoadedPdfPagesForBrowserPrint
            ? { renderLoadedPdfPagesForBrowserPrint: options.renderLoadedPdfPagesForBrowserPrint }
            : {}),
    }));

    if (!state) {
        throw new Error('Failed to create workspace print scope');
    }

    return {
        getQuickPrintPageMetrics,
        getPrintableSourceData,
        scope,
        state,
    };
}

describe('useWorkspacePrint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        documentsCapabilityMock.resetNativePrintDialogOpened();
        buildBrowserPrintFrameMarkupMock.mockReturnValue('<html><body><main data-browser-print-root></main></body></html>');
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        createObjectURLMock.mockReturnValue('blob:print-pdf');
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(null);
        shouldPrintSourcePdfDirectlyMock.mockResolvedValue(true);
        toastAddMock.mockReturnValue({ id: 'toast-id' });
        documentsCapabilityMock.openPdfInDefaultAppData.mockResolvedValue({ success: false });
        documentsCapabilityMock.openPdfInDefaultAppPath.mockResolvedValue({ success: false });
        documentsCapabilityMock.cancelPdfPrint.mockResolvedValue({canceled: true});
        documentsCapabilityMock.printPdfData.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string, params?: Record<string, unknown>) => {
            if (key === 'print.failedWithReason' && params?.reason) {
                return `print.failedWithReason:${String(params.reason)}`;
            }
            return key;
        } }));
        vi.stubGlobal('useToast', () => ({
            add: toastAddMock,
            remove: toastRemoveMock,
        }));
        vi.stubGlobal('URL', {
            createObjectURL: createObjectURLMock,
            revokeObjectURL: revokeObjectURLMock,
        });

        let timerId = 0;
        vi.stubGlobal('window', {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            focus: vi.fn(),
            print: vi.fn(),
            setTimeout: vi.fn((callback: () => void, delay?: number) => {
                timerId += 1;
                if (delay === 300) {
                    callback();
                }
                return timerId;
            }),
            clearTimeout: vi.fn(),
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 1;
            },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('refuses a large partial compact selection instead of printing all pages', async () => {
        const selection = createRangePageSelection(1_000_000, 2, 100_002);
        const {
            scope,
            state,
        } = createState({
            totalPages: 1_000_000,
            selectedPageSelection: selection,
        });

        try {
            state.handlePrint();
            expect(state.printDialogPageSelection.value).toEqual(selection);

            await state.handlePrintDialogSubmit({
                pageSelection: selection,
                viewMode: 'single',
                orientation: 'auto',
            });

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(state.printError.value).toBeNull();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'warning',
                title: 'print.selectionTooLarge',
            }));
        } finally {
            scope.stop();
        }
    });

    it('falls back to the current dense selection when the compact selection is stale', () => {
        const staleSelection = createRangePageSelection(9, 2, 8);
        const {
            scope,
            state,
        } = createState({
            totalPages: 10,
            selectedPageSelection: staleSelection,
        });

        try {
            state.handlePrint();

            expect(state.printDialogPageSelection.value).toEqual({
                kind: 'explicit',
                pageCount: 10,
                pages: [
                    1,
                    3,
                ],
            });
        } finally {
            scope.stop();
        }
    });

    it('keeps print preparation strict single-flight under reentrant commands', async () => {
        const readiness = Promise.withResolvers<boolean>();
        const ensurePrintReady = vi.fn(() => readiness.promise);
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({ensurePrintReady});

        try {
            const first = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await Promise.resolve();
            expect(state.isPreparingPrint.value).toBe(true);

            const reentrant = state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'single',
                orientation: 'landscape',
            });
            await expect(reentrant).resolves.toBeUndefined();
            expect(ensurePrintReady).toHaveBeenCalledOnce();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                duration: 0,
                title: 'print.preparing',
            }));

            readiness.resolve(false);
            await first;

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('does not let an older afterprint callback remove a newer run frame', async () => {
        const firstFrame = createFakeFrame();
        const secondFrame = createFakeFrame();
        stubDocumentWithFrames([
            firstFrame,
            secondFrame,
        ]);
        const {
            scope,
            state,
        } = createState();

        try {
            const firstPrint = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);
            firstFrame.frame.trigger('load');
            await firstPrint;

            const fakeWindow = Reflect.get(globalThis, 'window');
            const addWindowEventListener = typeof fakeWindow === 'object' && fakeWindow !== null
                ? Reflect.get(fakeWindow, 'addEventListener')
                : null;
            if (!vi.isMockFunction(addWindowEventListener)) {
                throw new Error('Expected a mocked window event listener');
            }
            const oldAfterPrint = addWindowEventListener.mock.calls.find(([eventName]) => (
                String(eventName) === 'afterprint'
            ))?.[1] as ((event: Event) => void) | undefined;
            if (typeof oldAfterPrint !== 'function') {
                throw new Error('Expected the first print run afterprint callback');
            }

            const secondPrint = state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);
            expect(document.body.append).toHaveBeenLastCalledWith(secondFrame.frame);

            oldAfterPrint(new Event('afterprint'));
            expect(secondFrame.frame.remove).not.toHaveBeenCalled();

            secondFrame.frame.trigger('load');
            await secondPrint;
            expect(secondFrame.frameWindow.print).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });

    it('aborts printing when open annotation-note persistence is not ready', async () => {
        const ensurePrintReady = vi.fn(async () => false);
        const getPrintableSourceData = vi.fn(async () => Uint8Array.of(1, 2, 3));
        const {
            scope,
            state,
        } = createState({
            ensurePrintReady,
            getPrintableSourceData,
        });

        await state.handlePrintDialogSubmit({
            viewMode: 'single',
            orientation: 'auto',
        }, {reopenDialogOnError: false});

        expect(ensurePrintReady).toHaveBeenCalledOnce();
        expect(getPrintableSourceData).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'print.failed',
        }));
        scope.stop();
    });

    it('quick-prints through rendered browser printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/quick-print.pdf',
            fileName: 'quick-print.pdf',
            getQuickPrintPageMetrics: vi.fn(async () => [{
                width: 612,
                height: 792,
            }]),
        });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(true);

        try {
            const printPromise = state.handleQuickPrint();
            await flushMicrotasks(20);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);
            appFrame.frame.trigger('load');
            await printPromise;

            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(toastAddMock).not.toHaveBeenCalledWith({
                color: 'success',
                title: 'print.requestSent',
            });
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('dispatches a multi-gigabyte path source directly without resolving PDF bytes', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({success: true});
        const {
            getQuickPrintPageMetrics,
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/multi-gigabyte.pdf'),
                size: 3 * 1024 * 1024 * 1024,
            },
            workingCopyPath: '/tmp/multi-gigabyte.pdf',
            fileName: 'multi-gigabyte.pdf',
        });

        try {
            await state.handleQuickPrint();

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/multi-gigabyte.pdf',
                'multi-gigabyte.pdf',
                {
                    viewMode: 'single',
                    orientation: 'auto',
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
            expect(getQuickPrintPageMetrics).not.toHaveBeenCalled();
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).not.toHaveBeenCalled();
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('keeps all advanced path print controls available at the planning limits', () => {
        const pathState = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/path-backed.pdf'),
                size: PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES,
            },
            totalPages: 5_000,
        });

        try {
            expect(pathState.state.supportsAdvancedPrintOptions.value).toBe(true);
            expect(pathState.state.supportsFirstPageSinglePrintLayout.value).toBe(true);
        } finally {
            pathState.scope.stop();
        }
    });

    it('exposes only single-page automatic printing for an oversized path PDF', () => {
        const pathState = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/oversized-path.pdf'),
                size: 3 * 1024 * 1024 * 1024,
            },
            totalPages: 10,
        });

        try {
            expect(pathState.state.supportsAdvancedPrintOptions.value).toBe(false);
            expect(pathState.state.supportsFirstPageSinglePrintLayout.value).toBe(false);
        } finally {
            pathState.scope.stop();
        }
    });

    it('hides advanced path print controls above the page-count limit', () => {
        const pathState = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/high-page-count-path.pdf'),
                size: PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES,
            },
            totalPages: 5_001,
        });

        try {
            expect(pathState.state.supportsAdvancedPrintOptions.value).toBe(false);
            expect(pathState.state.supportsFirstPageSinglePrintLayout.value).toBe(false);
        } finally {
            pathState.scope.stop();
        }
    });

    it('dispatches directly representable selected pages to native path printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({success: true});
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/selected-pages.pdf'),
                size: 3 * 1024 * 1024 * 1024,
            },
            fileName: 'selected-pages.pdf',
        });

        try {
            await state.handlePrintDialogSubmit({
                pageNumbers: [
                    8,
                    3,
                    3,
                ],
                viewMode: 'single',
                orientation: 'auto',
            });

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/selected-pages.pdf',
                'selected-pages.pdf',
                {
                    viewMode: 'single',
                    orientation: 'auto',
                    requestId: expect.stringMatching(/^print-/u),
                    pageNumbers: [
                        3,
                        8,
                    ],
                },
            );
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('refreshes a dirty path source through the strict save path before native printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({success: true});
        const ensureWorkingCopyFreshForRead = vi.fn(async () => '/tmp/refreshed.pdf');
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/stale.pdf'),
                size: 3 * 1024 * 1024 * 1024,
            },
            workingCopyPath: '/tmp/stale.pdf',
            hasPendingUnsavedChanges: true,
            ensureWorkingCopyFreshForRead,
        });

        try {
            await state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/refreshed.pdf',
                'document.pdf',
                {
                    viewMode: 'single',
                    orientation: 'auto',
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
            expect(getPrintableSourceData).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('reports a typed native-required failure when a dirty path has no native print capability', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
            unsupportedReason: 'requires-native-backend',
        });
        const ensureWorkingCopyFreshForRead = vi.fn(async () => true);
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/native-required.pdf'),
                size: 3 * 1024 * 1024 * 1024,
            },
            hasPendingUnsavedChanges: true,
            ensureWorkingCopyFreshForRead,
        });

        try {
            await state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            }, {reopenDialogOnError: false});

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'warning',
                description: expect.stringContaining('native desktop dialog is unavailable'),
            }));
        } finally {
            scope.stop();
        }
    });

    it('reuses the save receipt when dirty-path preparation cannot refresh the working copy', async () => {
        const receipt = {
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            eventId: 'save-failure-123456789',
            occurredAt: 1,
            severity: 'error',
        } as FailureReceipt;
        const savePresentation: FailurePresentation = {
            failure: receipt,
            title: 'errors.file.save',
            description: 'errors.save.notCompleted',
        };
        const capture = vi.spyOn(BrowserLogger, 'error');
        const ensureWorkingCopyFreshForRead = vi.fn(async () => false);
        const {
            scope,
            state,
        } = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/dirty-print.pdf'),
                size: 10,
            },
            hasPendingUnsavedChanges: true,
            ensureWorkingCopyFreshForRead,
            getLastFailurePresentation: () => savePresentation,
        });

        try {
            await state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            }, {reopenDialogOnError: false});

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(capture).toHaveBeenCalledWith(
                'workspace-print',
                'Document print failed',
                expect.any(Error),
                receipt,
            );
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'error',
                description: expect.stringContaining('dirty working copy could not be saved as a path'),
            }));
        } finally {
            scope.stop();
        }
    });

    it('dispatches selected facing-page printing without resolving path-backed PDF bytes', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({success: true});
        const sourcePdf: TPdfSource = {
            kind: 'path',
            path: requireDocumentRef('/tmp/clean-unrepresentable.pdf'),
            size: 3 * 1024 * 1024 * 1024,
        };
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({sourcePdf});

        try {
            await state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            }, {reopenDialogOnError: false});

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/clean-unrepresentable.pdf',
                'document.pdf',
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
        } finally {
            scope.stop();
        }
    });

    it.each([
        [
            'single pages with portrait orientation',
            'single',
            'portrait',
        ],
        [
            'single pages with landscape orientation',
            'single',
            'landscape',
        ],
        [
            'facing pages with automatic orientation',
            'facing',
            'auto',
        ],
        [
            'facing pages with portrait orientation',
            'facing',
            'portrait',
        ],
        [
            'facing pages with landscape orientation',
            'facing',
            'landscape',
        ],
        [
            'first page single with automatic orientation',
            'facing-first-single',
            'auto',
        ],
        [
            'first page single with portrait orientation',
            'facing-first-single',
            'portrait',
        ],
        [
            'first page single with landscape orientation',
            'facing-first-single',
            'landscape',
        ],
    ] as const)('hands supported path-backed %s to native printing without resolving PDF bytes', async (
        _label,
        viewMode,
        orientation,
    ) => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({success: true});
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({sourcePdf: {
            kind: 'path',
            path: requireDocumentRef('/tmp/path-options.pdf'),
            size: PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES,
        }});

        try {
            expect(state.supportsAdvancedPrintOptions.value).toBe(true);
            expect(state.supportsFirstPageSinglePrintLayout.value).toBe(true);

            await state.handlePrintDialogSubmit({
                viewMode,
                orientation,
            }, {reopenDialogOnError: false});

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/path-options.pdf',
                'document.pdf',
                {
                    viewMode,
                    orientation,
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
            expect(getPrintableSourceData).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });

    it('fails closed when native path printing is unavailable for a clean path source', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
            unsupportedReason: 'requires-native-backend',
        });
        const sourcePdf: TPdfSource = {
            kind: 'path',
            path: requireDocumentRef('/tmp/clean-native-required.pdf'),
            size: 3 * 1024 * 1024 * 1024,
        };
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({sourcePdf});

        try {
            await state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            }, {reopenDialogOnError: false});

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/clean-native-required.pdf',
                'document.pdf',
                {
                    viewMode: 'single',
                    orientation: 'auto',
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'warning',
                description: expect.stringContaining('native desktop dialog is unavailable'),
            }));
        } finally {
            scope.stop();
        }
    });

    it('refreshes a dirty path before native facing-page printing without materializing bytes', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({success: true});
        const ensureWorkingCopyFreshForRead = vi.fn(async () => '/tmp/refreshed-facing.pdf');
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: {
                kind: 'path',
                path: requireDocumentRef('/tmp/unrepresentable.pdf'),
                size: 3 * 1024 * 1024 * 1024,
            },
            hasPendingUnsavedChanges: true,
            ensureWorkingCopyFreshForRead,
        });

        try {
            await state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            }, {reopenDialogOnError: false});

            expect(ensureWorkingCopyFreshForRead).toHaveBeenCalledOnce();
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/refreshed-facing.pdf',
                'document.pdf',
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
        } finally {
            scope.stop();
        }
    });

    it('does not use the direct metrics policy when quick-print metrics are unavailable', async () => {
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            scope,
            state,
        } = createState({ getQuickPrintPageMetrics: vi.fn(async () => null) });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(true);

        try {
            const printPromise = state.handleQuickPrint();
            await flushMicrotasks(12);

            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(shouldPrintPageMetricsDirectlyMock).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;
        } finally {
            scope.stop();
        }
    });

    it('prints DjVu through the DjVu print source without serializing PDF data', async () => {
        const printDjvuSource = vi.fn(async () => {});
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({printDjvuSource});

        try {
            await state.handlePrintDialogSubmit({
                pageNumbers: [4],
                viewMode: 'single',
                orientation: 'auto',
            });

            expect(printDjvuSource).toHaveBeenCalledWith({
                pageNumbers: [4],
                viewMode: 'single',
                orientation: 'auto',
            }, {
                onNativePrintHandoffStart: expect.any(Function),
                signal: expect.any(AbortSignal),
            });
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('closes the app print dialog as soon as DjVu reaches the native print handoff', async () => {
        let finishPrint!: () => void;
        const printDjvuSource = vi.fn(async (
            _payload,
            options?: { onNativePrintHandoffStart?: () => void },
        ) => {
            options?.onNativePrintHandoffStart?.();
            await new Promise<void>(resolve => {
                finishPrint = resolve;
            });
        });
        const {
            scope,
            state,
        } = createState({printDjvuSource});

        try {
            state.handlePrint();
            expect(state.printDialogOpen.value).toBe(true);

            const submitPromise = state.handlePrintDialogSubmit({
                pageNumbers: [4],
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(4);

            expect(state.printDialogOpen.value).toBe(false);
            expect(state.isPreparingPrint.value).toBe(true);

            finishPrint();
            await submitPromise;

            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('uses the live viewer page when printing the current DjVu page', async () => {
        const printDjvuSource = vi.fn(async () => {});
        const {
            scope,
            state,
        } = createState({
            getCurrentPrintPage: () => 7,
            printDjvuSource,
        });

        try {
            await state.handlePrintCurrentPage();

            expect(printDjvuSource).toHaveBeenCalledWith({
                pageNumbers: [7],
                viewMode: 'single',
                orientation: 'auto',
            }, {
                onNativePrintHandoffStart: expect.any(Function),
                signal: expect.any(AbortSignal),
            });
        } finally {
            scope.stop();
        }
    });

    it('shows delayed preparing feedback while current-page DjVu printing waits for native handoff', async () => {
        const timeoutCallbacks = new Map<number, () => void>();
        let timerId = 0;
        vi.stubGlobal('window', {
            setTimeout: vi.fn((callback: () => void) => {
                timerId += 1;
                timeoutCallbacks.set(timerId, callback);
                return timerId;
            }),
            clearTimeout: vi.fn((id: number) => {
                timeoutCallbacks.delete(id);
            }),
        });

        let finishPrint!: () => void;
        let startNativePrintHandoff!: () => void;
        const printDjvuSource = vi.fn(async (
            _payload,
            options?: { onNativePrintHandoffStart?: () => void },
        ) => {
            startNativePrintHandoff = () => options?.onNativePrintHandoffStart?.();
            await new Promise<void>(resolve => {
                finishPrint = resolve;
            });
        });
        const {
            scope,
            state,
        } = createState({
            getCurrentPrintPage: () => 7,
            printDjvuSource,
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(4);

            timeoutCallbacks.get(1)?.();
            expect(toastAddMock).toHaveBeenCalledWith({
                close: false,
                color: 'neutral',
                description: 'print.systemDialogHint',
                duration: 0,
                icon: 'i-ph-circle-notch',
                title: 'print.preparing',
            });

            startNativePrintHandoff();
            expect(toastRemoveMock).not.toHaveBeenCalled();

            finishPrint();
            await printPromise;

            expect(toastRemoveMock).toHaveBeenCalledWith('toast-id');
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('removes path-print preparation feedback when the matching native dialog opens', async () => {
        let finishPrint!: (result: {success: boolean}) => void;
        documentsCapabilityMock.printPdfPath.mockImplementation(() => new Promise((resolve) => {
            finishPrint = resolve;
        }));
        const {
            scope,
            state,
        } = createState({sourcePdf: {
            kind: 'path',
            path: requireDocumentRef('/tmp/native-dialog.pdf'),
            size: 689 * 1024 * 1024,
        }});

        try {
            const printPromise = state.handlePrintDialogSubmit({
                viewMode: 'facing',
                orientation: 'landscape',
            });
            await flushMicrotasks();

            const requestOptions = documentsCapabilityMock.printPdfPath.mock.calls[0]?.[2];
            expect(requestOptions?.requestId).toMatch(/^print-/u);
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({title: 'print.preparing'}));
            expect(state.isPreparingPrint.value).toBe(true);

            documentsCapabilityMock.emitNativePrintDialogOpened({requestId: 'another-print'});
            expect(toastRemoveMock).not.toHaveBeenCalled();
            documentsCapabilityMock.emitNativePrintDialogOpened({requestId: requestOptions?.requestId ?? ''});

            expect(toastRemoveMock).toHaveBeenCalledWith('toast-id');
            expect(state.isPreparingPrint.value).toBe(true);

            finishPrint({success: true});
            await printPromise;

            expect(documentsCapabilityMock.unsubscribeNativePrintDialogOpened).toHaveBeenCalledOnce();
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('cancels a pending native path print when the workspace scope ends', async () => {
        let finishPrint!: (result: {
            success: boolean;
            canceled: boolean;
        }) => void;
        documentsCapabilityMock.printPdfPath.mockImplementation(() => new Promise((resolve) => {
            finishPrint = resolve;
        }));
        documentsCapabilityMock.cancelPdfPrint.mockImplementation(async () => {
            finishPrint({
                success: false,
                canceled: true,
            });
            return {canceled: true};
        });
        const {
            scope,
            state,
        } = createState({sourcePdf: {
            kind: 'path',
            path: requireDocumentRef('/tmp/cancel-path-print.pdf'),
            size: 689 * 1024 * 1024,
        }});
        const printPromise = state.handlePrintDialogSubmit({
            viewMode: 'facing',
            orientation: 'landscape',
        });
        await flushMicrotasks();
        const requestId = documentsCapabilityMock.printPdfPath.mock.calls[0]?.[2]?.requestId;

        scope.stop();
        await printPromise;

        expect(documentsCapabilityMock.cancelPdfPrint).toHaveBeenCalledWith(requestId);
        expect(documentsCapabilityMock.unsubscribeNativePrintDialogOpened).toHaveBeenCalledOnce();
    });

    it('removes data-print preparation feedback when the matching native dialog opens', async () => {
        let finishPrint!: (result: {success: boolean}) => void;
        documentsCapabilityMock.printPdfData.mockImplementation(() => new Promise((resolve) => {
            finishPrint = resolve;
        }));
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const {
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: null,
            fileName: 'data-native-dialog.pdf',
        });

        try {
            const printPromise = state.handlePrintDialogSubmit({
                viewMode: 'facing',
                orientation: 'landscape',
            });
            await flushMicrotasks(12);

            const requestOptions = documentsCapabilityMock.printPdfData.mock.calls[0]?.[2];
            expect(requestOptions?.requestId).toMatch(/^print-/u);
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({title: 'print.preparing'}));
            expect(state.isPreparingPrint.value).toBe(true);

            documentsCapabilityMock.emitNativePrintDialogOpened({requestId: 'another-print'});
            expect(toastRemoveMock).not.toHaveBeenCalled();
            documentsCapabilityMock.emitNativePrintDialogOpened({requestId: requestOptions?.requestId ?? ''});

            expect(toastRemoveMock).toHaveBeenCalledWith('toast-id');
            expect(state.isPreparingPrint.value).toBe(true);

            finishPrint({success: true});
            await printPromise;

            expect(documentsCapabilityMock.unsubscribeNativePrintDialogOpened).toHaveBeenCalledOnce();
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('removes the data-print handoff listener when native printing rejects', async () => {
        documentsCapabilityMock.printPdfData.mockRejectedValue(new Error('native print failed'));
        const {
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: null,
        });

        try {
            await state.handlePrintDialogSubmit({
                viewMode: 'facing',
                orientation: 'landscape',
            });

            expect(documentsCapabilityMock.unsubscribeNativePrintDialogOpened).toHaveBeenCalledOnce();
            expect(state.printError.value?.description).toContain('native print failed');
        } finally {
            scope.stop();
        }
    });

    it('cancels a pending native data print when the workspace scope ends', async () => {
        let finishPrint!: (result: {
            success: boolean;
            canceled: boolean;
        }) => void;
        documentsCapabilityMock.printPdfData.mockImplementation(() => new Promise((resolve) => {
            finishPrint = resolve;
        }));
        documentsCapabilityMock.cancelPdfPrint.mockImplementation(async () => {
            finishPrint({
                success: false,
                canceled: true,
            });
            return {canceled: true};
        });
        const {
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: null,
        });
        const printPromise = state.handlePrintDialogSubmit({
            viewMode: 'facing',
            orientation: 'landscape',
        });
        await flushMicrotasks(12);
        const requestId = documentsCapabilityMock.printPdfData.mock.calls[0]?.[2]?.requestId;

        scope.stop();
        await printPromise;

        expect(documentsCapabilityMock.cancelPdfPrint).toHaveBeenCalledWith(requestId);
        expect(documentsCapabilityMock.unsubscribeNativePrintDialogOpened).toHaveBeenCalledOnce();
    });

    it('uses rendered browser printing for the default flow when a working copy path is available', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/desktop.pdf',
            fileName: 'desktop.pdf',
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppData).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(7, 8, 9),
                'desktop.pdf',
                {requestId: expect.stringMatching(/^print-/u)},
            );
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);

            await appFrame.frame.waitForListener('load');
            appFrame.frame.trigger('load');
            await submitPromise;

            expect(buildBrowserPrintFrameMarkupMock).toHaveBeenCalledTimes(1);
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints only the current page through rendered browser printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await appFrame.frame.waitForListener('load');

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [4],
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;

            expect(buildBrowserPrintFrameMarkupMock).toHaveBeenCalledWith(
                'current-page - print.fileNamePage_{_page__4}.pdf',
            );
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(toastAddMock).not.toHaveBeenCalledWith({
                color: 'success',
                title: 'print.requestSent',
            });
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('adds comma-free page ranges to multi-page browser print titles', async () => {
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const appFrame = stubDocumentWithFrame();
        const {
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/selection.pdf',
            fileName: 'selection.pdf',
        });

        try {
            const printPromise = state.handlePrintDialogSubmit({
                pageNumbers: [
                    10,
                    2,
                    1,
                    3,
                    7,
                ],
                viewMode: 'single',
                orientation: 'auto',
            });
            await appFrame.frame.waitForListener('load');

            appFrame.frame.trigger('load');
            await printPromise;

            expect(buildBrowserPrintFrameMarkupMock).toHaveBeenCalledWith(
                'selection - print.fileNamePages_{_pages___1-3_7_10_}.pdf',
            );
        } finally {
            scope.stop();
        }
    });

    it('prints the current loaded PDF.js page without rebuilding the whole PDF', async () => {
        const renderLoadedPdfPagesForBrowserPrint = vi.fn(async () => {});
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
            hasPendingUnsavedChanges: true,
            hasPendingPrintSerializationChanges: false,
            renderLoadedPdfPagesForBrowserPrint,
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await printPromise;

            expect(renderLoadedPdfPagesForBrowserPrint).toHaveBeenCalledWith(
                appFrame.frameWindow.document,
                [4],
                { signal: expect.any(AbortSignal) },
            );
            expect(renderPdfPagesForBrowserPrintMock).not.toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('cancels current-page loaded-PDF print preparation', async () => {
        let abortSignal: AbortSignal | undefined;
        const renderLoadedPdfPagesForBrowserPrint = vi.fn(async (
            _targetDocument,
            _pageNumbers,
            options?: { signal?: AbortSignal },
        ) => {
            abortSignal = options?.signal;
            await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    const error = new Error('Print preparation was canceled');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        });
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
            renderLoadedPdfPagesForBrowserPrint,
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);
            appFrame.frame.trigger('load');
            await flushMicrotasks(12);

            expect(state.isPreparingPrint.value).toBe(true);
            state.handlePrintDialogOpenChange(false);

            expect(abortSignal?.aborted).toBe(true);
            expect(appFrame.frame.remove).toHaveBeenCalledTimes(1);

            await printPromise;

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(appFrame.frameWindow.print).not.toHaveBeenCalled();
            expect(toastAddMock).not.toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('cancels a dirty-document print while its materialization is still pending', async () => {
        let materializeSignal: AbortSignal | undefined;
        const materialized = Promise.withResolvers<Uint8Array | null>();
        const getPrintableSourceData = vi.fn(async (options?: { signal?: AbortSignal }) => {
            materializeSignal = options?.signal;
            return materialized.promise;
        });
        const appFrame = stubDocumentWithFrame();
        const {
            scope,
            state,
        } = createState({
            workingCopyPath: '/tmp/dirty-print.pdf',
            fileName: 'dirty-print.pdf',
            hasPendingUnsavedChanges: true,
            getPrintableSourceData,
        });

        try {
            const printPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(materializeSignal?.aborted).toBe(false);

            expect(state.isPreparingPrint.value).toBe(true);
            state.handlePrintDialogOpenChange(false);

            expect(materializeSignal?.aborted).toBe(true);

            materialized.resolve(null);
            await printPromise;

            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(appFrame.frameWindow.print).not.toHaveBeenCalled();
            expect(toastAddMock).not.toHaveBeenCalled();
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('falls back to a one-page printable PDF when native current-page extraction is unavailable', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [4],
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.isPreparingPrint.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('does not claim browser-print success when the system dialog returns no result', async () => {
        documentsCapabilityMock.printPdfPath.mockRejectedValue(new Error('Path is outside the allowed working directory'));
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/current-page.pdf',
            fileName: 'current-page.pdf',
        });

        try {
            const printPromise = state.handlePrintCurrentPage();
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [4],
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );

            appFrame.frame.trigger('load');
            await printPromise;

            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(toastAddMock).not.toHaveBeenCalledWith({
                color: 'success',
                title: 'print.requestSent',
            });
        } finally {
            scope.stop();
        }
    });

    it('quick-prints the current browser PDF source without rebuilding it', async () => {
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }),
            getQuickPrintPageMetrics: vi.fn(async () => [{
                width: 612,
                height: 792,
            }]),
        });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(true);

        try {
            const printPromise = state.handleQuickPrint();
            await flushMicrotasks(12);

            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);
            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();

            appFrame.frame.trigger('load');
            await printPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(appFrame.frame.srcdoc).toBe('<html><body><main data-browser-print-root></main></body></html>');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.isPreparingPrint.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('falls back to browser printing when native path printing is unavailable', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        });
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }),
            workingCopyPath: '/tmp/fallback.pdf',
            fileName: 'fallback.pdf',
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(7, 8, 9),
                'fallback.pdf',
                {requestId: expect.stringMatching(/^print-/u)},
            );
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('prints the current source PDF directly in the browser for the default flow', async () => {
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({ sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }) });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);
            expect(appFrame.frame.src).toBe('');
            expect(appFrame.frame.srcdoc).toBe('<html><body><main data-browser-print-root></main></body></html>');

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(Uint8Array.of(9, 8, 7), {
                viewMode: 'single',
                orientation: 'auto',
            });
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(waitForPrintPaintMock).toHaveBeenCalledWith(appFrame.frameWindow);
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();

            const afterPrintHandler = vi.mocked(appFrame.frameWindow.addEventListener).mock.calls[0]?.[1] as
                | (() => void)
                | undefined;
            afterPrintHandler?.();

            expect(appFrame.frame.remove).toHaveBeenCalledTimes(1);
        } finally {
            scope.stop();
        }
    });

    it('keeps a byte-small high-page-count PDF out of eager pdf-lib print planning', async () => {
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            totalPages: 5_001,
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }),
        });

        try {
            const printPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                'document.pdf',
                {requestId: expect.stringMatching(/^print-/u)},
            );
            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.srcdoc).toBe('<html><body><main data-browser-print-root></main></body></html>');

            appFrame.frame.trigger('load');
            await printPromise;

            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledOnce();
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it.each([
        [
            'facing pages with automatic orientation',
            'facing',
            'auto',
        ],
        [
            'single pages with portrait orientation',
            'single',
            'portrait',
        ],
    ] as const)('refuses an all-page advanced layout before loading a high-page-count PDF (%s)', async (
        _label,
        viewMode,
        orientation,
    ) => {
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            totalPages: 5_001,
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }),
        });

        try {
            const printPromise = state.handlePrintDialogSubmit({
                viewMode,
                orientation,
            }, {reopenDialogOnError: false});
            await flushMicrotasks(12);
            appFrame.frame.trigger('load');
            await printPromise;

            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'warning',
                description: expect.stringContaining('print.highPageCountAdvancedLayout'),
            }));
        } finally {
            scope.stop();
        }
    });

    it('never hands print jobs to the default PDF app when using rendered browser printing', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: '/tmp/working-copy.pdf',
            fileName: 'working-copy.pdf',
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);
            appFrame.frame.trigger('load');
            await submitPromise;

            expect(documentsCapabilityMock.printPdfPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppPath).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.openPdfInDefaultAppData).not.toHaveBeenCalled();
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('still builds a transformed PDF when the default flow cannot print from an existing source directly', async () => {
        shouldPrintSourcePdfDirectlyMock.mockResolvedValue(false);
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getQuickPrintPageMetrics,
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: null,
            workingCopyPath: null,
            getQuickPrintPageMetrics: vi.fn(async () => [{
                width: 734.4,
                height: 1113.12,
            }]),
        });
        shouldPrintPageMetricsDirectlyMock.mockReturnValue(false);

        try {
            const submitPromise = state.handleQuickPrint();

            await flushMicrotasks(12);

            expect(getQuickPrintPageMetrics).toHaveBeenCalledTimes(1);
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    viewMode: 'single',
                    orientation: 'auto',
                },
            );
            expect(shouldPrintSourcePdfDirectlyMock).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('routes byte-backed advanced layouts through the managed path when native printing is available', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({success: true});
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], {type: 'application/pdf'}),
            workingCopyPath: '/tmp/managed-byte-backed.pdf',
        });

        try {
            await state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            });

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/tmp/managed-byte-backed.pdf',
                'document.pdf',
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
            expect(getPrintableSourceData).not.toHaveBeenCalled();
            expect(buildPrintablePdfDataMock).not.toHaveBeenCalled();
            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('builds a transformed PDF and sends it to the native print dialog without a managed path', async () => {
        documentsCapabilityMock.printPdfData.mockResolvedValue({ success: true });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            hasPendingUnsavedChanges: true,
            workingCopyPath: null,
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            });
            await flushMicrotasks(12);
            appFrame.frame.trigger('load');
            await submitPromise;

            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                },
            );
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(7, 8, 9),
                'document.pdf',
                {requestId: expect.stringMatching(/^print-/u)},
            );
            expect(renderPdfPagesForBrowserPrintMock).not.toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('keeps oversized composed bytes out of the bounded native IPC handoff', async () => {
        buildPrintablePdfDataMock.mockResolvedValue(
            new Uint8Array(IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES + 1),
        );
        const appFrame = stubDocumentWithFrame();
        const {
            scope,
            state,
        } = createState({workingCopyPath: null});

        try {
            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'facing',
                orientation: 'portrait',
            });
            await flushMicrotasks(12);

            expect(documentsCapabilityMock.printPdfData).not.toHaveBeenCalled();
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalledOnce();
            expect(appFrame.frameWindow.print).toHaveBeenCalledOnce();
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('falls back to browser printing when managed-path and data handoffs need a native backend', async () => {
        documentsCapabilityMock.printPdfPath.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
            unsupportedReason: 'requires-native-backend',
        });
        documentsCapabilityMock.printPdfData.mockResolvedValue({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
            unsupportedReason: 'requires-native-backend',
        });
        buildPrintablePdfDataMock.mockResolvedValue(Uint8Array.of(7, 8, 9));
        const appFrame = stubDocumentWithFrame();
        const {
            getPrintableSourceData,
            scope,
            state,
        } = createState({
            sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], {type: 'application/pdf'}),
            workingCopyPath: '/browser/managed-byte-backed.pdf',
        });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                pageNumbers: [2],
                viewMode: 'facing',
                orientation: 'portrait',
            });
            await flushMicrotasks();

            expect(documentsCapabilityMock.printPdfPath).toHaveBeenCalledWith(
                '/browser/managed-byte-backed.pdf',
                'document.pdf',
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                    requestId: expect.stringMatching(/^print-/u),
                },
            );
            expect(getPrintableSourceData).toHaveBeenCalledTimes(1);
            expect(buildPrintablePdfDataMock).toHaveBeenCalledWith(
                Uint8Array.of(9, 8, 7),
                {
                    pageNumbers: [2],
                    viewMode: 'facing',
                    orientation: 'portrait',
                },
            );
            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(7, 8, 9),
                'document.pdf',
                {requestId: expect.stringMatching(/^print-/u)},
            );
            expect(document.body.append).toHaveBeenCalledWith(appFrame.frame);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(appFrame.frame.src).toBe('');
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('does not navigate a hidden frame to a PDF blob when rendered browser printing fails', async () => {
        const renderedFrame = createFakeFrame();
        renderedFrame.frameWindow.print.mockImplementation(() => {
            throw new Error('Rendered browser printing failed');
        });
        stubDocumentWithFrame(renderedFrame);
        const {
            scope,
            state,
        } = createState({ sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }) });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            expect(renderedFrame.frame.srcdoc).toBe('<html><body><main data-browser-print-root></main></body></html>');
            renderedFrame.frame.trigger('load');
            await submitPromise;

            expect(documentsCapabilityMock.printPdfData).toHaveBeenCalledWith(
                Uint8Array.of(7, 8, 9),
                'document.pdf',
                {requestId: expect.stringMatching(/^print-/u)},
            );
            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(state.printDialogOpen.value).toBe(true);
            expect(state.printError.value?.description).toContain('Rendered browser printing failed');
        } finally {
            scope.stop();
        }
    });

    it('prints even when the PDF frame blocks child-window event access', async () => {
        waitForPrintPaintMock.mockRejectedValueOnce(
            new Error(
                'Blocked a frame with origin "http://127.0.0.1:3235" from accessing a cross-origin frame.',
            ),
        );
        const appFrame = createFakeFrame();
        appFrame.frameWindow.addEventListener.mockImplementation(() => {
            throw new Error(
                'Blocked a frame with origin "http://127.0.0.1:3235" from accessing a cross-origin frame.',
            );
        });
        appFrame.frameWindow.removeEventListener.mockImplementation(() => {
            throw new Error('removeEventListener should not run for blocked cross-origin frames');
        });
        stubDocumentWithFrame(appFrame);
        const {
            scope,
            state,
        } = createState({ sourcePdf: new Blob([Uint8Array.of(1, 2, 3)], { type: 'application/pdf' }) });

        try {
            state.handlePrint();

            const submitPromise = state.handlePrintDialogSubmit({
                viewMode: 'single',
                orientation: 'auto',
            });
            await flushMicrotasks(12);

            appFrame.frame.trigger('load');
            await submitPromise;

            expect(createObjectURLMock).not.toHaveBeenCalled();
            expect(renderPdfPagesForBrowserPrintMock).toHaveBeenCalled();
            expect(appFrame.frameWindow.print).toHaveBeenCalledTimes(1);
            expect(state.printDialogOpen.value).toBe(false);
            expect(state.printError.value).toBeNull();
        } finally {
            scope.stop();
        }
    });
});
