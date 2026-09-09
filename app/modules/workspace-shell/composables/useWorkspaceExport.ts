import type { Ref } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IWorkspaceDocumentDriverExportTarget } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {
    getFailureReceipt,
    type ExpectedOutcome,
} from '@contracts/diagnostics/failureReceipt';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useFailureToast } from '@app/composables/useFailureToast';
import { useAnalytics } from '@app/composables/useAnalytics';
import type {
    IImageExportProgress,
    TDocumentImageExportSourceKind,
    TImageExportProgressFormat,
} from '@contracts/electronApiDocuments';
import {
    getDocumentWorkingCopyCapability,
    getImageExportCapability,
} from '@app/utils/platformDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { getErrorMessage } from '@app/utils/error';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import type { TPageSelection } from '@pdf-core/pdfPageSelection';
import {
    createAllPageSelection,
    createExplicitPageSelection,
    materializePageSelection,
    pageSelectionCount,
    requirePageNumber,
} from '@pdf-core/pdfPageSelection';

type TExportDialogMode = 'images' | 'multipage-tiff';
type TPageSelectionInput = number[] | TPageSelection;
const EXPORT_SELECTION_MATERIALIZATION_LIMIT = 100_000;

function resolveExportPageNumbers(selection: TPageSelection): number[] | undefined | null {
    const selectedCount = pageSelectionCount(selection);
    if (selectedCount === selection.pageCount) {
        return undefined;
    }
    if (selectedCount > EXPORT_SELECTION_MATERIALIZATION_LIMIT) {
        return null;
    }
    return materializePageSelection(selection);
}

type TExportSelectionResolution =
    | {kind: 'all'}
    | {
        kind: 'selection';
        selection: TPageSelection;
    }
    | {kind: 'refused'};

export interface IWorkspaceExportOverlay {
    kind: 'images' | 'multipage-tiff';
    pageCount: number;
    state: 'running' | 'success';
    progressPercent?: number;
}

interface IWorkspaceExportDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    exportTargets: {
        imageTarget: Ref<IWorkspaceDocumentDriverExportTarget | null>;
        multiPageTiffTarget: Ref<IWorkspaceDocumentDriverExportTarget | null>;
    };
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    totalPages: Ref<number>;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const useWorkspaceExport = (deps: IWorkspaceExportDeps) => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const toast = useToast();
    const { presentFailureToast } = useFailureToast();
    const {
        workingCopyPath,
        exportTargets,
        documentRevisionToken,
        totalPages,
        ensureWorkingCopyFreshForRead,
        runWithDocumentOperationLease = async (_kind, operation) => operation(),
    } = deps;

    const isExportInProgress = ref(false);
    const exportOverlay = ref<IWorkspaceExportOverlay | null>(null);
    const exportScopeDialogOpen = ref(false);
    const exportScopeDialogMode = ref<TExportDialogMode>('images');
    const exportScopeDialogSelectedPages = ref<number[]>([]);
    const exportScopeDialogPageSelection = shallowRef<TPageSelection | null>(null);
    let exportScopeDialogResolver: ((selection: TPageSelection | undefined | null) => void) | null = null;
    let exportProgressCleanup: (() => void) | null = null;
    let exportGeneration = 0;
    let isDisposed = false;

    interface IExportIdentity {
        generation: number;
        sourceKind: TDocumentImageExportSourceKind;
        sourcePath: TDocumentRef;
        workingCopyPath: TDocumentRef | null;
        requiresFreshWorkingCopy: boolean;
        documentRevisionToken: TDocumentRevisionToken | null;
    }

    function captureExportIdentity(
        generation: number,
        target: IWorkspaceDocumentDriverExportTarget | null,
    ): IExportIdentity | null {
        if (!target) {
            return null;
        }
        return {
            generation,
            sourceKind: target.sourceKind,
            sourcePath: target.sourcePath,
            workingCopyPath: workingCopyPath.value,
            requiresFreshWorkingCopy: target.requiresFreshWorkingCopy,
            documentRevisionToken: documentRevisionToken?.value ?? null,
        };
    }

    function ownsExportIdentity(
        identity: IExportIdentity,
        target: IWorkspaceDocumentDriverExportTarget | null,
    ) {
        return ownsExportSource(identity, target)
            && (documentRevisionToken?.value ?? null) === identity.documentRevisionToken;
    }

    function ownsExportSource(
        identity: IExportIdentity,
        target: IWorkspaceDocumentDriverExportTarget | null,
    ) {
        return !isDisposed
            && identity.generation === exportGeneration
            && target?.sourceKind === identity.sourceKind
            && target.sourcePath === identity.sourcePath
            && target.requiresFreshWorkingCopy === identity.requiresFreshWorkingCopy
            && workingCopyPath.value === identity.workingCopyPath;
    }

    const {
        start: startExportOverlayResetTimer,
        stop: stopExportOverlayResetTimer,
    } = useTimeoutFn((kind: IWorkspaceExportOverlay['kind'], pageCount: number) => {
        if (
            exportOverlay.value?.kind === kind
            && exportOverlay.value.state === 'success'
            && exportOverlay.value.pageCount === pageCount
        ) {
            exportOverlay.value = null;
        }
    }, 2200, { immediate: false });

    function clearExportOverlayTimer() {
        stopExportOverlayResetTimer();
    }

    function setExportOverlay(status: IWorkspaceExportOverlay | null) {
        clearExportOverlayTimer();
        exportOverlay.value = status;
    }

    function clearExportProgressSubscription() {
        exportProgressCleanup?.();
        exportProgressCleanup = null;
    }

    function createExportRequestId() {
        return createRequestId('export');
    }

    function subscribeExportProgress(
        imageExport: ReturnType<typeof getImageExportCapability>,
        requestId: TRequestId,
        format: TImageExportProgressFormat,
    ) {
        clearExportProgressSubscription();
        exportProgressCleanup = imageExport.onProgress((progress: IImageExportProgress) => {
            if (progress.requestId !== requestId || progress.format !== format) {
                return;
            }
            const current = exportOverlay.value;
            if (!current || current.state !== 'running') {
                return;
            }
            exportOverlay.value = {
                ...current,
                progressPercent: progress.percent,
            };
        });
    }

    function showExportRunning(kind: IWorkspaceExportOverlay['kind'], pageCount: number) {
        setExportOverlay({
            kind,
            pageCount,
            state: 'running',
        });
    }

    function showExportSuccess(kind: IWorkspaceExportOverlay['kind'], pageCount: number) {
        setExportOverlay({
            kind,
            pageCount,
            state: 'success',
        });
        startExportOverlayResetTimer(kind, pageCount);
    }

    function showExportFailure(title: string, error: unknown) {
        const failure = BrowserLogger.error(
            'workspace-export',
            'Document export failed',
            error,
            getFailureReceipt(error) ?? {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
        presentFailureToast({
            failure,
            title,
            description: getErrorMessage(error),
        });
    }

    function showExportSelectionRefusalToast() {
        BrowserLogger.warn('workspace-export', 'Export selection was rejected', {
            kind: 'expected',
            code: 'validation-rejected',
        } satisfies ExpectedOutcome);
        toast.add({
            color: 'warning',
            title: t('export.selectionTooLarge'),
        });
    }

    function normalizeExportSelectedPages(selectedPages: number[]) {
        return uniq(selectedPages)
            .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages.value)
            .sort((left, right) => left - right);
    }

    function resolveExportSelection(selectedPages: TPageSelectionInput): TExportSelectionResolution {
        const selection = Array.isArray(selectedPages)
            ? createExplicitPageSelection(totalPages.value, normalizeExportSelectedPages(selectedPages))
            : selectedPages;
        const selectedPageCount = pageSelectionCount(selection);
        if (selectedPageCount === totalPages.value) {
            return {kind: 'all'};
        }
        if (selectedPageCount > EXPORT_SELECTION_MATERIALIZATION_LIMIT) {
            return {kind: 'refused'};
        }
        return {
            kind: 'selection',
            selection,
        };
    }

    function getSelectedPageCount(pageNumbers?: number[]) {
        return pageNumbers?.length ?? totalPages.value;
    }

    function trackExportCompleted(payload: {
        startedAt: number;
        format: 'images' | 'multipage_tiff';
        selectedPageCount: number;
        status: 'success' | 'canceled';
        outputCount?: number;
    }) {
        analytics.track('export_completed', {
            durationMs: Math.max(0, Date.now() - payload.startedAt),
            format: payload.format,
            ...(payload.outputCount === undefined ? {} : { outputCount: payload.outputCount }),
            selectedPageCount: payload.selectedPageCount,
            status: payload.status,
        });
    }

    async function cleanupExportedOutputRefs(
        documentWorkingCopy: ReturnType<typeof getDocumentWorkingCopyCapability>,
        outputPaths: string[],
    ) {
        const cleanupPaths = outputPaths.flatMap((path) => {
            const documentRef = parseDocumentRef(path);
            return documentRef !== null && isBrowserDocumentRef(documentRef)
                ? [documentRef]
                : [];
        });
        if (cleanupPaths.length === 0) {
            return;
        }

        await Promise.allSettled(
            cleanupPaths.map(async (path) => {
                await documentWorkingCopy.cleanupFile(path);
            }),
        );
    }

    async function handleImageExportResult(
        documentWorkingCopy: ReturnType<typeof getDocumentWorkingCopyCapability>,
        result: Awaited<ReturnType<ReturnType<typeof getImageExportCapability>['exportPdfToImages']>>,
        selectedPageCount: number,
    ) {
        if (!result.success) {
            setExportOverlay(null);
            if (!result.canceled) {
                const resultError = 'error' in result && typeof result.error === 'string'
                    ? result.error
                    : t('errors.export.images');
                showExportFailure(t('errors.export.images'), resultError);
            }
            return;
        }

        if (result.outputPaths) {
            await cleanupExportedOutputRefs(documentWorkingCopy, result.outputPaths);
            showExportSuccess('images', result.outputPaths.length || selectedPageCount);
            return;
        }

        showExportSuccess('images', selectedPageCount);
    }

    function resolveExportScopeDialog(selection: TPageSelection | undefined | null) {
        const resolver = exportScopeDialogResolver;
        exportScopeDialogResolver = null;
        exportScopeDialogOpen.value = false;
        if (resolver) {
            resolver(selection);
        }
    }

    function openExportScopeDialog(
        mode: TExportDialogMode,
        selectedPageSelection: TPageSelection | null,
    ): Promise<TPageSelection | undefined | null> {
        if (exportScopeDialogResolver) {
            resolveExportScopeDialog(null);
        }

        exportScopeDialogMode.value = mode;
        exportScopeDialogPageSelection.value = selectedPageSelection;
        exportScopeDialogSelectedPages.value = selectedPageSelection
            && pageSelectionCount(selectedPageSelection) <= EXPORT_SELECTION_MATERIALIZATION_LIMIT
            ? materializePageSelection(selectedPageSelection)
            : [];
        exportScopeDialogOpen.value = true;

        return new Promise((resolve) => {
            exportScopeDialogResolver = resolve;
        });
    }

    function handleExportScopeDialogSubmit(payload: {
        pageNumbers?: number[];
        pageSelection?: TPageSelection;
    }) {
        resolveExportScopeDialog(payload.pageSelection ?? (payload.pageNumbers
            ? createExplicitPageSelection(totalPages.value, payload.pageNumbers)
            : undefined));
    }

    function handleExportScopeDialogOpenChange(isOpen: boolean) {
        if (isOpen) {
            return;
        }
        if (exportScopeDialogResolver) {
            resolveExportScopeDialog(null);
        } else {
            exportScopeDialogOpen.value = false;
        }
    }

    function acceptRasterExportPreflight(
        identity: NonNullable<ReturnType<typeof captureExportIdentity>>,
        target: IWorkspaceDocumentDriverExportTarget | null,
        isFreshForRead: boolean,
    ) {
        if (!isFreshForRead || !ownsExportSource(identity, target)) {
            setExportOverlay(null);
            return false;
        }
        return true;
    }

    function beginRasterExportPreflight(
        generation: number,
        target: IWorkspaceDocumentDriverExportTarget | null,
    ) {
        const identity = captureExportIdentity(generation, target);
        if (!identity) {
            return null;
        }
        return {
            identity,
            isFreshForRead: identity.requiresFreshWorkingCopy && ensureWorkingCopyFreshForRead
                ? ensureWorkingCopyFreshForRead()
                : true,
        };
    }

    async function runRasterExport(
        targetRef: Ref<IWorkspaceDocumentDriverExportTarget | null>,
        pageNumbers: number[] | undefined,
        task: (generation: number, selectedPageCount: number) => Promise<void>,
        handleFailure: (error: unknown) => void,
    ) {
        if (!targetRef.value || isExportInProgress.value) {
            return;
        }
        const selectedPageCount = getSelectedPageCount(pageNumbers);
        const generation = ++exportGeneration;
        isExportInProgress.value = true;
        try {
            const preflight = beginRasterExportPreflight(generation, targetRef.value);
            if (!preflight) {
                return;
            }
            const isFreshForRead = typeof preflight.isFreshForRead === 'boolean'
                ? preflight.isFreshForRead
                : await preflight.isFreshForRead;
            if (!acceptRasterExportPreflight(preflight.identity, targetRef.value, isFreshForRead)) {
                return;
            }
            await task(generation, selectedPageCount);
        } catch (error) {
            if (generation === exportGeneration && !isDisposed) {
                setExportOverlay(null);
                handleFailure(error);
            }
        } finally {
            if (generation === exportGeneration) {
                clearExportProgressSubscription();
                isExportInProgress.value = false;
            }
        }
    }

    function runImageExport(pageNumbers?: number[]) {
        return runRasterExport(
            exportTargets.imageTarget,
            pageNumbers,
            async (generation, selectedPageCount) => {
                await runWithDocumentOperationLease('raster-export', async () => {
                    const identity = captureExportIdentity(generation, exportTargets.imageTarget.value);
                    if (!identity || !ownsExportIdentity(identity, exportTargets.imageTarget.value)) {
                        setExportOverlay(null);
                        return;
                    }

                    showExportRunning('images', selectedPageCount);
                    const documentWorkingCopy = getDocumentWorkingCopyCapability();
                    const imageExport = getImageExportCapability();
                    const requestId = createExportRequestId();
                    subscribeExportProgress(imageExport, requestId, 'images');
                    const startedAt = Date.now();
                    const result = await imageExport.exportPdfToImages(
                        identity.sourcePath,
                        pageNumbers?.map(pageNumber => requirePageNumber(pageNumber, totalPages.value)),
                        requestId,
                        identity.sourceKind,
                    );
                    if (!ownsExportIdentity(identity, exportTargets.imageTarget.value)) {
                        await cleanupExportedOutputRefs(documentWorkingCopy, result.outputPaths ?? []);
                        if (generation === exportGeneration && !isDisposed) {
                            setExportOverlay(null);
                        }
                        return;
                    }
                    if (result.success || result.canceled) {
                        trackExportCompleted({
                            startedAt,
                            format: 'images',
                            outputCount: result.outputPaths?.length ?? 0,
                            selectedPageCount,
                            status: result.success ? 'success' : 'canceled',
                        });
                    }
                    await handleImageExportResult(documentWorkingCopy, result, selectedPageCount);
                });
            },
            (error) => {
                showExportFailure(t('errors.export.images'), error);
            },
        );
    }

    function runMultiPageTiffExport(pageNumbers?: number[]) {
        return runRasterExport(
            exportTargets.multiPageTiffTarget,
            pageNumbers,
            async (generation, selectedPageCount) => {
                await runWithDocumentOperationLease('raster-export', async () => {
                    const identity = captureExportIdentity(generation, exportTargets.multiPageTiffTarget.value);
                    if (!identity || !ownsExportIdentity(identity, exportTargets.multiPageTiffTarget.value)) {
                        setExportOverlay(null);
                        return;
                    }

                    showExportRunning('multipage-tiff', selectedPageCount);
                    const documentWorkingCopy = getDocumentWorkingCopyCapability();
                    const imageExport = getImageExportCapability();
                    const requestId = createExportRequestId();
                    subscribeExportProgress(imageExport, requestId, 'multipage-tiff');
                    const startedAt = Date.now();
                    const result = await imageExport.exportPdfToMultiPageTiff(
                        identity.sourcePath,
                        pageNumbers?.map(pageNumber => requirePageNumber(pageNumber, totalPages.value)),
                        requestId,
                        identity.sourceKind,
                    );
                    const outputPaths = result.outputPaths ?? (result.outputPath ? [result.outputPath] : []);
                    if (!ownsExportIdentity(identity, exportTargets.multiPageTiffTarget.value)) {
                        await cleanupExportedOutputRefs(documentWorkingCopy, outputPaths);
                        if (generation === exportGeneration && !isDisposed) {
                            setExportOverlay(null);
                        }
                        return;
                    }
                    if (result.success || result.canceled) {
                        trackExportCompleted({
                            startedAt,
                            format: 'multipage_tiff',
                            outputCount: outputPaths.length,
                            selectedPageCount,
                            status: result.success ? 'success' : 'canceled',
                        });
                    }
                    if (result.success && outputPaths.length > 0) {
                        await cleanupExportedOutputRefs(documentWorkingCopy, outputPaths);
                        showExportSuccess('multipage-tiff', selectedPageCount);
                    } else {
                        setExportOverlay(null);
                        if (!result.canceled) {
                            const resultError = 'error' in result && typeof result.error === 'string'
                                ? result.error
                                : t('errors.export.multiPageTiff');
                            showExportFailure(t('errors.export.multiPageTiff'), resultError);
                        }
                    }
                });
            },
            (error) => {
                showExportFailure(t('errors.export.multiPageTiff'), error);
            },
        );
    }

    async function handleExportImages(selectedPages: TPageSelectionInput = []) {
        if (!exportTargets.imageTarget.value) {
            return;
        }
        const resolvedSelection = resolveExportSelection(selectedPages);
        if (resolvedSelection.kind === 'refused') {
            showExportSelectionRefusalToast();
            return;
        }
        const initialSelection = resolvedSelection.kind === 'all'
            ? createAllPageSelection(totalPages.value)
            : resolvedSelection.selection;
        const selection = await openExportScopeDialog('images', initialSelection);
        if (selection === null) {
            return;
        }
        const pageNumbers = selection === undefined ? undefined : resolveExportPageNumbers(selection);
        if (pageNumbers === null) {
            showExportSelectionRefusalToast();
            return;
        }
        await runImageExport(pageNumbers);
    }

    async function handleExportMultiPageTiff(selectedPages: TPageSelectionInput = []) {
        if (!exportTargets.multiPageTiffTarget.value) {
            return;
        }
        const resolvedSelection = resolveExportSelection(selectedPages);
        if (resolvedSelection.kind === 'refused') {
            showExportSelectionRefusalToast();
            return;
        }
        const initialSelection = resolvedSelection.kind === 'all'
            ? createAllPageSelection(totalPages.value)
            : resolvedSelection.selection;
        const selection = await openExportScopeDialog('multipage-tiff', initialSelection);
        if (selection === null) {
            return;
        }
        const pageNumbers = selection === undefined ? undefined : resolveExportPageNumbers(selection);
        if (pageNumbers === null) {
            showExportSelectionRefusalToast();
            return;
        }
        await runMultiPageTiffExport(pageNumbers);
    }

    onScopeDispose(() => {
        isDisposed = true;
        exportGeneration += 1;
        clearExportProgressSubscription();
        clearExportOverlayTimer();
        if (exportScopeDialogResolver) {
            resolveExportScopeDialog(null);
        }
    });

    return {
        isExportInProgress,
        exportOverlay,
        exportScopeDialogOpen,
        exportScopeDialogMode,
        exportScopeDialogSelectedPages,
        exportScopeDialogPageSelection,
        handleExportScopeDialogSubmit,
        handleExportScopeDialogOpenChange,
        handleExportImages,
        handleExportMultiPageTiff,
    };
};
