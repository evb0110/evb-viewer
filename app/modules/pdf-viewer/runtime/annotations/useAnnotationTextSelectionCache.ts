import { requirePageNumber } from '@contracts/pageNumbers';
import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { SELECTION_CACHE_TTL_MS } from '@app/constants/timeouts';
import { errorToLogText } from '@app/modules/pdf-viewer/engine/annotation-css-utils/errorToLogText';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IUseAnnotationTextSelectionCacheOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    allowCrossPage?: boolean;
}

export interface IAnnotationTextSelectionSnapshot {
    readonly range: Range;
    readonly revision: number;
}

export const useAnnotationTextSelectionCache = ({
    viewerContainer,
    currentPage,
    allowCrossPage = false,
}: IUseAnnotationTextSelectionCacheOptions) => {
    let cachedSelectionRange: Range | null = null;
    let cachedSelectionTimestamp = 0;
    let cachedSelectionRevision = 0;
    let nextSelectionRevision = 0;
    let automaticSelectionAvailable = false;
    let selectionGesturePending = false;

    function sameRange(first: Range, second: Range) {
        return first.startContainer === second.startContainer
            && first.startOffset === second.startOffset
            && first.endContainer === second.endContainer
            && first.endOffset === second.endOffset;
    }

    function advanceSelectionRevision() {
        nextSelectionRevision += 1;
        cachedSelectionRevision = nextSelectionRevision;
    }

    function clearSelectionCache() {
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;
        automaticSelectionAvailable = false;
        selectionGesturePending = false;
        advanceSelectionRevision();
    }

    tryOnScopeDispose(() => {
        clearSelectionCache();
    });

    function getElementFromRangeNode(node: Node) {
        return node.nodeType === Node.TEXT_NODE
            ? node.parentElement
            : node instanceof HTMLElement ? node : null;
    }

    function getTextLayerFromRangeNode(node: Node) {
        return getElementFromRangeNode(node)?.closest<HTMLElement>('.text-layer, .textLayer') ?? null;
    }

    function isRangeWithinViewerTextLayer(range: Range) {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }
        if (!allowCrossPage) {
            const commonAncestorLayer = getTextLayerFromRangeNode(range.commonAncestorContainer);
            return Boolean(commonAncestorLayer && container.contains(commonAncestorLayer));
        }
        const startLayer = getTextLayerFromRangeNode(range.startContainer);
        const endLayer = getTextLayerFromRangeNode(range.endContainer);
        return Boolean(startLayer && endLayer && container.contains(startLayer) && container.contains(endLayer));
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

    function cacheRange(range: Range) {
        if (selectionGesturePending || !cachedSelectionRange || !sameRange(cachedSelectionRange, range)) {
            advanceSelectionRevision();
        }
        selectionGesturePending = false;
        cachedSelectionRange = range.cloneRange();
        cachedSelectionTimestamp = Date.now();
        automaticSelectionAvailable = true;
    }

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
        if (!isRangeWithinViewerTextLayer(range)) {
            clearSelectionCache();
            return;
        }

        cacheRange(range);
    }

    function getCachedSelectionSnapshot() {
        if (!cachedSelectionRange) {
            return null;
        }
        if ((Date.now() - cachedSelectionTimestamp) > SELECTION_CACHE_TTL_MS) {
            clearSelectionCache();
            return null;
        }
        if (!isRangeWithinViewerTextLayer(cachedSelectionRange)) {
            clearSelectionCache();
            return null;
        }
        return {
            range: cachedSelectionRange.cloneRange(),
            revision: cachedSelectionRevision,
        } satisfies IAnnotationTextSelectionSnapshot;
    }

    function getSelectionSnapshotForCommentAction() {
        const direct = getSelectionRangeFromDocument();
        if (direct) {
            cacheRange(direct);
        }
        return getCachedSelectionSnapshot();
    }

    function getSelectionSnapshotForToolActivation() {
        if (!automaticSelectionAvailable) {
            return null;
        }
        const direct = getSelectionRangeFromDocument();
        if (direct) {
            cacheRange(direct);
            return getCachedSelectionSnapshot();
        }
        return automaticSelectionAvailable ? getCachedSelectionSnapshot() : null;
    }

    function getSelectionSnapshotForRange(range: Range) {
        if (!isRangeWithinViewerTextLayer(range)) {
            return null;
        }
        const current = getSelectionRangeFromDocument();
        if (current && sameRange(current, range)) {
            cacheRange(current);
        } else if (!cachedSelectionRange || !sameRange(cachedSelectionRange, range)) {
            cacheRange(range);
        }
        return getCachedSelectionSnapshot();
    }

    /**
     * A blank pointer press inside the viewer invalidates automatic tool
     * activation while retaining the cache for explicit context-menu or
     * command actions. The revision still advances, so a pending creation
     * cannot consume a later selection by accident.
     */
    function invalidateSelectionForToolActivation() {
        automaticSelectionAvailable = false;
        selectionGesturePending = false;
        advanceSelectionRevision();
    }

    function beginSelectionGesture() {
        selectionGesturePending = true;
        automaticSelectionAvailable = true;
    }

    function consumeSelection(snapshot: IAnnotationTextSelectionSnapshot) {
        if (selectionGesturePending || !cachedSelectionRange || snapshot.revision !== cachedSelectionRevision) {
            return;
        }
        const selection = document.getSelection();
        const current = getSelectionRangeFromDocument();
        if (current && !sameRange(current, snapshot.range)) {
            // Selectionchange is delivered asynchronously in some browsers.
            // Capture a newer native range here before the older request can
            // clear the cache that still points at its own snapshot.
            cacheRange(current);
            return;
        }
        if (current && sameRange(current, snapshot.range)) {
            try {
                selection?.removeAllRanges();
            } catch (error) {
                BrowserLogger.debug('annotations', `Failed to clear consumed text selection: ${errorToLogText(error)}`);
            }
        }
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;
        automaticSelectionAvailable = false;
        advanceSelectionRevision();
    }

    function getSelectionRangeForCommentAction() {
        return getSelectionSnapshotForCommentAction()?.range ?? null;
    }

    function restoreSelectionRange(activeRange: Range) {
        const selection = document.getSelection();
        try {
            selection?.removeAllRanges();
            selection?.addRange(activeRange.cloneRange());
        } catch (error) {
            BrowserLogger.debug('annotations', `Failed to restore current text selection: ${errorToLogText(error)}`);
        }
        return selection;
    }

    function resolveTextLayerForRange(activeRange: Range) {
        const anchorElement = getElementFromRangeNode(activeRange.startContainer);
        const commonAncestorElement = getElementFromRangeNode(activeRange.commonAncestorContainer);
        return anchorElement?.closest<HTMLElement>('.text-layer, .textLayer')
            ?? commonAncestorElement?.closest<HTMLElement>('.text-layer, .textLayer')
            ?? null;
    }

    /**
     * True when a range starts in one page's text layer and ends in another.
     * pdf.js refuses such a range outright, so the caller has to recognize it
     * to explain the rejection.
     */
    function doesRangeSpanTextLayers(activeRange: Range) {
        const container = viewerContainer.value;
        const startLayer = getElementFromRangeNode(activeRange.startContainer)
            ?.closest<HTMLElement>('.text-layer, .textLayer');
        const endLayer = getElementFromRangeNode(activeRange.endContainer)
            ?.closest<HTMLElement>('.text-layer, .textLayer');
        return Boolean(
            container
            && startLayer
            && endLayer
            && startLayer !== endLayer
            && container.contains(startLayer)
            && container.contains(endLayer),
        );
    }

    /**
     * Explains why `getSelectionRangeForCommentAction` came back empty. The
     * cache rejects a cross-page range before pdf.js ever sees it, so a `null`
     * range alone cannot tell "nothing selected" from "selection refused".
     * Markup shortcuts fire on every pointer release, so only a genuine
     * cross-page selection is worth telling the user about.
     */
    function classifyUnavailableSelection(): 'none' | 'cross-page' {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return 'none';
        }
        return !allowCrossPage && doesRangeSpanTextLayers(selection.getRangeAt(0)) ? 'cross-page' : 'none';
    }

    function getPageNumberForTextLayer(textLayer: HTMLElement) {
        const pageContainer = textLayer.closest<HTMLElement>('.page_container');
        const pageNumber = pageContainer?.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
        return requirePageNumber(pageNumber);
    }

    return {
        cacheCurrentTextSelection,
        classifyUnavailableSelection,
        clearSelectionCache,
        doesRangeSpanTextLayers,
        getPageNumberForTextLayer,
        getSelectionRangeForCommentAction,
        getSelectionSnapshotForCommentAction,
        getSelectionSnapshotForRange,
        getSelectionSnapshotForToolActivation,
        consumeSelection,
        beginSelectionGesture,
        invalidateSelectionForToolActivation,
        resolveTextLayerForRange,
        restoreSelectionRange,
    };
};
