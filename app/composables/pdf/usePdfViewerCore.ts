import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    watch,
    type ComputedRef,
    type Ref,
    type ShallowRef,
} from 'vue';
import {
    useDebounceFn,
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import { PixelsPerInch } from 'pdfjs-dist';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { delay } from 'es-toolkit/promise';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    TFitMode,
    TPdfSource,
} from '@app/types/pdf';
import type { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import type { useAnnotationOrchestrator } from '@app/composables/pdf/useAnnotationOrchestrator';

type TPdfDocumentResult = ReturnType<typeof usePdfDocument>;
type TAnnotationOrchestrator = ReturnType<typeof useAnnotationOrchestrator>;

interface IPageRange {
    start: number;
    end: number;
}

interface IUsePdfViewerCoreOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    zoom: ComputedRef<number>;
    fitMode: ComputedRef<TFitMode>;
    isResizing: ComputedRef<boolean>;
    continuousScroll: ComputedRef<boolean>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    pdfDocumentResult: TPdfDocumentResult;
    annotations: TAnnotationOrchestrator;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    effectiveScale: Ref<number>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    resetScale: () => void;
    computeSkeletonInsets: (
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) => Promise<void>;
    resetInsets: () => void;
    setupPagePlaceholders: () => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: { preserveRenderedPages?: boolean },
    ) => Promise<void>;
    reRenderAllVisiblePages: (getVisibleRange: () => IPageRange) => Promise<void>;
    cleanupRenderedPages: () => void;
    invalidateRenderedPages: (pages: number[]) => void;
    applySearchHighlights: () => void;
    isPageRendered: (page: number) => boolean;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number) => void;
    resetContinuousScrollState: () => void;
    startDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    onDrag: (e: MouseEvent, container: HTMLElement | null) => void;
    stopDrag: () => void;
    emit: {
        (e: 'update:zoom', value: number): void;
        (e: 'update:currentPage', page: number): void;
        (e: 'update:totalPages', total: number): void;
        (e: 'update:loading', loading: boolean): void;
        (e: 'update:document', document: PDFDocumentProxy | null): void;
        (e: 'loading', loading: boolean): void;
        (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
        (e: 'annotation-modified'): void;
    };
}

export const usePdfViewerCore = (options: IUsePdfViewerCoreOptions) => {
    const {
        viewerContainer,
        src,
        zoom,
        fitMode,
        isResizing,
        continuousScroll,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        pdfDocumentResult,
        annotations,
        currentPage,
        visibleRange,
        effectiveScale,
        basePageWidth,
        basePageHeight,
        computeFitWidthScale,
        resetScale,
        computeSkeletonInsets,
        resetInsets,
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cleanupRenderedPages,
        invalidateRenderedPages,
        applySearchHighlights,
        isPageRendered,
        getMostVisiblePage,
        updateVisibleRange,
        scrollToPage,
        resetContinuousScrollState,
        startDrag,
        onDrag,
        emit,
    } = options;

    const {
        pdfDocument,
        numPages,
        isLoading,
        getRenderVersion,
        loadPdf,
        getPage,
        cleanup: cleanupDocument,
    } = pdfDocumentResult;

    const {
        editor,
        commentSync,
        inlineIndicators,
        highlight,
    } = annotations;

    const SKELETON_BUFFER = 3;

    function isPageNearVisible(page: number) {
        const start = Math.max(1, visibleRange.value.start - SKELETON_BUFFER);
        const end = Math.min(
            numPages.value,
            visibleRange.value.end + SKELETON_BUFFER,
        );
        return page >= start && page <= end;
    }

    function shouldShowSkeleton(page: number) {
        return isPageNearVisible(page) && !isPageRendered(page);
    }

    function handleDragStart(e: MouseEvent) {
        startDrag(e, viewerContainer.value);
    }
    function handleDragMove(e: MouseEvent) {
        onDrag(e, viewerContainer.value);
    }

    function getVisibleRange() {
        updateVisibleRange(viewerContainer.value, numPages.value);
        return visibleRange.value;
    }

    function hasRenderedPageCanvas() {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector('.page_container .page_canvas canvas'),
        );
    }

    function hasRenderedTextLayerContent() {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector(
                '.page_container .text-layer span, .page_container .textLayer span',
            ),
        );
    }

    function logAsyncStageError(stage: string, error: unknown) {
        BrowserLogger.error('pdf-viewer', `Failed to ${stage}`, error);
    }

    function scheduleRecoverInitialRender() {
        void recoverInitialRenderIfNeeded().catch((error) => {
            logAsyncStageError('recover initial PDF render', error);
        });
    }

    function scheduleReRenderVisiblePages(stage: string) {
        void reRenderAllVisiblePages(getVisibleRange).catch((error) => {
            logAsyncStageError(stage, error);
        });
    }

    function scheduleLoadFromSource(isReload = false) {
        void loadFromSource(isReload).catch((error) => {
            logAsyncStageError('load PDF source', error);
        });
    }

    function scheduleSetAnnotationTool(tool: TAnnotationTool, stage: string) {
        void editor.setAnnotationTool(tool).catch((error) => {
            logAsyncStageError(stage, error);
        });
    }

    async function recoverInitialRenderIfNeeded() {
        if (!pdfDocument.value || isLoading.value || numPages.value <= 0) {
            return;
        }
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }
        await nextTick();
        await delay(40);
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await reRenderAllVisiblePages(getVisibleRange);
        } catch (error) {
            logAsyncStageError(
                're-render visible pages during initial recovery',
                error,
            );
        }

        await nextTick();
        await delay(80);
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await renderVisiblePages(getVisibleRange());
        } catch (error) {
            logAsyncStageError('render visible pages during initial recovery', error);
        }
    }

    let pendingInvalidation: number[] | null = null;
    function invalidatePages(pages: number[]) {
        pendingInvalidation = pages;
    }

    async function loadFromSource(isReload = false) {
        if (!src.value) {
            commentSync.incrementSyncToken();
            annotationCommentsCache.value = [];
            activeCommentStableKey.value = null;
            emit('annotation-comments', []);
            return;
        }

        const pageToRestore = isReload ? currentPage.value : 1;
        const pagesToInvalidate = pendingInvalidation;
        pendingInvalidation = null;
        const isSelectiveReload = isReload && pagesToInvalidate !== null;

        const savedBaseWidth = isSelectiveReload ? basePageWidth.value : null;
        const savedBaseHeight = isSelectiveReload ? basePageHeight.value : null;
        const savedVisibleRange = isSelectiveReload
            ? { ...visibleRange.value }
            : null;

        emit('update:document', null);
        if (!isReload) emit('update:totalPages', 0);
        emit('update:currentPage', pageToRestore);

        if (isSelectiveReload && pagesToInvalidate) {
            invalidateRenderedPages(pagesToInvalidate);
        } else {
            cleanupRenderedPages();
            resetScale();
            resetInsets();
            currentPage.value = pageToRestore;
            visibleRange.value = {
                start: pageToRestore,
                end: pageToRestore,
            };
        }
        editor.destroyAnnotationEditor();

        const loaded = await loadPdf(
            src.value,
            isSelectiveReload ? { preservePageStructure: true } : undefined,
        );
        if (!loaded) {
            return;
        }

        if (
            isSelectiveReload &&
      savedBaseWidth !== null &&
      savedBaseHeight !== null
        ) {
            basePageWidth.value = savedBaseWidth;
            basePageHeight.value = savedBaseHeight;
        }

        emit('update:document', pdfDocument.value);
        editor.initAnnotationEditor();

        currentPage.value = Math.min(pageToRestore, numPages.value);
        emit('update:totalPages', numPages.value);
        emit('update:currentPage', currentPage.value);

        if (!isSelectiveReload) {
            void (async () => {
                try {
                    const firstPage = await getPage(1);
                    await computeSkeletonInsets(
                        firstPage,
                        loaded.version,
                        getRenderVersion,
                    );
                } catch (error) {
                    BrowserLogger.warn(
                        'pdf-viewer',
                        'Failed to compute PDF skeleton insets',
                        error,
                    );
                }
            })();
        }

        await nextTick();

        if (!isSelectiveReload) {
            computeFitWidthScale(viewerContainer.value);
            setupPagePlaceholders();
            if (isReload && currentPage.value > 1) {
                scrollToPage(currentPage.value);
                await nextTick();
            }
        } else if (savedVisibleRange) {
            visibleRange.value = savedVisibleRange;
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await renderVisiblePages(visibleRange.value);
        } catch (error) {
            logAsyncStageError('render visible pages after source load', error);
        }
        applySearchHighlights();
        commentSync.scheduleAnnotationCommentsSync(true);
        scheduleRecoverInitialRender();
    }

    function undoAnnotation() {
        annotationUiManager.value?.undo();
    }
    function redoAnnotation() {
        annotationUiManager.value?.redo();
    }

    const debouncedRenderOnResize = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        scheduleReRenderVisiblePages('re-render visible pages after resize');
    }, 200);

    function handleResize() {
        if (isLoading.value || isResizing.value) {
            return;
        }
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && pdfDocument.value) debouncedRenderOnResize();
    }

    useResizeObserver(viewerContainer, handleResize);

    const documentTarget = typeof document !== 'undefined' ? document : null;
    useEventListener(
        documentTarget,
        'selectionchange',
        highlight.cacheCurrentTextSelection,
        { passive: true },
    );
    useEventListener(
        documentTarget,
        'pointerup',
        highlight.handleDocumentPointerUp,
        { passive: true },
    );

    onMounted(() => {
        inlineIndicators.attachInlineCommentMarkerObserver();
        scheduleLoadFromSource();
    });

    onUnmounted(() => {
        inlineIndicators.cleanup();
        highlight.clearSelectionCache();
        cleanupRenderedPages();
        editor.destroyAnnotationEditor();
        cleanupDocument();
        annotationCommentsCache.value = [];
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
    });

    watch(fitMode, async (mode) => {
        const pageToSnapTo =
            mode === 'height'
                ? getMostVisiblePage(viewerContainer.value, numPages.value)
                : null;
        const updated = computeFitWidthScale(viewerContainer.value);
        if (updated && pdfDocument.value) {
            await reRenderAllVisiblePages(getVisibleRange);
            if (pageToSnapTo !== null) {
                await nextTick();
                scrollToPage(pageToSnapTo);
            }
        }
    });

    watch(src, (newSrc, oldSrc) => {
        if (newSrc !== oldSrc) {
            const isReload = !!oldSrc && !!newSrc;
            if (!newSrc) {
                emit('update:document', null);
                annotationCommentsCache.value = [];
                activeCommentStableKey.value = null;
                emit('annotation-comments', []);
            }
            scheduleLoadFromSource(isReload);
        }
    });

    watch(
        annotationCommentsCache,
        (comments) => {
            const activeKey = activeCommentStableKey.value;
            if (!activeKey) {
                return;
            }
            if (!comments.some((comment) => comment.stableKey === activeKey)) {
                activeCommentStableKey.value = null;
            }
        },
        { deep: true },
    );

    watch(
        () => continuousScroll.value,
        () => {
            resetContinuousScrollState();
        },
    );

    watch(zoom, () => {
        if (pdfDocument.value) {
            scheduleReRenderVisiblePages('re-render visible pages after zoom change');
        }
    });

    watch(effectiveScale, (scale) => {
        annotationUiManager.value?.onScaleChanging({scale: scale / PixelsPerInch.PDF_TO_CSS_UNITS});
    });

    watch(currentPage, (page) => {
        annotationUiManager.value?.onPageChanging({ pageNumber: page });
    });

    watch(
        annotationTool,
        (tool) => {
            if (tool !== 'none') highlight.cancelCommentPlacement();
            scheduleSetAnnotationTool(tool, `apply annotation tool "${tool}"`);
        },
        { immediate: true },
    );

    watch(annotationCursorMode, () => {
        if (annotationTool.value === 'none') {
            scheduleSetAnnotationTool('none', 're-apply annotation cursor mode');
        }
    });

    watch(
        annotationSettings,
        (settings) => {
            editor.applyAnnotationSettings(settings);
        },
        {
            deep: true,
            immediate: true,
        },
    );

    watch(isResizing, async (value) => {
        if (!value && pdfDocument.value && !isLoading.value) {
            await nextTick();
            await delay(20);
            computeFitWidthScale(viewerContainer.value);
            scheduleReRenderVisiblePages(
                're-render visible pages after resize settle',
            );
        }
    });

    const isEffectivelyLoading = computed(() => !!src.value && isLoading.value);

    watch(
        isEffectivelyLoading,
        async (value, oldValue) => {
            if (oldValue === true && value === false) {
                await nextTick();
                scheduleRecoverInitialRender();
            }
            emit('update:loading', value);
            emit('loading', value);
        },
        { immediate: true },
    );

    return {
        shouldShowSkeleton,
        handleDragStart,
        handleDragMove,
        undoAnnotation,
        redoAnnotation,
        invalidatePages,
    };
};
