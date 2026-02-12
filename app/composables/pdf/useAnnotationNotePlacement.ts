import {
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import {
    nextTick,
    ref,
    type Ref,
    type ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {IPdfjsEditor} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getCommentText,
    clamp01,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import type { useAnnotationToolManager } from '@app/composables/pdf/useAnnotationToolManager';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
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

export const useAnnotationNotePlacement = (deps: {
    viewerContainer: Ref<HTMLElement | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    currentPage: Ref<number>;
    identity: TIdentity;
    commentSync: TCommentSync;
    toolManager: TToolManager;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
    highlightSelectionInternal: (withComment: boolean, explicitRange: Range | null) => Promise<boolean>;
}) => {
    const isPlacingComment = ref(false);

    function findPageContainerFromClientPoint(clientX: number, clientY: number) {
        const container = deps.viewerContainer.value;
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
            : deps.currentPage.value;
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

    async function commentAtPoint(
        pageNumber: number,
        pageX: number,
        pageY: number,
        pointOptions: { preferTextAnchor?: boolean } = {},
    ) {
        const container = deps.viewerContainer.value;
        const uiManager = deps.annotationUiManager.value;
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
                const created = await deps.highlightSelectionInternal(true, range);
                if (created) {
                    return true;
                }
            }
        }

        const pageIndex = Math.max(0, pageNumber - 1);
        const editorsBefore = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
        const editorsBeforeRefs = new Set<IPdfjsEditor>(editorsBefore);
        const editorsBeforeIds = new Set<string>(editorsBefore.map(editor => deps.identity.getEditorIdentity(editor, pageIndex)));

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
            const freeTextModeError = await deps.toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.FREETEXT, pageNumber);
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

            deps.commentSync.pendingCommentEditorKeys.add(deps.identity.getEditorPendingKey(resolvedEditor, pageIndex));
            const resolvedEditorWithComment = resolvedEditor as IPdfjsEditor & { editComment?: () => void };
            if (typeof resolvedEditorWithComment.editComment === 'function') {
                resolvedEditorWithComment.editComment();
            } else {
                const summary = deps.commentSync.toEditorSummary(resolvedEditor, pageIndex, getCommentText(resolvedEditor));
                deps.emitAnnotationOpenNote(summary);
            }
            return true;
        } finally {
            if (previousMode !== AnnotationEditorType.FREETEXT) {
                await deps.toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
            }
        }
    }

    function setCommentPlacementMode(active: boolean) {
        if (isPlacingComment.value === active) {
            return;
        }
        isPlacingComment.value = active;
        deps.emitAnnotationNotePlacementChange(active);
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

    return {
        isPlacingComment,
        commentAtPoint,
        placeCommentAtClientPoint,
        startCommentPlacement,
        cancelCommentPlacement,
        resolvePagePointTarget,
        findPageContainerFromClientPoint,
    };
};
