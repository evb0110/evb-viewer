import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPagePreviewSource,
    IPreviewPageSize,
    TPreviewPageSizes,
} from '@app/modules/document-viewer/pagePreviewSource';
import {
    assertDocumentPageNumber,
    type IDocumentPageSource,
    type IDocumentRenderLease,
    type TDocumentRenderPriority,
} from '@app/modules/document-viewer/source/documentPageSource';

const POINTS_PER_INCH = 72;
let nextDjvuPageSourceId = 0;

interface IDjvuPointPageSize {
    width: number;
    height: number;
    dpi?: number | undefined;
}

function isPreviewPageSizeList(value: TPreviewPageSizes): value is readonly IPreviewPageSize[] {
    return Array.isArray(value);
}

export interface IDjvuSurfaceBudget {
    reserve(options: {
        scopeId: string;
        category: 'djvu-preview';
        bytes: number;
        priority: number;
        evict?: (() => void) | undefined;
        canEvict?: (() => boolean) | undefined;
    }): {
        promotePriority?(priority: number): void;
        setPriority?(priority: number): void;
        release(): void
    };
    tryReserve?(options: {
        scopeId: string;
        category: 'djvu-preview';
        bytes: number;
        priority: number;
        evict?: (() => void) | undefined;
        canEvict?: (() => boolean) | undefined;
    }): {
        promotePriority?(priority: number): void;
        setPriority?(priority: number): void;
        release(): void
    } | null;
    releaseScope(scopeId: string): void;
}

const previewPriorityByClass: Record<TDocumentRenderPriority, number> = {
    navigation: 100,
    visible: 90,
    nearby: 50,
    thumbnail: 20,
    prefetch: 10,
};

function isRequiredVisiblePriority(priority: TDocumentRenderPriority) {
    // Required pane content may temporarily exceed the soft cap after lower-priority
    // eviction; only speculative work is allowed to fail budget admission.
    return priority === 'navigation' || priority === 'visible';
}

export async function createDjvuPageSource(
    documentRef: TDocumentRef,
    previewSource: IPagePreviewSource,
    surfaceBudget: IDjvuSurfaceBudget,
    options: {initialPageNumber?: number} = {},
): Promise<IDocumentPageSource> {
    const requestedInitialPage = Math.max(1, Math.trunc(options.initialPageNumber ?? 1));
    const pageSizes = new Map<number, IDjvuPointPageSize>();
    let pageCount: number;
    if (previewSource.getPageSourceInfo) {
        const sourceInfo = await previewSource.getPageSourceInfo(requestedInitialPage);
        pageCount = sourceInfo.pageCount;
        pageSizes.set(sourceInfo.pageNumber, sourceInfo.pageSize);
    } else {
        const compatibilityPageSizes = await previewSource.getPageSizes();
        if (!isPreviewPageSizeList(compatibilityPageSizes)) {
            throw new Error('DjVu page-size preview returned compact PDF metadata');
        }
        pageCount = compatibilityPageSizes.length;
        compatibilityPageSizes.forEach((size, index) => pageSizes.set(index + 1, size));
    }
    const getPageSize = async (pageNumber: number) => {
        assertDocumentPageNumber(pageNumber, pageCount);
        const cached = pageSizes.get(pageNumber);
        if (cached) {
            return cached;
        }
        if (previewSource.getPageSize) {
            const size = await previewSource.getPageSize(pageNumber);
            pageSizes.set(pageNumber, size);
            return size;
        }
        const compatibilityPageSizes = await previewSource.getPageSizes();
        if (!isPreviewPageSizeList(compatibilityPageSizes)) {
            throw new Error('DjVu page-size preview returned compact PDF metadata');
        }
        compatibilityPageSizes.forEach((size, index) => pageSizes.set(index + 1, size));
        const size = pageSizes.get(pageNumber);
        if (!size) {
            throw new RangeError(`Document page ${pageNumber} is outside 1..${pageCount}`);
        }
        return size;
    };
    const scopeId = `djvu-page-source:${++nextDjvuPageSourceId}`;
    let nextRenderRequestId = 0;
    const urlLeases = new Map<string, {
        lease: {
            promotePriority?(priority: number): void;
            setPriority?(priority: number): void;
            release(): void
        } | null;
        invalidationListeners: Set<() => void>;
    }>();

    const releaseUrl = (objectUrl: string) => {
        urlLeases.get(objectUrl)?.lease?.release();
        urlLeases.delete(objectUrl);
        previewSource.revokeObjectURL(objectUrl);
    };

    const renderSurface = async (request: Parameters<IDocumentPageSource['renderPage']>[0]) => {
        assertDocumentPageNumber(request.pageNumber, pageCount);
        request.signal.throwIfAborted();
        nextRenderRequestId += 1;
        const previewRequestId = `${scopeId}:${request.pageNumber}:${nextRenderRequestId}`;
        const pageSize = await getPageSize(request.pageNumber);
        request.signal.throwIfAborted();
        const transientWidthPx = previewSource.fullResolutionDecodeBeforeScale
            ? Math.max(1, pageSize.width)
            : Math.max(1, Math.min(pageSize.width, request.widthPx));
        const transientHeightPx = Math.max(1, Math.round(
            transientWidthPx * Math.max(1, pageSize.height) / Math.max(1, pageSize.width),
        ));
        const transientBytes = transientWidthPx * transientHeightPx * 4;
        const transientPriority = previewPriorityByClass[request.priority];
        const transientReservation = {
            scopeId,
            category: 'djvu-preview',
            bytes: transientBytes,
            priority: transientPriority,
            canEvict: () => false,
        } as const;
        const transientLease = isRequiredVisiblePriority(request.priority)
            ? surfaceBudget.reserve(transientReservation)
            : surfaceBudget.tryReserve?.(transientReservation)
                ?? (surfaceBudget.tryReserve ? null : surfaceBudget.reserve(transientReservation));
        if (!transientLease) {
            throw new RangeError('DjVu preview exceeds the available raster surface budget');
        }
        let transientLeaseReleased = false;
        const releaseTransientLease = () => {
            if (transientLeaseReleased) {
                return;
            }
            transientLeaseReleased = true;
            transientLease.release();
        };
        const cancelPreview = () => {
            releaseTransientLease();
            previewSource.cancelPagePreview?.(request.pageNumber, previewRequestId);
        };
        request.signal.addEventListener('abort', cancelPreview, {once: true});
        let rendered;
        try {
            rendered = await previewSource.renderPageObjectUrl(request.pageNumber, {
                previewPriority: transientPriority,
                previewRequestId,
                targetWidthPx: request.widthPx,
            });
        } finally {
            request.signal.removeEventListener('abort', cancelPreview);
            releaseTransientLease();
        }
        if (request.signal.aborted) {
            releaseUrl(rendered.objectUrl);
            request.signal.throwIfAborted();
        }
        const heightPx = Math.max(1, Math.round(
            rendered.renderedPx * Math.max(1, pageSize.height) / Math.max(1, pageSize.width),
        ));
        const bytes = rendered.renderedPx * heightPx * 4;
        const leaseEntry = {
            lease: null as {
                promotePriority?(priority: number): void;
                setPriority?(priority: number): void;
                release(): void
            } | null,
            invalidationListeners: new Set<() => void>(),
        };
        let priority = previewPriorityByClass[request.priority];
        urlLeases.set(rendered.objectUrl, leaseEntry);
        const retainedReservation = {
            scopeId,
            category: 'djvu-preview',
            bytes,
            priority,
            canEvict: () => priority < previewPriorityByClass.visible,
            evict: () => {
                for (const listener of leaseEntry.invalidationListeners) {
                    listener();
                }
                leaseEntry.invalidationListeners.clear();
                releaseUrl(rendered.objectUrl);
            },
        } as const;
        leaseEntry.lease = isRequiredVisiblePriority(request.priority)
            ? surfaceBudget.reserve(retainedReservation)
            : surfaceBudget.tryReserve?.(retainedReservation)
                ?? (surfaceBudget.tryReserve ? null : surfaceBudget.reserve(retainedReservation));
        if (!leaseEntry.lease) {
            urlLeases.delete(rendered.objectUrl);
            previewSource.revokeObjectURL(rendered.objectUrl);
            throw new RangeError('DjVu preview exceeds the available raster surface budget');
        }
        if (!urlLeases.has(rendered.objectUrl)) {
            leaseEntry.lease.release();
            throw new Error('DjVu preview evicted under memory pressure');
        }
        let released = false;
        return {
            widthPx: rendered.renderedPx,
            heightPx,
            bytes,
            surface: rendered.objectUrl,
            onInvalidated(listener: () => void) {
                leaseEntry.invalidationListeners.add(listener);
                return () => leaseEntry.invalidationListeners.delete(listener);
            },
            promotePriority(nextPriority: TDocumentRenderPriority) {
                const promotedPriority = previewPriorityByClass[nextPriority];
                if (!released && promotedPriority > priority) {
                    priority = promotedPriority;
                    leaseEntry.lease?.promotePriority?.(promotedPriority);
                }
            },
            setPriority(nextPriority: TDocumentRenderPriority) {
                if (!released) {
                    priority = previewPriorityByClass[nextPriority];
                    leaseEntry.lease?.setPriority?.(priority);
                }
            },
            release() {
                if (!released) {
                    released = true;
                    leaseEntry.invalidationListeners.clear();
                    releaseUrl(rendered.objectUrl);
                }
            },
        } satisfies IDocumentRenderLease;
    };

    const getPageText = previewSource.getPageText;
    const searchText = previewSource.searchText;
    const getOutline = previewSource.getOutline;
    return {
        kind: 'djvu',
        documentRef,
        pageCount,
        ...(getPageText ? {textProvider: {async getPageText(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageCount);
            signal.throwIfAborted();
            const text = await getPageText(pageNumber);
            signal.throwIfAborted();
            return text;
        }}} : {}),
        ...(searchText ? {searchProvider: {search(request) {
            return searchText({
                ...request,
                pageCount,
            });
        }}} : {}),
        ...(getOutline ? {outlineProvider: {async getOutline(signal) {
            signal.throwIfAborted();
            const outline = await getOutline();
            signal.throwIfAborted();
            return outline;
        }}} : {}),
        thumbnailProvider: {renderThumbnail: renderSurface},
        rasterProvider: {renderRaster: renderSurface},
        async getPageMetrics(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageCount);
            signal?.throwIfAborted();
            const size = await getPageSize(pageNumber);
            signal?.throwIfAborted();
            const dpi = typeof size.dpi === 'number' && Number.isFinite(size.dpi) && size.dpi > 0
                ? size.dpi
                : 300;
            return {
                widthPoints: size.width * POINTS_PER_INCH / dpi,
                heightPoints: size.height * POINTS_PER_INCH / dpi,
                rotation: 0,
            };
        },
        renderPage: renderSurface,
        dispose() {
            for (const objectUrl of [...urlLeases.keys()]) {
                releaseUrl(objectUrl);
            }
            surfaceBudget.releaseScope(scopeId);
            previewSource.terminate();
        },
    };
}
