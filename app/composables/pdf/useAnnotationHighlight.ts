import {
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import {
    ref,
    nextTick,
    type Ref,
    type ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IAnnotationContextMenuPayload,
} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getCommentText,
    errorToLogText,
    clamp01,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import type { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TMarkupSubtypeComposable = ReturnType<typeof useAnnotationMarkupSubtype>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;
type TToolManager = ReturnType<typeof useAnnotationToolManager>;

interface IPagePointTarget {
    pageContainer: HTMLElement;
    pageNumber: number;
    pageX: number;
    pageY: number;
}

interface IClosestTextSpan {
    span: HTMLElement;
    score: number;
    rect: DOMRect;
}

interface IUseAnnotationHighlightOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    identity: TIdentity;
    markupSubtype: TMarkupSubtypeComposable;
    commentSync: TCommentSync;
    toolManager: TToolManager;
    stopDrag: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

export function useAnnotationHighlight(options: IUseAnnotationHighlightOptions) {
    const {
        viewerContainer,
        annotationUiManager,
        currentPage,
        annotationTool,
        identity,
        markupSubtype,
        commentSync,
        toolManager,
        stopDrag,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
    } = options;

    let cachedSelectionRange: Range | null = null;
    let cachedSelectionTimestamp = 0;
    const SELECTION_CACHE_TTL_MS = 3000;
    const isPlacingComment = ref(false);

    function cacheCurrentTextSelection() {
        const container = viewerContainer.value;
        if (!container) {
            cachedSelectionRange = null;
            return;
        }

        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return;
        }

        const range = selection.getRangeAt(0);
        const commonAncestor = range.commonAncestorContainer;
        const element = commonAncestor.nodeType === Node.TEXT_NODE
            ? commonAncestor.parentElement
            : commonAncestor as HTMLElement | null;

        if (!element?.closest('.text-layer, .textLayer') || !container.contains(element)) {
            cachedSelectionRange = null;
            cachedSelectionTimestamp = 0;
            return;
        }

        cachedSelectionRange = range.cloneRange();
        cachedSelectionTimestamp = Date.now();
    }

    function isRangeWithinViewerTextLayer(range: Range) {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }

        const commonAncestor = range.commonAncestorContainer;
        const element = commonAncestor.nodeType === Node.TEXT_NODE
            ? commonAncestor.parentElement
            : commonAncestor as HTMLElement | null;
        if (!element) {
            return false;
        }

        const textLayer = element.closest('.text-layer, .textLayer');
        return Boolean(textLayer && container.contains(textLayer));
    }

    function getSelectionRangeFromDocument() {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return null;
        }

        const range = selection.getRangeAt(0);
        if (!isRangeWithinViewerTextLayer(range)) {
            return null;
        }
        return range.cloneRange();
    }

    function getSelectionRangeForCommentAction() {
        const direct = getSelectionRangeFromDocument();
        if (direct) {
            return direct;
        }

        if (!cachedSelectionRange) {
            return null;
        }
        if ((Date.now() - cachedSelectionTimestamp) > SELECTION_CACHE_TTL_MS) {
            return null;
        }
        if (!isRangeWithinViewerTextLayer(cachedSelectionRange)) {
            return null;
        }
        return cachedSelectionRange.cloneRange();
    }

    function findPageContainerFromClientPoint(clientX: number, clientY: number) {
        const container = viewerContainer.value;
        if (!container) {
            return null;
        }

        const pages = Array.from(container.querySelectorAll<HTMLElement>('.page_container'));
        if (pages.length === 0) {
            return null;
        }

        let nearest: {
            element: HTMLElement;
            distanceSquared: number;
        } | null = null;
        for (const element of pages) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                continue;
            }

            const inside = (
                clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom
            );
            if (inside) {
                return element;
            }

            const dx = clientX < rect.left
                ? rect.left - clientX
                : (clientX > rect.right ? clientX - rect.right : 0);
            const dy = clientY < rect.top
                ? rect.top - clientY
                : (clientY > rect.bottom ? clientY - rect.bottom : 0);
            const distanceSquared = dx * dx + dy * dy;
            if (!nearest || distanceSquared < nearest.distanceSquared) {
                nearest = {
                    element,
                    distanceSquared,
                };
            }
        }

        return nearest?.element ?? null;
    }

    function resolvePagePointTarget(clientX: number, clientY: number): IPagePointTarget | null {
        const pageContainer = findPageContainerFromClientPoint(clientX, clientY);
        if (!pageContainer) {
            return null;
        }
        const rect = pageContainer.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        const pageNumber = pageContainer.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
        if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
            return null;
        }
        return {
            pageContainer,
            pageNumber,
            pageX: clamp01((clientX - rect.left) / rect.width),
            pageY: clamp01((clientY - rect.top) / rect.height),
        };
    }

    function findClosestTextSpanInPage(
        pageContainer: HTMLElement,
        targetX: number,
        targetY: number,
    ): IClosestTextSpan | null {
        const spans = Array.from(
            pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'),
        );
        let best: IClosestTextSpan | null = null;

        spans.forEach((span) => {
            const text = span.textContent?.trim() ?? '';
            if (!text) {
                return;
            }
            const rect = span.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }

            const inside = targetX >= rect.left
                && targetX <= rect.right
                && targetY >= rect.top
                && targetY <= rect.bottom;
            const dx = inside
                ? 0
                : Math.min(Math.abs(targetX - rect.left), Math.abs(targetX - rect.right));
            const dy = inside
                ? 0
                : Math.min(Math.abs(targetY - rect.top), Math.abs(targetY - rect.bottom));
            const score = (dx * dx) + (dy * dy);
            if (!best || score < best.score) {
                best = {
                    span,
                    score,
                    rect,
                };
            }
        });

        return best;
    }

    function resolveWordOffsets(text: string, seedOffset: number) {
        const length = text.length;
        if (length <= 0) {
            return null;
        }

        let offset = Math.max(0, Math.min(length - 1, seedOffset));
        if (/\s/.test(text[offset] ?? '')) {
            let left = offset - 1;
            let right = offset + 1;
            while (left >= 0 || right < length) {
                if (left >= 0 && !/\s/.test(text[left] ?? '')) {
                    offset = left;
                    break;
                }
                if (right < length && !/\s/.test(text[right] ?? '')) {
                    offset = right;
                    break;
                }
                left -= 1;
                right += 1;
            }
        }

        let start = offset;
        let end = Math.min(length, offset + 1);
        while (start > 0 && !/\s/.test(text[start - 1] ?? '')) {
            start -= 1;
        }
        while (end < length && !/\s/.test(text[end] ?? '')) {
            end += 1;
        }

        if (start === end) {
            end = Math.min(length, start + 1);
        }
        return {
            start,
            end,
        };
    }

    function buildRangeFromPagePoint(target: IPagePointTarget) {
        const pageRect = target.pageContainer.getBoundingClientRect();
        const clientX = pageRect.left + (target.pageX * pageRect.width);
        const clientY = pageRect.top + (target.pageY * pageRect.height);
        const nearest = findClosestTextSpanInPage(target.pageContainer, clientX, clientY);
        if (!nearest) {
            return null;
        }

        const textNode = Array
            .from(nearest.span.childNodes)
            .find((node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent?.length ?? 0) > 0)
            ?? null;
        if (!textNode) {
            return null;
        }

        const text = textNode.textContent ?? '';
        if (!text.length) {
            return null;
        }

        const ratio = nearest.rect.width > 0
            ? clamp01((clientX - nearest.rect.left) / nearest.rect.width)
            : 0;
        const offsetSeed = Math.floor(ratio * Math.max(1, text.length - 1));
        const offsets = resolveWordOffsets(text, offsetSeed);
        if (!offsets) {
            return null;
        }

        const range = document.createRange();
        range.setStart(textNode, offsets.start);
        range.setEnd(textNode, offsets.end);
        return range;
    }

    async function highlightSelectionInternal(withComment: boolean, explicitRange: Range | null = null): Promise<boolean> {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return false;
        }

        let selection = document.getSelection();
        const activeRange = explicitRange?.cloneRange() ?? getSelectionRangeForCommentAction();

        if (!activeRange) {
            return false;
        }

        try {
            selection = document.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(activeRange.cloneRange());
        } catch {
            // Ignore selection restoration failure and continue with available data.
        }

        const {
            startContainer,
            startOffset,
            endContainer,
            endOffset,
            commonAncestorContainer,
        } = activeRange;
        const text = activeRange.toString();

        const anchorElement = startContainer.nodeType === Node.TEXT_NODE
            ? startContainer.parentElement
            : (startContainer as HTMLElement | null);
        const commonAncestorElement = commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? commonAncestorContainer.parentElement
            : (commonAncestorContainer as HTMLElement | null);
        const textLayer = (anchorElement?.closest('.text-layer, .textLayer')
            ?? commonAncestorElement?.closest('.text-layer, .textLayer')) as HTMLElement | null;
        if (!textLayer) {
            return false;
        }

        const boxes = uiManager.getSelectionBoxes(textLayer);
        if (!boxes) {
            return false;
        }

        const pageContainer = textLayer.closest<HTMLElement>('.page_container');
        const pageNumber = pageContainer?.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
        const pageIndex = Math.max(0, pageNumber - 1);

        const editorsBefore = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
        const editorsBeforeRefs = new Set<IPdfjsEditor>(editorsBefore);
        const editorsBeforeIds = new Set<string>(editorsBefore.map(editor => identity.getEditorIdentity(editor, pageIndex)));

        selection?.removeAllRanges();
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;

        const previousMode = uiManager.getMode();
        const markupSubtypeOverride = markupSubtype.TOOL_TO_MARKUP_SUBTYPE[annotationTool.value] ?? null;
        let createdAnnotation = false;

        const pickCreatedEditorCandidate = () => {
            const editorsAfter = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
            return editorsAfter.find((editor) => {
                if (!editorsBeforeRefs.has(editor)) {
                    return true;
                }
                const editorIdentity = identity.getEditorIdentity(editor, pageIndex);
                return !editorsBeforeIds.has(editorIdentity);
            }) ?? editorsAfter.at(-1) ?? null;
        };

        const resolveCreatedEditor = async (createdEditor: IPdfjsEditor | null) => {
            if (createdEditor) {
                return createdEditor;
            }

            const activeEditor = (uiManager as AnnotationEditorUIManager & { getActive?: () => unknown })
                .getActive?.() as IPdfjsEditor | null | undefined;
            if (activeEditor) {
                return activeEditor;
            }

            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch {
                // Ignore and continue with best-effort lookup.
            }
            await nextTick();
            return pickCreatedEditorCandidate();
        };

        const applySubtypeOverrideToEditor = (editor: IPdfjsEditor | null) => {
            if (!editor || !markupSubtypeOverride) {
                return false;
            }
            markupSubtype.setEditorMarkupSubtypeOverride(editor, pageIndex, markupSubtypeOverride);
            queueMicrotask(() => {
                markupSubtype.syncMarkupSubtypePresentationForEditors();
            });
            return true;
        };

        try {
            const highlightModeError = await toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.HIGHLIGHT, pageNumber);
            if (highlightModeError) {
                throw highlightModeError;
            }
            await uiManager.waitForEditorsRendered(pageNumber);

            const layer = uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer;
            const createdEditor = layer?.createAndAddNewEditor(
                new PointerEvent('pointerdown'),
                false,
                {
                    methodOfCreation: 'toolbar',
                    boxes,
                    anchorNode: startContainer,
                    anchorOffset: startOffset,
                    focusNode: endContainer,
                    focusOffset: endOffset,
                    text,
                },
            );
            createdAnnotation = true;
            const targetEditor = await resolveCreatedEditor((createdEditor ?? null) as IPdfjsEditor | null);
            applySubtypeOverrideToEditor(targetEditor);

            if (!targetEditor && !withComment && markupSubtypeOverride) {
                let attempts = 0;
                const applySubtypeLater = () => {
                    const lateEditor = pickCreatedEditorCandidate();
                    if (applySubtypeOverrideToEditor(lateEditor)) {
                        return;
                    }
                    attempts += 1;
                    if (attempts < 12) {
                        setTimeout(applySubtypeLater, 80);
                    }
                };
                setTimeout(applySubtypeLater, 80);
            }

            if (withComment) {
                if (targetEditor) {
                    commentSync.pendingCommentEditorKeys.add(identity.getEditorPendingKey(targetEditor, pageIndex));
                    const summary = commentSync.toEditorSummary(targetEditor, pageIndex, getCommentText(targetEditor));
                    emitAnnotationOpenNote(summary);
                } else {
                    let attempts = 0;
                    const tryEmitLater = () => {
                        const lateEditor = pickCreatedEditorCandidate();
                        if (!lateEditor) {
                            attempts += 1;
                            if (attempts < 12) {
                                setTimeout(tryEmitLater, 80);
                            }
                            return;
                        }
                        applySubtypeOverrideToEditor(lateEditor);
                        commentSync.pendingCommentEditorKeys.add(identity.getEditorPendingKey(lateEditor, pageIndex));
                        const summary = commentSync.toEditorSummary(lateEditor, pageIndex, getCommentText(lateEditor));
                        emitAnnotationOpenNote(summary);
                    };
                    setTimeout(tryEmitLater, 80);
                }
            }
        } catch (error) {
            console.warn(`Failed to highlight selection: ${errorToLogText(error)}`);
        }

        if (createdAnnotation) {
            toolManager.maybeAutoResetAnnotationTool();
        }

        const restoreModeError = await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
        if (restoreModeError) {
            console.warn('Failed to restore annotation mode:', restoreModeError);
        }

        return createdAnnotation;
    }

    function highlightSelection() {
        return highlightSelectionInternal(false);
    }

    async function maybeApplySelectionMarkup(explicitRange: Range | null = null) {
        if (!markupSubtype.isSelectionMarkupTool(annotationTool.value) || isPlacingComment.value) {
            return false;
        }
        const range = explicitRange ?? getSelectionRangeForCommentAction();
        if (!range) {
            return false;
        }
        return highlightSelectionInternal(false, range);
    }

    async function commentSelection() {
        return highlightSelectionInternal(true);
    }

    async function commentAtPoint(
        pageNumber: number,
        pageX: number,
        pageY: number,
        pointOptions: { preferTextAnchor?: boolean } = {},
    ) {
        const container = viewerContainer.value;
        const uiManager = annotationUiManager.value;
        if (!container || !uiManager) {
            return false;
        }

        const pageContainer = container.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
        if (!pageContainer) {
            return false;
        }

        if (pointOptions.preferTextAnchor ?? true) {
            const range = buildRangeFromPagePoint({
                pageContainer,
                pageNumber,
                pageX: clamp01(pageX),
                pageY: clamp01(pageY),
            });
            if (range) {
                const created = await highlightSelectionInternal(true, range);
                if (created) {
                    return true;
                }
            }
        }

        const pageIndex = Math.max(0, pageNumber - 1);
        const editorsBefore = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
        const editorsBeforeRefs = new Set<IPdfjsEditor>(editorsBefore);
        const editorsBeforeIds = new Set<string>(editorsBefore.map(editor => identity.getEditorIdentity(editor, pageIndex)));

        const pickCreatedEditorCandidate = () => {
            const editorsAfter = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
            return editorsAfter.find((editor) => {
                if (!editorsBeforeRefs.has(editor)) {
                    return true;
                }
                const editorIdentity = identity.getEditorIdentity(editor, pageIndex);
                return !editorsBeforeIds.has(editorIdentity);
            }) ?? editorsAfter.at(-1) ?? null;
        };

        const resolveCreatedEditor = async (createdEditor: IPdfjsEditor | null) => {
            if (createdEditor) {
                return createdEditor;
            }

            const immediate = pickCreatedEditorCandidate();
            if (immediate) {
                return immediate;
            }

            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch {
                // Ignore and continue with best-effort lookup.
            }
            await delay(60);
            await nextTick();
            return pickCreatedEditorCandidate();
        };

        const previousMode = uiManager.getMode();
        try {
            const freeTextModeError = await toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.FREETEXT, pageNumber);
            if (freeTextModeError) {
                throw freeTextModeError;
            }
            await uiManager.waitForEditorsRendered(pageNumber);
            const layer = uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer;
            if (!layer?.div) {
                return false;
            }

            const layerRect = layer.div.getBoundingClientRect();
            const clientX = layerRect.left + clamp01(pageX) * layerRect.width;
            const clientY = layerRect.top + clamp01(pageY) * layerRect.height;
            const eventInit: PointerEventInit = {
                clientX,
                clientY,
                button: 0,
                buttons: 1,
                bubbles: true,
                pointerType: 'mouse',
                isPrimary: true,
            };
            layer.div.dispatchEvent(new PointerEvent('pointerdown', eventInit));
            layer.div.dispatchEvent(new PointerEvent('pointerup', eventInit));

            const resolvedEditor = await resolveCreatedEditor(null);
            if (!resolvedEditor) {
                return false;
            }

            commentSync.pendingCommentEditorKeys.add(identity.getEditorPendingKey(resolvedEditor, pageIndex));
            const resolvedEditorWithComment = resolvedEditor as IPdfjsEditor & { editComment?: () => void };
            if (typeof resolvedEditorWithComment.editComment === 'function') {
                resolvedEditorWithComment.editComment();
            } else {
                const summary = commentSync.toEditorSummary(resolvedEditor, pageIndex, getCommentText(resolvedEditor));
                emitAnnotationOpenNote(summary);
            }
            return true;
        } finally {
            if (previousMode !== AnnotationEditorType.FREETEXT) {
                await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
            }
        }
    }

    function setCommentPlacementMode(active: boolean) {
        if (isPlacingComment.value === active) {
            return;
        }
        isPlacingComment.value = active;
        emitAnnotationNotePlacementChange(active);
    }

    function startCommentPlacement() {
        setCommentPlacementMode(true);
    }

    function cancelCommentPlacement() {
        setCommentPlacementMode(false);
    }

    async function placeCommentAtClientPoint(clientX: number, clientY: number) {
        const target = resolvePagePointTarget(clientX, clientY);
        if (!target) {
            return false;
        }

        const created = await commentAtPoint(
            target.pageNumber,
            target.pageX,
            target.pageY,
            { preferTextAnchor: false },
        );
        if (created) {
            setCommentPlacementMode(false);
        }
        return created;
    }

    function handleViewerMouseUp() {
        stopDrag();
    }

    function handleDocumentPointerUp(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        void maybeApplySelectionMarkup();
    }

    function buildAnnotationContextMenuPayload(
        comment: IAnnotationCommentSummary | null,
        clientX: number,
        clientY: number,
    ): IAnnotationContextMenuPayload {
        const target = resolvePagePointTarget(clientX, clientY);
        return {
            comment,
            clientX,
            clientY,
            hasSelection: Boolean(getSelectionRangeForCommentAction()),
            pageNumber: target?.pageNumber ?? null,
            pageX: target?.pageX ?? null,
            pageY: target?.pageY ?? null,
        };
    }

    function clearSelectionCache() {
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;
    }

    return {
        isPlacingComment,
        highlightSelection,
        commentSelection,
        commentAtPoint,
        placeCommentAtClientPoint,
        startCommentPlacement,
        cancelCommentPlacement,
        handleViewerMouseUp,
        handleDocumentPointerUp,
        cacheCurrentTextSelection,
        maybeApplySelectionMarkup,
        buildAnnotationContextMenuPayload,
        resolvePagePointTarget,
        findPageContainerFromClientPoint,
        clearSelectionCache,
    };
}
