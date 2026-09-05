import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {parsePdfAnnotationRef} from '@app/utils/pdfAnnotationRefs';
import { parsePdfAnnotationStableKeyRef } from '@app/modules/pdf-viewer/annotations/pdf-refs/parsePdfAnnotationStableKey';
import type { IPdfNoteGeometryUpdate } from '@contracts/electronApiDocuments';
import {requirePageIndex} from '@contracts/pageNumbers';
import type { INativePdfMutationBuildResult } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

function resolveNativeNoteGeometryUpdateRef(
    comment: IAnnotationCommentSummary,
) {
    return parsePdfAnnotationStableKeyRef(comment.stableKey)?.ref
        ?? parsePdfAnnotationRef(comment.annotationId);
}

function isImportedStickyNote(comment: IAnnotationCommentSummary) {
    const normalizedSubtype = comment.subtype?.trim().toLowerCase();
    return comment.source === 'pdf'
        && comment.hasNote === true
        && (normalizedSubtype === 'text' || normalizedSubtype === 'freetext' || normalizedSubtype === 'note' || normalizedSubtype === 'popup');
}

/**
 * Project moved imported sticky notes to their existing PDF objects. The
 * native writer updates the target and its linked Popup in one bounded append,
 * so this path never creates a second annotation or materializes the document.
 */
export function nativeNoteGeometryProjection(
    changedComments: readonly IAnnotationCommentSummary[],
): INativePdfMutationBuildResult<IPdfNoteGeometryUpdate[]> {
    const candidates = changedComments.filter(isImportedStickyNote);
    if (candidates.length === 0) {
        return {
            value: null,
            skipEvents: [],
        };
    }

    const updates: IPdfNoteGeometryUpdate[] = [];
    const seenRefs = new Set<string>();
    for (const comment of candidates) {
        const targetRef = resolveNativeNoteGeometryUpdateRef(comment);
        const markerRect = comment.markerRect;
        if (
            !targetRef
            || targetRef.generationNumber > 65_535
            || !markerRect
            || !Number.isFinite(markerRect.left)
            || !Number.isFinite(markerRect.top)
            || !Number.isFinite(markerRect.width)
            || !Number.isFinite(markerRect.height)
            || markerRect.left < 0
            || markerRect.top < 0
            || markerRect.width <= 0
            || markerRect.height <= 0
            || markerRect.left + markerRect.width > 1
            || markerRect.top + markerRect.height > 1
        ) {
            return {
                value: null,
                skipEvents: [{
                    event: 'Skipped native note-geometry save fast path',
                    reason: 'imported-sticky-note-geometry-not-native-eligible',
                    details: {
                        stableKey: comment.stableKey,
                        targetRef,
                        hasMarkerRect: Boolean(markerRect),
                    },
                }],
            };
        }
        const refKey = `${targetRef.objectNumber}R${targetRef.generationNumber}`;
        const existing = seenRefs.has(refKey);
        if (existing) {
            return {
                value: null,
                skipEvents: [{
                    event: 'Skipped native note-geometry save fast path',
                    reason: 'conflicting-native-note-geometry-aliases',
                    details: {
                        stableKey: comment.stableKey,
                        refKey,
                    },
                }],
            };
        }
        seenRefs.add(refKey);
        updates.push({
            objectNumber: targetRef.objectNumber,
            generationNumber: targetRef.generationNumber,
            pageIndex: requirePageIndex(comment.pageIndex),
            markerRect: structuredClone(markerRect),
        });
    }

    return {
        value: updates,
        skipEvents: [],
    };
}
