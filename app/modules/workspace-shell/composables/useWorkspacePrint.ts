import { getErrorMessage } from '@app/utils/error';
import type { Ref } from 'vue';
import {
    getFailureReceipt,
    type ExpectedOutcome,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import { uniq } from 'es-toolkit/array';
import {
    createRequestId,
    type TPdfViewMode,
    type TRequestId,
} from '@contracts/shared';
import type {
    IPdfPageMetric,
    TPdfSource,
} from '@app/types/pdfUi';
import {
    buildBrowserPrintFrameMarkup,
    normalizePrintPageNumbers,
    type IBrowserPrintDocument,
    type TPrintOrientation,
} from '@app/utils/pdfPrintShared';
import { buildPrintSelectionFileName } from '@app/utils/buildPrintSelectionFileName';
import {
    getDocumentPdfCapability,
    isNativePrintCapabilityUnavailable,
} from '@app/utils/platformDocuments';
import type { TPageSelection } from '@pdf-core/pdfPageSelection';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';
import { PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES } from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import {
    createExplicitPageSelection,
    materializePageSelection,
    pageSelectionCount,
} from '@pdf-core/pdfPageSelection';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    useFailureToast,
    type FailurePresentation,
} from '@app/composables/useFailureToast';
import { isPathPdfSource } from '@app/modules/pdf-viewer/public';
import type {
    TWorkspaceDriverCommandResult,
    IWorkspaceDriverPrintRequest,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';

const BROWSER_PRINT_CLEANUP_TIMEOUT_MS = 60000;
const BROWSER_PRINT_LOAD_TIMEOUT_MS = 30000;
const BROWSER_PRINT_LOAD_SETTLE_DELAY_MS = 300;
const PRINT_PREPARING_TOAST_DELAY_MS = 600;
const BROWSER_PRINT_FRAME_MIN_WIDTH_PX = 1280;
const BROWSER_PRINT_FRAME_MIN_HEIGHT_PX = 1600;
const NATIVE_PRINT_REQUIRED_REASON = 'requires-native-backend' as const;
const PDF_LIB_PRINT_PAGE_COUNT_LIMIT = 5_000;
const PRINT_SELECTION_MATERIALIZATION_LIMIT = 100_000;
const HIGH_PAGE_COUNT_PRINT_LAYOUT_ERROR_KEY = 'print.highPageCountAdvancedLayout' as const;
function createNativePrintRequestId() {
    return createRequestId('print');
}

class NativePrintRequiredError extends Error {
    readonly code = 'native-print-required' as const;
    readonly unsupportedReason = NATIVE_PRINT_REQUIRED_REASON;

    constructor(message = 'Native PDF printing is required for this request') {
        super(message);
        this.name = 'NativePrintRequiredError';
    }
}

function isCrossOriginFrameAccessError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return error.name === 'SecurityError'
        || getErrorMessage(error).includes('cross-origin frame')
        || getErrorMessage(error).includes('Blocked a frame with origin');
}

function createPrintAbortError() {
    const error = new Error('Print preparation was canceled');
    error.name = 'AbortError';
    return error;
}

function isPrintAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

function isNativePrintRequiredError(error: unknown): error is NativePrintRequiredError {
    return error instanceof NativePrintRequiredError;
}

function throwIfPrintAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw createPrintAbortError();
    }
}

function createPrintSignalOptions(signal: AbortSignal | undefined) {
    return signal ? { signal } : {};
}

function registerNativePrintCancellation(
    cancelPdfPrint: ((requestId: TRequestId) => Promise<{canceled: boolean}>) | undefined,
    requestId: TRequestId,
    signal: AbortSignal | undefined,
) {
    if (!cancelPdfPrint || !signal) {
        return () => undefined;
    }
    const cancelPendingNativePrint = () => {
        void cancelPdfPrint(requestId).catch(() => undefined);
    };
    signal.addEventListener('abort', cancelPendingNativePrint, {once: true});
    return () => signal.removeEventListener('abort', cancelPendingNativePrint);
}

interface IWorkspacePrintDeps {
    totalPages: Readonly<Ref<number>>;
    currentPage: Readonly<Ref<number>>;
    selectedPages: Readonly<Ref<number[]>>;
    selectedPageSelection?: Readonly<Ref<TPageSelection | null>>;
    sourcePdf: Readonly<Ref<TPdfSource | null>>;
    workingCopyPath: Readonly<Ref<string | null>>;
    fileName: Readonly<Ref<string | null>>;
    hasPendingUnsavedChanges: Readonly<Ref<boolean>>;
    hasPendingPrintSerializationChanges?: Readonly<Ref<boolean>>;
    getCurrentPrintPage?: () => number | null | undefined;
    getQuickPrintPageMetrics: () => Promise<IPdfPageMetric[] | null>;
    isDriverOwnedQuickPrint?: () => boolean;
    ensurePrintReady?: () => Promise<boolean>;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean | string | null>;
    getLastFailurePresentation?: () => FailurePresentation | null;
    getPrintableSourceData: (options?: { signal?: AbortSignal }) => Promise<Uint8Array | null>;
    renderLoadedPdfPagesForBrowserPrint?: (
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        options?: { signal?: AbortSignal },
    ) => Promise<void>;
    preparePrintSource?: (
        payload: IWorkspaceDriverPrintRequest,
        options?: {
            onNativePrintHandoffStart?: () => void;
            signal?: AbortSignal;
        },
    ) => Promise<TWorkspaceDriverCommandResult>;
}

interface IPrintDialogSubmitPayload {
    pageNumbers?: number[];
    pageSelection?: TPageSelection;
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export const useWorkspacePrint = (deps: IWorkspacePrintDeps) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const { presentFailureToast } = useFailureToast();
    const printDialogOpen = ref(false);
    const printDialogSelectedPages = ref<number[]>([]);
    const printDialogPageSelection = shallowRef<TPageSelection | null>(null);
    const isPreparingPrint = ref(false);
    const activePrintAction = ref<'default' | 'current-page' | null>(null);
    const printError = ref<FailurePresentation | null>(null);
    const activePrintFrame = ref<HTMLIFrameElement | null>(null);
    const printStatus = computed(() => isPreparingPrint.value ? t('print.preparing') : null);
    const isPreparingCurrentPagePrint = computed(() => (
        isPreparingPrint.value && activePrintAction.value === 'current-page'
    ));
    let removeAfterPrintListener: (() => void) | null = null;
    let browserPrintCleanupTimer: number | null = null;
    let activePrintAbortController: AbortController | null = null;
    const preparationFailureReceipt = ref<FailureReceipt | undefined>();
    const readPreparationFailureReceipt = () => preparationFailureReceipt.value;
    let activePrintResourceOwner: number | null = null;
    let nextPrintRunId = 0;
    let closeDialogForSystemPrint = false;
    let preparingPrintToastTimer: number | null = null;
    let preparingPrintToastId: string | number | null = null;

    const supportsAdvancedPrintOptions = computed(() => {
        const sourcePdf = deps.sourcePdf.value;
        return deps.totalPages.value <= PDF_LIB_PRINT_PAGE_COUNT_LIMIT
            && (
                !isPathPdfSource(sourcePdf)
                || sourcePdf.size <= PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES
            );
    });
    const supportsFirstPageSinglePrintLayout = computed(() => supportsAdvancedPrintOptions.value);

    function requiresNativePrintForHighPageCountLayout(payload: IPrintDialogSubmitPayload) {
        if (
            deps.totalPages.value <= PDF_LIB_PRINT_PAGE_COUNT_LIMIT
            || Boolean(payload.pageNumbers?.length)
        ) {
            return false;
        }

        return payload.viewMode !== 'single' || payload.orientation !== 'auto';
    }

    function resetPrintError() {
        printError.value = null;
    }

    function clearBrowserPrintCleanupTimer() {
        if (browserPrintCleanupTimer === null || typeof window === 'undefined') {
            return;
        }

        window.clearTimeout(browserPrintCleanupTimer);
        browserPrintCleanupTimer = null;
    }

    function cleanupPrintFrame(expectedOwner?: number) {
        if (expectedOwner !== undefined && activePrintResourceOwner !== expectedOwner) {
            return;
        }
        if (typeof window !== 'undefined' && removeAfterPrintListener) {
            removeAfterPrintListener();
            removeAfterPrintListener = null;
        }

        if (typeof window !== 'undefined') {
            clearBrowserPrintCleanupTimer();
        }

        if (activePrintFrame.value) {
            activePrintFrame.value.remove();
            activePrintFrame.value = null;
        }
        activePrintResourceOwner = null;
    }

    function clearPreparingPrintToast() {
        if (typeof window !== 'undefined' && preparingPrintToastTimer !== null) {
            window.clearTimeout(preparingPrintToastTimer);
        }
        preparingPrintToastTimer = null;

        if (preparingPrintToastId !== null) {
            toast.remove(preparingPrintToastId);
            preparingPrintToastId = null;
        }
    }

    function showPreparingPrintToast() {
        if (preparingPrintToastId !== null || !isPreparingPrint.value) {
            return;
        }
        if (typeof window !== 'undefined' && preparingPrintToastTimer !== null) {
            window.clearTimeout(preparingPrintToastTimer);
            preparingPrintToastTimer = null;
        }
        const preparingToast = toast.add({
            close: false,
            color: 'neutral',
            description: t('print.systemDialogHint'),
            duration: 0,
            icon: 'i-ph-circle-notch',
            title: t('print.preparing'),
        });
        preparingPrintToastId = preparingToast.id;
    }

    function schedulePreparingPrintToast() {
        if (typeof window === 'undefined' || preparingPrintToastTimer !== null || preparingPrintToastId !== null) {
            return;
        }

        preparingPrintToastTimer = window.setTimeout(() => {
            preparingPrintToastTimer = null;
            if (!isPreparingPrint.value) {
                return;
            }
            showPreparingPrintToast();
        }, PRINT_PREPARING_TOAST_DELAY_MS);
    }

    function cancelActivePrintPreparation() {
        activePrintAbortController?.abort();
        clearPreparingPrintToast();
        cleanupPrintFrame();
        isPreparingPrint.value = false;
        activePrintAction.value = null;
    }

    function closePrintDialogForSystemDialog() {
        closeDialogForSystemPrint = true;
        printDialogOpen.value = false;
    }

    function normalizeSelectedPages() {
        return uniq(deps.selectedPages.value)
            .filter(page => Number.isInteger(page) && page >= 1 && page <= deps.totalPages.value)
            .sort((left, right) => left - right);
    }

    function resolveCurrentPageSelection() {
        const selection = deps.selectedPageSelection?.value;
        if (selection?.pageCount === deps.totalPages.value) {
            return selection;
        }
        return createExplicitPageSelection(deps.totalPages.value, normalizeSelectedPages());
    }

    function normalizeCurrentPage() {
        const page = deps.getCurrentPrintPage?.() ?? deps.currentPage.value;
        if (!Number.isInteger(page) || page < 1 || page > deps.totalPages.value) {
            return null;
        }

        return page;
    }

    function resolveBrowserPrintTitle(payload: IPrintDialogSubmitPayload) {
        return buildPrintSelectionFileName({
            fileName: deps.fileName.value,
            pageNumbers: payload.pageNumbers,
            totalPages: deps.totalPages.value,
            formatPage: page => t('print.fileNamePage', { page }),
            formatPages: pages => t('print.fileNamePages', { pages }),
            formatSelection: selection => t('print.fileNamePageSelection', selection),
        });
    }

    function handlePrint() {
        closeDialogForSystemPrint = false;
        printDialogSelectedPages.value = normalizeSelectedPages();
        printDialogPageSelection.value = resolveCurrentPageSelection();
        resetPrintError();
        printDialogOpen.value = true;
    }

    async function handleQuickPrint() {
        printDialogSelectedPages.value = normalizeSelectedPages();
        printDialogPageSelection.value = resolveCurrentPageSelection();
        resetPrintError();
        const defaultPayload = {
            viewMode: 'single',
            orientation: 'auto',
        } satisfies IPrintDialogSubmitPayload;

        if (deps.preparePrintSource && deps.isDriverOwnedQuickPrint?.() === true) {
            await handlePrintDialogSubmit(defaultPayload, {
                action: 'default',
                reopenDialogOnError: false,
            });
            return;
        }

        if (isPathPdfSource(deps.sourcePdf.value)) {
            await handlePrintDialogSubmit(defaultPayload, {
                action: 'default',
                reopenDialogOnError: false,
            });
            return;
        }

        const { shouldPrintPageMetricsDirectly } = await import('@app/utils/pdfPrint');
        const quickPrintPageMetrics = await deps.getQuickPrintPageMetrics();
        const printSourceDirectly = quickPrintPageMetrics !== null
            && shouldPrintPageMetricsDirectly(
                quickPrintPageMetrics,
                defaultPayload,
            ) === true;

        await handlePrintDialogSubmit(defaultPayload, {
            action: 'default',
            printSourceDirectly,
            reopenDialogOnError: false,
        });
    }

    async function handlePrintCurrentPage() {
        const currentPrintPage = normalizeCurrentPage();
        if (currentPrintPage === null) {
            return;
        }

        resetPrintError();
        await handlePrintDialogSubmit({
            pageNumbers: [currentPrintPage],
            viewMode: 'single',
            orientation: 'auto',
        }, {
            action: 'current-page',
            reopenDialogOnError: false,
        });
    }

    function handlePrintDialogOpenChange(isOpen: boolean) {
        printDialogOpen.value = isOpen;
        if (!isOpen) {
            if (closeDialogForSystemPrint) {
                closeDialogForSystemPrint = false;
                resetPrintError();
                return;
            }

            if (isPreparingPrint.value) {
                cancelActivePrintPreparation();
            }
            resetPrintError();
        } else {
            closeDialogForSystemPrint = false;
        }
    }

    function createHiddenPrintFrame(owner: number) {
        if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.print !== 'function') {
            throw new Error('Window printing is unavailable');
        }

        cleanupPrintFrame();
        activePrintResourceOwner = owner;

        const frame = document.createElement('iframe');
        const frameWidth = Math.max(window.innerWidth || 0, BROWSER_PRINT_FRAME_MIN_WIDTH_PX);
        const frameHeight = Math.max(window.innerHeight || 0, BROWSER_PRINT_FRAME_MIN_HEIGHT_PX);
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.position = 'fixed';
        frame.style.left = `-${frameWidth + 200}px`;
        frame.style.top = '0';
        frame.style.width = `${frameWidth}px`;
        frame.style.height = `${frameHeight}px`;
        frame.style.opacity = '0.001';
        frame.style.pointerEvents = 'none';
        frame.style.border = '0';
        document.body.append(frame);
        activePrintFrame.value = frame;

        return frame;
    }

    function waitForPrintFrameLoad(frame: HTMLIFrameElement, signal?: AbortSignal) {
        if (typeof window === 'undefined') {
            return Promise.reject(new Error('Window printing is unavailable'));
        }

        return new Promise<void>((resolve, reject) => {
            const onLoad = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error('Failed to load the printable PDF'));
            };
            const onAbort = () => {
                cleanup();
                reject(createPrintAbortError());
            };
            const timeoutId = window.setTimeout(() => {
                cleanup();
                reject(new Error('Timed out while preparing the printable PDF'));
            }, BROWSER_PRINT_LOAD_TIMEOUT_MS);
            const cleanup = () => {
                frame.removeEventListener('load', onLoad);
                frame.removeEventListener('error', onError);
                signal?.removeEventListener('abort', onAbort);
                window.clearTimeout(timeoutId);
            };

            if (signal?.aborted) {
                cleanup();
                reject(createPrintAbortError());
                return;
            }

            frame.addEventListener('load', onLoad, { once: true });
            frame.addEventListener('error', onError, { once: true });
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async function waitForPrintFrameReady(targetWindow: Window, signal?: AbortSignal) {
        throwIfPrintAborted(signal);
        try {
            const { waitForPrintPaint } = await import('@app/utils/pdfPrint');
            await waitForPrintPaint(targetWindow);
        } catch (error) {
            if (!isCrossOriginFrameAccessError(error)) {
                throw error;
            }
        }
        throwIfPrintAborted(signal);

        if (typeof window === 'undefined') {
            return;
        }

        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, BROWSER_PRINT_LOAD_SETTLE_DELAY_MS);
        });
        throwIfPrintAborted(signal);
    }

    function installAfterPrintCleanup(frameWindow: Window, owner: number) {
        const afterPrint = () => {
            cleanupPrintFrame(owner);
        };
        window.addEventListener('afterprint', afterPrint, {once: true});
        removeAfterPrintListener = () => {
            window.removeEventListener('afterprint', afterPrint);
        };
        try {
            frameWindow.addEventListener('afterprint', afterPrint, {once: true});
            removeAfterPrintListener = () => {
                window.removeEventListener('afterprint', afterPrint);
                frameWindow.removeEventListener('afterprint', afterPrint);
            };
        } catch (error) {
            if (!isCrossOriginFrameAccessError(error)) {
                cleanupPrintFrame(owner);
                throw error;
            }
        }
        browserPrintCleanupTimer = window.setTimeout(afterPrint, BROWSER_PRINT_CLEANUP_TIMEOUT_MS);
    }

    async function printRenderedContentInHiddenFrame(
        renderContent: (
            targetDocument: IBrowserPrintDocument,
            signal: AbortSignal | undefined,
        ) => Promise<void>,
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        const frame = createHiddenPrintFrame(owner);
        const frameLoad = waitForPrintFrameLoad(frame, signal);

        frame.srcdoc = buildBrowserPrintFrameMarkup(printTitle);
        await frameLoad;
        throwIfPrintAborted(signal);

        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
            cleanupPrintFrame(owner);
            throw new Error('Missing print frame window');
        }

        await renderContent(frameWindow.document, signal);
        throwIfPrintAborted(signal);

        installAfterPrintCleanup(frameWindow, owner);

        try {
            await waitForPrintFrameReady(frameWindow, signal);
            closePrintDialogForSystemDialog();
            frameWindow.focus();
            throwIfPrintAborted(signal);
            frameWindow.print();
        } catch (error) {
            cleanupPrintFrame(owner);
            throw error;
        }
    }

    async function printPdfInHiddenFrame(
        printablePdf: Blob | Uint8Array,
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        await printRenderedContentInHiddenFrame(
            async (targetDocument, renderSignal) => {
                const { renderPdfPagesForBrowserPrint } = await import('@app/utils/pdfPrint');
                await renderPdfPagesForBrowserPrint(
                    targetDocument,
                    printablePdf,
                    createPrintSignalOptions(renderSignal),
                );
            },
            printTitle,
            signal,
            owner,
        );
    }

    async function printLoadedPdfPagesInHiddenFrame(
        pageNumbers: number[],
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        const renderLoadedPdfPagesForBrowserPrint = deps.renderLoadedPdfPagesForBrowserPrint;
        if (!renderLoadedPdfPagesForBrowserPrint) {
            throw new Error('Loaded PDF printing is unavailable');
        }

        await printRenderedContentInHiddenFrame(
            (targetDocument, renderSignal) => renderLoadedPdfPagesForBrowserPrint(
                targetDocument,
                pageNumbers,
                createPrintSignalOptions(renderSignal),
            ),
            printTitle,
            signal,
            owner,
        );
    }

    async function printPdfDataWithNativeHandoff(
        printablePdf: Uint8Array,
        printTitle: string,
        signal?: AbortSignal,
        owner = 0,
    ) {
        throwIfPrintAborted(signal);
        const documentPdfCapability = getDocumentPdfCapability();
        const printPdfData = documentPdfCapability.printPdfData;
        if (
            typeof printPdfData === 'function'
            && printablePdf.byteLength <= IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES
        ) {
            const requestId = createNativePrintRequestId();
            const stopNativeDialogOpenedListener = documentPdfCapability.onNativePrintDialogOpened?.((event) => {
                if (event.requestId === requestId) {
                    clearPreparingPrintToast();
                }
            });
            const stopNativePrintCancellation = registerNativePrintCancellation(
                documentPdfCapability.cancelPdfPrint,
                requestId,
                signal,
            );
            closePrintDialogForSystemDialog();
            showPreparingPrintToast();
            try {
                let result;
                try {
                    result = await printPdfData(
                        printablePdf,
                        deps.fileName.value ?? undefined,
                        {requestId},
                    );
                } catch (error) {
                    throwIfPrintAborted(signal);
                    throw error;
                }
                throwIfPrintAborted(signal);
                if (result.success || result.canceled) {
                    return true;
                }
                if (!isNativePrintCapabilityUnavailable(result)) {
                    throw new Error(result.error ?? 'Failed to open the native print dialog');
                }
            } finally {
                stopNativePrintCancellation();
                stopNativeDialogOpenedListener?.();
            }
            clearPreparingPrintToast();
        }

        try {
            await printPdfInHiddenFrame(printablePdf, printTitle, signal, owner);
            return true;
        } catch (error) {
            throwIfPrintAborted(signal);
            throw error;
        }
    }

    function hasPendingPrintSerializationChanges() {
        return deps.hasPendingPrintSerializationChanges?.value
            ?? deps.hasPendingUnsavedChanges.value;
    }

    function hasPendingPathPrintChanges() {
        return deps.hasPendingUnsavedChanges.value || hasPendingPrintSerializationChanges();
    }

    function resolveLoadedPdfSinglePagePrint(payload: IPrintDialogSubmitPayload) {
        if (
            !deps.renderLoadedPdfPagesForBrowserPrint
            || hasPendingPrintSerializationChanges()
            || payload.viewMode !== 'single'
            || payload.orientation !== 'auto'
            || !payload.pageNumbers?.length
        ) {
            return null;
        }

        const pageNumbers = normalizePrintPageNumbers(payload.pageNumbers, deps.totalPages.value);
        return pageNumbers.length === 1 ? pageNumbers : null;
    }

    function resolveNativePathPrintPageNumbers(payload: IPrintDialogSubmitPayload) {
        if (!payload.pageNumbers?.length) {
            return undefined;
        }

        const pageNumbers = normalizePrintPageNumbers(payload.pageNumbers, deps.totalPages.value);
        if (pageNumbers.length === 0) {
            return null;
        }

        const totalPages = deps.totalPages.value;
        if (
            totalPages > 0
            && pageNumbers.length === totalPages
            && pageNumbers.every((pageNumber, index) => pageNumber === index + 1)
        ) {
            return undefined;
        }

        return pageNumbers;
    }

    async function tryPrintPathInNativeDialog(
        payload: IPrintDialogSubmitPayload,
        signal: AbortSignal,
    ) {
        const sourcePdf = deps.sourcePdf.value;
        const isPathSource = isPathPdfSource(sourcePdf);
        const requiresLayoutComposition = payload.viewMode !== 'single'
            || payload.orientation !== 'auto';
        const managedPrintPath = isPathSource
            ? sourcePdf.path
            : requiresLayoutComposition
                ? deps.workingCopyPath.value
                : null;
        if (!managedPrintPath) {
            return false;
        }

        const pageNumbers = resolveNativePathPrintPageNumbers(payload);
        if (pageNumbers === null) {
            throw new NativePrintRequiredError(
                'Native PDF printing is required because the selected path-backed pages are invalid',
            );
        }

        const documentPdfCapability = getDocumentPdfCapability();
        const printPdfPath = documentPdfCapability.printPdfPath;
        if (typeof printPdfPath !== 'function') {
            throw new NativePrintRequiredError(
                'Native PDF printing is required because path printing is unavailable',
            );
        }

        const wasDirty = hasPendingPathPrintChanges();
        let printPath = managedPrintPath;
        if (wasDirty) {
            throwIfPrintAborted(signal);
            if (!deps.ensureWorkingCopyFreshForRead) {
                throw new NativePrintRequiredError(
                    'Native PDF printing is required because the dirty working copy could not be refreshed as a path',
                );
            }

            const freshPath = await deps.ensureWorkingCopyFreshForRead();
            throwIfPrintAborted(signal);
            if (freshPath === false || freshPath === null) {
                preparationFailureReceipt.value = deps.getLastFailurePresentation?.()?.failure;
                throw new NativePrintRequiredError(
                    'Native PDF printing is required because the dirty working copy could not be saved as a path',
                );
            }

            if (typeof freshPath === 'string') {
                if (!freshPath) {
                    throw new NativePrintRequiredError(
                        'Native PDF printing is required because the refreshed working-copy path is empty',
                    );
                }
                printPath = freshPath;
            } else if (deps.workingCopyPath.value) {
                printPath = deps.workingCopyPath.value;
            } else {
                const freshSource = deps.sourcePdf.value;
                if (!isPathPdfSource(freshSource)) {
                    throw new NativePrintRequiredError(
                        'Native PDF printing is required because the refreshed working-copy path is unavailable',
                    );
                }
                printPath = freshSource.path;
            }
        }

        throwIfPrintAborted(signal);
        const documentRef = parseDocumentRef(printPath);
        if (documentRef === null) {
            throw new NativePrintRequiredError(
                'Native PDF printing is required because the print path is invalid',
            );
        }
        closePrintDialogForSystemDialog();
        showPreparingPrintToast();
        const requestId = createNativePrintRequestId();
        const stopNativeDialogOpenedListener = documentPdfCapability.onNativePrintDialogOpened?.((event) => {
            if (event.requestId === requestId) {
                clearPreparingPrintToast();
            }
        });
        const stopNativePrintCancellation = registerNativePrintCancellation(
            documentPdfCapability.cancelPdfPrint,
            requestId,
            signal,
        );
        let result;
        try {
            try {
                result = await printPdfPath(documentRef, deps.fileName.value ?? undefined, {
                    viewMode: payload.viewMode,
                    orientation: payload.orientation,
                    requestId,
                    ...(pageNumbers === undefined ? {} : {pageNumbers}),
                });
            } catch (error) {
                throwIfPrintAborted(signal);
                throw error;
            }
        } finally {
            stopNativePrintCancellation();
            stopNativeDialogOpenedListener?.();
        }
        throwIfPrintAborted(signal);
        if (result.success || result.canceled) {
            return true;
        }

        if (isNativePrintCapabilityUnavailable(result)) {
            if (!isPathSource) {
                clearPreparingPrintToast();
                return false;
            }
            throw new NativePrintRequiredError(
                result.error ?? 'Native PDF printing requires a native backend for this path-backed document',
            );
        }

        throw new Error(result.error ?? 'Failed to open the native print dialog');
    }

    async function handlePrintDialogSubmit(
        payload: IPrintDialogSubmitPayload,
        options: {
            action?: 'default' | 'current-page';
            printSourceDirectly?: boolean;
            reopenDialogOnError?: boolean;
        } = {},
    ) {
        if (isPreparingPrint.value) {
            showPreparingPrintToast();
            return;
        }
        const printRunId = ++nextPrintRunId;
        const abortController = new AbortController();
        activePrintAbortController = abortController;
        const { signal } = abortController;
        closeDialogForSystemPrint = false;
        isPreparingPrint.value = true;
        activePrintAction.value = options.action ?? 'default';
        resetPrintError();
        preparationFailureReceipt.value = undefined;
        if (!printDialogOpen.value) {
            schedulePreparingPrintToast();
        }

        try {
            if (payload.pageSelection) {
                const selection = payload.pageSelection.pageCount === deps.totalPages.value
                    ? payload.pageSelection
                    : resolveCurrentPageSelection();
                const selectedCount = pageSelectionCount(selection);
                if (selectedCount > PRINT_SELECTION_MATERIALIZATION_LIMIT) {
                    BrowserLogger.warn('workspace-print', 'Print selection was rejected', {
                        kind: 'expected',
                        code: 'validation-rejected',
                    } satisfies ExpectedOutcome);
                    toast.add({
                        color: 'warning',
                        title: t('print.selectionTooLarge'),
                    });
                    return;
                }
                payload = {
                    viewMode: payload.viewMode,
                    orientation: payload.orientation,
                    ...(selectedCount === deps.totalPages.value
                        ? {}
                        : {pageNumbers: materializePageSelection(selection)}),
                };
            }
            if (
                !isPathPdfSource(deps.sourcePdf.value)
                && requiresNativePrintForHighPageCountLayout(payload)
            ) {
                throw new NativePrintRequiredError(t(HIGH_PAGE_COUNT_PRINT_LAYOUT_ERROR_KEY));
            }
            throwIfPrintAborted(signal);
            if (deps.ensurePrintReady && !await deps.ensurePrintReady()) {
                throw new Error('Annotation notes could not be persisted for printing');
            }
            throwIfPrintAborted(signal);

            if (deps.preparePrintSource) {
                throwIfPrintAborted(signal);
                const nativePrintHandoff: { started: boolean } = { started: false };
                const driverResult = await deps.preparePrintSource(payload, {
                    signal,
                    onNativePrintHandoffStart: () => {
                        nativePrintHandoff.started = true;
                        closePrintDialogForSystemDialog();
                    },
                });
                throwIfPrintAborted(signal);
                if (driverResult.status === 'completed') {
                    if (nativePrintHandoff.started !== true) {
                        closePrintDialogForSystemDialog();
                    }
                    return;
                }
                if (driverResult.capability !== 'print') {
                    throw new Error('The active document driver cannot print');
                }
            }

            if (await tryPrintPathInNativeDialog(payload, signal)) {
                return;
            }

            const browserPrintTitle = resolveBrowserPrintTitle(payload);
            const loadedPageNumbers = resolveLoadedPdfSinglePagePrint(payload);
            if (loadedPageNumbers) {
                await printLoadedPdfPagesInHiddenFrame(
                    loadedPageNumbers,
                    browserPrintTitle,
                    signal,
                    printRunId,
                );
                return;
            }

            throwIfPrintAborted(signal);
            const sourceData = await deps.getPrintableSourceData({ signal });
            throwIfPrintAborted(signal);
            if (!sourceData) {
                throw new Error('Missing printable PDF source data');
            }

            if (options.printSourceDirectly === true) {
                await printPdfDataWithNativeHandoff(
                    sourceData,
                    browserPrintTitle,
                    signal,
                    printRunId,
                );
                return;
            }

            if (
                deps.totalPages.value > PDF_LIB_PRINT_PAGE_COUNT_LIMIT
                && payload.viewMode === 'single'
                && payload.orientation === 'auto'
                && (!payload.pageNumbers || payload.pageNumbers.length === 0)
            ) {
                await printPdfDataWithNativeHandoff(
                    sourceData,
                    browserPrintTitle,
                    signal,
                    printRunId,
                );
                return;
            }

            const { buildPrintablePdfData } = await import('@app/utils/pdfPrint');
            const printablePdfData = await buildPrintablePdfData(sourceData, payload);
            throwIfPrintAborted(signal);
            if (!printablePdfData) {
                throw new Error('Failed to prepare printable PDF data');
            }

            await printPdfDataWithNativeHandoff(
                printablePdfData,
                browserPrintTitle,
                signal,
                printRunId,
            );
        } catch (error) {
            if (isPrintAbortError(error)) {
                return;
            }
            const localizedError = error instanceof Error && getErrorMessage(error)
                ? t('print.failedWithReason', { reason: getErrorMessage(error) })
                : t('print.failed');
            if (isNativePrintRequiredError(error) && readPreparationFailureReceipt() === undefined) {
                BrowserLogger.warn('workspace-print', 'Print needs an unavailable native backend', {
                    kind: 'expected',
                    code: 'temporarily-unavailable',
                } satisfies ExpectedOutcome);
                toast.add({
                    color: 'warning',
                    title: t('print.failed'),
                    description: localizedError,
                });
                return;
            }
            const failure = BrowserLogger.error(
                'workspace-print',
                'Document print failed',
                error,
                getFailureReceipt(error) ?? readPreparationFailureReceipt() ?? {
                    code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                    context: {},
                },
            );
            const presentation: FailurePresentation = {
                failure,
                title: t('print.failed'),
                description: localizedError,
            };
            if (options.reopenDialogOnError === false) {
                presentFailureToast(presentation);
            } else {
                printDialogOpen.value = true;
                printError.value = presentation;
            }
        } finally {
            if (activePrintAbortController === abortController) {
                activePrintAbortController = null;
                clearPreparingPrintToast();
                isPreparingPrint.value = false;
                activePrintAction.value = null;
                closeDialogForSystemPrint = false;
                preparationFailureReceipt.value = undefined;
            }
        }
    }

    onScopeDispose(() => {
        activePrintAbortController?.abort();
        activePrintAbortController = null;
        clearPreparingPrintToast();
        cleanupPrintFrame();
        printDialogOpen.value = false;
        printDialogSelectedPages.value = [];
        isPreparingPrint.value = false;
        activePrintAction.value = null;
        printError.value = null;
        closeDialogForSystemPrint = false;
    });

    return {
        printDialogOpen,
        printDialogSelectedPages,
        printDialogPageSelection,
        isPreparingPrint,
        isPreparingCurrentPagePrint,
        printError,
        printStatus,
        supportsAdvancedPrintOptions,
        supportsFirstPageSinglePrintLayout,
        handlePrint,
        handleQuickPrint,
        handlePrintCurrentPage,
        handlePrintDialogOpenChange,
        handlePrintDialogSubmit,
    };
};
