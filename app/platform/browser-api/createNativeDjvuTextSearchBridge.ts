import type { IDjvuCapability } from '@contracts/djvuPlatformFeature';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    parseRequestId,
    type TRequestId,
} from '@contracts/shared';
import { isBrowserDocumentRef } from '@app/platform/browserDocumentStore';
import { getValidatedElectronPlatformApi } from '@app/utils/electronPlatformBridge';
import {PdfCombineCapabilityError} from '@contracts/pdfCombineErrors';
import type { IPagePreviewSource } from '@app/modules/document-viewer/public';

type TNativeDjvuSearchCapability = Pick<
    IDjvuCapability,
    'cancelTextSearch' | 'onTextSearchProgress' | 'searchText'
>;
type TDocumentSearchRequest = Parameters<NonNullable<IPagePreviewSource['searchText']>>[0];

function getNativeDjvuSearchCapability(documentRef: TDocumentRef) {
    if (isBrowserDocumentRef(documentRef)) {
        return null;
    }
    const djvu = getValidatedElectronPlatformApi()?.djvu;
    if (
        typeof djvu?.searchText !== 'function'
        || typeof djvu.cancelTextSearch !== 'function'
        || typeof djvu.onTextSearchProgress !== 'function'
    ) {
        throw new PdfCombineCapabilityError(
            'native-unavailable',
            `Native DjVu text search capability is unavailable for desktop path: ${documentRef}`,
            {operation: 'djvu-text-search'},
        );
    }
    return djvu satisfies TNativeDjvuSearchCapability;
}

/**
 * Text search is a document capability, independent from the selected raster
 * renderer. Desktop DjVu keeps native streaming search even when a small file
 * is rendered by DjVu.js.
 */
export function createNativeDjvuTextSearchBridge(documentRef: TDocumentRef) {
    const nativeDjvu = getNativeDjvuSearchCapability(documentRef);
    if (!nativeDjvu) {
        return null;
    }
    const searchCapability: TNativeDjvuSearchCapability = nativeDjvu;
    const activeRequestIds = new Set<TRequestId>();

    async function searchText(request: TDocumentSearchRequest) {
        request.signal.throwIfAborted();
        const requestId = parseRequestId(request.requestId);
        if (requestId === null) {
            throw new TypeError('DjVu search request ID is invalid');
        }
        activeRequestIds.add(requestId);
        const unsubscribe = searchCapability.onTextSearchProgress((progress) => {
            if (progress.requestId === requestId) {
                request.onProgress?.(progress);
            }
        });
        const cancel = () => {
            void searchCapability.cancelTextSearch(requestId).catch(() => undefined);
        };
        request.signal.addEventListener('abort', cancel, {once: true});
        try {
            const response = await searchCapability.searchText(documentRef, request.query, {
                requestId,
                pageCount: request.pageCount,
                ...request.matchOptions,
            });
            request.signal.throwIfAborted();
            return response;
        } finally {
            activeRequestIds.delete(requestId);
            request.signal.removeEventListener('abort', cancel);
            unsubscribe();
        }
    }

    function dispose() {
        for (const requestId of activeRequestIds) {
            void searchCapability.cancelTextSearch(requestId).catch(() => undefined);
        }
        activeRequestIds.clear();
    }

    return {
        dispose,
        searchText,
    };
}
