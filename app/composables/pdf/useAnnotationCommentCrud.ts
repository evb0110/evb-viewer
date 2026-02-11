import {
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import {
    nextTick,
    type Ref,
    type ShallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type {
    IPdfjsEditor,
    IAnnotationContextMenuPayload,
} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getCommentText,
    hasEditorCommentPayload,
    normalizeMarkerRect,
    escapeCssAttr,
    errorToLogText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useFreeTextResize } from '@app/composables/pdf/useFreeTextResize';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import type { useInlineCommentIndicators } from '@app/composables/pdf/useInlineCommentIndicators';
import type { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';
import type { useAnnotationHighlight } from '@app/composables/pdf/useAnnotationHighlight';

type TFreeTextResize = ReturnType<typeof useFreeTextResize>;
type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;
type TInlineIndicators = ReturnType<typeof useInlineCommentIndicators>;
type TToolManager = ReturnType<typeof useAnnotationToolManager>;
type THighlight = ReturnType<typeof useAnnotationHighlight>;

type TUiManagerSelectedEditor = Parameters<AnnotationEditorUIManager['setSelected']>[0];

interface IEditorTargetMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    targetAnnotationId: string | null;
}

interface IUseAnnotationCommentCrudOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number 
    }>;
    annotationTool: Ref<TAnnotationTool>;
    identity: TIdentity;
    commentSync: TCommentSync;
    freeTextResize: TFreeTextResize;
    toolManager: TToolManager;
    inlineIndicators: TInlineIndicators;
    highlight: THighlight;
    scrollToPage: (pageNumber: number) => void;
    renderVisiblePages: (range: {
        start: number;
        end: number 
    }, options?: { preserveRenderedPages?: boolean }) => Promise<void>;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    emitAnnotationModified: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolCancel: () => void;
}

export function useAnnotationCommentCrud(options: IUseAnnotationCommentCrudOptions) {
    const {
        viewerContainer,
        pdfDocument,
        annotationUiManager,
        numPages,
        currentPage,
        visibleRange,
        annotationTool,
        identity,
        commentSync,
        freeTextResize,
        toolManager,
        inlineIndicators,
        highlight,
        scrollToPage,
        renderVisiblePages,
        updateVisibleRange,
        emitAnnotationModified,
        emitAnnotationOpenNote,
        emitAnnotationCommentClick,
        emitAnnotationContextMenu,
        emitAnnotationToolCancel,
    } = options;

    function setActiveCommentAndSync(stableKey: string | null) {
        commentSync.setActiveCommentStableKey(stableKey);
        inlineIndicators.debouncedSyncInlineCommentIndicators();
    }

    function getCommentCandidateIds(comment: IAnnotationCommentSummary) {
        return [
            comment.uid,
            comment.annotationId,
            comment.id,
        ]
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
            .filter((id, index, arr) => arr.indexOf(id) === index);
    }

    function findEditorForComment(comment: IAnnotationCommentSummary) {
        const uiManager = annotationUiManager.value;
        if (!uiManager || numPages.value <= 0) {
            return null;
        }

        const candidateIds = getCommentCandidateIds(comment);
        if (candidateIds.length === 0) {
            return null;
        }

        const preferredPage = Math.max(0, Math.min(comment.pageIndex, numPages.value - 1));
        const pageIndexes = [
            preferredPage,
            ...Array.from({ length: numPages.value }, (_, index) => index).filter(index => index !== preferredPage),
        ];

        for (const pageIndex of pageIndexes) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                const editorIdentity = identity.getEditorIdentity(editor as IPdfjsEditor, pageIndex);
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

    function findEditorByAnnotationElementId(pageIndex: number, annotationId: string) {
        const uiManager = annotationUiManager.value;
        if (!uiManager || numPages.value <= 0) {
            return null;
        }

        const preferredPage = Math.max(0, Math.min(pageIndex, numPages.value - 1));
        const pageIndexes = [
            preferredPage,
            ...Array.from({ length: numPages.value }, (_, index) => index).filter(index => index !== preferredPage),
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

    async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
        if (!pdfDocument.value) {
            return;
        }
        setActiveCommentAndSync(comment.stableKey);

        const pageNumber = Math.max(1, Math.min(comment.pageNumber, numPages.value));
        scrollToPage(pageNumber);

        await nextTick();
        updateVisibleRange(viewerContainer.value, numPages.value);
        await renderVisiblePages(visibleRange.value, { preserveRenderedPages: true });
        inlineIndicators.syncInlineCommentIndicators();
        await nextTick();
        inlineIndicators.pulseCommentIndicator(comment.stableKey);

        const uiManager = annotationUiManager.value as (AnnotationEditorUIManager & {
            getLayer?: (pageIndex: number) => { getEditorByUID?: (uid: string) => IPdfjsEditor | null } | null;
            selectComment?: (pageIndex: number, uid: string) => void;
        }) | null;
        const pageIndex = pageNumber - 1;

        if (uiManager) {
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch {
                // ignore
            }

            const layer = uiManager.getLayer?.(pageIndex) ?? null;
            const candidateIds = getCommentCandidateIds(comment);

            for (const id of candidateIds) {
                const editor = layer?.getEditorByUID?.(id);
                if (editor) {
                    editor.toggleComment?.(true, true);
                    return;
                }
            }

            if (typeof uiManager.selectComment === 'function') {
                for (const id of candidateIds) {
                    uiManager.selectComment(pageIndex, id);
                }
            }
        }

        const annotationId = comment.annotationId;
        const container = viewerContainer.value;
        if (!annotationId || !container) {
            return;
        }

        const selector = `[data-annotation-id="${escapeCssAttr(annotationId)}"]`;
        const target = container.querySelector<HTMLElement>(selector);
        if (!target) {
            return;
        }
        target.classList.add('annotation-focus-pulse');
        setTimeout(() => {
            target.classList.remove('annotation-focus-pulse');
        }, 900);
    }

    function updateAnnotationComment(comment: IAnnotationCommentSummary, text: string) {
        const resolvedComment = identity.resolveCommentFromCache(comment) ?? comment;
        const editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        if (!editor) {
            return false;
        }

        const nextText = text;
        const nextTrimmed = nextText.trim();
        const previousText = getCommentText(editor);
        const previousTrimmed = previousText.trim();
        const editorPageIndex = Number.isFinite(editor.parentPageIndex)
            ? editor.parentPageIndex as number
            : resolvedComment.pageIndex;
        const pendingKey = identity.getEditorPendingKey(editor, editorPageIndex);
        const hadExplicitNote = Boolean(
            resolvedComment.hasNote
            || commentSync.pendingCommentEditorKeys.has(pendingKey)
            || hasEditorCommentPayload(editor)
            || previousTrimmed.length > 0,
        );
        if (nextText === previousText) {
            return true;
        }

        editor.comment = nextTrimmed.length > 0 ? nextText : '';
        editor.addToAnnotationStorage?.();
        if (nextTrimmed.length > 0) {
            commentSync.pendingCommentEditorKeys.add(pendingKey);
            identity.rememberSummaryText({
                ...resolvedComment,
                text: nextText,
                hasNote: true,
                modifiedAt: Date.now(),
            });
        } else {
            if (hadExplicitNote) {
                commentSync.pendingCommentEditorKeys.add(pendingKey);
            } else {
                commentSync.pendingCommentEditorKeys.delete(pendingKey);
            }
            if (previousTrimmed.length > 0) {
                identity.forgetSummaryText(resolvedComment);
            }
        }
        emitAnnotationModified();
        commentSync.scheduleAnnotationCommentsSync(true);
        inlineIndicators.debouncedSyncInlineCommentIndicators();
        return true;
    }

    async function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return false;
        }
        const resolvedComment = identity.resolveCommentFromCache(comment) ?? comment;

        const pageNumber = Math.max(1, Math.min(resolvedComment.pageNumber, numPages.value));
        const pageIndex = Math.max(0, pageNumber - 1);
        const candidateIds = getCommentCandidateIds(resolvedComment);
        const managerWithCommentSelection = uiManager as AnnotationEditorUIManager & {
            selectComment?: (candidatePageIndex: number, uid: string) => void;
            getLayer?: (candidatePageIndex: number) => { getEditorByUID?: (uid: string) => IPdfjsEditor | null } | null;
        };

        let editor = findEditorForComment(resolvedComment);
        let switchedToPopupMode = false;
        const previousMode = uiManager.getMode();

        if (!editor && previousMode === AnnotationEditorType.NONE) {
            const switchError = await toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.POPUP, pageNumber);
            if (!switchError) {
                switchedToPopupMode = true;
            }
        }

        if (!editor) {
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch {
                // Ignore and continue with best effort lookup.
            }
            editor = findEditorForComment(resolvedComment) ?? findEditorForComment(comment);
        }

        if (!editor && candidateIds.length > 0) {
            for (const id of candidateIds) {
                const fromLayer = managerWithCommentSelection.getLayer?.(pageIndex)?.getEditorByUID?.(id);
                if (fromLayer) {
                    editor = fromLayer;
                    break;
                }
            }
        }

        if (!editor && candidateIds.length > 0 && typeof managerWithCommentSelection.selectComment === 'function') {
            for (const id of candidateIds) {
                managerWithCommentSelection.selectComment(pageIndex, id);
            }
            await nextTick();
            editor = findEditorForComment(comment);
        }

        if (!editor && resolvedComment.annotationId) {
            const annotationStorage = pdfDocument.value?.annotationStorage as { getEditor?: (annotationElementId: string) => IPdfjsEditor | null } | undefined;
            editor = annotationStorage?.getEditor?.(resolvedComment.annotationId) ?? null;
        }

        if (!editor && resolvedComment.annotationId) {
            editor = findEditorByAnnotationElementId(pageIndex, resolvedComment.annotationId);
        }

        if (!editor) {
            if (switchedToPopupMode) {
                await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
            }
            return false;
        }

        const pendingKey = identity.getEditorPendingKey(
            editor,
            Number.isFinite(editor.parentPageIndex) ? (editor.parentPageIndex as number) : resolvedComment.pageIndex,
        );
        let deleted = false;

        try {
            uiManager.setSelected(editor as TUiManagerSelectedEditor);
            uiManager.delete();
            deleted = true;
        } catch {
            try {
                editor.remove?.();
                deleted = true;
            } catch {
                try {
                    editor.delete?.();
                    deleted = true;
                } catch {
                    deleted = false;
                }
            }
        } finally {
            if (switchedToPopupMode) {
                await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
            }
        }

        if (!deleted) {
            return false;
        }

        commentSync.pendingCommentEditorKeys.delete(pendingKey);
        identity.forgetSummaryText(resolvedComment);
        emitAnnotationModified();
        commentSync.scheduleAnnotationCommentsSync(true);
        inlineIndicators.debouncedSyncInlineCommentIndicators();
        return true;
    }

    function findEditorFromTarget(target: HTMLElement): IEditorTargetMatch | null {
        const uiManager = annotationUiManager.value;
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
            : currentPage.value;
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

    function findEditorSummaryFromTarget(target: HTMLElement) {
        const match = findEditorFromTarget(target);
        if (!match) {
            return null;
        }

        const summary = commentSync.toEditorSummary(match.editor, match.pageIndex, getCommentText(match.editor));
        const normalizedSummary = {
            ...identity.hydrateSummaryFromMemory(summary),
            annotationId: summary.annotationId ?? match.targetAnnotationId,
            stableKey: identity.computeSummaryStableKey({
                id: summary.id,
                pageIndex: summary.pageIndex,
                source: summary.source,
                uid: summary.uid,
                annotationId: summary.annotationId ?? match.targetAnnotationId,
            }),
        };
        const candidateIds = [
            normalizedSummary.annotationId,
            normalizedSummary.uid,
            normalizedSummary.id,
        ]
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
            .filter((id, index, arr) => arr.indexOf(id) === index);

        const cached = commentSync.annotationCommentsCache.value.find((c) => (
            c.pageIndex === match.pageIndex
            && (
                candidateIds.includes(c.annotationId ?? '')
                || candidateIds.includes(c.uid ?? '')
                || candidateIds.includes(c.id)
            )
        )) ?? commentSync.annotationCommentsCache.value.find((c) => (
            candidateIds.includes(c.annotationId ?? '')
            || candidateIds.includes(c.uid ?? '')
            || candidateIds.includes(c.id)
        )) ?? null;

        return cached ?? identity.hydrateSummaryFromMemory(normalizedSummary);
    }

    function findPdfAnnotationSummaryFromTarget(target: HTMLElement) {
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
            : currentPage.value;
        const pageIndex = Math.max(0, pageNumber - 1);

        return commentSync.annotationCommentsCache.value.find(c => (
            c.annotationId === annotationId && c.pageIndex === pageIndex
        )) ?? commentSync.annotationCommentsCache.value.find(c => c.annotationId === annotationId) ?? null;
    }

    function findAnnotationSummaryFromTarget(target: HTMLElement) {
        const editorSummary = findEditorSummaryFromTarget(target);
        const pdfSummary = findPdfAnnotationSummaryFromTarget(target);

        if (!editorSummary) {
            return pdfSummary;
        }
        if (!pdfSummary) {
            return editorSummary;
        }

        const editorText = editorSummary.text.trim();
        const pdfText = pdfSummary.text.trim();
        if (!editorText && pdfText) {
            return pdfSummary;
        }
        if (!editorSummary.modifiedAt && pdfSummary.modifiedAt) {
            return pdfSummary;
        }
        return editorSummary;
    }

    function findAnnotationSummaryFromPoint(target: HTMLElement, clientX: number, clientY: number) {
        const pageContainer = target.closest<HTMLElement>('.page_container')
            ?? highlight.findPageContainerFromClientPoint(clientX, clientY);
        if (!pageContainer) {
            return null;
        }

        const pageNumber = pageContainer.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
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

        commentSync.annotationCommentsCache.value.forEach((summary) => {
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

    async function ensureEditorInteractionModeFromTarget(target: HTMLElement) {
        const activeTool = annotationTool.value;
        if (activeTool !== 'none' && activeTool !== 'text') {
            return false;
        }
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return false;
        }

        const match = findEditorFromTarget(target);
        if (!match) {
            return false;
        }

        const layerClass = match.editor.div?.closest<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer')
            ?.className ?? '';
        const isNonEditing = layerClass.includes('nonEditing');
        if (!isNonEditing) {
            return false;
        }

        const mode = activeTool === 'text'
            ? AnnotationEditorType.FREETEXT
            : AnnotationEditorType.POPUP;
        const modeError = await toolManager.updateModeWithRetry(uiManager, mode, match.pageIndex + 1);
        if (modeError) {
            console.warn(`Failed to enable editor interaction mode: ${errorToLogText(modeError)}`);
            return false;
        }

        uiManager.setSelected(match.editor as TUiManagerSelectedEditor);
        freeTextResize.ensureFreeTextEditorCanResize(match.editor);
        return true;
    }

    function resolveCommentFromIndicatorClickTarget(target: HTMLElement, clientX: number, clientY: number) {
        const customIndicator = target.closest<HTMLElement>('.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker');
        if (customIndicator) {
            const inlineTarget = customIndicator.closest<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment');
            return (
                inlineIndicators.resolveCommentFromIndicatorElement(customIndicator)
                ?? (inlineTarget ? inlineIndicators.findCommentFromInlineTarget(inlineTarget) : null)
                ?? findAnnotationSummaryFromTarget(customIndicator)
                ?? findAnnotationSummaryFromPoint(customIndicator, clientX, clientY)
            );
        }

        const popupTrigger = target.closest<HTMLElement>('.annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea');
        if (popupTrigger) {
            return (
                findAnnotationSummaryFromTarget(popupTrigger)
                ?? findAnnotationSummaryFromPoint(popupTrigger, clientX, clientY)
            );
        }

        return null;
    }

    function handleAnnotationEditorDblClick(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        const explicitCommentTrigger = event.target.closest<HTMLElement>(
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea',
        );
        if (!explicitCommentTrigger) {
            return;
        }

        const summary = findAnnotationSummaryFromTarget(explicitCommentTrigger)
            ?? findAnnotationSummaryFromPoint(explicitCommentTrigger, event.clientX, event.clientY);
        if (summary) {
            setActiveCommentAndSync(summary.stableKey);
            emitAnnotationOpenNote(summary);
        }
    }

    async function handleAnnotationCommentClick(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        if (highlight.isPlacingComment.value) {
            void highlight.placeCommentAtClientPoint(event.clientX, event.clientY);
            return;
        }

        const indicatorSummary = resolveCommentFromIndicatorClickTarget(event.target, event.clientX, event.clientY);
        if (indicatorSummary) {
            setActiveCommentAndSync(indicatorSummary.stableKey);
            inlineIndicators.pulseCommentIndicator(indicatorSummary.stableKey);
            emitAnnotationOpenNote(indicatorSummary);
            return;
        }

        if (annotationTool.value !== 'none') {
            if (annotationTool.value === 'text') {
                await ensureEditorInteractionModeFromTarget(event.target);
            }
            return;
        }
        if (event.target.closest('.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog')) {
            return;
        }

        const selection = document.getSelection();
        if (selection && !selection.isCollapsed) {
            return;
        }

        await ensureEditorInteractionModeFromTarget(event.target);

        const inlineTarget = event.target.closest<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment');
        if (inlineTarget) {
            const summary = inlineIndicators.findCommentFromInlineTarget(inlineTarget);
            if (summary) {
                setActiveCommentAndSync(summary.stableKey);
                inlineIndicators.pulseCommentIndicator(summary.stableKey);
                emitAnnotationCommentClick(summary);
                return;
            }
        }

        const summary = findAnnotationSummaryFromTarget(event.target)
            ?? findAnnotationSummaryFromPoint(event.target, event.clientX, event.clientY);
        if (!summary) {
            return;
        }
        setActiveCommentAndSync(summary.stableKey);
        inlineIndicators.pulseCommentIndicator(summary.stableKey);
        emitAnnotationCommentClick(summary);
    }

    function handleAnnotationCommentContextMenu(event: MouseEvent) {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        if (highlight.isPlacingComment.value) {
            event.preventDefault();
            return;
        }

        if (annotationTool.value !== 'none') {
            event.preventDefault();
            emitAnnotationToolCancel();
        }

        const inlineTarget = event.target.closest<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment');
        const summary = (inlineTarget ? inlineIndicators.findCommentFromInlineTarget(inlineTarget) : null)
            ?? findAnnotationSummaryFromTarget(event.target)
            ?? findAnnotationSummaryFromPoint(event.target, event.clientX, event.clientY);
        event.preventDefault();
        if (summary) {
            setActiveCommentAndSync(summary.stableKey);
            inlineIndicators.pulseCommentIndicator(summary.stableKey);
        } else {
            setActiveCommentAndSync(null);
        }
        emitAnnotationContextMenu(highlight.buildAnnotationContextMenuPayload(summary, event.clientX, event.clientY));
    }

    return {
        findEditorForComment,
        findEditorByAnnotationElementId,
        focusAnnotationComment,
        updateAnnotationComment,
        deleteAnnotationComment,
        findEditorFromTarget,
        findEditorSummaryFromTarget,
        findAnnotationSummaryFromTarget,
        findAnnotationSummaryFromPoint,
        ensureEditorInteractionModeFromTarget,
        resolveCommentFromIndicatorClickTarget,
        handleAnnotationCommentClick,
        handleAnnotationCommentContextMenu,
        handleAnnotationEditorDblClick,
    };
}
