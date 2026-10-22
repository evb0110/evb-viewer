import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { useEventListener } from '@vueuse/core';

interface ITextLayerEntry {
    textLayer: HTMLElement;
    endOfContent: HTMLElement;
}

const textLayers = new Map<HTMLElement, ITextLayerEntry>();
const mouseDownStops = new WeakMap<HTMLElement, () => void>();
let stopGlobalSelectionListeners: (() => void) | null = null;
let prevRange: Range | null = null;
let isPointerDown = false;
let activeSelectionLayer: HTMLElement | null = null;
let previousSelectionLayer: HTMLElement | null = null;

function reset(entry: ITextLayerEntry) {
    const {
        textLayer,
        endOfContent,
    } = entry;
    textLayer.appendChild(endOfContent);
    endOfContent.style.width = '';
    endOfContent.style.height = '';
    textLayer.classList.remove('selecting');
}

function resolveTextLayerFromNode(node: Node | null) {
    if (!node) {
        return null;
    }

    const element = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
    return element?.closest('.text-layer') as HTMLElement | null;
}

function clearTrackedSelectionLayers() {
    const layersToReset = new Set<HTMLElement>();
    if (activeSelectionLayer) {
        layersToReset.add(activeSelectionLayer);
    }
    if (previousSelectionLayer) {
        layersToReset.add(previousSelectionLayer);
    }

    layersToReset.forEach((layer) => {
        const entry = textLayers.get(layer);
        if (entry) {
            reset(entry);
        }
    });

    activeSelectionLayer = null;
    previousSelectionLayer = null;
}

function isSelectionStartBeingModified(range: Range) {
    return Boolean(prevRange && (
        range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0
    ));
}

function normalizeSelectionAnchorNode(anchor: Node | null) {
    return anchor?.nodeType === Node.TEXT_NODE
        ? anchor.parentNode
        : anchor;
}

function resolvePreviousSelectableAnchor(anchor: Node | null) {
    let candidate = anchor;
    while (candidate && !candidate.previousSibling) {
        candidate = candidate.parentNode;
    }
    if (!candidate) {
        return null;
    }

    candidate = candidate.previousSibling;
    while (candidate && !candidate.childNodes.length) {
        candidate = candidate.previousSibling;
    }
    return candidate;
}

function resolveSelectionSentinelAnchor(range: Range, modifyStart: boolean) {
    const initialAnchor = modifyStart ? range.startContainer : range.endContainer;
    const anchor = normalizeSelectionAnchorNode(initialAnchor);
    return !modifyStart && range.endOffset === 0
        ? resolvePreviousSelectableAnchor(anchor)
        : anchor;
}

function insertSelectionSentinel(
    endOfContent: HTMLElement,
    anchor: Node,
    insertBeforeAnchor: boolean,
) {
    const anchorElement = anchor as Element;
    const anchorTextLayer = resolveTextLayerFromNode(anchorElement);
    const anchorParent = anchorElement.parentElement;
    if (!anchorTextLayer || !textLayers.has(anchorTextLayer) || !anchorParent || !anchorTextLayer.contains(anchorParent)) {
        return;
    }

    anchorParent.insertBefore(
        endOfContent,
        insertBeforeAnchor ? anchor : anchorElement.nextSibling,
    );
}

function updateSelectionSentinel(
    textLayerDiv: HTMLElement,
    entry: ITextLayerEntry,
    range: Range,
) {
    const { endOfContent } = entry;
    endOfContent.style.width = textLayerDiv.style.width || '100%';
    endOfContent.style.height = textLayerDiv.style.height || '100%';
    // A collapsed caret must not land on the page-sized sentinel: a drag
    // that starts beside a line would then anchor at the end of the page.
    endOfContent.style.userSelect = range.collapsed ? 'none' : 'text';

    const modifyStart = isSelectionStartBeingModified(range);
    const anchor = resolveSelectionSentinelAnchor(range, modifyStart);

    if (!anchor) {
        return;
    }

    insertSelectionSentinel(endOfContent, anchor, modifyStart);
}

function enableGlobalSelectionListener() {
    if (stopGlobalSelectionListeners) {
        return;
    }

    const stopPointerDown = useEventListener(
        document,
        'pointerdown',
        () => {
            isPointerDown = true;
        },
    );

    const stopPointerUp = useEventListener(
        document,
        'pointerup',
        () => {
            isPointerDown = false;
            clearTrackedSelectionLayers();
        },
    );

    const stopWindowBlur = useEventListener(
        window,
        'blur',
        () => {
            isPointerDown = false;
            clearTrackedSelectionLayers();
        },
    );

    const stopKeyup = useEventListener(
        document,
        'keyup',
        () => {
            if (!isPointerDown) {
                clearTrackedSelectionLayers();
            }
        },
    );

    const stopSelectionChange = useEventListener(
        document,
        'selectionchange',
        () => {
            const selection = document.getSelection();
            if (!selection || selection.rangeCount === 0) {
                clearTrackedSelectionLayers();
                prevRange = null;
                return;
            }

            const range = selection.getRangeAt(0);
            const nextActiveLayer =
                resolveTextLayerFromNode(range.commonAncestorContainer) ??
                resolveTextLayerFromNode(selection.anchorNode) ??
                resolveTextLayerFromNode(selection.focusNode) ??
                activeSelectionLayer ??
                previousSelectionLayer;

            const layersToReset = new Set<HTMLElement>();
            if (activeSelectionLayer && activeSelectionLayer !== nextActiveLayer) {
                layersToReset.add(activeSelectionLayer);
            }
            if (
                previousSelectionLayer &&
                previousSelectionLayer !== nextActiveLayer &&
                previousSelectionLayer !== activeSelectionLayer
            ) {
                layersToReset.add(previousSelectionLayer);
            }

            layersToReset.forEach((layer) => {
                const entry = textLayers.get(layer);
                if (entry) {
                    reset(entry);
                }
            });

            previousSelectionLayer = activeSelectionLayer;
            activeSelectionLayer = nextActiveLayer;

            if (!nextActiveLayer) {
                prevRange = range.cloneRange();
                return;
            }

            const entry = textLayers.get(nextActiveLayer);
            if (entry) {
                nextActiveLayer.classList.add('selecting');
                updateSelectionSentinel(nextActiveLayer, entry, range);
            }

            prevRange = range.cloneRange();
        },
    );

    stopGlobalSelectionListeners = () => {
        stopPointerDown();
        stopPointerUp();
        stopWindowBlur();
        stopKeyup();
        stopSelectionChange();
    };
}

function teardownTextLayer(textLayerDiv: HTMLElement) {
    clearPdfSelectionForLayerTeardown({ target: textLayerDiv });

    const entry = textLayers.get(textLayerDiv);
    if (entry) {
        textLayers.delete(textLayerDiv);
        textLayerDiv.classList.remove('selecting');
        entry.endOfContent.remove();
    }

    if (activeSelectionLayer === textLayerDiv) {
        activeSelectionLayer = null;
    }
    if (previousSelectionLayer === textLayerDiv) {
        previousSelectionLayer = null;
    }

    const stopMouseDown = mouseDownStops.get(textLayerDiv);
    if (stopMouseDown) {
        stopMouseDown();
        mouseDownStops.delete(textLayerDiv);
    }

    if (textLayers.size === 0 && stopGlobalSelectionListeners) {
        stopGlobalSelectionListeners();
        stopGlobalSelectionListeners = null;
        prevRange = null;
        activeSelectionLayer = null;
        previousSelectionLayer = null;
    }
}

export const useTextLayerSelection = () => {
    function setupTextLayer(textLayerDiv: HTMLElement) {
        const existingEntry = textLayers.get(textLayerDiv);
        if (existingEntry) {
            return () => {
                teardownTextLayer(textLayerDiv);
            };
        }

        for (const staleEndOfContent of textLayerDiv.querySelectorAll<HTMLElement>('.end-of-content[data-evb-text-layer-selection="true"]')) {
            staleEndOfContent.remove();
        }

        const endOfContent = document.createElement('div');
        endOfContent.className = 'end-of-content';
        endOfContent.dataset.evbTextLayerSelection = 'true';
        textLayerDiv.appendChild(endOfContent);

        let stopMouseDown = mouseDownStops.get(textLayerDiv);
        if (!stopMouseDown) {
            stopMouseDown = useEventListener(
                textLayerDiv,
                'mousedown',
                () => {
                    // The last drag left the sentinel selectable; clear that
                    // before this press places its caret over the whole page.
                    endOfContent.style.userSelect = 'none';
                    textLayerDiv.classList.add('selecting');
                },
            );
            mouseDownStops.set(textLayerDiv, stopMouseDown);
        }

        textLayers.set(textLayerDiv, {
            textLayer: textLayerDiv,
            endOfContent,
        });

        enableGlobalSelectionListener();

        return () => {
            teardownTextLayer(textLayerDiv);
        };
    }

    return { setupTextLayer };
};
