import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {TAnnotationTool} from '@app/types/annotations';
import {isSelectionMarkupTool} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionMarkupTool';
import {runGuardedTask} from '@app/utils/asyncGuard';

interface IAnnotationSelectionCachePort {
    cacheCurrentTextSelection: () => void;
    beginSelectionGesture: () => void;
    invalidateSelectionForToolActivation: () => void;
}

interface IAnnotationSelectionLifecyclePort {invalidateActiveRequests: () => void;}

interface ICreateAnnotationSelectionInteractionControllerOptions {
    viewerContainer: Ref<HTMLElement | null>;
    isActive: ComputedRef<boolean>;
    annotationTool: ComputedRef<TAnnotationTool>;
    selectionCache: IAnnotationSelectionCachePort;
    selectionLifecycle: IAnnotationSelectionLifecyclePort;
    applySelectionMarkup: (range?: Range | null) => Promise<boolean>;
}

interface ISelectionCaret {
    readonly layer: HTMLElement;
    readonly node: Node;
    readonly offset: number;
}

// A search result is an inline span nested inside PDF.js's absolutely
// positioned text span. Chromium can resolve a native drag's start at the
// outer span boundary, so marked-text drags keep the pointer's caret explicitly.
function selectionCaretFromPoint(event: PointerEvent): ISelectionCaret | null {
    const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (!position) {
        return null;
    }
    const element = position.offsetNode.nodeType === Node.ELEMENT_NODE
        ? position.offsetNode as Element
        : position.offsetNode.parentElement;
    const layer = element?.closest<HTMLElement>('.text-layer, .textLayer') ?? null;
    return layer
        ? {
            layer,
            node: position.offsetNode,
            offset: position.offset,
        }
        : null;
}

function caretIsInsideSearchHighlight(caret: ISelectionCaret | null) {
    const element = caret?.node.nodeType === Node.ELEMENT_NODE
        ? caret.node as Element
        : caret?.node.parentElement;
    return Boolean(element?.closest('.pdf-search-highlight'));
}

function rangeBetweenCarets(start: ISelectionCaret, end: ISelectionCaret) {
    const ownerDocument = start.node.ownerDocument;
    if (!ownerDocument || ownerDocument !== end.node.ownerDocument || start.layer !== end.layer) {
        return null;
    }
    const startBoundary = ownerDocument.createRange();
    const endBoundary = ownerDocument.createRange();
    try {
        startBoundary.setStart(start.node, start.offset);
        startBoundary.collapse(true);
        endBoundary.setStart(end.node, end.offset);
        endBoundary.collapse(true);
        const startBeforeEnd = startBoundary.compareBoundaryPoints(Range.START_TO_START, endBoundary) <= 0;
        const range = ownerDocument.createRange();
        range.setStart(startBeforeEnd ? start.node : end.node, startBeforeEnd ? start.offset : end.offset);
        range.setEnd(startBeforeEnd ? end.node : start.node, startBeforeEnd ? end.offset : start.offset);
        return range;
    } catch {
        return null;
    }
}

/** Owns DOM selection and pointer gesture routing for all text-markup tools. */
export function createAnnotationSelectionInteractionController(
    options: ICreateAnnotationSelectionInteractionControllerOptions,
) {
    let selectionPointerId: number | null = null;
    let selectionAnchor: ISelectionCaret | null = null;
    const stopToolWatch = watch(options.annotationTool, tool => {
        selectionPointerId = null;
        selectionAnchor = null;
        options.selectionLifecycle.invalidateActiveRequests();
        if (!options.isActive.value || !isSelectionMarkupTool(tool)) {
            return;
        }
        runGuardedTask(
            async () => {
                await options.applySelectionMarkup();
            },
            {
                category: 'user-visible-operation',
                scope: 'annotations',
                message: 'Failed to apply selected text after activating markup tool',
            },
        );
    }, {flush: 'sync'});

    const handleDocumentPointerCancel = (event: PointerEvent) => {
        if (selectionPointerId === event.pointerId) {
            selectionPointerId = null;
            selectionAnchor = null;
        }
    };
    const handleDocumentPointerMove = (event: PointerEvent) => {
        if (
            selectionPointerId !== event.pointerId
            || !selectionAnchor
            || !caretIsInsideSearchHighlight(selectionAnchor)
            || !isSelectionMarkupTool(options.annotationTool.value)
        ) {
            return;
        }
        const selection = document.getSelection();
        const caret = selectionCaretFromPoint(event);
        if (!selection || !caret || caret.layer !== selectionAnchor.layer) {
            return;
        }
        const range = rangeBetweenCarets(selectionAnchor, caret);
        if (!range) {
            return;
        }
        selection.removeAllRanges();
        selection.addRange(range);
    };
    function handleDocumentPointerDown(event: PointerEvent) {
        if (event.button !== 0 || !options.isActive.value) {
            return;
        }
        const viewerContainer = options.viewerContainer.value;
        if (!viewerContainer || !(event.target instanceof Node)) {
            selectionPointerId = null;
            return;
        }
        const target = event.target instanceof Element ? event.target : event.target.parentElement;
        const textLayer = target?.closest<HTMLElement>('.text-layer, .textLayer');
        if (textLayer && viewerContainer.contains(textLayer)) {
            options.selectionCache.beginSelectionGesture();
            selectionPointerId = isSelectionMarkupTool(options.annotationTool.value)
                ? event.pointerId
                : null;
            selectionAnchor = selectionPointerId === event.pointerId
                ? selectionCaretFromPoint(event)
                : null;
            if (caretIsInsideSearchHighlight(selectionAnchor)) {
                event.preventDefault();
            } else {
                selectionAnchor = null;
            }
            return;
        }
        selectionPointerId = null;
        selectionAnchor = null;
        if (viewerContainer.contains(event.target)) {
            options.selectionCache.invalidateSelectionForToolActivation();
        }
    }
    function handleDocumentPointerUp(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        if (!options.isActive.value) {
            selectionPointerId = null;
            selectionAnchor = null;
            return;
        }
        const viewerContainer = options.viewerContainer.value;
        if (!viewerContainer) {
            selectionPointerId = null;
            selectionAnchor = null;
            return;
        }
        if (!isSelectionMarkupTool(options.annotationTool.value)) {
            selectionPointerId = null;
            selectionAnchor = null;
            if (event.target instanceof Node && viewerContainer.contains(event.target)) {
                const selection = document.getSelection();
                if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                    options.selectionCache.invalidateSelectionForToolActivation();
                }
            }
            return;
        }
        if (selectionPointerId !== event.pointerId) {
            return;
        }
        selectionPointerId = null;
        selectionAnchor = null;
        const selection = document.getSelection();
        const range = selection && selection.rangeCount > 0
            ? selection.getRangeAt(0).cloneRange()
            : null;
        if (!range || range.collapsed) {
            return;
        }
        runGuardedTask(
            () => options.applySelectionMarkup(range),
            {
                category: 'user-visible-operation',
                scope: 'annotations',
                message: 'Failed to apply selection markup on pointer up',
            },
        );
    }

    const handleSelectionChange = () => {
        if (options.isActive.value) {
            options.selectionCache.cacheCurrentTextSelection();
        }
    };
    const dispose = () => {
        stopToolWatch();
        if (typeof document === 'undefined') {
            return;
        }
        document.removeEventListener('selectionchange', handleSelectionChange);
        document.removeEventListener('pointerdown', handleDocumentPointerDown);
        document.removeEventListener('pointermove', handleDocumentPointerMove);
        document.removeEventListener('pointerup', handleDocumentPointerUp);
        document.removeEventListener('pointercancel', handleDocumentPointerCancel);
    };
    if (typeof document !== 'undefined') {
        document.addEventListener('selectionchange', handleSelectionChange, {passive: true});
        document.addEventListener('pointerdown', handleDocumentPointerDown, {passive: false});
        document.addEventListener('pointermove', handleDocumentPointerMove, {passive: true});
        document.addEventListener('pointerup', handleDocumentPointerUp, {passive: true});
        document.addEventListener('pointercancel', handleDocumentPointerCancel, {passive: true});
    }
    return dispose;
}
