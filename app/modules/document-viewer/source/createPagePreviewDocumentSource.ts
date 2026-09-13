import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPagePreviewSource,
    IPreviewPageSize,
} from '@app/modules/document-viewer/pagePreviewSource';
import {
    assertDocumentPageNumber,
    type IDocumentPageSource,
    type TDocumentRenderPriority,
} from '@app/modules/document-viewer/source/documentPageSource';

const previewPriorityByClass: Record<TDocumentRenderPriority, number> = {
    navigation: 100,
    visible: 90,
    nearby: 50,
    thumbnail: 20,
    prefetch: 10,
};

interface ICreatePagePreviewDocumentSourceBaseOptions {
    documentRef: TDocumentRef;
    previewSource: IPagePreviewSource;
    ownsPreviewSource?: boolean;
}

type TCreatePagePreviewDocumentSourceOptions = ICreatePagePreviewDocumentSourceBaseOptions & (
    {
        pageSizes: readonly IPreviewPageSize[];
        pageCount?: never;
        getPageSize?: never;
    } | {
        pageSizes?: never;
        pageCount: number;
        getPageSize: (pageNumber: number) => IPreviewPageSize;
    }
);

/** Adapts the native preview renderer to the source-neutral chassis contract. */
export function createPagePreviewDocumentSource(
    options: TCreatePagePreviewDocumentSourceOptions,
): IDocumentPageSource {
    const pageCount = options.pageSizes !== undefined
        ? options.pageSizes.length
        : options.pageCount;
    const getPageSize = options.pageSizes === undefined
        ? options.getPageSize
        : (pageNumber: number) => {
            const pageSize = options.pageSizes[pageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`Page ${String(pageNumber)} is outside the preview source`);
            }
            return pageSize;
        };
    let nextRenderRequestId = 0;
    async function renderPage(request: Parameters<IDocumentPageSource['renderPage']>[0]) {
        assertDocumentPageNumber(request.pageNumber, pageCount);
        request.signal.throwIfAborted();
        nextRenderRequestId += 1;
        const previewRequestId = [
            'document-page-source',
            request.pageNumber,
            nextRenderRequestId,
        ].join(':');
        let rejectForAbort: (error: DOMException) => void = () => undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectForAbort = reject;
        });
        const cancelRender = () => {
            options.previewSource.cancelPagePreview?.(request.pageNumber, previewRequestId);
            rejectForAbort(new DOMException('Document page preview render aborted', 'AbortError'));
        };
        request.signal.addEventListener('abort', cancelRender, {once: true});
        if (request.signal.aborted) {
            cancelRender();
        }
        let canceledRenderResolved = false;
        const nativeRender = options.previewSource.renderPageObjectUrl(request.pageNumber, {
            previewRequestId,
            targetWidthPx: request.widthPx,
        });
        void nativeRender.then((lateRendered) => {
            if (request.signal.aborted) {
                canceledRenderResolved = true;
                options.previewSource.revokeObjectURL(lateRendered.objectUrl);
            }
        }, () => undefined);
        let rendered;
        try {
            rendered = await Promise.race([
                nativeRender,
                aborted,
            ]);
        } catch (error) {
            if (request.signal.aborted) {
                throw new DOMException('Document page preview render aborted', 'AbortError');
            }
            throw error;
        } finally {
            request.signal.removeEventListener('abort', cancelRender);
        }
        if (request.signal.aborted) {
            if (!canceledRenderResolved.valueOf()) {
                options.previewSource.revokeObjectURL(rendered.objectUrl);
            }
            request.signal.throwIfAborted();
        }
        const size = getPageSize(request.pageNumber);
        const widthPx = Math.max(1, rendered.renderedPx);
        const heightPx = Math.max(1, Math.round(widthPx * size.height / Math.max(1, size.width)));
        let released = false;
        const invalidationListeners = new Set<() => void>();
        const unsubscribeInvalidation = rendered.onInvalidated?.(() => {
            for (const listener of invalidationListeners) {
                listener();
            }
            invalidationListeners.clear();
        }) ?? null;
        let priority = previewPriorityByClass[request.priority];
        rendered.promotePriority?.(priority);
        return {
            widthPx,
            heightPx,
            bytes: widthPx * heightPx * 4,
            surface: rendered.objectUrl,
            onInvalidated(listener: () => void) {
                if (released) {
                    return () => undefined;
                }
                invalidationListeners.add(listener);
                return () => invalidationListeners.delete(listener);
            },
            promotePriority(nextPriority: TDocumentRenderPriority) {
                const promotedPriority = previewPriorityByClass[nextPriority];
                if (!released && promotedPriority > priority) {
                    priority = promotedPriority;
                    rendered.promotePriority?.(promotedPriority);
                }
            },
            release() {
                if (!released) {
                    released = true;
                    unsubscribeInvalidation?.();
                    invalidationListeners.clear();
                    options.previewSource.revokeObjectURL(rendered.objectUrl);
                }
            },
        };
    }

    return {
        kind: 'pdf',
        documentRef: options.documentRef,
        pageCount,
        getPageMetrics(pageNumber, signal) {
            assertDocumentPageNumber(pageNumber, pageCount);
            signal?.throwIfAborted();
            const size = getPageSize(pageNumber);
            return Promise.resolve({
                widthPoints: size.width,
                heightPoints: size.height,
                rotation: 0,
            });
        },
        renderPage,
        thumbnailProvider: {renderThumbnail: renderPage},
        dispose() {
            if (options.ownsPreviewSource) {
                options.previewSource.terminate();
            }
        },
    };
}
