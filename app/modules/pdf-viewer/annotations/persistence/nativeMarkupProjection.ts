import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { collectMarkupSubtypeHints } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/collectMarkupSubtypeHints';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type { IPdfNativeMarkupSubtypeHint } from '@contracts/electronApiDocuments';
import { requirePageIndex } from '@contracts/pageNumbers';
import { PDF_ANNOTATION_MARKUP_SUBTYPES } from '@contracts/annotations';
import { isOneOf } from '@contracts/runtimeGuards';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';

function isNativeMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return isOneOf(PDF_ANNOTATION_MARKUP_SUBTYPES, value);
}

function isNativeMarkupHintEligible(hint: IMarkupSubtypeHint) {
    return isNativeMarkupSubtype(hint.subtype)
        && Number.isSafeInteger(hint.pageIndex)
        && hint.pageIndex >= 0
        && Boolean(normalizeMarkerRect(hint.markerRect));
}

export function toNativeMarkupHint(hint: IMarkupSubtypeHint): IPdfNativeMarkupSubtypeHint | null {
    if (!isNativeMarkupHintEligible(hint)) {
        return null;
    }
    const markerRect = normalizeMarkerRect(hint.markerRect);
    if (!markerRect) {
        return null;
    }
    const markupGeometry = hint.markupGeometry?.length
        ? hint.markupGeometry.map(normalizeMarkerRect)
        : null;
    if (markupGeometry?.some(rect => !rect)) {
        return null;
    }
    const validMarkupGeometry = markupGeometry
        ? markupGeometry.filter((rect): rect is NonNullable<typeof rect> => rect !== null)
        : null;
    const emittedMarkupGeometry = validMarkupGeometry
        && validMarkupGeometry.length <= PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems
        ? validMarkupGeometry
        : null;
    return {
        subtype: hint.subtype,
        pageIndex: requirePageIndex(hint.pageIndex),
        markerRect,
        ...(hint.appAnnotationId?.trim() ? {appAnnotationId: hint.appAnnotationId.trim()} : {}),
        ...(emittedMarkupGeometry
            ? {markupGeometry: emittedMarkupGeometry}
            : {}),
        annotationId: hint.annotationId ?? null,
        color: hint.color ?? null,
        ...(hint.opacity !== undefined ? {opacity: hint.opacity} : {}),
        ...(hint.contents !== undefined ? {contents: hint.contents} : {}),
        ...(hint.author !== undefined ? {author: hint.author} : {}),
        id: hint.id ?? null,
        pageMarkupIndex: typeof hint.pageMarkupIndex === 'number' && Number.isSafeInteger(hint.pageMarkupIndex)
            ? hint.pageMarkupIndex
            : null,
        source: hint.source ?? null,
    };
}

// Subtype hints come only from canonical comment records. Save never receives
// a live editor snapshot and the native wire has no override channel, so the
// native markup projection has no second source.
export function buildNativeMarkupMutationForSave(opts: {
    canonicalComments: IAnnotationCommentSummary[];
    changedComments?: IAnnotationCommentSummary[];
    annotationWorkDirty: boolean;
}) {
    if (!opts.annotationWorkDirty) {
        return null;
    }
    // Explicit geometry is authored work. Never acknowledge it as a style-only
    // save if a malformed quad would make the collector omit the entire list.
    for (const comment of opts.changedComments ?? opts.canonicalComments) {
        if (!isNativeMarkupSubtype(comment.subtype) || comment.markupGeometry == null) {
            continue;
        }
        if (comment.markupGeometry.length === 0 || comment.markupGeometry.some(rect => (
            ![
                rect.left,
                rect.top,
                rect.width,
                rect.height,
            ].every(Number.isFinite)
            || !normalizeMarkerRect(rect)
        ))) {
            throw new Error('Cannot save text-markup annotation with invalid geometry');
        }
    }
    const currentMarkupHints = collectMarkupSubtypeHints(opts.canonicalComments);
    const changedMarkupHints = opts.changedComments
        ? collectMarkupSubtypeHints(opts.changedComments, {includeContents: true})
        : currentMarkupHints.filter(hint => hint.color !== null || hint.source === 'editor');
    // Incremental native markup touches only canonical comments whose
    // revision changed. This includes note-only edits on imported markup.
    const hints = changedMarkupHints.flatMap((hint) => {
        const nativeHint = toNativeMarkupHint(hint);
        return nativeHint ? [nativeHint] : [];
    });
    if (hints.length === 0) {
        return null;
    }
    return {hints};
}
