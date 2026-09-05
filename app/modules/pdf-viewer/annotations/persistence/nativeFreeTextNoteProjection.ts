import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { toFreeTextNoteMarkerRect } from '@app/modules/pdf-viewer/engine/annotations/toFreeTextNoteMarkerRect';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import type { IPdfNativeFreeTextNote } from '@contracts/electronApiDocuments';
import { parsePageIndex } from '@contracts/pageNumbers';
import {parsePdfJsAnnotationRef} from '@app/utils/pdfAnnotationRefs';
import type { INativePdfMutationBuildResult } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

export function isReplayableEditorOnlyFreeTextNote(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim().toLowerCase();
    return comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && Boolean(comment.hasNote)
        && Boolean(normalizeMarkerRect(comment.markerRect))
        && (subtype === 'freetext' || subtype === 'typewriter');
}

/** A newly authored canonical point note has no PDF reference until this save. */
export function isReplayableCanonicalStickyNote(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim().toLowerCase();
    return comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && Boolean(comment.hasNote)
        && Boolean(normalizeMarkerRect(comment.markerRect))
        && subtype === 'text';
}

export function toNativeFreeTextNote(comment: IAnnotationCommentSummary): IPdfNativeFreeTextNote | null {
    const markerRect = toFreeTextNoteMarkerRect(comment.markerRect);
    const canonicalIdentity = comment.appAnnotationId?.trim();
    const stableKey = (
        isReplayableCanonicalStickyNote(comment) && canonicalIdentity
            ? canonicalIdentity
            : comment.stableKey
    )?.trim();
    const pageIndex = parsePageIndex(comment.pageIndex);
    if (!markerRect || !stableKey || pageIndex === null) {
        return null;
    }

    return {
        pageIndex,
        stableKey,
        text: comment.text ?? '',
        markerRect,
        author: comment.author ?? null,
        color: comment.color ?? null,
        createdAt: typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
            ? Math.trunc(comment.createdAt)
            : null,
    };
}

/** Builds native payloads for replayable PDF.js notes and EVB-owned sticky notes. */
export function buildNativeFreeTextNotesForSave(
    opts: {
        canonicalComments: IAnnotationCommentSummary[];
        replayableCanonicalStickyNoteStableKeys?: ReadonlySet<string>;
    },
): INativePdfMutationBuildResult<IPdfNativeFreeTextNote[]> {
    const skip = (reason: string, details: Record<string, unknown> = {}) => {
        return {
            value: null,
            skipEvents: [{
                event: 'Skipped native FreeText note save fast path',
                reason,
                details,
            }],
        };
    };

    const replayableCanonicalStickyNoteStableKeys = opts.replayableCanonicalStickyNoteStableKeys ?? new Set<string>();
    const candidates = opts.canonicalComments
        .filter(comment => (
            isReplayableEditorOnlyFreeTextNote(comment)
            || (
                isReplayableCanonicalStickyNote(comment)
                && replayableCanonicalStickyNoteStableKeys.has(comment.stableKey)
            )
        ))
        .flatMap((comment) => {
            const note = toNativeFreeTextNote(comment);
            return note ? [note] : [];
        });
    if (candidates.length === 0) {
        return skip('no-replayable-editor-free-text-notes');
    }

    const notesByStableKey = new Map<string, IPdfNativeFreeTextNote>();
    for (const note of candidates) {
        const existing = notesByStableKey.get(note.stableKey);
        if (existing) {
            if (
                existing.text !== note.text
                || existing.pageIndex !== note.pageIndex
                || existing.createdAt !== note.createdAt
            ) {
                return skip('conflicting-native-free-text-note-aliases', {stableKey: note.stableKey});
            }
            continue;
        }
        notesByStableKey.set(note.stableKey, note);
    }

    return {
        value: Array.from(notesByStableKey.values()),
        skipEvents: [],
    };
}
