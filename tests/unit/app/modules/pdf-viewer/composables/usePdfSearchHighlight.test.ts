// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import { buildVisualMatchesWithCurrent } from '@app/modules/pdf-viewer/engine/search/buildVisualMatchesWithCurrent';
import { usePdfSearchHighlight } from '@app/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight';
import {
    clearTextLayerTextMapping,
    createTextLayerRangeForSearchMatch,
    createTextLayerRangeForSearchOccurrence,
    getCachedTextLayerIndex,
    highlightTextRunInPdfjsStyle,
    registerTextLayerTextMapping,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import { requirePageIndex } from '@contracts/pageNumbers';
import { assembleSearchablePageText } from '@pdf-core';

describe('usePdfSearchHighlight', () => {
    it('keeps backend identity instead of re-finding matches in the rendered layer', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            searchOptions: {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            matches: [
                {
                    matchIndex: 0,
                    start: 11,
                    end: 16,
                },
                {
                    matchIndex: 1,
                    start: 0,
                    end: 5,
                },
            ],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 1,
            matchIndex: 1,
            startOffset: 0,
            endOffset: 5,
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, currentMatch, 'alpha beta alpha');

        expect(result).toEqual([
            {
                start: 11,
                end: 16,
                isCurrent: false,
            },
            {
                start: 0,
                end: 5,
                isCurrent: true,
            },
        ]);
    });

    it('keeps compatible backend offsets instead of adding extra local matches', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            matches: [{
                matchIndex: 0,
                start: 0,
                end: 5,
            }],
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, null, 'alpha beta alpha');

        expect(result).toEqual([{
            start: 0,
            end: 5,
            isCurrent: false,
        }]);
    });

    it('reconciles backend ranges with the rendered layer before selecting the current occurrence', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            searchOptions: {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            matches: [
                {
                    matchIndex: 10,
                    start: 100,
                    end: 105,
                },
                {
                    matchIndex: 11,
                    start: 12,
                    end: 17,
                },
            ],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 1,
            matchIndex: 11,
            startOffset: 12,
            endOffset: 17,
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, currentMatch, 'alpha alpha alpha');

        expect(result).toEqual([
            {
                start: 0,
                end: 5,
                isCurrent: false,
            },
            {
                start: 6,
                end: 11,
                isCurrent: false,
            },
            {
                start: 12,
                end: 17,
                isCurrent: true,
            },
        ]);
    });

    it('maps rendered-layer fallback matches back to raw text-run offsets', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'Lezgian',
            matches: [{
                matchIndex: 0,
                start: 100,
                end: 107,
            }],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 100,
            endOffset: 107,
        };
        const assembledLayerText = assembleSearchablePageText([
            {text: 'prefix'},
            {text: 'Lezgian'},
        ]);

        expect(buildVisualMatchesWithCurrent(
            pageMatches,
            currentMatch,
            'prefixLezgian',
            assembledLayerText,
        )).toEqual([{
            start: 6,
            end: 13,
            isCurrent: true,
        }]);
    });

    it('rejects in-bounds backend offsets that point at different rendered text', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'Lezgian',
            matches: [{
                matchIndex: 0,
                start: 0,
                end: 7,
            }],
        };
        const assembledLayerText = assembleSearchablePageText([
            {text: 'prefix'},
            {text: 'Lezgian'},
        ]);

        expect(buildVisualMatchesWithCurrent(
            pageMatches,
            null,
            'prefixLezgian',
            assembledLayerText,
        )).toEqual([{
            start: 6,
            end: 13,
            isCurrent: false,
        }]);
    });

    it('keeps the page-local current occurrence when equal-count native offsets drift', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'needle',
            matches: [
                {
                    matchIndex: 0,
                    start: 8,
                    end: 14,
                },
                {
                    matchIndex: 1,
                    start: 15,
                    end: 21,
                },
            ],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 8,
            endOffset: 14,
        };

        expect(buildVisualMatchesWithCurrent(
            pageMatches,
            currentMatch,
            'needle prefix needle extra',
        )).toEqual([
            {
                start: 0,
                end: 6,
                isCurrent: true,
            },
            {
                start: 14,
                end: 20,
                isCurrent: false,
            },
        ]);
    });

    it('does not preserve backend identity after falling back from shifted reversed ranges', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            matches: [
                {
                    matchIndex: 10,
                    start: 12,
                    end: 17,
                },
                {
                    matchIndex: 11,
                    start: 1,
                    end: 6,
                },
            ],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 0,
            matchIndex: 10,
            startOffset: 12,
            endOffset: 17,
        };

        expect(buildVisualMatchesWithCurrent(
            pageMatches,
            currentMatch,
            'alpha beta alpha',
        )).toEqual([
            {
                start: 0,
                end: 5,
                isCurrent: false,
            },
            {
                start: 11,
                end: 16,
                isCurrent: true,
            },
        ]);
    });

    it('requires distinct rendered occurrences for duplicate backend ranges', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            matches: [
                {
                    matchIndex: 0,
                    start: 0,
                    end: 5,
                },
                {
                    matchIndex: 1,
                    start: 0,
                    end: 5,
                },
            ],
        };

        expect(buildVisualMatchesWithCurrent(
            pageMatches,
            null,
            'alpha beta alpha',
        )).toEqual([
            {
                start: 0,
                end: 5,
                isCurrent: false,
            },
            {
                start: 11,
                end: 16,
                isCurrent: false,
            },
        ]);
    });

    it('maps collapsed fake-bold text to one authoritative highlight set', () => {
        const segment = 'alpha beta gamma delta '.repeat(8);
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: segment,
            searchQuery: 'alpha',
            matches: [{
                matchIndex: 0,
                start: 0,
                end: 5,
            }],
        };

        expect(buildVisualMatchesWithCurrent(pageMatches, null, segment.repeat(2))).toEqual([{
            start: 0,
            end: 5,
            isCurrent: false,
        }]);
    });
});

describe('pdfSearchHighlightDom text-layer mapping', () => {
    it('preserves positioned text spans inside PDF.js marked-content wrappers', () => {
        const textLayer = document.createElement('div');
        const markedContent = document.createElement('span');
        markedContent.className = 'markedContent';
        const prefixSpan = document.createElement('span');
        prefixSpan.textContent = 'prefix';
        const matchSpan = document.createElement('span');
        matchSpan.textContent = 'Lezgian';
        markedContent.append(prefixSpan, matchSpan);
        textLayer.append(markedContent);
        registerTextLayerTextMapping(textLayer, {
            textDivs: [
                prefixSpan,
                matchSpan,
            ],
            textContentItemsStr: [
                'prefix',
                'Lezgian',
            ],
        });
        const index = getCachedTextLayerIndex(textLayer);
        expect(index.runs).toHaveLength(2);
        expect(index.runs.every(run => run.kind === 'span' && run.textNode !== null)).toBe(true);

        const highlight = usePdfSearchHighlight();
        highlight.highlightPage(textLayer, {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'Lezgian',
            matches: [{
                matchIndex: 0,
                start: 6,
                end: 13,
            }],
        }, null);

        expect(markedContent.children).toHaveLength(2);
        expect(markedContent.firstElementChild).toBe(prefixSpan);
        expect(markedContent.lastElementChild).toBe(matchSpan);
        expect(matchSpan.querySelector('.pdf-search-highlight')?.textContent).toBe('Lezgian');
    });

    it('uses pdf.js text mapping instead of reconstructed span text', () => {
        const textLayer = document.createElement('div');
        const span = document.createElement('span');
        span.textContent = 'mutated';
        textLayer.append(span);

        registerTextLayerTextMapping(textLayer, {
            textDivs: [span],
            textContentItemsStr: ['canonical'],
        });

        const index = getCachedTextLayerIndex(textLayer);

        expect(index.text).toBe('canonical');
        expect(index.runs[0]).toMatchObject({
            kind: 'span',
            startOffset: 0,
            endOffset: 9,
        });

        clearTextLayerTextMapping(textLayer);
    });

    it('keeps text-layer line breaks in the search offset domain', () => {
        const textLayer = document.createElement('div');
        const first = document.createElement('span');
        const second = document.createElement('span');
        first.textContent = 'first';
        second.textContent = 'second';
        textLayer.append(first, document.createElement('br'), second);

        registerTextLayerTextMapping(textLayer, {
            textDivs: [
                first,
                second,
            ],
            textContentItemsStr: [
                'first',
                'second',
            ],
        });

        const index = getCachedTextLayerIndex(textLayer);

        expect(index.text).toBe('first\nsecond');
        expect(index.runs.map(run => ({
            kind: run.kind,
            startOffset: run.startOffset,
            endOffset: run.endOffset,
        }))).toEqual([
            {
                kind: 'span',
                startOffset: 0,
                endOffset: 5,
            },
            {
                kind: 'br',
                startOffset: 5,
                endOffset: 6,
            },
            {
                kind: 'span',
                startOffset: 6,
                endOffset: 12,
            },
        ]);

        clearTextLayerTextMapping(textLayer);
    });

    it('paints highlights as pdf.js-style inline spans inside mapped text divs', () => {
        const span = document.createElement('span');
        span.textContent = 'stale';
        const textNode = document.createTextNode('canonical');
        span.replaceChildren(textNode);

        const elements = highlightTextRunInPdfjsStyle(
            {
                kind: 'span',
                span,
                textNode,
                text: 'canonical',
                startOffset: 0,
                endOffset: 9,
            },
            [{
                start: 0,
                end: 5,
                isCurrent: true,
            }],
            'pdf-search-highlight',
            'pdf-search-highlight--current',
        );

        expect(elements).toHaveLength(1);
        expect(elements[0]?.tagName).toBe('SPAN');
        expect(elements[0]?.className).toBe('pdf-search-highlight appended pdf-search-highlight--current');
        expect(span.querySelector('mark')).toBeNull();
        expect(span.textContent).toBe('canonical');
    });

    it('rebuilds a root text span after nested highlight spans were inserted', () => {
        const textLayer = document.createElement('div');
        const span = document.createElement('span');
        span.textContent = 'prefix needle suffix';
        textLayer.append(span);
        registerTextLayerTextMapping(textLayer, {
            textDivs: [span],
            textContentItemsStr: ['prefix needle suffix'],
        });

        const initialIndex = getCachedTextLayerIndex(textLayer);
        const initialRun = initialIndex.runs[0];
        if (!initialRun || initialRun.kind !== 'span') {
            throw new Error('Expected the fixture text span to produce a span run');
        }
        highlightTextRunInPdfjsStyle(
            initialRun,
            [{
                start: 7,
                end: 13,
                isCurrent: true,
            }],
            'pdf-search-highlight',
            'pdf-search-highlight--current',
        );

        const rebuiltIndex = getCachedTextLayerIndex(textLayer);
        expect(rebuiltIndex.text).toBe('prefix needle suffix');
        const range = createTextLayerRangeForSearchMatch(textLayer, {
            startOffset: 7,
            endOffset: 13,
        });
        expect(range?.toString()).toBe('needle');

        clearTextLayerTextMapping(textLayer);
    });

    it.each([
        'اللغة العربية',
        'fragmented words',
    ])('highlights and navigates whole and fragmented occurrences for %s', (text) => {
        const textLayer = document.createElement('div');
        const items = [
            text,
            '\n',
            ...Array.from(text),
        ];
        const pageText = items.join('');
        const spans = items.map((character) => {
            const span = document.createElement('span');
            span.textContent = character;
            textLayer.append(span);
            return span;
        });
        registerTextLayerTextMapping(textLayer, {
            textDivs: spans,
            textContentItemsStr: items,
        });
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText,
            searchQuery: text,
            matches: [
                {
                    matchIndex: 0,
                    start: 0,
                    end: text.length,
                },
                {
                    matchIndex: 1,
                    start: text.length + 1,
                    end: pageText.length,
                },
            ],
        };
        const result = usePdfSearchHighlight().highlightPage(textLayer, pageMatches, {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 1,
            matchIndex: 1,
            startOffset: text.length + 1,
            endOffset: pageText.length,
        });
        expect(result.currentMatchElements.map(element => element.textContent).join('')).toBe(text);
        expect(createTextLayerRangeForSearchOccurrence(textLayer, {
            text,
            searchQuery: text,
            pageMatchIndex: 1,
            expectedPageMatchCount: 2,
        })?.toString()).toBe(text);
        expect(textLayer.textContent).toBe(pageText);
    });

    it('preserves word-separated occurrences when contiguous text contains fewer matches', () => {
        const textLayer = document.createElement('div');
        const words = [
            'foo ',
            'bar',
            'foo',
        ];
        const spans = words.map((text) => {
            const span = document.createElement('span');
            span.textContent = text;
            textLayer.append(span);
            return span;
        });
        registerTextLayerTextMapping(textLayer, {
            textDivs: spans,
            textContentItemsStr: words,
        });
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: 'foo bar foo',
            searchQuery: 'foo',
            searchOptions: {wholeWord: true},
            matches: [
                {
                    matchIndex: 0,
                    start: 0,
                    end: 3,
                },
                {
                    matchIndex: 1,
                    start: 8,
                    end: 11,
                },
            ],
        };
        const result = usePdfSearchHighlight().highlightPage(textLayer, pageMatches, null);
        expect(result.elements.map(element => element.textContent)).toEqual([
            'foo',
            'foo',
        ]);
        expect(createTextLayerRangeForSearchOccurrence(textLayer, {
            text: 'foo',
            searchOptions: {wholeWord: true},
            pageMatchIndex: 1,
            expectedPageMatchCount: 2,
        })?.toString()).toBe('foo');
    });

    it('marks multi-div highlights with pdf.js begin and end segment classes', () => {
        const first = document.createElement('span');
        const second = document.createElement('span');
        const firstTextNode = document.createTextNode('alpha');
        const secondTextNode = document.createTextNode('beta');
        first.append(firstTextNode);
        second.append(secondTextNode);
        const match = {
            start: 2,
            end: 8,
            isCurrent: false,
        };

        const firstHighlights = highlightTextRunInPdfjsStyle(
            {
                kind: 'span',
                span: first,
                textNode: firstTextNode,
                text: 'alpha',
                startOffset: 0,
                endOffset: 5,
            },
            [match],
            'pdf-search-highlight',
            'pdf-search-highlight--current',
        );
        const secondHighlights = highlightTextRunInPdfjsStyle(
            {
                kind: 'span',
                span: second,
                textNode: secondTextNode,
                text: 'beta',
                startOffset: 5,
                endOffset: 9,
            },
            [match],
            'pdf-search-highlight',
            'pdf-search-highlight--current',
        );

        expect(firstHighlights[0]?.className).toBe('pdf-search-highlight appended begin');
        expect(secondHighlights[0]?.className).toBe('pdf-search-highlight appended end');
    });
});
