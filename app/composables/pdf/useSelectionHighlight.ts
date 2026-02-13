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
import type {IPdfjsEditor} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getCommentText,
    errorToLogText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import { SELECTION_CACHE_TTL_MS } from '@app/constants/timeouts';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import type { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';
import { BrowserLogger } from '@app/utils/browser-logger';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TMarkupSubtypeComposable = ReturnType<typeof useAnnotationMarkupSubtype>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;
type TToolManager = ReturnType<typeof useAnnotationToolManager>;

export const useSelectionHighlight = (deps: {
    viewerContainer: Ref<HTMLElement | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    identity: TIdentity;
    markupSubtype: TMarkupSubtypeComposable;
    commentSync: TCommentSync;
    toolManager: TToolManager;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    isPlacingComment: Ref<boolean>;
}) => {
    let cachedSelectionRange: Range | null = null;
    let cachedSelectionTimestamp = 0;

    function cacheCurrentTextSelection() {
        const container = deps.viewerContainer.value;
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
        const container = deps.viewerContainer.value;
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

    async function highlightSelectionInternal(withComment: boolean, explicitRange: Range | null = null): Promise<boolean> {
        const uiManager = deps.annotationUiManager.value;
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
            : deps.currentPage.value;
        const pageIndex = Math.max(0, pageNumber - 1);

        const editorsBefore = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
        const editorsBeforeRefs = new Set<IPdfjsEditor>(editorsBefore);
        const editorsBeforeIds = new Set<string>(editorsBefore.map(editor => deps.identity.getEditorIdentity(editor, pageIndex)));

        selection?.removeAllRanges();
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;

        const previousMode = uiManager.getMode();
        const markupSubtypeOverride = deps.markupSubtype.TOOL_TO_MARKUP_SUBTYPE[deps.annotationTool.value] ?? null;
        let createdAnnotation = false;

        const pickCreatedEditorCandidate = () => {
            const editorsAfter = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
            return editorsAfter.find((editor) => {
                if (!editorsBeforeRefs.has(editor)) {
                    return true;
                }
                const editorIdentity = deps.identity.getEditorIdentity(editor, pageIndex);
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
            deps.markupSubtype.setEditorMarkupSubtypeOverride(editor, pageIndex, markupSubtypeOverride);
            queueMicrotask(() => {
                deps.markupSubtype.syncMarkupSubtypePresentationForEditors();
            });
            return true;
        };

        try {
            const highlightModeError = await deps.toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.HIGHLIGHT, pageNumber);
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
                    deps.commentSync.pendingCommentEditorKeys.add(deps.identity.getEditorPendingKey(targetEditor, pageIndex));
                    const summary = deps.commentSync.toEditorSummary(targetEditor, pageIndex, getCommentText(targetEditor));
                    deps.emitAnnotationOpenNote(summary);
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
                        deps.commentSync.pendingCommentEditorKeys.add(deps.identity.getEditorPendingKey(lateEditor, pageIndex));
                        const summary = deps.commentSync.toEditorSummary(lateEditor, pageIndex, getCommentText(lateEditor));
                        deps.emitAnnotationOpenNote(summary);
                    };
                    setTimeout(tryEmitLater, 80);
                }
            }
        } catch (error) {
            BrowserLogger.warn('annotations', `Failed to highlight selection: ${errorToLogText(error)}`);
        }

        if (createdAnnotation) {
            deps.toolManager.maybeAutoResetAnnotationTool();
        }

        const restoreModeError = await deps.toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
        if (restoreModeError) {
            BrowserLogger.warn('annotations', 'Failed to restore annotation mode', restoreModeError);
        }

        return createdAnnotation;
    }

    function highlightSelection() {
        return highlightSelectionInternal(false);
    }

    async function commentSelection() {
        return highlightSelectionInternal(true);
    }

    async function maybeApplySelectionMarkup(explicitRange: Range | null = null) {
        if (!deps.markupSubtype.isSelectionMarkupTool(deps.annotationTool.value) || deps.isPlacingComment.value) {
            return false;
        }
        const range = explicitRange ?? getSelectionRangeForCommentAction();
        if (!range) {
            return false;
        }
        return highlightSelectionInternal(false, range);
    }

    function clearSelectionCache() {
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;
    }

    return {
        cacheCurrentTextSelection,
        getSelectionRangeForCommentAction,
        highlightSelection,
        commentSelection,
        maybeApplySelectionMarkup,
        highlightSelectionInternal,
        clearSelectionCache,
    };
};
