import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type * as WorkspaceOrchestration from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import * as pdfAnnotationRefs from '@app/utils/pdfAnnotationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';

type TPageAnnotationDeleteViewer = Pick<WorkspaceOrchestration.IPdfViewerExpose,
    'deleteAnnotationComment'
    | 'deleteAnnotationEditor'
    | 'deleteReopenedEditorAnnotation'
    | 'removeAnnotationFromDom'
    | 'removeAnnotationFromInternalCache'
    | 'deleteEmbeddedAnnotationDeferred'
>;

interface IPageAnnotationDeleteActionsOptions<TViewer extends TPageAnnotationDeleteViewer = TPageAnnotationDeleteViewer> {
    pdfViewerRef: Ref<TViewer | null>;
    closeAnnotationContextMenu: () => void;
    getAnnotationCommentsSnapshot: () => IAnnotationCommentSummary[] | null;
    getDeleteErrorMessage: () => string;
    invalidateAnnotationPage: (comment: IAnnotationCommentSummary) => void;
    removeDeletedAnnotationState: (
        comment: IAnnotationCommentSummary,
        commentsBeforeDelete?: IAnnotationCommentSummary[] | null,
    ) => void;
    setAnnotationNoteWindowError: (stableKey: string, error: string | null) => void;
}

export const createPageAnnotationDeleteActions = <TViewer extends TPageAnnotationDeleteViewer>(
    options: IPageAnnotationDeleteActionsOptions<TViewer>,
) => {
    const {
        pdfViewerRef,
        closeAnnotationContextMenu,
        getAnnotationCommentsSnapshot,
        getDeleteErrorMessage,
        invalidateAnnotationPage,
        removeDeletedAnnotationState,
        setAnnotationNoteWindowError,
    } = options;

    let annotationDeleteQueue: Promise<void> = Promise.resolve();

    function resolveEmbeddedPdfAnnotationId(comment: IAnnotationCommentSummary) {
        const annotationId = pdfAnnotationRefs.normalizePdfJsAnnotationId(comment.annotationId);
        if (pdfAnnotationRefs.parsePdfJsAnnotationRef(annotationId)) {
            return annotationId;
        }

        const stableRef = comment.stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/iu)?.[1];
        const stableAnnotationId = pdfAnnotationRefs.normalizePdfJsAnnotationId(stableRef);
        if (pdfAnnotationRefs.parsePdfJsAnnotationRef(stableAnnotationId)) {
            return stableAnnotationId;
        }

        return null;
    }

    function shouldUseEmbeddedDeletePath(comment: IAnnotationCommentSummary) {
        return comment.source !== 'shape'
            && (comment.source === 'pdf' || Boolean(resolveEmbeddedPdfAnnotationId(comment)));
    }

    function shouldRemoveLiveEditorBeforeEmbeddedDelete(comment: IAnnotationCommentSummary) {
        const subtype = comment.subtype?.trim().toLowerCase();
        return subtype === 'freetext' || subtype === 'typewriter';
    }

    function shouldUseEmbeddedDeleteFallback(comment: IAnnotationCommentSummary, deleted: boolean) {
        return !deleted && shouldUseEmbeddedDeletePath(comment);
    }

    async function deleteLiveEditorBeforeEmbeddedDelete(
        viewer: TViewer,
        comment: IAnnotationCommentSummary,
    ) {
        const deleteEditor = viewer.deleteReopenedEditorAnnotation;
        if (deleteEditor) {
            return {
                deleted: await deleteEditor(comment) === true,
                canonicalDeleteHandled: true,
            };
        }
        const legacyDeleteEditor = viewer.deleteAnnotationEditor;
        if (!legacyDeleteEditor) {
            return {
                deleted: false,
                canonicalDeleteHandled: false,
            };
        }
        return {
            deleted: await legacyDeleteEditor(comment) === true,
            canonicalDeleteHandled: false,
        };
    }

    function queueDeferredEmbeddedDelete(comment: IAnnotationCommentSummary) {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return false;
        }
        const embeddedAnnotationId = resolveEmbeddedPdfAnnotationId(comment);
        const deletionComment: IAnnotationCommentSummary = embeddedAnnotationId && embeddedAnnotationId !== comment.annotationId
            ? {
                ...comment,
                annotationId: embeddedAnnotationId,
            }
            : comment;

        if (viewer.deleteEmbeddedAnnotationDeferred?.(deletionComment) !== true) {
            return false;
        }
        viewer.removeAnnotationFromDom(deletionComment);
        viewer.removeAnnotationFromInternalCache(comment.stableKey);
        invalidateAnnotationPage(comment);
        return true;
    }

    function handleAnnotationDeleteFailure(comment: IAnnotationCommentSummary) {
        BrowserLogger.warn('annotations', 'Delete annotation comment failed after all fallbacks', {
            stableKey: comment.stableKey,
            source: comment.source,
            annotationId: comment.annotationId ?? null,
            uid: comment.uid ?? null,
            id: comment.id,
        });
        setAnnotationNoteWindowError(comment.stableKey, getDeleteErrorMessage());
    }

    function deleteAnnotationCommentWithFallbacks(comment: IAnnotationCommentSummary, deleted: boolean) {
        if (!shouldUseEmbeddedDeleteFallback(comment, deleted)) {
            return deleted;
        }
        return queueDeferredEmbeddedDelete(comment);
    }

    async function performDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }
        BrowserLogger.debug('annotations', 'Delete annotation comment requested', {
            stableKey: comment.stableKey,
            source: comment.source,
            annotationId: comment.annotationId ?? null,
            uid: comment.uid ?? null,
            pageNumber: comment.pageNumber,
        });
        setAnnotationNoteWindowError(comment.stableKey, null);
        const commentsBeforeDelete = getAnnotationCommentsSnapshot();
        if (shouldUseEmbeddedDeletePath(comment)) {
            if (shouldRemoveLiveEditorBeforeEmbeddedDelete(comment)) {
                let deleted = false;
                let canonicalDeleteHandled = false;
                try {
                    const deletion = await deleteLiveEditorBeforeEmbeddedDelete(viewer, comment);
                    deleted = deletion.deleted;
                    canonicalDeleteHandled = deletion.canonicalDeleteHandled;
                } catch (error) {
                    BrowserLogger.debug(
                        'annotations',
                        'Atomic reopened FreeText deletion failed',
                        error,
                    );
                }
                if (!deleted) {
                    handleAnnotationDeleteFailure(comment);
                    return;
                }
                if (!canonicalDeleteHandled && viewer.deleteEmbeddedAnnotationDeferred?.(comment) !== true) {
                    handleAnnotationDeleteFailure(comment);
                    return;
                }
                viewer.removeAnnotationFromDom(comment);
                viewer.removeAnnotationFromInternalCache(comment.stableKey);
                invalidateAnnotationPage(comment);
            } else {
                const deleted = deleteAnnotationCommentWithFallbacks(comment, false);
                if (!deleted) {
                    handleAnnotationDeleteFailure(comment);
                    return;
                }
            }
            removeDeletedAnnotationState(comment, commentsBeforeDelete);
            return;
        }

        const viewerDeleted = await viewer.deleteAnnotationComment(comment);
        BrowserLogger.debug('annotations', 'Delete annotation comment viewer result', {
            stableKey: comment.stableKey,
            deleted: viewerDeleted,
        });
        const deleted = deleteAnnotationCommentWithFallbacks(comment, viewerDeleted);
        if (!deleted) {
            handleAnnotationDeleteFailure(comment);
            return;
        }
        removeDeletedAnnotationState(comment, commentsBeforeDelete);
        invalidateAnnotationPage(comment);
    }

    async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        annotationDeleteQueue = annotationDeleteQueue
            .catch(() => undefined)
            .then(() => performDeleteAnnotationComment(comment));
        await annotationDeleteQueue;
    }

    return { handleDeleteAnnotationComment };
};
