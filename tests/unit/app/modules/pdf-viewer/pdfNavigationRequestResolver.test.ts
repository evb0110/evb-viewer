import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import {
    isPdfNavigationReady,
    resolvePdfNavigationAnchor,
    resolvePdfNavigationTarget,
    resolveTextAnchorRect,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';
import type { IPdfNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';

function request(overrides: Partial<IPdfNavigationRequest> = {}): IPdfNavigationRequest {
    return {
        target: {
            kind: 'page',
            page: 2,
        },
        alignment: 'page-top',
        readiness: 'page-canvas',
        source: 'toolbar',
        supersession: 'latest-wins',
        ...overrides,
    };
}

describe('PDF navigation request resolver', () => {
    it.each([
        [
            'toolbar',
            'page',
        ],
        [
            'wheel',
            'page',
        ],
        [
            'search',
            'text-anchor',
        ],
        [
            'bookmark',
            'named-dest',
        ],
        [
            'annotation',
            'rect',
        ],
        [
            'thumbnail',
            'page',
        ],
        [
            'activation',
            'page',
        ],
        [
            'restore',
            'page',
        ],
    ] as const)('preserves the %s source while resolving a %s target', async (source, kind) => {
        const targets = {
            page: {
                kind: 'page',
                page: 2,
            },
            rect: {
                kind: 'rect',
                page: 2,
                rect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.4,
                },
            },
            'text-anchor': {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
            },
            'named-dest': {
                kind: 'named-dest',
                destination: [1] as unknown[],
            },
        } as const;
        const pdfDocument = cast<IPdfDocument>({
            numPages: 3,
            getDestination: vi.fn(async () => null),
            getPageIndex: vi.fn(async () => 1),
            getPage: vi.fn(),
        });
        const navigation = request({
            source,
            target: targets[kind],
        });
        const resolved = await resolvePdfNavigationTarget(navigation.target, pdfDocument);
        expect(navigation.source).toBe(source);
        expect(resolved.page).toBe(2);
    });

    it('resolves page-top and rect-center alignments deterministically', () => {
        const target = {
            page: 4,
            rect: {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.2,
            },
        };
        expect(resolvePdfNavigationAnchor(request({alignment: 'page-top'}), target)).toMatchObject({
            page: 4,
            pageYFraction: 0.3,
            viewportYFraction: 0,
            affinity: 'start',
        });
        expect(resolvePdfNavigationAnchor(request({alignment: 'rect-center'}), target)).toMatchObject({
            page: 4,
            pageXFraction: 0.4,
            pageYFraction: 0.4,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        });
    });

    it('resolves a text anchor to normalized page geometry', () => {
        const span = cast<HTMLElement>({
            textContent: 'prefix needle suffix',
            getBoundingClientRect: () => cast<DOMRect>({
                left: 30,
                top: 50,
                width: 20,
                height: 10,
            }),
        });
        const textLayer = cast<HTMLElement>({querySelectorAll: () => [span]});
        const page = cast<HTMLElement>({
            getBoundingClientRect: () => cast<DOMRect>({
                left: 10,
                top: 10,
                width: 100,
                height: 200,
            }),
            querySelector: () => textLayer,
        });
        const container = cast<HTMLElement>({querySelector: () => page});
        expect(resolveTextAnchorRect(container, {
            kind: 'text-anchor',
            page: 2,
            text: 'needle',
            prefix: 'prefix ',
            suffix: ' suffix',
        })).toEqual({
            left: 0.2,
            top: 0.2,
            width: 0.2,
            height: 0.05,
        });
    });

    it('resolves the requested duplicate occurrence from its canonical search range', () => {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = '2';
        page.getBoundingClientRect = () => cast<DOMRect>({
            left: 10,
            top: 10,
            width: 100,
            height: 200,
        });

        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const first = document.createElement('span');
        first.textContent = 'first needle ';
        const second = document.createElement('span');
        second.textContent = 'second needle';
        textLayer.append(first, second);
        page.append(textLayer);
        const container = document.createElement('div');
        container.append(page);

        const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = vi.fn(function (this: Range) {
            return cast<DOMRect>(this.startContainer === second.firstChild
                ? {
                    left: 50,
                    top: 110,
                    width: 20,
                    height: 10,
                }
                : {
                    left: 30,
                    top: 50,
                    width: 20,
                    height: 10,
                });
        });

        try {
            expect(resolveTextAnchorRect(container, {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
                searchRange: {
                    startOffset: 'first needle '.length + 'second '.length,
                    endOffset: 'first needle '.length + 'second needle'.length,
                },
            })).toEqual({
                left: 0.4,
                top: 0.5,
                width: 0.2,
                height: 0.05,
            });

        } finally {
            Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it('prefers the page-local occurrence over a drifted identical canonical range', () => {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = '2';
        page.getBoundingClientRect = () => cast<DOMRect>({
            left: 10,
            top: 10,
            width: 100,
            height: 200,
        });

        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const first = document.createElement('span');
        first.textContent = 'first needle ';
        const second = document.createElement('span');
        second.textContent = 'second needle';
        textLayer.append(first, second);
        page.append(textLayer);
        const container = document.createElement('div');
        container.append(page);

        const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = vi.fn(function (this: Range) {
            return cast<DOMRect>(this.startContainer === second.firstChild
                ? {
                    left: 50,
                    top: 110,
                    width: 20,
                    height: 10,
                }
                : {
                    left: 30,
                    top: 50,
                    width: 20,
                    height: 10,
                });
        });

        try {
            expect(resolveTextAnchorRect(container, {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
                pageMatchIndex: 1,
                searchQuery: 'needle',
                expectedPageMatchCount: 2,
                searchOptions: {
                    matchCase: false,
                    wholeWord: false,
                    useRegex: false,
                },
                // This canonical range has drifted to the first duplicate.
                searchRange: {
                    startOffset: 'first '.length,
                    endOffset: 'first needle'.length,
                },
            })).toEqual({
                left: 0.4,
                top: 0.5,
                width: 0.2,
                height: 0.05,
            });

        } finally {
            Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it('uses the case-sensitive indexed occurrence when the canonical range has the wrong case', () => {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = '2';
        page.getBoundingClientRect = () => cast<DOMRect>({
            left: 10,
            top: 10,
            width: 100,
            height: 200,
        });

        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const first = document.createElement('span');
        first.textContent = 'needle first';
        const second = document.createElement('span');
        second.textContent = 'Needle second';
        textLayer.append(first, second);
        page.append(textLayer);
        const container = document.createElement('div');
        container.append(page);

        const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = vi.fn(function (this: Range) {
            return cast<DOMRect>(this.startContainer === second.firstChild
                ? {
                    left: 50,
                    top: 110,
                    width: 20,
                    height: 10,
                }
                : {
                    left: 30,
                    top: 50,
                    width: 20,
                    height: 10,
                });
        });

        try {
            expect(resolveTextAnchorRect(container, {
                kind: 'text-anchor',
                page: 2,
                text: 'Needle',
                pageMatchIndex: 1,
                searchQuery: '[nN]eedle',
                searchOptions: {
                    matchCase: true,
                    wholeWord: false,
                    useRegex: true,
                },
                expectedPageMatchCount: 2,
                // The native range drifted onto the lowercase duplicate.
                searchRange: {
                    startOffset: 0,
                    endOffset: 'needle'.length,
                },
            })).toEqual({
                left: 0.4,
                top: 0.5,
                width: 0.2,
                height: 0.05,
            });
        } finally {
            Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it('falls back to a matching canonical range when the page-local index is unmappable', () => {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = '2';
        page.getBoundingClientRect = () => cast<DOMRect>({
            left: 10,
            top: 10,
            width: 100,
            height: 200,
        });

        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const first = document.createElement('span');
        first.textContent = 'first needle ';
        const second = document.createElement('span');
        second.textContent = 'second needle';
        textLayer.append(first, second);
        page.append(textLayer);
        const container = document.createElement('div');
        container.append(page);

        const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = vi.fn(function (this: Range) {
            return cast<DOMRect>(this.startContainer === second.firstChild
                ? {
                    left: 50,
                    top: 110,
                    width: 20,
                    height: 10,
                }
                : {
                    left: 30,
                    top: 50,
                    width: 20,
                    height: 10,
                });
        });

        try {
            expect(resolveTextAnchorRect(container, {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
                pageMatchIndex: 2,
                searchQuery: 'needle',
                searchOptions: {
                    matchCase: false,
                    wholeWord: false,
                    useRegex: false,
                },
                searchRange: {
                    startOffset: 'first '.length,
                    endOffset: 'first needle'.length,
                },
            })).toEqual({
                left: 0.2,
                top: 0.2,
                width: 0.2,
                height: 0.05,
            });
        } finally {
            Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it('keeps the canonical range when the rendered occurrence count mismatches', () => {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = '2';
        page.getBoundingClientRect = () => cast<DOMRect>({
            left: 10,
            top: 10,
            width: 100,
            height: 200,
        });

        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const first = document.createElement('span');
        first.textContent = 'needle first';
        const second = document.createElement('span');
        second.textContent = 'needle second';
        const third = document.createElement('span');
        third.textContent = 'needle third';
        textLayer.append(first, second, third);
        page.append(textLayer);
        const container = document.createElement('div');
        container.append(page);

        const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = vi.fn(function (this: Range) {
            return cast<DOMRect>(this.startContainer === second.firstChild
                ? {
                    left: 50,
                    top: 110,
                    width: 20,
                    height: 10,
                }
                : {
                    left: 30,
                    top: 50,
                    width: 20,
                    height: 10,
                });
        });

        try {
            expect(resolveTextAnchorRect(container, {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
                pageMatchIndex: 0,
                searchQuery: 'needle',
                searchOptions: {
                    matchCase: false,
                    wholeWord: false,
                    useRegex: false,
                },
                expectedPageMatchCount: 2,
                searchRange: {
                    startOffset: 'needle first '.length,
                    endOffset: 'needle first '.length + 'needle'.length,
                },
            })).toEqual({
                left: 0.4,
                top: 0.5,
                width: 0.2,
                height: 0.05,
            });

            // Count mismatch must not disable the legacy occurrence fallback
            // when the native range cannot map at all.
            expect(resolveTextAnchorRect(container, {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
                pageMatchIndex: 1,
                searchQuery: 'needle',
                expectedPageMatchCount: 2,
                searchRange: {
                    startOffset: 500,
                    endOffset: 506,
                },
            })).toEqual({
                left: 0.4,
                top: 0.5,
                width: 0.2,
                height: 0.05,
            });
        } finally {
            Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it('uses the page-local occurrence when native offsets do not fit the text layer', () => {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = '2';
        page.getBoundingClientRect = () => cast<DOMRect>({
            left: 10,
            top: 10,
            width: 100,
            height: 200,
        });

        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const first = document.createElement('span');
        first.textContent = 'needle first';
        const second = document.createElement('span');
        second.textContent = 'needle second';
        const third = document.createElement('span');
        third.textContent = 'needle third';
        textLayer.append(first, second, third);
        page.append(textLayer);
        const container = document.createElement('div');
        container.append(page);

        const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
        Range.prototype.getBoundingClientRect = vi.fn(function (this: Range) {
            return cast<DOMRect>(this.startContainer === second.firstChild
                ? {
                    left: 50,
                    top: 110,
                    width: 20,
                    height: 10,
                }
                : {
                    left: 30,
                    top: 50,
                    width: 20,
                    height: 10,
                });
        });

        try {
            expect(resolveTextAnchorRect(container, {
                kind: 'text-anchor',
                page: 2,
                text: 'needle',
                pageMatchIndex: 1,
                searchQuery: 'needle',
                searchOptions: {
                    matchCase: false,
                    wholeWord: false,
                    useRegex: false,
                },
                searchRange: {
                    startOffset: 500,
                    endOffset: 506,
                },
            })).toEqual({
                left: 0.4,
                top: 0.5,
                width: 0.2,
                height: 0.05,
            });
        } finally {
            Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        }
    });

    it.each([
        [
            'metrics',
            true,
        ],
        [
            'page-canvas',
            true,
        ],
        [
            'text-layer',
            false,
        ],
        [
            'annotation-editor',
            true,
        ],
    ] as const)('honors %s readiness', (readiness, expected) => {
        const page = cast<HTMLElement>({querySelector: (selector: string) => selector.includes('text') || selector.includes('annotation') ? {} : null});
        const container = cast<HTMLElement>({querySelector: () => page});
        expect(isPdfNavigationReady(container, 2, readiness, () => true)).toBe(expected);
    });

    it('requires the renderer readiness marker before using a text layer', () => {
        const textLayer = {dataset: {pdfTextLayerReady: 'true'}};
        const page = cast<HTMLElement>({querySelector: () => textLayer});
        const container = cast<HTMLElement>({querySelector: () => page});
        expect(isPdfNavigationReady(container, 2, 'text-layer', () => true)).toBe(true);
    });
});
