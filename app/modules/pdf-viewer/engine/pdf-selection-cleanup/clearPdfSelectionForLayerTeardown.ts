const ELEMENT_NODE = 1;

const TEXT_NODE = 3;

const PDF_TEXT_LAYER_SELECTOR = '.text-layer, .textLayer';

interface IClearPdfSelectionForLayerTeardownOptions {
    target?: HTMLElement | null;
    root?: HTMLElement | null;
    includeDetached?: boolean;
    includeAnyPdfTextSelection?: boolean;
}

function getSelectionDocument() {
    return typeof document === 'undefined' ? null : document;
}

function getElementFromNode(node: Node | null | undefined) {
    if (!node) {
        return null;
    }
    if (node.nodeType === ELEMENT_NODE) {
        return node as Element;
    }
    if (node.nodeType === TEXT_NODE) {
        return node.parentElement;
    }
    return node.parentElement;
}

function elementContainsNode(element: HTMLElement, node: Node | null | undefined) {
    if (!node) {
        return false;
    }
    try {
        return element === node || element.contains(node);
    } catch {
        return false;
    }
}

function nodeIsDisconnected(node: Node | null | undefined) {
    return Boolean(node && node.isConnected === false);
}

function getRangeAt(selection: Selection, index: number) {
    try {
        return selection.getRangeAt(index);
    } catch {
        return null;
    }
}

function getSelectionNodes(selection: Selection) {
    const nodes: Array<Node | null> = [selection.anchorNode, selection.focusNode];

    for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = getRangeAt(selection, index);
        if (!range) {
            continue;
        }
        nodes.push(range.commonAncestorContainer, range.startContainer, range.endContainer);
    }

    return nodes;
}

function selectionTouchesElement(selection: Selection, element: HTMLElement) {
    return getSelectionNodes(selection).some((node) => elementContainsNode(element, node));
}

function selectionHasDisconnectedNode(selection: Selection) {
    return getSelectionNodes(selection).some(nodeIsDisconnected);
}

function selectionTouchesPdfTextLayer(selection: Selection, root?: HTMLElement | null) {
    return getSelectionNodes(selection).some((node) => {
        const element = getElementFromNode(node);
        const textLayer = element?.closest(PDF_TEXT_LAYER_SELECTOR);
        return Boolean(textLayer && (!root || root.contains(textLayer)));
    });
}

export function clearPdfSelectionForLayerTeardown(options: IClearPdfSelectionForLayerTeardownOptions = {}) {
    const doc = getSelectionDocument();
    const selection = doc?.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return false;
    }

    const {target = null, root = null, includeDetached = false, includeAnyPdfTextSelection = false} = options;

    const shouldClear =
        (target ? selectionTouchesElement(selection, target) : false) ||
        (includeAnyPdfTextSelection ? selectionTouchesPdfTextLayer(selection, root) : false) ||
        (includeDetached ? selectionHasDisconnectedNode(selection) : false);

    if (!shouldClear) {
        return false;
    }

    try {
        selection.removeAllRanges();
        return true;
    } catch {
        return false;
    }
}
