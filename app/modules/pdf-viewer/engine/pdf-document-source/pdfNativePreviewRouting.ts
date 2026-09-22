import type {
    IPdfPathSource,
    TPdfSource,
} from '@app/types/pdfUi';
import { isNativeLegacyDocumentRef } from '@contracts/documentRef';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';

interface IPdfNativeOpeningPreviewGeometry {
    readonly pageCount?: IPdfOpeningGeometry['pageCount'];
    readonly linearized?: IPdfOpeningGeometry['linearized'];
    readonly size?: number;
}

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
    geometry: IPdfNativeOpeningPreviewGeometry | null | undefined,
) {
    return Boolean(
        isPathPdfSource(value)
        && !isBrowserDocumentRef(value.path)
        && geometry
        && (
            value.size >= PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES
            || geometry.linearized === false
                && geometry.pageCount !== undefined
                && geometry.pageCount >= STAGED_NATIVE_OPENING_PREVIEW_MIN_PAGES
        ),
    );
}

export function shouldDeferNativePdfOpeningSkeleton(input: {
    documentId: string | null | undefined;
    geometry: IPdfNativeOpeningPreviewGeometry | null | undefined;
    isOpening: boolean;
    nativeOpeningPreviewState?: 'inactive' | 'loading' | 'settled' | 'failed';
    nativeOpeningPreviewStaged?: boolean;
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
    const nativePreviewEligible = shouldStageNativePdfOpeningPreview(input.source, input.geometry);
    const isLargeOrUnresolvedNativePath = size === undefined
        ? isNativeDocument
        : size >= PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES
            && (isNativeDocument || isNativePathSource)
            || nativePreviewEligible;
    // Before the stage has a generation to claim, the size is the only trusted
    // signal available. Keep PDF.js's provisional surface deferred for that
    // interval; the chassis owns the visible loading surface. Once the stage
    // has finished, `failed` releases PDF.js while loading/settled retain one
    // native-preview owner through the handoff.
    const nativePreviewOwnsOpeningSurface = input.nativeOpeningPreviewStaged === undefined
        ? input.nativeOpeningPreviewState === undefined
            || input.nativeOpeningPreviewState === 'inactive'
            ? isLargeOrUnresolvedNativePath
            : input.nativeOpeningPreviewState === 'loading'
                || input.nativeOpeningPreviewState === 'settled'
        : input.nativeOpeningPreviewStaged
            && (input.nativeOpeningPreviewState === 'loading'
                || input.nativeOpeningPreviewState === 'settled');
    return input.sourceKind === 'pdf'
        && input.rendererKind === 'pdfjs'
        && input.isOpening
        && nativePreviewOwnsOpeningSurface;
}
