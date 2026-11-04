// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { buildRangeFromPageText } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPageText';
import { highlightTextRunInPdfjsStyle } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';

/**
 * A click on a page arrives as a normalized fraction of the page box, while the
 * text layer only knows client coordinates. This is the seam that converts one
 * into the other and picks the word under the pointer, so the cases that matter
 * are the ones where the conversion or the span lookup can come back empty.
 */

const PAGE_RECT = {
    bottom: 100,
    height: 100,
    left: 0,
    right: 200,
    top: 0,
    width: 200,
    x: 0,
    y: 0,
};

interface ITextSpanFixture {
    height: number;
    left: number;
    node: Node;
    top: number;
    width: number;
}

function stubRect(element: HTMLElement, rect: typeof PAGE_RECT) {
    element.getBoundingClientRect = () => ({
        ...rect,
        toJSON: () => rect,
    }) as DOMRect;
}

function createPage(spans: readonly ITextSpanFixture[]) {
    const pageContainer = document.createElement('div');
    stubRect(pageContainer, PAGE_RECT);

    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    pageContainer.append(textLayer);

    spans.forEach((span) => {
        const element = document.createElement('span');
        element.append(span.node);
        stubRect(element, {
            bottom: span.top + span.height,
            height: span.height,
            left: span.left,
            right: span.left + span.width,
            top: span.top,
            width: span.width,
            x: span.left,
            y: span.top,
        });
        textLayer.append(element);
    });

    document.body.append(pageContainer);
    return pageContainer;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('buildRangeFromPageText', () => {
    const line = (text: string) => createPage([{
        height: 20,
        left: 0,
        node: document.createTextNode(text),
        top: 0,
        width: 160,
    }]);

    it('finds text inside and around a search highlight without disturbing it', () => {
        const page = line('Alpha beta');
        const span = page.querySelector<HTMLSpanElement>('.text-layer span')!;
        highlightTextRunInPdfjsStyle({
            kind: 'span',
            span,
            textNode: span.firstChild as Text,
            text: 'Alpha beta',
            startOffset: 0,
            endOffset: 10,
        }, [{
            start: 0,
            end: 5,
            isCurrent: true,
        }], 'highlight', 'selected');
        expect(span.querySelector('.highlight')?.textContent).toBe('Alpha');

        for (const text of [
            'Alpha',
            'beta',
            'pha be',
        ]) {
            const result = buildRangeFromPageText(page, {text});
            expect(result?.range.toString(), text).toBe(text);
            expect(result?.matchedText).toBe(text);
        }
        expect(span.querySelector('.highlight')?.textContent, 'the search result stays').toBe('Alpha');
    });

    it('keeps exact offsets after characters outside the BMP and case folds that lengthen', () => {
        for (const [
            text,
            query,
            expected,
        ] of [
                [
                    '\u{1D49C}lpha beta',
                    'beta',
                    'beta',
                ],
                [
                    '\u{1D49C}lpha beta',
                    '\u{1D49C}lpha',
                    '\u{1D49C}lpha',
                ],
                [
                    '\u0130stanbul beta',
                    'beta',
                    'beta',
                ],
                [
                    '\u0130stanbul beta',
                    '\u0130STANBUL',
                    '\u0130stanbul',
                ],
                [
                    'plain ascii text',
                    'ascii',
                    'ascii',
                ],
            ] as const) {
            document.body.innerHTML = '';
            const result = buildRangeFromPageText(line(text), {text: query});
            expect(result?.range.toString(), `${query} in ${text}`).toBe(expected);
            expect(result?.matchedText).toBe(expected);
        }
    });

    it('matches normalized text across text-layer spans and returns its range', () => {
        const page = createPage([
            {
                height: 20,
                left: 0,
                node: document.createTextNode('Alpha'),
                top: 0,
                width: 40,
            },
            {
                height: 20,
                left: 50,
                node: document.createTextNode('beta'),
                top: 0,
                width: 40,
            },
        ]);

        const result = buildRangeFromPageText(page, {
            text: ' alpha   beta ',
            wholeWord: true,
        });

        expect(result?.matchedText).toBe('Alpha beta');
        expect(result?.range.toString()).toBe('Alphabeta');
    });

    it('honors case and whole-word matching while selecting an occurrence', () => {
        const page = createPage([{
            height: 20,
            left: 0,
            node: document.createTextNode('Catalog catalog'),
            top: 0,
            width: 120,
        }]);

        expect(buildRangeFromPageText(page, {
            text: 'CATALOG',
            caseSensitive: true,
        })).toBeNull();

        const result = buildRangeFromPageText(page, {
            occurrence: 2,
            text: 'catalog',
            wholeWord: true,
        });
        expect(result?.matchedText).toBe('catalog');
        expect(result?.range.toString()).toBe('catalog');

        expect(buildRangeFromPageText(page, {
            text: 'cat',
            wholeWord: true,
        })).toBeNull();
    });
});
