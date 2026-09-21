import type {
    IPdfPathSource,
    TPdfSource,
} from '@app/types/pdfUi';
import { isNativeLegacyDocumentRef } from '@contracts/documentRef';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';

export const PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES = 512 * 1024 * 1024;
const STAGED_NATIVE_OPENING_PREVIEW_MIN_PAGES = 1_000;

export function isPathPdfSource(value: TPdfSource | null | undefined): value is IPdfPathSource {
    return Boolean(
        value
        && typeof value === 'object'
        && !(value instanceof Blob)
        && typeof value.path === 'string',
    );
}

export function shouldStageNativePdfOpeningPreview(
    value: TPdfSource | null | undefined,
    geometry: IPdfOpeningGeometry | null | undefined,
) {
    return Boolean(
        isPathPdfSource(value)
        && !isBrowserDocumentRef(value.path)
        && geometry
        && (
            value.size >= PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES
            || geometry.linearized === false
                && geometry.pageCount >= STAGED_NATIVE_OPENING_PREVIEW_MIN_PAGES
        ),
    );
}

export function shouldDeferNativePdfOpeningSkeleton(input: {
    documentId: string | null | undefined;
    geometry: { readonly size?: number } | null | undefined;
    hasPreview: boolean;
    isOpening: boolean;
    rendererKind: string | null | undefined;
    source?: TPdfSource | null | undefined;
    sourceKind: string | null | undefined;
}) {
    const sourceSize = isPathPdfSource(input.source)
        ? input.source.size
        : undefined;
    const isNativePathSource = isPathPdfSource(input.source)
        && !isBrowserDocumentRef(input.source.path);
    const size = sourceSize ?? input.geometry?.size;
    const isNativeDocument = isNativeLegacyDocumentRef(input.documentId);
    // The opening chassis can paint before the source object and trusted
    // geometry are available. Keep that unresolved native-path opening hidden
    // until the size check arrives; the `isOpening` fence releases it for
    // small files as soon as the opening surface commits.
    const isLargeOrUnresolvedNativePath = size === undefined
        ? isNativeDocument
        : size >= PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES
            && (isNativeDocument || isNativePathSource);
    return input.sourceKind === 'pdf'
        && input.rendererKind === 'pdfjs'
        && input.isOpening
        && isLargeOrUnresolvedNativePath
        && !input.hasPreview;
}
