import type {TDocumentRef} from '@contracts/documentRef';
import type {IPagePreviewSource} from '@app/modules/document-viewer/pagePreviewSource';
import {
    assertDocumentPageNumber,
    type IDocumentPageSource,
    type IDocumentRenderLease,
    type TDocumentRenderPriority,
} from '@app/modules/document-viewer/source/documentPageSource';

import {resolveDjvuPageSizeInPoints} from '@app/modules/document-viewer/source/resolveDjvuPageSizeInPoints';

let nextDjvuPageSourceId = 0;

interface ITransientWaitState {
    activeCount: number;
    waiters: Set<() => void>;
}

const transientStateByBudget = new WeakMap<IDjvuSurfaceBudget, ITransientWaitState>();

function getTransientState(budget: IDjvuSurfaceBudget): ITransientWaitState {
    let state = transientStateByBudget.get(budget);
    if (!state) {
        state = {activeCount: 0, waiters: new Set()};
        transientStateByBudget.set(budget, state);
    }
    return state;
}

function notifyTransientWaiters(state: ITransientWaitState) {
    if (state.waiters.size === 0) {
        return;
    }
    const waiters = [...state.waiters];
    state.waiters.clear();
    for (const wake of waiters) {
        wake();
    }
}

function createAbortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException('DjVu render canceled', 'AbortError');
}

function createDisposedError() {
    return new DOMException('DjVu page source was disposed', 'AbortError');
}

interface IDjvuPointPageSize {
    width: number;
    height: number;
    dpi?: number | undefined;
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
        release(): void;
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
        release(): void;
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
        compatibilityPageSizes.forEach((size, index) => pageSizes.set(index + 1, size));
        const size = pageSizes.get(pageNumber);
        if (!size) {
            throw new RangeError(`Document page ${pageNumber} is outside 1..${pageCount}`);
        }
        return size;
    };
    const scopeId = `djvu-page-source:${++nextDjvuPageSourceId}`;
    const transientState = getTransientState(surfaceBudget);
    const disposeWaiters = new Set<() => void>();
    let disposed = false;
    let inFlightTransientCount = 0;
    let nextRenderRequestId = 0;
    const urlLeases = new Map<
        string,
        {
            lease: {
                promotePriority?(priority: number): void;
                setPriority?(priority: number): void;
                release(): void;
            } | null;
            invalidationListeners: Set<() => void>;
        }
    >();

    const releaseUrl = (objectUrl: string) => {
        const entry = urlLeases.get(objectUrl);
        urlLeases.delete(objectUrl);
        entry?.lease?.release();
        previewSource.revokeObjectURL(objectUrl);
        notifyTransientWaiters(transientState);
    };

    const waitForTransientDrain = (signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
                reject(createAbortReason(signal));
                return;
            }
            if (disposed) {
                reject(createDisposedError());
                return;
            }
            const wake = () => {
                signal.removeEventListener('abort', onAbort);
                disposeWaiters.delete(onDispose);
                transientState.waiters.delete(wake);
                resolve();
            };
            const onAbort = () => {
                disposeWaiters.delete(onDispose);
                transientState.waiters.delete(wake);
                reject(createAbortReason(signal));
            };
            const onDispose = () => {
                signal.removeEventListener('abort', onAbort);
                transientState.waiters.delete(wake);
                reject(createDisposedError());
            };
            transientState.waiters.add(wake);
            disposeWaiters.add(onDispose);
            signal.addEventListener('abort', onAbort, {once: true});
        });

    const reserveWithTransientRetry = async (
        reservation: Parameters<IDjvuSurfaceBudget['reserve']>[0],
        priority: TDocumentRenderPriority,
        signal: AbortSignal,
    ) => {
        const claim = (lease: ReturnType<IDjvuSurfaceBudget['reserve']>) => {
            // Count the transient reservation synchronously as soon as it takes budget,
            // before returning across an await boundary to a sibling speculative render.
            inFlightTransientCount += 1;
            transientState.activeCount += 1;
            return lease;
        };
        if (isRequiredVisiblePriority(priority) || !surfaceBudget.tryReserve) {
            return claim(surfaceBudget.reserve(reservation));
        }
        for (;;) {
            if (disposed) {
                throw createDisposedError();
            }
            signal.throwIfAborted();
            const lease = surfaceBudget.tryReserve(reservation);
            if (lease) {
                return claim(lease);
            }
            if (transientState.activeCount === 0) {
                return null;
            }
            await waitForTransientDrain(signal);
        }
    };

    const renderSurface = async (request: Parameters<IDocumentPageSource['renderPage']>[0]) => {
        assertDocumentPageNumber(request.pageNumber, pageCount);
        if (disposed) {
            throw createDisposedError();
        }
        request.signal.throwIfAborted();
        nextRenderRequestId += 1;
        const previewRequestId = `${scopeId}:${request.pageNumber}:${nextRenderRequestId}`;
        const pageSize = await getPageSize(request.pageNumber);
        if (disposed) {
            throw createDisposedError();
        }
        request.signal.throwIfAborted();
        const transientWidthPx = previewSource.fullResolutionDecodeBeforeScale
            ? Math.max(1, pageSize.width)
            : Math.max(1, Math.min(pageSize.width, request.widthPx));
        const transientHeightPx = Math.max(1, Math.round((transientWidthPx * Math.max(1, pageSize.height)) / Math.max(1, pageSize.width)));
        const transientBytes = transientWidthPx * transientHeightPx * 4;
        const transientPriority = previewPriorityByClass[request.priority];
        const transientReservation = {
            scopeId,
            category: 'djvu-preview',
            bytes: transientBytes,
            priority: transientPriority,
            canEvict: () => false,
        } as const;
        const transientLease = await reserveWithTransientRetry(transientReservation, request.priority, request.signal);
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
            inFlightTransientCount = Math.max(0, inFlightTransientCount - 1);
            transientState.activeCount = Math.max(0, transientState.activeCount - 1);
            if (disposed && inFlightTransientCount === 0) {
                surfaceBudget.releaseScope(scopeId);
            }
            notifyTransientWaiters(transientState);
        };
        const cancelPreview = () => {
            previewSource.cancelPagePreview?.(request.pageNumber, previewRequestId);
        };
        request.signal.addEventListener('abort', cancelPreview, {once: true});
        let rendered;
        try {
            if (disposed) {
                throw createDisposedError();
            }
            request.signal.throwIfAborted();
            rendered = await previewSource.renderPageObjectUrl(request.pageNumber, {
                previewPriority: transientPriority,
                previewRequestId,
                targetWidthPx: request.widthPx,
                signal: request.signal,
            });
        } finally {
            request.signal.removeEventListener('abort', cancelPreview);
            releaseTransientLease();
        }
        if (disposed || request.signal.aborted) {
            releaseUrl(rendered.objectUrl);
            if (request.signal.aborted) {
                request.signal.throwIfAborted();
            }
            throw createDisposedError();
        }
        const heightPx = Math.max(1, Math.round((rendered.renderedPx * Math.max(1, pageSize.height)) / Math.max(1, pageSize.width)));
        const bytes = rendered.renderedPx * heightPx * 4;
        const leaseEntry = {
            lease: null as {
                promotePriority?(priority: number): void;
                setPriority?(priority: number): void;
                release(): void;
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
        leaseEntry.lease =
            isRequiredVisiblePriority(request.priority) || !surfaceBudget.tryReserve
                ? surfaceBudget.reserve(retainedReservation)
                : surfaceBudget.tryReserve(retainedReservation);
        if (!leaseEntry.lease) {
            urlLeases.delete(rendered.objectUrl);
            previewSource.revokeObjectURL(rendered.objectUrl);
            throw new RangeError('DjVu preview exceeds the available raster surface budget');
        }
        if (disposed || request.signal.aborted) {
            leaseEntry.lease.release();
            urlLeases.delete(rendered.objectUrl);
            previewSource.revokeObjectURL(rendered.objectUrl);
            notifyTransientWaiters(transientState);
            if (request.signal.aborted) {
                request.signal.throwIfAborted();
            }
            throw createDisposedError();
        }
        if (!urlLeases.has(rendered.objectUrl)) {
            leaseEntry.lease.release();
            notifyTransientWaiters(transientState);
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
        ...(getPageText
            ? {
                  textProvider: {
                      async getPageText(pageNumber, signal) {
                          assertDocumentPageNumber(pageNumber, pageCount);
                          signal.throwIfAborted();
                          const text = await getPageText(pageNumber);
                          signal.throwIfAborted();
                          return text;
                      },
                  },
              }
            : {}),
        ...(searchText
            ? {
                  searchProvider: {
                      search(request) {
                          return searchText({
                              ...request,
                              pageCount,
                          });
                      },
                  },
              }
            : {}),
        ...(getOutline
            ? {
                  outlineProvider: {
                      async getOutline(signal) {
                          signal.throwIfAborted();
                          const outline = await getOutline();
                          signal.throwIfAborted();
                          return outline;
                      },
                  },
              }
            : {}),
        thumbnailProvider: {renderThumbnail: renderSurface},
        rasterProvider: {renderRaster: renderSurface},
        async getPageMetrics(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageCount);
            signal?.throwIfAborted();
            const size = await getPageSize(pageNumber);
            signal?.throwIfAborted();
            const {widthPoints, heightPoints} = resolveDjvuPageSizeInPoints(size);
            return {
                widthPoints,
                heightPoints,
                rotation: 0,
            };
        },
        renderPage: renderSurface,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const wake of [...disposeWaiters]) {
                wake();
            }
            disposeWaiters.clear();
            for (const objectUrl of [...urlLeases.keys()]) {
                releaseUrl(objectUrl);
            }
            if (inFlightTransientCount === 0) {
                surfaceBudget.releaseScope(scopeId);
                notifyTransientWaiters(transientState);
            }
            previewSource.terminate();
        },
    };
}
