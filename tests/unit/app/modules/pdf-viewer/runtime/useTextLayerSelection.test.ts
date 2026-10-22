// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useTextLayerSelection } from '@app/modules/pdf-viewer/runtime/composables/useTextLayerSelection';

interface ITextLayerHarness {
    cleanup: () => void;
    layer: HTMLElement;
    sentinel: HTMLElement;
    text: Text;
}

const cleanups: Array<() => void> = [];

function createTextLayer(content: string): ITextLayerHarness {
    const layer = document.createElement('div');
    layer.className = 'text-layer';
    const span = document.createElement('span');
    const text = document.createTextNode(content);
    span.append(text);
    layer.append(span);
    document.body.append(layer);

    const cleanup = useTextLayerSelection().setupTextLayer(layer);
    cleanups.push(cleanup);

    const sentinel = layer.querySelector<HTMLElement>('[data-evb-text-layer-selection="true"]');
    if (!sentinel) {
        throw new Error('Expected selection sentinel');
    }

    return {
        cleanup,
        layer,
        sentinel,
        text,
    };
}

function dispatchSelection(anchor: Text, focus: Text) {
    const range = document.createRange();
    range.setStart(anchor, 0);
    range.setEnd(focus, focus.length);
    const selection: Partial<Selection> = {
        anchorNode: anchor,
        focusNode: focus,
        getRangeAt: () => range,
        rangeCount: 1,
    };
    vi.spyOn(document, 'getSelection').mockReturnValue(selection as Selection);
    document.dispatchEvent(new Event('selectionchange'));
}

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()?.();
    }
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

describe('useTextLayerSelection', () => {
    it('keeps the PDF selection sentinel out of unrelated selectable UI', () => {
        const pdf = createTextLayer('PDF text');
        const assistant = document.createElement('aside');
        const heading = document.createTextNode('Ask about the current document');
        assistant.append(heading);
        document.body.append(assistant);

        dispatchSelection(pdf.text, heading);

        expect(pdf.layer.contains(pdf.sentinel)).toBe(true);
        expect(assistant.contains(pdf.sentinel)).toBe(false);
    });

    it('still moves the selection sentinel between registered PDF text layers during a drag', () => {
        const firstPage = createTextLayer('First page');
        const secondPage = createTextLayer('Second page');

        document.dispatchEvent(new Event('pointerdown'));
        dispatchSelection(firstPage.text, secondPage.text);

        expect(secondPage.layer.contains(firstPage.sentinel)).toBe(true);
    });

    it('leaves the sentinel reset when a selection change arrives after the press ends', () => {
        const firstPage = createTextLayer('First page');
        const secondPage = createTextLayer('Second page');

        document.dispatchEvent(new Event('pointerdown'));
        document.dispatchEvent(new Event('pointerup'));
        dispatchSelection(firstPage.text, secondPage.text);

        // A late change must not cover the page again and swallow the next press.
        expect(firstPage.layer.lastElementChild).toBe(firstPage.sentinel);
        expect(firstPage.sentinel.style.height).toBe('');
        expect(firstPage.layer.classList.contains('selecting')).toBe(false);
    });
});
