import type {IPdfPlacedImageFinalizePayload} from '@app/types/pdfImagePlacement';
import type {IAnnotationRasterImage} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    createStaticBrowserImagePreview,
    PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
    readBlobAsDataUrl,
} from '@app/platform/browser-api/public';

/** Encoded bytes remain available to the editor and its undo history until save. */
export async function preparePdfAnnotationRaster(payload: IPdfPlacedImageFinalizePayload): Promise<IAnnotationRasterImage> {
    let bytes = payload.bytes;
    let mimeType: 'image/png' | 'image/jpeg';
    // PDF image streams do not apply EXIF orientation. Bake it into the pixels
    // once so the saved appearance matches the browser's image preview.
    if ((payload.mimeType === 'image/jpeg' && (payload.sourceOrientation ?? 1) === 1) || (payload.mimeType === 'image/png' && (payload.sourceFrameCount ?? 1) === 1)) {
        mimeType = payload.mimeType;
    } else {
        const png = await createStaticBrowserImagePreview({
            bytes,
            mimeType: payload.mimeType,
            width: payload.sourcePixelWidth,
            height: payload.sourcePixelHeight,
            frameCount: 1,
        }, PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS.maxEdge, payload.signal);
        bytes = new Uint8Array(await png.arrayBuffer());
        mimeType = 'image/png';
    }
    if (bytes.byteLength > PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS.maxEncodedBytes) {
        throw new RangeError('ERR_BROWSER_IMAGE_ENCODED_SIZE_TOO_LARGE');
    }
    const [
        dataUrl,
        digest,
    ] = await Promise.all([
        readBlobAsDataUrl(new Blob([bytes as BlobPart], {type: mimeType})),
        crypto.subtle.digest('SHA-256', bytes as BufferSource),
    ]);
    const image: IAnnotationRasterImage = {
        kind: 'raster',
        mimeType,
        dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        byteLength: bytes.byteLength,
        sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        width: payload.sourcePixelWidth,
        height: payload.sourcePixelHeight,
    };
    return image;
}
