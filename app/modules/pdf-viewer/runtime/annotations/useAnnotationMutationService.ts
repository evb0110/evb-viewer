import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    ITextMarkupAnnotationProperties,
} from '@app/types/annotations';
import type { ITextMarkupColorMutationResult } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import type { AnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';

interface IAnnotationMutationContext {source: 'user' | 'note-window' | 'agent' | 'undo' | 'redo' | 'sync' | 'save-reload';}

export interface IUseAnnotationMutationServiceOptions {
    findAnnotationCommentByStableKey?: (stableKey: string) => IAnnotationCommentSummary | null;
    runHistoryTransaction?: <T>(action: () => T) => T;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    updateSelectedTextMarkupAnnotationColor: (color: string) => ITextMarkupColorMutationResult;
    updateSelectedTextMarkupAnnotationProperties: (
        updates: Partial<Pick<ITextMarkupAnnotationProperties, 'color' | 'opacity' | 'contents'>>,
        selected: ITextMarkupAnnotationProperties,
    ) => boolean;
    updateTextMarkupAnnotationColor: (comment: IAnnotationCommentSummary, color: string) => ITextMarkupColorMutationResult;
    markAnnotationLocallyDeleted: (comment: IAnnotationCommentSummary) => void;
    restoreAnnotationLocally: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationFromInternalCache: (stableKey: string) => void;
    clearPendingMarkerMoves: () => void;
    handleMarkerMove: (
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
        options?: {
            markEditorPending?: (
                updated: IAnnotationCommentSummary,
                original: IAnnotationCommentSummary,
                markerRect: IAnnotationMarkerRect,
            ) => void;
            markModified?: () => void;
        },
    ) => boolean;
    findEditorForComment: (comment: IAnnotationCommentSummary) => object | null;
    markModified: () => void;
    flushAnnotationCommentsForSave: () => unknown | Promise<unknown>;
    resolveCanonicalAnnotationId?: (comment: IAnnotationCommentSummary) => AnnotationId | null;
    setCanonicalNoteText: (id: AnnotationId, text: string) => void;
    deleteCanonicalAnnotation: (id: AnnotationId) => void;
    moveCanonicalAnchor: (id: AnnotationId, rect: IAnnotationMarkerRect) => void;
}

function isPdfBackedFreeTextComment(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim().toLowerCase();
    if (subtype !== 'freetext' && subtype !== 'typewriter') {
        return false;
    }
    return comment.source === 'pdf' || Boolean(parsePdfJsAnnotationRef(comment.annotationId));
}

export const useAnnotationMutationService = (
    options: IUseAnnotationMutationServiceOptions,
) => {
    function runHistoryTransaction<T>(action: () => T) {
        return options.runHistoryTransaction?.(action) ?? action();
    }

    function deleteEmbeddedAnnotationDeferred(comment: IAnnotationCommentSummary) {
        const annotationId = options.resolveCanonicalAnnotationId?.(comment);
        if (!annotationId) {
            return false;
        }
        options.deleteCanonicalAnnotation?.(annotationId);
        return true;
    }

    function updateComment(
        input: {
            comment: IAnnotationCommentSummary;
            text: string;
        },
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(() => {
            const id = options.resolveCanonicalAnnotationId?.(input.comment);
            if (!id) {
                return false;
            }
            options.setCanonicalNoteText(id, input.text);
            options.updateAnnotationComment(input.comment, input.text);
            return true;
        });
    }

    async function deleteAnnotation(
        input: {
            comment: IAnnotationCommentSummary;
            strategy?: 'auto' | 'pdfjs' | 'embedded-deferred' | 'shape' | 'local-only';
        },
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(async () => {
            const id = options.resolveCanonicalAnnotationId?.(input.comment);
            if (!id) {
                return false;
            }
            if (
                input.strategy !== 'local-only'
                && input.strategy !== 'embedded-deferred'
                && isPdfBackedFreeTextComment(input.comment)
            ) {
                try {
                    if (!await options.deleteAnnotationComment(input.comment)) {
                        return false;
                    }
                } catch {
                    return false;
                }
                options.deleteCanonicalAnnotation(id);
                return true;
            }
            options.deleteCanonicalAnnotation(id);
            if (input.strategy === 'local-only') {
                options.markAnnotationLocallyDeleted(input.comment);
                return true;
            }
            try {
                await options.deleteAnnotationComment(input.comment);
            } catch { /* canonical tombstone and removal effect remain authoritative */ }
            return true;
        });
    }

    async function deleteReopenedEditorAnnotation(
        input: {comment: IAnnotationCommentSummary},
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(async () => {
            const id = options.resolveCanonicalAnnotationId?.(input.comment);
            if (!id) {
                return false;
            }
            try {
                if (!await options.deleteAnnotationComment(input.comment)) {
                    return false;
                }
            } catch {
                return false;
            }
            options.deleteCanonicalAnnotation(id);
            return true;
        });
    }

    function updateColor(
        input: {
            comment?: IAnnotationCommentSummary | null;
            color: string;
            selected?: boolean;
        },
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(() => updateColorInTransaction(input));
    }

    function updateColorInTransaction(input: {
        comment?: IAnnotationCommentSummary | null;
        color: string;
        selected?: boolean;
    }) {
        const comment = input.comment ?? null;
        const id = comment ? options.resolveCanonicalAnnotationId?.(comment) : null;
        if (!comment || !id) {
            return false;
        }
        const result = input.selected === true
            ? options.updateSelectedTextMarkupAnnotationColor(input.color)
            : options.updateTextMarkupAnnotationColor(comment, input.color);
        return result.updated;
    }

    function updateSelectedTextMarkupAnnotationProperties(
        input: {
            updates: Partial<Pick<ITextMarkupAnnotationProperties, 'color' | 'opacity' | 'contents'>>;
            selected: ITextMarkupAnnotationProperties;
        },
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(() => {
            const updated = options.updateSelectedTextMarkupAnnotationProperties(
                input.updates,
                input.selected,
            );
            if (updated) {
                options.markModified();
            }
            return updated;
        });
    }

    function moveMarker(
        input: {
            comment: IAnnotationCommentSummary;
            rect: IAnnotationMarkerRect;
        },
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(() => moveMarkerInTransaction(input));
    }

    function moveMarkerInTransaction(input: {
        comment: IAnnotationCommentSummary;
        rect: IAnnotationMarkerRect;
    }) {
        const id = options.resolveCanonicalAnnotationId?.(input.comment);
        if (!id) {
            return false;
        }
        options.moveCanonicalAnchor(id, input.rect);
        const persistThroughNativeGeometry = input.comment.source === 'pdf'
            && input.comment.hasNote === true
            && isPdfBackedFreeTextComment(input.comment);
        if (persistThroughNativeGeometry) {
            // Native geometry moves do not touch PDF.js annotationStorage.
            // Publish the dirty edge explicitly so Save observes the canonical
            // mutation while its projection is still settling.
            options.markModified();
        }
        options.handleMarkerMove(input.comment, input.rect, {...(!persistThroughNativeGeometry ? {markModified: options.markModified} : {})});
        return true;
    }

    function restoreAnnotation(
        comment: IAnnotationCommentSummary,
        _context: IAnnotationMutationContext,
    ) {
        options.restoreAnnotationLocally(comment);
    }

    function removeAnnotationFromInternalCache(
        stableKey: string,
        _context: IAnnotationMutationContext,
    ) {
        options.removeAnnotationFromInternalCache(stableKey);
    }

    async function flushForSave() {
        await options.flushAnnotationCommentsForSave();
    }

    return {
        updateComment,
        deleteAnnotation,
        deleteReopenedEditorAnnotation,
        updateColor,
        updateSelectedTextMarkupAnnotationProperties,
        moveMarker,
        restoreAnnotation,
        removeAnnotationFromInternalCache,
        clearPendingMarkerMoves: options.clearPendingMarkerMoves,
        deleteEmbeddedAnnotationDeferred,
        flushForSave,
    };
};
