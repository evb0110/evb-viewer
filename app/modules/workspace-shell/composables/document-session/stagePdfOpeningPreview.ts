import type {
    IPdfNativePageSize,
    IPdfOpeningGeometry,
} from '@contracts/electronApiDocuments';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IPdfPageMetric,
    IPdfPathSource,
} from '@app/types/pdfUi';
import type {
    IDocumentOpenSurfaceSession,
    IDocumentOpenSurfaceSnapshot,
    IDocumentPageSource,
} from '@app/modules/document-viewer/public';
import { getViewColumnCount } from '@app/utils/pdfViewMode';
import {
    resolveCurrentSpreadBaseWidth,
    resolvePdfFitWidthDimensions,
    resolvePdfFitWidthRowWidths,
} from '@app/modules/pdf-viewer/public';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { getErrorMessage } from '@app/utils/error';
import { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/public';
import {
    clampDocumentFitScale,
    createPagePreviewDocumentSource,
    DOCUMENT_PAGE_GUTTER_PX,
} from '@app/modules/document-viewer/public';
import { shouldStageNativePdfOpeningPreview } from '@app/modules/pdf-viewer/public/nativePreviewRouting';
import type { IPdfValidationSourceRevision } from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';
import {
    createRequestId,
    type TDocumentViewMode,
    type TFitMode,
    type TRequestId,
    type TZoomMode,
} from '@contracts/shared';

type TNativePreviewFiles = Parameters<typeof createNativePdfPreviewSourceFromPath>[1];

export interface IPdfOpeningGeometryResolution {
    readonly openingGeometry: IPdfOpeningGeometry | null;
    readonly sourceRevision: IPdfValidationSourceRevision | null;
}

export interface IStagedPdfOpeningPreview {cancel(reason: string): void;}

export interface IPdfOpeningPreviewLayoutPolicy {
    readonly fitMode: TFitMode;
    readonly viewMode: TDocumentViewMode;
    readonly zoom: number;
    readonly zoomMode: TZoomMode;
    readonly continuousScroll: boolean;
}

function isOpeningTransitionPhase(phase: IDocumentOpenSurfaceSnapshot['phase']) {
    return phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
}

function resolveTargetWidth(
    surface: IDocumentOpenSurfaceSession,
    geometry: Pick<IPdfOpeningGeometry, 'width'>,
) {
    const frameWidth = Number.parseFloat(
        surface.snapshot.value.openingPageFrame?.style.width ?? '',
    );
    const cssWidth = Number.isFinite(frameWidth) && frameWidth > 0
        ? frameWidth
        : geometry.width;
    const pixelRatio = typeof window === 'undefined'
        ? 1
        : Math.max(1, window.devicePixelRatio || 1);
    return Math.min(4_096, Math.max(64, Math.ceil(cssWidth * pixelRatio)));
}

function isValidPageSize(value: unknown): value is IPdfNativePageSize {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.width === 'number'
        && Number.isFinite(record.width)
        && record.width > 0
        && typeof record.height === 'number'
        && Number.isFinite(record.height)
        && record.height > 0;
}

export function resolvePdfOpeningPageFrameDocumentFitWidthStyle(options: {
    readonly frame: NonNullable<IDocumentOpenSurfaceSnapshot['openingPageFrame']>;
    readonly geometry: IPdfOpeningGeometry;
    readonly pageSizes: readonly IPdfNativePageSize[];
    readonly metrics?: IPdfPageMetric[];
    readonly policy: IPdfOpeningPreviewLayoutPolicy;
    /** Viewport width captured before the opening frame is reconciled. */
    readonly rawSize: number;
    readonly widthRows?: ReadonlyMap<number, number>;
}) {
    if (
        options.policy.fitMode !== 'width'
        || options.policy.zoomMode !== 'fit-width'
        || options.policy.continuousScroll !== true
        || options.pageSizes.length !== options.geometry.pageCount
    ) {
        return null;
    }
    if (!Number.isFinite(options.rawSize) || options.rawSize <= 0 || options.geometry.width <= 0) {
        return null;
    }
    const pageNumber = requirePageNumber(options.geometry.pageNumber, options.geometry.pageCount);
    const metrics = options.metrics ?? options.pageSizes.map(pageSize => ({
        width: pageSize.width,
        height: pageSize.height,
    }));
    const currentWidth = resolveCurrentSpreadBaseWidth(
        metrics,
        options.policy.viewMode,
        options.geometry.pageCount,
        pageNumber,
    );
    if (currentWidth === null) {
        return null;
    }
    const dimensions = resolvePdfFitWidthDimensions({
        metrics,
        rawSize: options.rawSize,
        page: pageNumber,
        currentWidth,
        viewMode: options.policy.viewMode,
        totalPages: options.geometry.pageCount,
        continuousScroll: true,
        ...(options.widthRows === undefined ? {} : {widthRows: options.widthRows}),
    });
    if (dimensions.availableSize <= 0 || dimensions.baseDimension <= 0) {
        return null;
    }
    const scale = clampDocumentFitScale(dimensions.availableSize / dimensions.baseDimension);
    const width = options.geometry.width * scale;
    const height = options.geometry.height * scale;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return Object.freeze({
        width: `${String(width)}px`,
        height: `${String(height)}px`,
    });
}

export function stagePdfOpeningPreview(options: {
    readonly documentFiles: TNativePreviewFiles;
    readonly geometryResolution: Promise<IPdfOpeningGeometryResolution>;
    readonly isCurrent: () => boolean;
    readonly openSurface: IDocumentOpenSurfaceSession;
    readonly source: IPdfPathSource;
    readonly readOpeningPageFramePolicy?: () => IPdfOpeningPreviewLayoutPolicy;
    readonly traceContext?: Readonly<Record<string, unknown>>;
}): IStagedPdfOpeningPreview {
    const lifecycle: {
        canceled: boolean;
        disposed: boolean;
    } = {
        canceled: false,
        disposed: false,
    };
    let objectUrl: string | null = null;
    let source: ReturnType<typeof createNativePdfPreviewSourceFromPath> | null = null;
    let pageSource: IDocumentPageSource | null = null;
    let stopWatchingOpeningFrame: (() => void) | null = null;
    let stopWatchingSurface: (() => void) | null = null;
    let stopWatchingInvalidation: (() => void) | null = null;
    let stopWatchingNavigation: (() => void) | null = null;
    let stopWatchingTargetWidth: (() => void) | null = null;
    let resolveOpeningFrameWait: ((snapshot: IDocumentOpenSurfaceSnapshot | null) => void) | null = null;
    let generation: number | null = null;

    function cancelOpeningFrameWait() {
        const resolveWait = resolveOpeningFrameWait;
        resolveOpeningFrameWait = null;
        resolveWait?.(null);
        stopWatchingOpeningFrame?.();
        stopWatchingOpeningFrame = null;
    }

    function dispose(reason: string, clearPreview = true) {
        if (lifecycle.disposed) {
            return;
        }
        lifecycle.disposed = true;
        cancelOpeningFrameWait();
        stopWatchingSurface?.();
        stopWatchingSurface = null;
        stopWatchingInvalidation?.();
        stopWatchingInvalidation = null;
        stopWatchingNavigation?.();
        stopWatchingNavigation = null;
        stopWatchingTargetWidth?.();
        stopWatchingTargetWidth = null;
        resolveOpeningFrameWait?.(null);
        resolveOpeningFrameWait = null;
        if (clearPreview && generation !== null && objectUrl !== null) {
            options.openSurface.clearOpeningPagePreview(generation, objectUrl);
        }
        if (generation !== null) {
            const current = options.openSurface.snapshot.value;
            options.openSurface.setNativeOpeningPreviewState(
                generation,
                isOpeningTransitionPhase(current.phase) ? 'failed' : 'inactive',
            );
        }
        if (generation !== null && pageSource !== null) {
            options.openSurface.clearOpeningPageSource(generation, pageSource);
        }
        pageSource?.dispose();
        pageSource = null;
        source?.terminate();
        source = null;
        logPdfRenderTrace('pdf-open-native-preview-retired', {
            ...options.traceContext,
            reason,
        });
    }

    function releaseNativeOpeningPreviewIfCurrent() {
        if (!options.isCurrent()) {
            return;
        }
        const current = options.openSurface.snapshot.value;
        if (!isOpeningTransitionPhase(current.phase)) {
            return;
        }
        generation = current.generation;
        // No native preview was admitted (for example, a low-CPU cache miss).
        // Release the provisional policy owner instead of presenting that
        // ordinary non-staged open as a failed native lane.
        options.openSurface.setNativeOpeningPreviewState(generation, 'inactive');
    }

    function waitForOpeningFrame(input: {
        documentId: string;
        openingGeometry: IPdfOpeningGeometry;
        pageNumber: number;
        sourceRevisionKey: string;
    }): Promise<IDocumentOpenSurfaceSnapshot | null> {
        // One preview attempt owns one generation-bound watcher. Replacement,
        // cancellation, and disposal all settle it through
        // cancelOpeningFrameWait, so no observer can survive its attempt.
        cancelOpeningFrameWait();
        let boundGeneration: number | null = null;
        const inspect = (snapshot: IDocumentOpenSurfaceSnapshot) => {
            if (
                lifecycle.canceled
                || lifecycle.disposed
                || !options.isCurrent()
            ) {
                return null;
            }
            if (!isOpeningTransitionPhase(snapshot.phase)) {
                return snapshot.identity?.documentId === input.documentId
                    && (snapshot.phase === 'ready' || snapshot.phase === 'failed')
                    ? null
                    : undefined;
            }
            if (snapshot.identity?.documentId !== input.documentId) {
                return undefined;
            }
            boundGeneration ??= snapshot.generation;
            if (snapshot.generation !== boundGeneration) {
                return null;
            }
            generation ??= boundGeneration;
            if (snapshot.nativeOpeningPreviewState !== 'loading') {
                options.openSurface.setNativeOpeningPreviewState(boundGeneration, 'loading');
            }
            if (snapshot.openingPageGeometry === null && snapshot.phase === 'pending') {
                options.openSurface.commitOpeningPageGeometry(snapshot.generation, {
                    documentId: input.documentId,
                    ...input.openingGeometry,
                });
                return undefined;
            }
            const frame = snapshot.openingPageFrame;
            if (
                frame?.generation === boundGeneration
                && frame.pageNumber === input.pageNumber
                && frame.sourceRevisionKey === input.sourceRevisionKey
            ) {
                return snapshot;
            }
            return undefined;
        };
        const initial = inspect(options.openSurface.snapshot.value);
        if (initial !== undefined) {
            return Promise.resolve(initial);
        }
        return new Promise((resolve) => {
            let settled = false;
            const settle = (snapshot: IDocumentOpenSurfaceSnapshot | null) => {
                if (settled) {
                    return;
                }
                settled = true;
                stopWatchingOpeningFrame?.();
                stopWatchingOpeningFrame = null;
                resolveOpeningFrameWait = null;
                resolve(snapshot);
            };
            resolveOpeningFrameWait = settle;
            stopWatchingOpeningFrame = watch(
                () => options.openSurface.snapshot.value,
                (snapshot) => {
                    const result = inspect(snapshot);
                    if (result !== undefined) {
                        settle(result);
                    }
                },
                {flush: 'sync'},
            );
            const current = inspect(options.openSurface.snapshot.value);
            if (current !== undefined) {
                settle(current);
            }
        });
    }

    void (async () => {
        logPdfRenderTrace('pdf-open-native-preview-resolution-start', options.traceContext);
        const resolution = await options.geometryResolution;
        const shouldStage = shouldStageNativePdfOpeningPreview(options.source, resolution.openingGeometry);
        const resolvedSnapshot = options.openSurface.snapshot.value;
        logPdfRenderTrace('pdf-open-native-preview-resolution-end', {
            ...options.traceContext,
            canceled: lifecycle.canceled,
            current: options.isCurrent(),
            documentId: resolvedSnapshot.identity?.documentId ?? null,
            hasOpeningGeometry: resolution.openingGeometry !== null,
            hasSourceRevision: resolution.sourceRevision !== null,
            pageCount: resolution.openingGeometry?.pageCount ?? null,
            phase: resolvedSnapshot.phase,
            size: resolution.openingGeometry?.size ?? null,
            sourceSize: options.source.size,
            sourceRevisionDocumentId: resolution.sourceRevision?.documentId ?? null,
            shouldStage,
        });
        if (
            lifecycle.canceled
            || !options.isCurrent()
            || resolution.openingGeometry === null
            || resolution.sourceRevision === null
            || !shouldStage
        ) {
            // The PDF.js source is the managed working-copy path, while the
            // open surface is identified by the user's original path. Do not
            // compare those two identities here: on low-resource profiles
            // geometry preflight is cache-only, so a cache miss must release
            // the provisional skeleton owner instead of leaving it visible
            // forever.
            releaseNativeOpeningPreviewIfCurrent();
            return;
        }
        const openingGeometry = resolution.openingGeometry;
        const sourceRevision = resolution.sourceRevision;
        const sourceRevisionKey = `${String(sourceRevision.size)}:${String(sourceRevision.modifiedAt)}`;
        const resolvedSurface = options.openSurface.snapshot.value;
        if (
            isOpeningTransitionPhase(resolvedSurface.phase)
            && resolvedSurface.identity?.documentId === sourceRevision.documentId
        ) {
            generation = resolvedSurface.generation;
            options.openSurface.setNativeOpeningPreviewState(generation, 'loading');
        }
        logPdfRenderTrace('pdf-open-native-preview-frame-wait-start', {
            ...options.traceContext,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        const snapshot = await waitForOpeningFrame({
            documentId: sourceRevision.documentId,
            openingGeometry,
            pageNumber: openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        generation = snapshot?.generation ?? null;
        logPdfRenderTrace('pdf-open-native-preview-frame-wait-end', {
            ...options.traceContext,
            generation,
            matched: snapshot !== null,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        if (snapshot === null || Boolean(lifecycle.canceled) || !options.isCurrent()) {
            return;
        }
        const activeGeneration = snapshot.generation;
        generation = activeGeneration;
        const previewSource = createNativePdfPreviewSourceFromPath(options.source.path, options.documentFiles);
        source = previewSource;
        const loadedPageSizes = await Promise.resolve(previewSource.getPageSizes()).catch(() => null);
        if (Boolean(lifecycle.disposed) || Boolean(lifecycle.canceled) || !options.isCurrent()) {
            dispose('surface-retired-during-page-sizes', false);
            return;
        }
        const pageCount = openingGeometry.pageCount;
        let pageSizes: readonly IPdfNativePageSize[] | null = null;
        let pageMetrics: IPdfPageMetric[] | null = null;
        if (
            Array.isArray(loadedPageSizes)
            && loadedPageSizes.length === pageCount
            && loadedPageSizes.every(isValidPageSize)
        ) {
            pageSizes = loadedPageSizes;
            pageMetrics = loadedPageSizes.map(pageSize => ({
                width: pageSize.width,
                height: pageSize.height,
            }));
        }
        if (pageSizes === null || pageMetrics === null) {
            // Compact native metadata contains only bounded early/late
            // overrides; pages in the middle are still guesses. A native
            // opening preview without a complete page table would render
            // page 1 at a guessed document-wide size, then jump when PDF.js
            // applies the real Fit Width. Release the provisional owner and
            // let the regular PDF.js open continue instead.
            logPdfRenderTrace('pdf-open-native-preview-page-sizes-unavailable', {
                ...options.traceContext,
                loadedPageSizes: loadedPageSizes === null
                    ? 'null'
                    : Array.isArray(loadedPageSizes)
                        ? `array:${String(loadedPageSizes.length)}`
                        : 'compact-incomplete',
                pageCount,
            });
            dispose('page-sizes-unavailable', false);
            return;
        }
        const completePageSizes = pageSizes;
        const completePageMetrics = pageMetrics;
        const getPageSize = (pageNumber: number) => completePageSizes[
            requirePageNumber(pageNumber, pageCount) - 1
        ]!;
        let fitWidthRowWidthsCacheKey: TDocumentViewMode | null = null;
        let fitWidthRowWidths: ReadonlyMap<number, number> | undefined;
        let fitWidthRawSize: number | null = null;
        function getFitWidthRowWidths(policy: IPdfOpeningPreviewLayoutPolicy) {
            if (fitWidthRowWidthsCacheKey !== policy.viewMode) {
                fitWidthRowWidthsCacheKey = policy.viewMode;
                fitWidthRowWidths = resolvePdfFitWidthRowWidths({
                    metrics: completePageMetrics,
                    viewMode: policy.viewMode,
                    totalPages: pageCount,
                });
            }
            return fitWidthRowWidths;
        }
        function getFitWidthRawSize(
            frame: NonNullable<IDocumentOpenSurfaceSnapshot['openingPageFrame']>,
            policy: IPdfOpeningPreviewLayoutPolicy,
        ) {
            if (
                policy.fitMode !== 'width'
                || policy.zoomMode !== 'fit-width'
                || policy.continuousScroll !== true
            ) {
                return null;
            }
            if (fitWidthRawSize !== null) {
                return fitWidthRawSize;
            }
            const frameWidth = Number.parseFloat(frame.style.width ?? '');
            if (!Number.isFinite(frameWidth) || frameWidth <= 0) {
                return null;
            }
            const columns = getViewColumnCount(policy.viewMode, pageCount);
            const rawSize = frameWidth * columns + DOCUMENT_PAGE_GUTTER_PX * (columns + 1);
            if (!Number.isFinite(rawSize) || rawSize <= 0) {
                return null;
            }
            fitWidthRawSize = rawSize;
            return rawSize;
        }
        function reconcileOpeningPageFrameDocumentFitWidth(geometry: IPdfOpeningGeometry) {
            const current = options.openSurface.snapshot.value;
            const frame = current.openingPageFrame;
            const policy = options.readOpeningPageFramePolicy?.();
            const rawSize = frame !== null && policy !== undefined
                ? getFitWidthRawSize(frame, policy)
                : null;
            const widthRows = policy === undefined
                ? undefined
                : getFitWidthRowWidths(policy);
            const style = frame !== null && policy !== undefined && rawSize !== null
                ? resolvePdfOpeningPageFrameDocumentFitWidthStyle({
                    frame,
                    geometry,
                    pageSizes: completePageSizes,
                    metrics: completePageMetrics,
                    policy,
                    rawSize,
                    ...(widthRows === undefined ? {} : {widthRows}),
                })
                : null;
            if (style !== null && frame !== null) {
                const accepted = options.openSurface.commitOpeningPageFrame(activeGeneration, {
                    generation: activeGeneration,
                    ownerId: frame.ownerId,
                    pageNumber: frame.pageNumber,
                    intentKey: frame.intentKey,
                    sourceRevisionKey: frame.sourceRevisionKey ?? sourceRevisionKey,
                    style,
                });
                if (accepted) {
                    logPdfRenderTrace('pdf-open-native-preview-fit-width-reconciled', {
                        ...options.traceContext,
                        generation: activeGeneration,
                        pageCount,
                        previousWidth: frame.style.width,
                        nextWidth: style.width,
                        viewMode: policy?.viewMode ?? null,
                    });
                }
            }
            return style !== null && frame !== null;
        }
        if (!reconcileOpeningPageFrameDocumentFitWidth(openingGeometry)) {
            logPdfRenderTrace('pdf-open-native-preview-fit-width-unavailable', {
                ...options.traceContext,
                pageCount,
            });
            dispose('document-fit-width-unavailable', false);
            return;
        }
        options.openSurface.setNativeOpeningPreviewState(activeGeneration, 'settled');
        pageSource = createPagePreviewDocumentSource({
            documentRef: sourceRevision.documentId,
            previewSource,
            pageSizes: completePageSizes,
            ownsPreviewSource: false,
        });
        if (!options.openSurface.publishOpeningPageSource(
            activeGeneration,
            pageSource,
            () => dispose('surface-retired'),
        )) {
            dispose('source-rejected', false);
            return;
        }

        let nextRenderRevision = 0;
        let activeRender: {
            key: string;
            pageNumber: number;
            requestId: TRequestId;
        } | null = null;
        let committedRenderKey: string | null = null;
        async function renderPreview(pageNumber: number, reason: string) {
            if (lifecycle.disposed || lifecycle.canceled || !options.isCurrent()) {
                return false;
            }
            const boundedPage = Math.min(
                Math.max(1, Math.trunc(pageNumber)),
                pageCount,
            );
            const currentGeometry = options.openSurface.snapshot.value.openingPageGeometry
                ?? openingGeometry;
            const targetWidthPx = resolveTargetWidth(options.openSurface, currentGeometry);
            const renderKey = `${String(boundedPage)}:${String(targetWidthPx)}`;
            if (renderKey === activeRender?.key) {
                return false;
            }
            if (
                renderKey === committedRenderKey
                && options.openSurface.snapshot.value.openingPageFrame?.preview?.pageNumber
                === boundedPage
            ) {
                return true;
            }
            nextRenderRevision += 1;
            const renderRevision = nextRenderRevision;
            if (activeRender !== null) {
                previewSource.cancelPagePreview(
                    activeRender.pageNumber,
                    activeRender.requestId,
                );
            }
            const requestId = createRequestId('pdf-opening');
            const pendingRender = {
                key: renderKey,
                pageNumber: boundedPage,
                requestId,
            };
            activeRender = pendingRender;
            logPdfRenderTrace('pdf-open-native-preview-submit', {
                ...options.traceContext,
                generation: activeGeneration,
                pageNumber: boundedPage,
                reason,
                sourceRevisionKey,
                targetWidthPx,
            });
            let rendered;
            try {
                rendered = await previewSource.renderPageObjectUrl(boundedPage, {
                    previewRequestId: requestId,
                    targetWidthPx,
                });
            } catch (error) {
                if (
                    Boolean(lifecycle.disposed)
                    || Boolean(lifecycle.canceled)
                    || !options.isCurrent()
                    || renderRevision !== nextRenderRevision
                ) {
                    return false;
                }
                throw error;
            } finally {
                if (activeRender === pendingRender) {
                    activeRender = null;
                }
            }
            if (
                Boolean(lifecycle.disposed)
                || Boolean(lifecycle.canceled)
                || !options.isCurrent()
                || renderRevision !== nextRenderRevision
            ) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            const current = options.openSurface.snapshot.value;
            const currentRevision = current.identity?.documentRevision;
            if (
                current.generation !== activeGeneration
                || current.identity?.documentId !== sourceRevision.documentId
                || currentRevision === undefined
                || !isOpeningTransitionPhase(current.phase)
                || options.openSurface.viewportSession.value.requestedPage !== boundedPage
            ) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            const pageSize = getPageSize(boundedPage);
            const nextGeometry = {
                ...openingGeometry,
                documentId: sourceRevision.documentId,
                pageNumber: requirePageNumber(boundedPage, pageCount),
                pageCount,
                width: pageSize.width,
                height: pageSize.height,
                rotation: boundedPage === openingGeometry.pageNumber
                    ? openingGeometry.rotation
                    : 0 as const,
            };
            const geometryMatches = current.openingPageGeometry?.pageNumber === boundedPage
                && current.openingPageGeometry.width === nextGeometry.width
                && current.openingPageGeometry.height === nextGeometry.height;
            if (
                !geometryMatches
                && !options.openSurface.commitOpeningPageGeometry(activeGeneration, nextGeometry)
            ) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            const accepted = options.openSurface.commitOpeningPagePreview(activeGeneration, {
                documentId: sourceRevision.documentId,
                documentRevision: currentRevision,
                objectUrl: rendered.objectUrl,
                pageNumber: boundedPage,
                renderedWidth: rendered.renderedPx,
                sourceRevisionKey,
            });
            if (!accepted) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            // Preview commit wakes the opening-frame owner, which may restore
            // its page-local draft in the same synchronous watcher turn. Reuse
            // the document-wide fit decision after that handoff so the native
            // shell and the settled PDF.js surface keep one width authority.
            reconcileOpeningPageFrameDocumentFitWidth(nextGeometry);
            const previousObjectUrl = objectUrl;
            stopWatchingInvalidation?.();
            objectUrl = rendered.objectUrl;
            stopWatchingInvalidation = rendered.onInvalidated?.(() => {
                if (generation === null || objectUrl !== rendered.objectUrl) {
                    return;
                }
                options.openSurface.clearOpeningPagePreview(generation, rendered.objectUrl);
                objectUrl = null;
                committedRenderKey = null;
                requestPreviewRender(
                    options.openSurface.viewportSession.value.requestedPage,
                    'memory-pressure-recovery',
                );
            }) ?? null;
            if (previousObjectUrl && previousObjectUrl !== rendered.objectUrl) {
                previewSource.revokeObjectURL(previousObjectUrl);
            }
            committedRenderKey = renderKey;
            logPdfRenderTrace('pdf-open-native-preview-committed', {
                ...options.traceContext,
                generation: activeGeneration,
                pageNumber: boundedPage,
                reason,
                renderedWidth: rendered.renderedPx,
                sourceRevisionKey,
            });
            return true;
        }

        function requestPreviewRender(pageNumber: number, reason: string) {
            void renderPreview(pageNumber, reason).catch((error: unknown) => {
                if (lifecycle.disposed || lifecycle.canceled) {
                    return;
                }
                logPdfRenderTrace('pdf-open-native-preview-failed', {
                    ...options.traceContext,
                    error: getErrorMessage(error),
                    reason,
                });
                dispose('render-failed');
            });
        }

        stopWatchingSurface = watch(
            () => {
                const live = options.openSurface.snapshot.value;
                return [
                    live.generation,
                    live.phase,
                ] as const;
            },
            ([
                liveGeneration,
                phase,
            ]) => {
                if (
                    liveGeneration !== activeGeneration
                    || phase === 'ready'
                    || phase === 'failed'
                ) {
                    dispose(phase === 'ready' ? 'pdfjs-handoff' : 'surface-changed', false);
                }
            },
            {flush: 'sync'},
        );
        stopWatchingNavigation = watch(
            () => options.openSurface.viewportSession.value.requestedPage,
            (pageNumber) => {
                if (
                    options.openSurface.snapshot.value.openingPageFrame?.preview?.pageNumber
                    !== pageNumber
                ) {
                    requestPreviewRender(pageNumber, 'navigation');
                }
            },
            {flush: 'sync'},
        );
        const initialRendered = await renderPreview(
            options.openSurface.viewportSession.value.requestedPage,
            'initial',
        );
        if (
            !initialRendered
            && lifecycle.disposed !== true
            && options.openSurface.snapshot.value.openingPageFrame?.preview === undefined
        ) {
            dispose('initial-render-rejected', false);
        }
        if (lifecycle.disposed === true) {
            return;
        }
        stopWatchingTargetWidth = watch(
            () => options.openSurface.snapshot.value.openingPageFrame?.style.width ?? '',
            (_width, previousWidth) => {
                if (previousWidth) {
                    requestPreviewRender(
                        options.openSurface.viewportSession.value.requestedPage,
                        'viewport-scale',
                    );
                }
            },
            {flush: 'post'},
        );
    })().catch((error: unknown) => {
        if (!lifecycle.canceled) {
            logPdfRenderTrace('pdf-open-native-preview-failed', {
                ...options.traceContext,
                error: getErrorMessage(error),
            });
        }
        dispose(lifecycle.canceled ? 'canceled' : 'render-failed');
    });

    return Object.freeze({cancel(reason: string) {
        lifecycle.canceled = true;
        dispose(reason);
    }});
}
