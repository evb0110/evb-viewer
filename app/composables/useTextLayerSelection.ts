/**
 * Text layer selection handling based on Mozilla PDF.js TextLayerBuilder
 * Fixes selection "wandering" by dynamically repositioning an endOfContent sentinel div
 */

interface ITextLayerEntry {
    textLayer: HTMLElement;
    endOfContent: HTMLElement;
}

const textLayers = new Map<HTMLElement, ITextLayerEntry>();
const mouseDownListenerAttached = new WeakSet<HTMLElement>();
let selectionAbortController: AbortController | null = null;
let prevRange: Range | null = null;
let isPointerDown = false;

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

function enableGlobalSelectionListener() {
    if (selectionAbortController) {
        return;
    }

    selectionAbortController = new AbortController();
    const { signal } = selectionAbortController;

    document.addEventListener(
        'pointerdown',
        () => {
            isPointerDown = true;
        },
        { signal },
    );

    document.addEventListener(
        'pointerup',
        () => {
            isPointerDown = false;
            textLayers.forEach(reset);
        },
        { signal },
    );

    window.addEventListener(
        'blur',
        () => {
            isPointerDown = false;
            textLayers.forEach(reset);
        },
        { signal },
    );

    document.addEventListener(
        'keyup',
        () => {
            if (!isPointerDown) {
                textLayers.forEach(reset);
            }
        },
        { signal },
    );

    document.addEventListener(
        'selectionchange',
        () => {
            const selection = document.getSelection();
            if (!selection || selection.rangeCount === 0) {
                textLayers.forEach(reset);
                prevRange = null;
                return;
            }

            const activeTextLayers = new Set<HTMLElement>();
            for (let i = 0; i < selection.rangeCount; i++) {
                const range = selection.getRangeAt(i);
                for (const [textLayerDiv] of textLayers) {
                    if (!activeTextLayers.has(textLayerDiv) && range.intersectsNode(textLayerDiv)) {
                        activeTextLayers.add(textLayerDiv);
                    }
                }
            }

            for (const [
                textLayerDiv,
                entry,
            ] of textLayers) {
                if (activeTextLayers.has(textLayerDiv)) {
                    textLayerDiv.classList.add('selecting');
                } else {
                    reset(entry);
                }
            }

            const range = selection.getRangeAt(0);
            const modifyStart = prevRange && (
                range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
                range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0
            );

            let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;

            if (anchor?.nodeType === Node.TEXT_NODE) {
                anchor = anchor.parentNode;
            }

            if (!modifyStart && range.endOffset === 0 && anchor) {
                while (anchor && !anchor.previousSibling) {
                    anchor = anchor.parentNode;
                }
                if (anchor) {
                    anchor = anchor.previousSibling;
                    while (anchor && !(anchor as Element).childNodes?.length) {
                        anchor = anchor.previousSibling;
                    }
                }
            }

            if (!anchor) {
                prevRange = range.cloneRange();
                return;
            }

            const parentTextLayer = (anchor as Element).parentElement?.closest('.text-layer') as HTMLElement | null;
            const entry = parentTextLayer ? textLayers.get(parentTextLayer) : null;

            if (entry) {
                const { endOfContent } = entry;
                endOfContent.style.width = parentTextLayer!.style.width || '100%';
                endOfContent.style.height = parentTextLayer!.style.height || '100%';
                endOfContent.style.userSelect = 'text';

                const anchorParent = (anchor as Element).parentElement;
                if (anchorParent) {
                    anchorParent.insertBefore(
                        endOfContent,
                        modifyStart ? anchor as Node : (anchor as Element).nextSibling,
                    );
                }
            }

            prevRange = range.cloneRange();
        },
        { signal },
    );
}

function removeGlobalSelectionListener(textLayerDiv: HTMLElement) {
    textLayers.delete(textLayerDiv);

    if (textLayers.size === 0 && selectionAbortController) {
        selectionAbortController.abort();
        selectionAbortController = null;
        prevRange = null;
    }
}

export const useTextLayerSelection = () => {
    function setupTextLayer(textLayerDiv: HTMLElement) {
        const endOfContent = document.createElement('div');
        endOfContent.className = 'end-of-content';
        textLayerDiv.appendChild(endOfContent);

        if (!mouseDownListenerAttached.has(textLayerDiv)) {
            mouseDownListenerAttached.add(textLayerDiv);
            textLayerDiv.addEventListener('mousedown', () => {
                textLayerDiv.classList.add('selecting');
            });
        }

        textLayers.set(textLayerDiv, {
            textLayer: textLayerDiv,
            endOfContent,
        });

        enableGlobalSelectionListener();

        return () => {
            removeGlobalSelectionListener(textLayerDiv);
        };
    }

    return { setupTextLayer };
};
