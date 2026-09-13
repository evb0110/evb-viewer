import type { ComponentPublicInstance } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentViewMode } from '@contracts/shared';
import type {
    IDocumentSearchMatch,
    IDocumentPageMetrics,
    IDocumentPageSource,
    IDocumentSourceCapabilities, IDocumentTransition , IDocumentViewerRuntime,  
} from '@app/modules/document-viewer/public';
import {
    createDocumentTransitionChannel, createDjvuPageSource , resolveDocumentPageSourceOpeningFrame , DOCUMENT_PAGE_GUTTER_PX,  
} from '@app/modules/document-viewer/public';
import {
    createProvisionalDocumentPageMetrics,
    hydrateRemainingDocumentPageMetrics,
    loadInitialDocumentPageMetric,
    type TDocumentPageMetricsCollection,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import { createDjvuPagePreviewSourceFromPath } from '@app/platform/browser-api/public';
import type { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';

/** Keep background DjVu metric work within the visible and render-priority window. */
const DOCUMENT_SOURCE_BACKGROUND_METRIC_HYDRATION_MAX_PAGES = 128;

export interface IDocumentPageSourceFence {
    readonly loadGeneration: number;
    readonly openSurfaceGeneration: number | null;
    readonly documentRevision: string | null;
    readonly src: TDocumentRef | null;
}
export interface IDocumentPageSourceTransition extends IDocumentTransition<IDocumentPageSourceFence> {readonly kind: 'open' | 'settle' | 'invalidate' | 'restore';}
const SUPERSEDABLE_OPEN_PHASES = new Set([
    'pending',
    'geometry-committed',
    'canvas-committed',
    'viewport-committed',
]);
export function createDocumentPageSourceLifecycle(options: {
    chassisAuthority: IDocumentViewerRuntime | null;
    readIsActive: () => boolean;
    readRevisionToken: () => TDocumentRevisionToken | null;
    readSrc: () => TDocumentRef | null;
}) {
    const loadGeneration = ref(0);
    const openSurfaceGeneration = ref<number | null>(null);
    const documentRevision = ref<string | null>(null);
    const activeFences = new WeakSet<IDocumentPageSourceFence>();
    const readFence = (): IDocumentPageSourceFence => Object.freeze({
        loadGeneration: loadGeneration.value,
        openSurfaceGeneration: openSurfaceGeneration.value,
        documentRevision: documentRevision.value,
        src: options.readSrc(),
    });
    const isFenceCurrent = (fence: IDocumentPageSourceFence) => (
        fence.loadGeneration === loadGeneration.value
        && fence.openSurfaceGeneration === openSurfaceGeneration.value
        && fence.documentRevision === documentRevision.value
        && fence.src === options.readSrc()
        && (!activeFences.has(fence) || options.readIsActive())
    );
    const channel = createDocumentTransitionChannel<
        IDocumentPageSourceFence,
        IDocumentPageSourceTransition
    >(isFenceCurrent);
    function supersede() {
        const openSurface = options.chassisAuthority?.openSurface;
        const snapshot = openSurface?.snapshot.value;
        if (
            openSurface
            && snapshot
            && openSurfaceGeneration.value !== null
            && snapshot.generation === openSurfaceGeneration.value
            && snapshot.openingPageFrame !== null
            && SUPERSEDABLE_OPEN_PHASES.has(snapshot.phase)
        ) {
            openSurface.supersede();
        }
        openSurfaceGeneration.value = null;
        documentRevision.value = null;
    }
    function start() {
        watch(
            [
                options.readSrc,
                options.readRevisionToken,
            ],
            ([src], previous) => {
                if (previous[0]) {
                    supersede();
                }
                const generation = ++loadGeneration.value;
                documentRevision.value = src
                    ? String(options.readRevisionToken() ?? `page-source:${String(generation)}`)
                    : null;
                const chassisAuthority = options.chassisAuthority;
                openSurfaceGeneration.value = src && chassisAuthority
                    ? chassisAuthority.openSurface.claim({
                        documentId: chassisAuthority.openSurface.snapshot.value.identity?.documentId
                            ?? String(src),
                        documentRevision: documentRevision.value ?? '',
                    })
                    : null;
                void channel.publish({
                    kind: 'open',
                    fence: readFence(),
                });
            },
            {immediate: true},
        );
        watch(
            () => [
                options.chassisAuthority?.openSurface.snapshot.value.generation ?? null,
                options.chassisAuthority?.openSurface.snapshot.value.identity?.documentId ?? null,
                options.chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision ?? null,
                options.chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.generation ?? null,
            ] as const,
            ([
                generation,
                documentId,
                revision,
                frameGeneration,
            ]) => {
                const src = options.readSrc();
                if (
                    generation === null
                    || frameGeneration !== generation
                    || !src
                    || documentId !== String(src)
                    || revision !== documentRevision.value
                    || generation === openSurfaceGeneration.value
                ) {
                    return;
                }
                openSurfaceGeneration.value = generation;
                void channel.publish({
                    kind: 'settle',
                    fence: readFence(),
                });
            },
            {flush: 'sync'},
        );
        watch(options.readIsActive, (isActive) => {
            if (!isActive) {
                void channel.publish({
                    kind: 'invalidate',
                    fence: readFence(),
                });
                return;
            }
            const fence = readFence();
            activeFences.add(fence);
            void channel.publish({
                kind: 'restore',
                fence,
            });
        }, {flush: 'post'});
    }
    return {
        channel,
        dispose() {
            supersede();
            channel.dispose();
        },
        isCurrent: isFenceCurrent,
        loadGeneration: readonly(loadGeneration),
        openSurfaceGeneration: readonly(openSurfaceGeneration),
        readFence,
        start,
    };
}
export interface IDocumentPageSourceFeaturePackProps {
    src: TDocumentRef | null;
    zoom?: number;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    viewMode?: TDocumentViewMode;
    continuousScroll?: boolean;
    documentRevisionToken?: TDocumentRevisionToken | null;
    isActive?: boolean;
    isInteractionActive?: boolean;
    isResizing?: boolean;
    currentPage?: number;
    searchResults?: readonly IDocumentSearchMatch[];
    currentSearchResultIndex?: number;
}
export type TDocumentPageSourceRuntimeProps = Required<Pick<
    IDocumentPageSourceFeaturePackProps,
    'continuousScroll' | 'currentPage' | 'isActive' | 'isInteractionActive' | 'isResizing' | 'viewMode' | 'zoom' | 'zoomMode'
>> & Pick<IDocumentPageSourceFeaturePackProps, 'documentRevisionToken' | 'src'>;
export interface IDocumentPageSourceFeaturePackEmit {
    (event: 'update:zoom', value: number): void;
    (event: 'update:zoomMode', value: 'custom' | 'fit-width' | 'fit-height'): void;
    (event: 'update:effectiveZoom', value: number): void;
    (event: 'update:currentPage', value: number): void;
    (event: 'update:totalPages', value: number): void;
    (event: 'update:sourceCapabilities', value: IDocumentSourceCapabilities): void;
    (event: 'update:pageSource', value: IDocumentPageSource | null): void;
    (event: 'loading', value: boolean): void;
    (event: 'loadError', value: unknown): void;
    (event: 'initial-visual-pending'): void;
    (event: 'initial-visual-ready', value: {pageNumber: number;}): void;
}
export async function openDocumentPageSource(
    transition: IDocumentPageSourceTransition,
    context: {
        chassisAuthority: IDocumentViewerRuntime | null;
        emit: IDocumentPageSourceFeaturePackEmit;
        commitPageTerminalError: (pageNumber: number, cause?: unknown) => string;
        createPageFailureError: (pageNumber: number, message?: string) => Error;
        ensureExactPageMetric: (
            source: IDocumentPageSource, loadGeneration: number, pageNumber: number,
            signal: AbortSignal, isCurrent: () => boolean,
        ) => Promise<IDocumentPageMetrics>;
        getOpeningShellTarget: (pageNumber: number) => HTMLElement | null;
        layoutLifecycle: {
            beginLayoutTransaction: () => number;
            endLayoutTransaction: (transaction: number, restore: boolean) => Promise<void>;
            preserveLayoutMutation: (mutate: () => void) => void;
        };
        loadController: AbortController;
        openingPageFrameOwnerId: string;
        markExactPageMetric: (pageNumber: number) => void;
        measureViewport: () => void;
        publishPageMetrics: (metrics: TDocumentPageMetricsCollection) => void;
        readCurrentPage: () => number;
        getPriorityPages: () => readonly number[];
        readPageMetric: (pageNumber: number) => IDocumentPageMetrics | undefined;
        readPolicy: () => {
            continuousScroll: boolean;
            zoom: number;
            zoomMode: 'custom' | 'fit-width' | 'fit-height';
        };
        readViewport: () => HTMLElement | null;
        renderPage: (pageNumber: number) => Promise<void>;
        resetMetricPublication: () => void;
        scheduleRender: () => void;
        scrollToPage: (pageNumber: number) => void;
        setSource: (source: IDocumentPageSource | null) => void;
        surfaceBudget: typeof workspaceSurfaceBudgetController;
    },
): Promise<boolean> {
    const documentRef = transition.fence.src;
    if (!documentRef) {
        return false;
    }
    try {
        const preview = await createDjvuPagePreviewSourceFromPath(documentRef);
        if (!transition.isCurrent()) {
            preview.terminate();
            return false;
        }
        const nextSource = await createDjvuPageSource(
            documentRef,
            preview,
            context.surfaceBudget,
            {initialPageNumber: Math.max(1, Math.trunc(context.readCurrentPage()))},
        ).catch((error: unknown) => {
            preview.terminate();
            throw error;
        });
        if (!transition.isCurrent()) {
            nextSource.dispose();
            return false;
        }
        context.setSource(nextSource);
        context.emit('update:pageSource', nextSource);
        context.chassisAuthority?.bindSource(nextSource);
        context.emit('update:sourceCapabilities', {
            annotations: false,
            directImageExport: Boolean(nextSource.rasterProvider),
            outline: Boolean(nextSource.outlineProvider),
            pageEdits: false,
            search: Boolean(nextSource.searchProvider ?? nextSource.textProvider),
            text: Boolean(nextSource.textProvider),
        });
        const normalizePage = () => Math.max(1, Math.min(
            nextSource.pageCount,
            Math.trunc(context.readCurrentPage()),
        ));
        let initialPage = normalizePage();
        let initialMetric = await loadInitialDocumentPageMetric(
            nextSource,
            initialPage,
            context.loadController.signal,
        );
        if (!transition.isCurrent()) {
            return false;
        }
        context.publishPageMetrics(createProvisionalDocumentPageMetrics(nextSource.pageCount, initialMetric));
        context.markExactPageMetric(initialPage);
        context.emit('update:totalPages', nextSource.pageCount);
        await nextTick();
        if (!transition.isCurrent()) {
            return false;
        }
        const restoredPage = normalizePage();
        if (restoredPage !== initialPage) {
            initialPage = restoredPage;
            initialMetric = await context.ensureExactPageMetric(
                nextSource,
                transition.fence.loadGeneration,
                initialPage,
                context.loadController.signal,
                transition.isCurrent,
            );
        }
        if (!transition.isCurrent()) {
            return false;
        }
        context.emit('loading', false);
        context.scrollToPage(initialPage);
        if (!transition.isCurrent()) {
            return false;
        }
        context.measureViewport();
        const generation = transition.fence.openSurfaceGeneration;
        const authority = context.chassisAuthority;
        const metric = context.readPageMetric(initialPage);
        const viewport = context.readViewport();
        if (
            generation === null
            || !authority
            || !metric
            || !viewport
            || authority.openSurface.snapshot.value.generation !== generation
        ) {
            throw new Error('Unable to commit the initial document page shell');
        }
        const surface = authority.openSurface;
        let snapshot = surface.snapshot.value;
        if (snapshot.openingPageGeometry === null && !surface.commitOpeningPageGeometry(generation, {
            documentId: snapshot.identity?.documentId ?? String(documentRef),
            pageNumber: initialPage,
            pageCount: nextSource.pageCount,
            width: metric.widthPoints,
            height: metric.heightPoints,
            rotation: metric.rotation,
        })) {
            throw new Error('Unable to commit the initial document page geometry');
        }
        snapshot = surface.snapshot.value;
        const policy = context.readPolicy();
        const frameGeometry = snapshot.openingPageGeometry;
        const frame = frameGeometry && resolveDocumentPageSourceOpeningFrame({
            geometry: frameGeometry,
            viewportWidth: viewport.clientWidth,
            viewportHeight: viewport.clientHeight,
            zoom: policy.zoom,
            zoomMode: policy.zoomMode,
        });
        if (!frame) {
            throw new Error('Unable to resolve the initial document page shell');
        }
        const existingFrame = snapshot.openingPageFrame;
        if (!(existingFrame
            ? existingFrame.generation === generation && existingFrame.pageNumber === initialPage
            : surface.commitOpeningPageFrame(generation, {
                generation,
                ownerId: context.openingPageFrameOwnerId,
                pageNumber: initialPage,
                intentKey: `page-source:${policy.zoomMode}:${String(policy.zoom)}:${String(policy.continuousScroll)}`,
                style: frame.style,
            }))) {
            throw new Error('Unable to commit the initial document page frame');
        }
        await nextTick();
        if (!transition.isCurrent()) {
            return false;
        }
        const target = context.getOpeningShellTarget(initialPage);
        const rect = target?.getBoundingClientRect();
        if (
            !target
            || !rect
            || rect.width <= 0
            || rect.height <= 0
            || !surface.commitGeometry(generation, {
                width: rect.width,
                height: rect.height,
                margin: DOCUMENT_PAGE_GUTTER_PX,
            })
        ) {
            throw new Error('Unable to commit the initial document page shell');
        }
        await context.renderPage(initialPage);
        if (!transition.isCurrent()) {
            return false;
        }
        void (async () => {
            const layoutTransaction = context.layoutLifecycle.beginLayoutTransaction();
            try {
                const metrics = await hydrateRemainingDocumentPageMetrics({
                    source: nextSource,
                    initialPage,
                    initialMetric,
                    signal: context.loadController.signal,
                    isCurrent: () => (
                        transition.isCurrent()
                        && !context.loadController.signal.aborted
                    ),
                    getPriorityPage: () => Math.max(1, Math.min(
                        nextSource.pageCount,
                        Math.trunc(context.readCurrentPage()),
                    )),
                    getPriorityPages: context.getPriorityPages,
                    maxHydratedPages: DOCUMENT_SOURCE_BACKGROUND_METRIC_HYDRATION_MAX_PAGES,
                    loadMetric: (pageNumber, signal) => context.ensureExactPageMetric(
                        nextSource,
                        transition.fence.loadGeneration,
                        pageNumber,
                        signal,
                        transition.isCurrent,
                    ),
                    onMetric: context.scheduleRender,
                });
                if (!metrics || !transition.isCurrent()) {
                    return;
                }
                context.resetMetricPublication();
                context.layoutLifecycle.preserveLayoutMutation(() => context.publishPageMetrics(metrics));
                context.scheduleRender();
            } catch (error) {
                if (transition.isCurrent() && !(error instanceof DOMException && error.name === 'AbortError')) {
                    context.emit('loadError', error);
                }
            } finally {
                await context.layoutLifecycle.endLayoutTransaction(
                    layoutTransaction,
                    transition.isCurrent() && !context.loadController.signal.aborted,
                );
            }
        })();
        return true;
    } catch (error) {
        if (transition.isCurrent() && !(error instanceof DOMException && error.name === 'AbortError')) {
            context.emit('loading', false);
            const pageNumber = Math.max(1, Math.trunc(context.readCurrentPage()));
            const message = context.commitPageTerminalError(pageNumber, error);
            context.emit('loadError', error instanceof Error
                ? error
                : context.createPageFailureError(pageNumber, message));
        }
        return false;
    }
}
export type TDocumentPageElement = Element | ComponentPublicInstance | null;
