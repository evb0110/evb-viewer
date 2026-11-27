// @vitest-environment happy-dom

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearPdfSelectionForLayerTeardown} from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';

function createElement(classNames: string[] = [], parentElement: HTMLElement | null = null) {
    const element = document.createElement('div');
    element.classList.add(...classNames);
    parentElement?.append(element);
    return element;
}

function createText(parentElement: HTMLElement) {
    const text = document.createTextNode('selected text');
    parentElement.append(text);
    return text;
}

function stubSelection(selection: Partial<Selection> | null) {
    vi.spyOn(document, 'getSelection').mockReturnValue(selection as Selection | null);
}

function createSelection(node: Node, overrides: Partial<Selection> = {}) {
    const range = {
        commonAncestorContainer: node,
        startContainer: node,
        endContainer: node,
    } as Range;
    return {
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: vi.fn(() => range),
        removeAllRanges: vi.fn(),
        ...overrides,
    } as Selection;
}

describe('clearPdfSelectionForLayerTeardown', () => {
    beforeEach(() => {
        document.body.replaceChildren();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('clears a selection inside the torn-down page container', () => {
        const page = createElement(['page_container']);
        const textLayer = createElement(['text-layer'], page);
        const text = createText(textLayer);
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({target: page});

        expect(cleared).toBe(true);
        expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    });

    it('leaves unrelated connected selections alone', () => {
        const page = createElement(['page_container']);
        const sidebar = createElement(['sidebar']);
        const text = createText(sidebar);
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({target: page});

        expect(cleared).toBe(false);
        expect(selection.removeAllRanges).not.toHaveBeenCalled();
    });

    it('clears a detached selection endpoint after virtualization removes its page', () => {
        const page = createElement(['page_container']);
        const textLayer = createElement(['textLayer'], page);
        const text = createText(textLayer);
        page.remove();
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({includeDetached: true});

        expect(cleared).toBe(true);
        expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    });

    it('can clear any PDF text selection inside the viewer root', () => {
        const root = createElement(['pdfViewer']);
        const page = createElement(['page_container'], root);
        const textLayer = createElement(['textLayer'], page);
        const text = createText(textLayer);
        const selection = createSelection(text);
        stubSelection(selection);

        const cleared = clearPdfSelectionForLayerTeardown({
            root,
            includeAnyPdfTextSelection: true,
        });

        expect(cleared).toBe(true);
        expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    });
});
