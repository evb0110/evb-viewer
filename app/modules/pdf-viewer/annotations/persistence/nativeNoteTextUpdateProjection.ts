import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    normalizePdfJsAnnotationId,
    parsePdfAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { parsePdfAnnotationStableKeyRef } from '@app/modules/pdf-viewer/annotations/pdf-refs/parsePdfAnnotationStableKey';
import { normalizeAnnotationSubtypeToken } from '@app/utils/textNormalization';
import type {
    IPdfNativeFreeTextNote,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type { INativePdfMutationBuildResult } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

const NATIVE_NOTE_TEXT_UPDATE_SUBTYPES = new Set([
    'text',
    'popup',
    'note',
    'freetext',
    'highlight',
    'underline',
    'strikeout',
    'squiggly',
]);

function parseAnnotationRefFromStableKey(stableKey: string) {
    return parsePdfAnnotationStableKeyRef(stableKey)?.ref ?? null;
}

function resolveNativeNoteTextUpdateRef(stableKey: string, comment: IAnnotationCommentSummary) {
    return parseAnnotationRefFromStableKey(stableKey)
        ?? parseAnnotationRefFromStableKey(comment.stableKey)
        ?? parsePdfAnnotationRef(comment.annotationId);
}

function buildNativeNoteTextCommentLookup(comments: IAnnotationCommentSummary[]) {
    const commentsByKey = new Map<string, IAnnotationCommentSummary>();
    const addCommentKey = (key: string | null | undefined, comment: IAnnotationCommentSummary) => {
        const normalized = key?.trim();
        if (normalized && !commentsByKey.has(normalized)) {
            commentsByKey.set(normalized, comment);
        }
    };

    comments.forEach((comment) => {
        addCommentKey(comment.stableKey, comment);
        const normalizedAnnotationId = normalizePdfJsAnnotationId(comment.annotationId);
        addCommentKey(normalizedAnnotationId, comment);
        if (normalizedAnnotationId) {
            addCommentKey(`ann:${comment.pageIndex}:${normalizedAnnotationId}`, comment);
        }
    });

    return commentsByKey;
}

function isNativeNoteTextUpdateSubtype(comment: IAnnotationCommentSummary) {
    const normalizedSubtype = normalizeAnnotationSubtypeToken(comment.subtype);
    return NATIVE_NOTE_TEXT_UPDATE_SUBTYPES.has(normalizedSubtype);
}

/**
 * Reachable only through a native-append grant whose annotation route is loaded-source,
 * and all-or-nothing: updates are produced only when every pending text resolves to a
 * native-eligible ref, which is what makes coverage a set membership test downstream.
 */
export function buildNativeNoteTextUpdatesForSave(
    opts: {
        pendingTexts: ReadonlyMap<string, string>;
        canonicalComments: IAnnotationCommentSummary[];
    },
): INativePdfMutationBuildResult<IPdfNoteTextUpdate[]> {
    const skip = (reason: string, details: Record<string, unknown> = {}) => {
        return {
            value: null,
            skipEvents: [{
                event: 'Skipped native note-text save fast path',
                reason,
                details,
            }],
        };
    };

    const commentsByStableKey = buildNativeNoteTextCommentLookup(opts.canonicalComments);
    const updatesByRef = new Map<string, IPdfNoteTextUpdate>();
    const updates: IPdfNoteTextUpdate[] = [];
    for (const [
        stableKey,
        text,
    ] of opts.pendingTexts.entries()) {
        const comment = commentsByStableKey.get(stableKey);
        const targetRef = comment ? resolveNativeNoteTextUpdateRef(stableKey, comment) : null;
        if (
            !comment
            || comment.source !== 'pdf'
            || !isNativeNoteTextUpdateSubtype(comment)
            || !targetRef
            || targetRef.generationNumber > 65_535
        ) {
            return skip('pending-text-not-native-eligible', {
                stableKey,
                hasComment: Boolean(comment),
                source: comment?.source ?? null,
                subtype: comment?.subtype ?? null,
                targetRef,
            });
        }
        const refKey = `${targetRef.objectNumber}R${targetRef.generationNumber}`;
        const existing = updatesByRef.get(refKey);
        if (existing) {
            if (existing.text !== text) {
                return skip('conflicting-native-note-text-aliases', {
                    stableKey,
                    objectNumber: targetRef.objectNumber,
                    generationNumber: targetRef.generationNumber,
                });
            }
            continue;
        }
        const update = {
            objectNumber: targetRef.objectNumber,
            generationNumber: targetRef.generationNumber,
            text,
        };
        updatesByRef.set(refKey, update);
        updates.push(update);
    }

    return {
        value: updates.length > 0 ? updates : null,
        skipEvents: [],
    };
}

/**
 * Note-text updates are all-or-nothing, so anything they did not carry must be
 * carried verbatim by a native FreeText note upsert.
 */
export function arePendingTextsCoveredByNativeChanges(opts: {
    pendingTexts: ReadonlyMap<string, string>;
    nativeNoteTextUpdates: IPdfNoteTextUpdate[] | null;
    nativeFreeTextNotes: IPdfNativeFreeTextNote[] | null;
}) {
    if (!opts.pendingTexts.size || opts.nativeNoteTextUpdates) {
        return true;
    }

    const freeTextByStableKey = new Map((opts.nativeFreeTextNotes ?? []).map(note => [
        note.stableKey,
        note.text,
    ]));
    return [...opts.pendingTexts].every(([
        stableKey,
        text,
    ]) => freeTextByStableKey.get(stableKey.trim()) === text);
}
