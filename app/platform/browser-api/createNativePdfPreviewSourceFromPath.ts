import type { TDocumentRef } from '@contracts/documentRef';
import {
    createRequestId,
    parseRequestId,
    type TRequestId,
} from '@contracts/shared';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {
    IDocumentsFileIoCapability,
    IPdfNativePagePreviewOptions,
    TPdfNativePageSizes,
} from '@contracts/electronApiDocuments';
import {
    requireWorkspaceSurfaceBudgetPort,
    type IWorkspaceSurfaceBudgetLeasePort,
} from '@app/utils/workspaceSurfaceBudgetPort';
import type { IPagePreviewRenderedObjectUrl } from '@app/modules/document-viewer/public';

function createJpegObjectUrl(bytes: Uint8Array) {
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
}

let nextNativePreviewSourceInstanceId = 0;

export function createNativePdfPreviewSourceFromPath(
    pdfPath: TDocumentRef,
    documentFiles: Pick<
        IDocumentsFileIoCapability,
        'cancelPdfNativePagePreview' | 'renderPdfNativePagePreview'
    > & {getPdfNativePageSizes?: (path: TDocumentRef) => Promise<TPdfNativePageSizes>},
) {
    const cancelPdfNativePagePreview = documentFiles.cancelPdfNativePagePreview;
    const getPdfNativePageSizes = documentFiles.getPdfNativePageSizes;
    const renderPdfNativePagePreview = documentFiles.renderPdfNativePagePreview;

    if (
        typeof cancelPdfNativePagePreview !== 'function'
        || typeof getPdfNativePageSizes !== 'function'
        || typeof renderPdfNativePagePreview !== 'function'
    ) {
        throw new Error('Native PDF preview is unavailable in this runtime');
    }

    let terminated = false;
    let nextPreviewRequestId = 0;
    nextNativePreviewSourceInstanceId += 1;
    const sourceInstanceId = nextNativePreviewSourceInstanceId;
    const activePreviewRequestIds = new Set<TRequestId>();
    const activePreviewRequestIdsByPage = new Map<number, Set<TRequestId>>();
    const canceledPreviewRequestIds = new Set<TRequestId>();
    const objectUrlLeases = new Map<string, {
        lease: IWorkspaceSurfaceBudgetLeasePort | null;
        invalidationListeners: Set<() => void>;
    }>();
    const surfaceScopeId = `native-preview:${sourceInstanceId}:${pdfPath}`;
    const surfaceBudget = requireWorkspaceSurfaceBudgetPort();
    const cancelPreviewRequest = (requestId: TRequestId) => {
        void cancelPdfNativePagePreview(requestId).catch(() => undefined);
    };
    const cancelPagePreview = (pageNumber: number, requestId?: string) => {
        const pageRequestIds = activePreviewRequestIdsByPage.get(pageNumber);
        const parsedRequestId = requestId === undefined ? null : parseRequestId(requestId);
        const requestIds = parsedRequestId ? [parsedRequestId] : [...pageRequestIds ?? []];
        for (const activeRequestId of requestIds) {
            if (!activePreviewRequestIds.has(activeRequestId)) continue;
            canceledPreviewRequestIds.add(activeRequestId);
            cancelPreviewRequest(activeRequestId);
        }
    };
    const createPreviewRequestId = (pageNumber: number, options?: IPdfNativePagePreviewOptions) => {
        const requestId = options?.previewRequestId;
        if (requestId) {
            const parsedRequestId = parseRequestId(requestId);
            if (parsedRequestId === null) {
                throw new TypeError('Invalid native preview request ID');
            }
            return parsedRequestId;
        }
        nextPreviewRequestId += 1;
        return createRequestId(`pdf-native-preview-${sourceInstanceId}-${pageNumber}-${nextPreviewRequestId}`);
    };

    return {
        cancelPagePreview,
        getPageSizes: () => getPdfNativePageSizes(pdfPath),
        async renderPageObjectUrl(
            pageNumber: number,
            options?: IPdfNativePagePreviewOptions,
        ): Promise<IPagePreviewRenderedObjectUrl> {
            if (terminated) {
                throw new Error('Native PDF preview canceled');
            }
            const previewRequestId = createPreviewRequestId(pageNumber, options);
            activePreviewRequestIds.add(previewRequestId);
            const pageRequestIds = activePreviewRequestIdsByPage.get(pageNumber) ?? new Set<TRequestId>();
            pageRequestIds.add(previewRequestId);
            activePreviewRequestIdsByPage.set(pageNumber, pageRequestIds);
            let preview;
            try {
                preview = await renderPdfNativePagePreview(pdfPath, requirePageNumber(pageNumber), {
                    ...options,
                    previewRequestId,
                });
                if (terminated.valueOf() || canceledPreviewRequestIds.has(previewRequestId)) {
                    throw new Error('Native PDF preview canceled');
                }
            } finally {
                activePreviewRequestIds.delete(previewRequestId);
                canceledPreviewRequestIds.delete(previewRequestId);
                pageRequestIds.delete(previewRequestId);
                if (pageRequestIds.size === 0) {
                    activePreviewRequestIdsByPage.delete(pageNumber);
                }
            }
            const objectUrl = createJpegObjectUrl(preview.bytes);
            const leaseEntry = {
                lease: null as IWorkspaceSurfaceBudgetLeasePort | null,
                invalidationListeners: new Set<() => void>(),
            };
            objectUrlLeases.set(objectUrl, leaseEntry);
            leaseEntry.lease = surfaceBudget.reserve({
                scopeId: surfaceScopeId,
                category: 'native-preview',
                bytes: preview.width * preview.height * 4,
                priority: 20,
                evict: () => {
                    objectUrlLeases.delete(objectUrl);
                    for (const listener of leaseEntry.invalidationListeners) {
                        listener();
                    }
                    leaseEntry.invalidationListeners.clear();
                    URL.revokeObjectURL(objectUrl);
                },
            });
            if (!objectUrlLeases.has(objectUrl)) {
                leaseEntry.lease.release();
                throw new Error('Native PDF preview evicted under memory pressure');
            }
            return {
                objectUrl,
                renderedPx: preview.width,
                ...(preview.rasterWidthCeilingPx === undefined
                    ? {}
                    : {rasterWidthCeilingPx: preview.rasterWidthCeilingPx}),
                promotePriority(priority) {
                    leaseEntry.lease?.promotePriority?.(priority);
                },
                onInvalidated(listener: () => void) {
                    leaseEntry.invalidationListeners.add(listener);
                    return () => leaseEntry.invalidationListeners.delete(listener);
                },
            };
        },
        revokeObjectURL: (url: string) => {
            objectUrlLeases.get(url)?.lease?.release();
            objectUrlLeases.get(url)?.invalidationListeners.clear();
            objectUrlLeases.delete(url);
            URL.revokeObjectURL(url);
        },
        terminate() {
            terminated = true;
            for (const requestId of activePreviewRequestIds) {
                cancelPreviewRequest(requestId);
            }
            activePreviewRequestIds.clear();
            activePreviewRequestIdsByPage.clear();
            canceledPreviewRequestIds.clear();
            for (const [
                objectUrl,
                entry,
            ] of objectUrlLeases) {
                entry.lease?.release();
                URL.revokeObjectURL(objectUrl);
            }
            objectUrlLeases.clear();
            surfaceBudget.releaseScope(surfaceScopeId);
        },
    };
}
