import type {IPlacedImageEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {TPdfDocumentSession} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {formatPdfJsAnnotationRef} from '@app/utils/pdfAnnotationRefs';
import {BrowserLogger} from '@app/utils/browserLogger';
import {AnnotationMode} from '@app/services/pdfjs/runtimeLib';
import {resolvePdfJsStampImageDataUrl} from '@app/modules/pdf-viewer/runtime/annotations/resolvePdfJsStampImageDataUrl';

// Canvas data URLs contain ASCII base64, so their string length is their byte
// length. Keep one document's resolved stamp images bounded while letting the
// document proxy itself remain weakly referenced.
const MAX_PDF_STAMP_IMAGE_CACHE_BYTES = 32 * 1024 * 1024;

export interface IPdfStampImageCache {
    readonly byteLength: number;
    get: (imageRef: string) => string | undefined;
    set: (imageRef: string, dataUrl: string) => void;
}

export function createPdfStampImageCache(
    maxBytes = MAX_PDF_STAMP_IMAGE_CACHE_BYTES,
): IPdfStampImageCache {
    const entries = new Map<string, string>();
    let byteLength = 0;

    function remove(imageRef: string) {
        const existing = entries.get(imageRef);
        if (existing === undefined) {
            return;
        }
        entries.delete(imageRef);
        byteLength -= existing.length;
    }

    return {
        get byteLength() {
            return byteLength;
        },
        get(imageRef) {
            const dataUrl = entries.get(imageRef);
            if (dataUrl === undefined) {
                return undefined;
            }
            // Map insertion order is the LRU order. A hit becomes most recent.
            entries.delete(imageRef);
            entries.set(imageRef, dataUrl);
            return dataUrl;
        },
        set(imageRef, dataUrl) {
            remove(imageRef);
            if (dataUrl.length > maxBytes) {
                return;
            }
            entries.set(imageRef, dataUrl);
            byteLength += dataUrl.length;
            while (byteLength > maxBytes) {
                const oldestImageRef = entries.keys().next().value;
                if (oldestImageRef === undefined) {
                    byteLength = 0;
                    return;
                }
                remove(oldestImageRef);
            }
        },
    };
}

export function createPdfAnnotationStampImageResolver(documentSession: TPdfDocumentSession) {
    const stampImageCacheByDocument = new WeakMap<object, IPdfStampImageCache>();
    const stampImageRequestsByDocument = new WeakMap<object, Map<string, Promise<string | null>>>();

    return async function resolveStampImage(entity: IPlacedImageEntity) {
        const pdfDocument = documentSession.pdfDocument.value;
        if (!pdfDocument) {
            return null;
        }
        const imageRef = formatPdfJsAnnotationRef(entity.image);
        const cachedImages = stampImageCacheByDocument.get(pdfDocument)
            ?? createPdfStampImageCache();
        stampImageCacheByDocument.set(pdfDocument, cachedImages);
        const cachedImage = cachedImages.get(imageRef);
        if (cachedImage !== undefined) {
            return cachedImage;
        }
        const pendingRequests = stampImageRequestsByDocument.get(pdfDocument)
            ?? new Map<string, Promise<string | null>>();
        stampImageRequestsByDocument.set(pdfDocument, pendingRequests);
        const pendingRequest = pendingRequests.get(imageRef);
        if (pendingRequest) {
            return pendingRequest;
        }
        const request = (async () => {
            let lease: Awaited<ReturnType<TPdfDocumentSession['leasePage']>> | null = null;
            try {
                lease = await documentSession.leasePage(
                    entity.pageIndex + 1,
                    'transient-background',
                );
                if (documentSession.pdfDocument.value !== pdfDocument) {
                    return null;
                }
                await lease.page.getOperatorList({annotationMode: AnnotationMode.ENABLE});
                if (documentSession.pdfDocument.value !== pdfDocument) {
                    return null;
                }
                const dataUrl = resolvePdfJsStampImageDataUrl(lease.page, entity.image);
                if (dataUrl) {
                    cachedImages.set(imageRef, dataUrl);
                }
                return dataUrl;
            } catch (error) {
                BrowserLogger.warn(
                    'pdf-annotations',
                    `Failed to resolve persisted stamp image on page ${String(entity.pageIndex + 1)}`,
                    error,
                );
                return null;
            } finally {
                lease?.release();
            }
        })();
        pendingRequests.set(imageRef, request);
        try {
            return await request;
        } finally {
            if (pendingRequests.get(imageRef) === request) {
                pendingRequests.delete(imageRef);
            }
        }
    };
}
