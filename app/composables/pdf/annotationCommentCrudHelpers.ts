import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/composables/pdf/pdfAnnotationUtils';
import { normalizeMarkerRect } from '@app/composables/pdf/pdfAnnotationUtils';

export interface IEditorTargetMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    targetAnnotationId: string | null;
}

export function getCommentCandidateIds(comment: IAnnotationCommentSummary) {
    return [
        comment.uid,
        comment.annotationId,
        comment.id,
    ]
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .filter((id, index, arr) => arr.indexOf(id) === index);
}

export function findEditorForComment(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    comment: IAnnotationCommentSummary,
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    const candidateIds = getCommentCandidateIds(comment);
    if (candidateIds.length === 0) {
        return null;
    }

    const preferredPage = Math.max(0, Math.min(comment.pageIndex, numPages - 1));
    const pageIndexes = [
        preferredPage,
        ...Array.from({ length: numPages }, (_, index) => index).filter(index => index !== preferredPage),
    ];

    for (const pageIndex of pageIndexes) {
        for (const editor of uiManager.getEditors(pageIndex)) {
            const editorIdentity = getEditorIdentity(editor as IPdfjsEditor, pageIndex);
            if (
                candidateIds.includes(editorIdentity)
                || (editor.uid && candidateIds.includes(editor.uid))
                || (editor.annotationElementId && candidateIds.includes(editor.annotationElementId))
                || (editor.id && candidateIds.includes(editor.id))
            ) {
                return editor as IPdfjsEditor;
            }
        }
    }

    return null;
}

export function findEditorByAnnotationElementId(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    pageIndex: number,
    annotationId: string,
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    const preferredPage = Math.max(0, Math.min(pageIndex, numPages - 1));
    const pageIndexes = [
        preferredPage,
        ...Array.from({ length: numPages }, (_, index) => index).filter(index => index !== preferredPage),
    ];

    for (const candidatePageIndex of pageIndexes) {
        for (const editor of uiManager.getEditors(candidatePageIndex)) {
            const normalizedEditor = editor as IPdfjsEditor;
            if (normalizedEditor.annotationElementId === annotationId) {
                return normalizedEditor;
            }
        }
    }

    return null;
}

export function findEditorFromTarget(
    uiManager: AnnotationEditorUIManager | null,
    target: HTMLElement,
    currentPage: number,
): IEditorTargetMatch | null {
    if (!uiManager) {
        return null;
    }

    const targetAnnotationId = target.closest<HTMLElement>('[data-annotation-id]')
        ?.dataset.annotationId
        ?? null;

    const editorElement = target.closest<HTMLElement>(
        '.annotation-editor-layer .highlightEditor, .annotation-editor-layer .freeTextEditor, .annotation-editor-layer .inkEditor, .annotationEditorLayer .highlightEditor, .annotationEditorLayer .freeTextEditor, .annotationEditorLayer .inkEditor',
    );
    if (!editorElement) {
        return null;
    }

    const pageContainer = editorElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    const pageIndex = Math.max(0, pageNumber - 1);

    for (const editor of uiManager.getEditors(pageIndex)) {
        const normalizedEditor = editor as IPdfjsEditor;
        const editorDiv = normalizedEditor.div;
        if (!editorDiv) {
            continue;
        }
        if (editorDiv === editorElement || editorDiv.contains(target)) {
            return {
                editor: normalizedEditor,
                pageIndex,
                targetAnnotationId,
            };
        }
    }

    return null;
}

export function findPdfAnnotationSummaryFromTarget(
    target: HTMLElement,
    currentPage: number,
    annotationCommentsCache: IAnnotationCommentSummary[],
) {
    const annotationElement = target.closest<HTMLElement>(
        '.annotationLayer [data-annotation-id], .annotation-layer [data-annotation-id]',
    );
    if (!annotationElement) {
        return null;
    }

    const annotationId = annotationElement.dataset.annotationId ?? annotationElement.getAttribute('data-annotation-id');
    if (!annotationId) {
        return null;
    }

    const pageContainer = annotationElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    const pageIndex = Math.max(0, pageNumber - 1);

    return annotationCommentsCache.find(c => (
        c.annotationId === annotationId && c.pageIndex === pageIndex
    )) ?? annotationCommentsCache.find(c => c.annotationId === annotationId) ?? null;
}

export function findAnnotationSummaryFromPoint(
    target: HTMLElement,
    clientX: number,
    clientY: number,
    currentPage: number,
    annotationCommentsCache: IAnnotationCommentSummary[],
    findPageContainerFromClientPoint: (cx: number, cy: number) => HTMLElement | null,
) {
    const pageContainer = target.closest<HTMLElement>('.page_container')
        ?? findPageContainerFromClientPoint(clientX, clientY);
    if (!pageContainer) {
        return null;
    }

    const pageNumber = pageContainer.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
        return null;
    }

    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }

    const x = (clientX - pageRect.left) / pageRect.width;
    const y = (clientY - pageRect.top) / pageRect.height;
    const toleranceX = 14 / pageRect.width;
    const toleranceY = 14 / pageRect.height;

    let bestSummary: IAnnotationCommentSummary | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    annotationCommentsCache.forEach((summary) => {
        if (summary.pageNumber !== pageNumber) {
            return;
        }
        const rect = normalizeMarkerRect(summary.markerRect);
        if (!rect) {
            return;
        }

        const left = rect.left - toleranceX;
        const top = rect.top - toleranceY;
        const right = rect.left + rect.width + toleranceX;
        const bottom = rect.top + rect.height + toleranceY;

        if (x < left || x > right || y < top || y > bottom) {
            return;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distanceScore = ((x - centerX) ** 2 + (y - centerY) ** 2) * 10000;
        const areaScore = rect.width * rect.height;
        const score = distanceScore + areaScore;

        if (score < bestScore) {
            bestScore = score;
            bestSummary = summary;
        }
    });

    return bestSummary;
}
