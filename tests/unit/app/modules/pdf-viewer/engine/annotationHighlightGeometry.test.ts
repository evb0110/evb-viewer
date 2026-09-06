import type {IPdfTextContent} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import { buildHighlightQuadsFromSelection } from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildHighlightQuadsFromSelection';
import type {
    ITextLineBox,
    ITextLineRun,
} from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildTextLineBoxesFromTextContent';
import { buildTextLineBoxesFromTextContent } from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildTextLineBoxesFromTextContent';
import { mergeLineBoxesOnBaseline } from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/mergeLineBoxesOnBaseline';
import {
    clearTextLayerTextMapping,
    registerTextLayerTextMapping,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import {resolvePdfAnnotationSelectionGeometry} from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfAnnotationSelectionGeometry';
import { subtypeForAnnotationTool } from '@app/modules/pdf-viewer/runtime/sessions/subtypeForAnnotationTool';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import { cast } from '@tests/helpers/cast';

function rect(
    left: number,
    top: number,
    width: number,
    height: number,
) {
    return {
        left,
        top,
        width,
        height,
    };
}

function pageContainer(scale: number) {
    const page = document.createElement('div');
    Object.defineProperty(page, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            left: 0,
            top: 0,
            width: 100 * scale,
            height: 100 * scale,
            right: 100 * scale,
            bottom: 100 * scale,
        }),
    });
    return page;
}

function run(
    page: HTMLElement,
    itemIndex: number,
    text: string,
    left: number,
    top: number,
    width: number,
    baseline = top + 0.03,
    scale = 1,
): ITextLineRun {
    const span = document.createElement('span');
    const textNode = document.createTextNode(text);
    span.append(textNode);
    page.append(span);
    Object.defineProperty(span, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            left: left * 100 * scale,
            top: top * 100 * scale,
            width: width * 100 * scale,
            height: 4 * scale,
            right: (left + width) * 100 * scale,
            bottom: (top * 100 + 4) * scale,
        }),
    });
    return {
        itemIndex,
        text,
        textDiv: span,
        textNode,
        rect: rect(left, top, width, 0.04),
        baseline,
        inlineStart: left,
        inlineEnd: left + width,
        isVertical: false,
        hasEOL: false,
    };
}

function line(...runs: ITextLineRun[]): ITextLineBox {
    return {
        runs,
        left: Math.min(...runs.map(item => item.rect.left)),
        top: Math.min(...runs.map(item => item.rect.top)),
        right: Math.max(...runs.map(item => item.rect.left + item.rect.width)),
        bottom: Math.max(...runs.map(item => item.rect.top + item.rect.height)),
        baseline: runs[0]?.baseline ?? 0,
    };
}

describe('annotation highlight geometry', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('builds metric boxes in text-item order around marked and empty content', () => {
        const firstSpan = document.createElement('span');
        const emptySpan = document.createElement('span');
        const secondSpan = document.createElement('span');
        firstSpan.textContent = 'first';
        secondSpan.textContent = 'second';
        const textContent: IPdfTextContent = {
            items: [
                {
                    str: 'first',
                    dir: 'ltr',
                    transform: [
                        1,
                        0,
                        0,
                        1,
                        10,
                        80,
                    ],
                    width: 25,
                    height: 10,
                    fontName: 'font',
                    hasEOL: false,
                },
                {
                    type: 'beginMarkedContent',
                    id: 'marked',
                },
                {
                    str: '',
                    dir: 'ltr',
                    transform: [
                        1,
                        0,
                        0,
                        1,
                        10,
                        70,
                    ],
                    width: 1,
                    height: 10,
                    fontName: 'font',
                    hasEOL: false,
                },
                {
                    str: 'second',
                    dir: 'ltr',
                    transform: [
                        1,
                        0,
                        0,
                        1,
                        10,
                        60,
                    ],
                    width: 30,
                    height: 10,
                    fontName: 'font',
                    hasEOL: true,
                },
            ],
            styles: {font: {
                ascent: 0.8,
                descent: -0.2,
                vertical: false,
                fontFamily: 'sans-serif',
            }},
            lang: null,
        };

        const boxes = buildTextLineBoxesFromTextContent({
            textContent,
            textMapping: {
                textDivs: [
                    firstSpan,
                    emptySpan,
                    secondSpan,
                ],
                textContentItemsStr: [
                    'mapped first',
                    '',
                    'mapped second',
                ],
            },
            pageView: [
                0,
                0,
                100,
                100,
            ],
            pageRotation: 0,
        });

        expect(boxes).toHaveLength(2);
        expect(boxes.map(box => ({
            itemIndex: box.runs[0]?.itemIndex,
            text: box.runs[0]?.text,
            hasEOL: box.runs[0]?.hasEOL,
        }))).toEqual([
            {
                itemIndex: 0,
                text: 'mapped first',
                hasEOL: false,
            },
            {
                itemIndex: 2,
                text: 'mapped second',
                hasEOL: true,
            },
        ]);
        expect(boxes[0]?.left).toBeGreaterThan(0);
        expect(boxes[1]?.left).toBeGreaterThan(0);
    });

    it('uses the display axes for quarter-turned page text', () => {
        const span = document.createElement('span');
        span.textContent = 'rotated text';
        const textContent: IPdfTextContent = {
            items: [{
                str: 'raw text',
                dir: 'ltr',
                transform: [
                    1,
                    0,
                    0,
                    1,
                    10,
                    20,
                ],
                width: 30,
                height: 10,
                fontName: 'font',
                hasEOL: false,
            }],
            styles: {font: {
                ascent: 0.8,
                descent: -0.2,
                vertical: false,
                fontFamily: 'sans-serif',
            }},
            lang: null,
        };

        const [box] = buildTextLineBoxesFromTextContent({
            textContent,
            textMapping: {
                textDivs: [span],
                textContentItemsStr: ['rotated text'],
            },
            pageView: [
                0,
                0,
                100,
                200,
            ],
            pageRotation: 90,
        });
        const rotatedRun = box?.runs[0];

        expect(rotatedRun).toMatchObject({
            text: 'rotated text',
            isVertical: true,
            baseline: expect.closeTo(0.1, 1e-8),
            inlineStart: expect.closeTo(0.1, 1e-8),
            inlineEnd: expect.closeTo(0.4, 1e-8),
        });
        expect(rotatedRun?.rect).toMatchObject({
            left: expect.closeTo(0.09, 1e-8),
            top: expect.closeTo(0.1, 1e-8),
            width: expect.closeTo(0.05, 1e-8),
            height: expect.closeTo(0.3, 1e-8),
        });
    });

    it('resolves a registered text selection through the document page lease', async () => {
        const viewer = document.createElement('div');
        const page = pageContainer(1);
        page.className = 'page_container';
        page.dataset.page = '1';
        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        const span = document.createElement('span');
        span.textContent = 'selected text';
        textLayer.append(span);
        page.append(textLayer);
        viewer.append(page);
        document.body.append(viewer);
        registerTextLayerTextMapping(textLayer, {
            textDivs: [span],
            textContentItemsStr: ['selected text'],
        });
        onTestFinished(() => clearTextLayerTextMapping(textLayer));

        const range = document.createRange();
        range.selectNodeContents(span);
        expect(range.intersectsNode(textLayer)).toBe(true);
        const textContent: IPdfTextContent = {
            items: [{
                str: 'selected text',
                dir: 'ltr',
                transform: [
                    1,
                    0,
                    0,
                    1,
                    10,
                    80,
                ],
                width: 50,
                height: 10,
                fontName: 'font',
                hasEOL: true,
            }],
            styles: {font: {
                ascent: 0.8,
                descent: -0.2,
                vertical: false,
                fontFamily: 'sans-serif',
            }},
            lang: null,
        };
        const release = vi.fn();
        const getTextContent = vi.fn(async () => textContent);
        const documentSession = cast<TPdfDocumentSession>({
            captureFence: () => ({
                loadToken: 1,
                documentVersion: 1,
                documentRevision: 'test',
                openSurfaceGeneration: 1,
            }),
            isCurrent: vi.fn(() => true),
            leasePage: vi.fn(async () => ({
                page: cast({
                    view: [
                        0,
                        0,
                        100,
                        100,
                    ],
                    rotate: 0,
                    getTextContent,
                }),
                release,
            })),
        });

        const result = await resolvePdfAnnotationSelectionGeometry({
            documentSession,
            viewerContainer: viewer,
            range,
        });

        expect(result.status).toBe('ready');
        if (result.status === 'ready') {
            expect(result.pages).toHaveLength(1);
            expect(result.pages[0]?.selectedText).toBe('selected text');
            expect(result.pages[0]?.quadPoints).toHaveLength(1);
        }
        expect(getTextContent).toHaveBeenCalledWith({
            includeMarkedContent: true,
            disableNormalization: true,
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('maps every text-markup tool to its PDF subtype', () => {
        expect(subtypeForAnnotationTool('highlight')).toBe('Highlight');
        expect(subtypeForAnnotationTool('underline')).toBe('Underline');
        expect(subtypeForAnnotationTool('strikethrough')).toBe('StrikeOut');
        expect(subtypeForAnnotationTool('squiggly')).toBe('Squiggly');
    });

    it('merges adjacent runs on one baseline but keeps separate lines', () => {
        const page = pageContainer(1);
        const first = run(page, 0, 'Hello', 0.1, 0.1, 0.2);
        const second = run(page, 1, ' world', 0.31, 0.1, 0.25);
        const nextLine = run(page, 2, 'Next', 0.1, 0.2, 0.2, 0.23);

        const merged = mergeLineBoxesOnBaseline([
            line(nextLine),
            line(second),
            line(first),
        ]);

        expect(merged).toHaveLength(2);
        expect(merged[0]?.runs.map(item => item.text)).toEqual([
            'Hello',
            ' world',
        ]);
        expect(merged[1]?.runs.map(item => item.text)).toEqual(['Next']);
    });

    it('uses span metrics only for partial horizontal endpoints and splits by page', () => {
        const firstPage = pageContainer(1);
        const secondPage = pageContainer(1);
        document.body.append(firstPage, secondPage);
        const firstRun = run(firstPage, 0, 'first line', 0.1, 0.1, 0.6);
        const secondRun = run(firstPage, 1, 'second line', 0.1, 0.2, 0.6, 0.23);
        const thirdRun = run(secondPage, 0, 'other page', 0.2, 0.1, 0.5);

        const range = document.createRange();
        range.setStart(firstRun.textNode!, 2);
        range.setEnd(thirdRun.textNode!, 5);

        const geometry = buildHighlightQuadsFromSelection(range, [
            {
                pageNumber: 1,
                pageContainer: firstPage,
                lineBoxes: [
                    line(firstRun),
                    line(secondRun),
                ],
            },
            {
                pageNumber: 2,
                pageContainer: secondPage,
                lineBoxes: [line(thirdRun)],
            },
        ]);

        expect(geometry).toHaveLength(2);
        expect(geometry[0]?.selectedText).toBe('rst line second line');
        expect(geometry[0]?.quadPoints).toHaveLength(2);
        expect(geometry[0]?.quadPoints[0]).toMatchObject({
            left: expect.closeTo(0.22, 1e-8),
            top: expect.closeTo(0.1, 1e-8),
            width: expect.closeTo(0.48, 1e-8),
            height: expect.closeTo(0.04, 1e-8),
        });
        expect(geometry[0]?.quadPoints[1]).toMatchObject({
            left: expect.closeTo(0.1, 1e-8),
            top: expect.closeTo(0.2, 1e-8),
            width: expect.closeTo(0.6, 1e-8),
            height: expect.closeTo(0.04, 1e-8),
        });
        expect(geometry[1]?.selectedText).toBe('other');
    });

    it('keeps authored geometry stable when the page is rendered at another scale', () => {
        const firstPage = pageContainer(1);
        const scaledPage = pageContainer(2);
        const firstRun = run(firstPage, 0, 'scaled text', 0.1, 0.1, 0.6, 0.13, 1);
        const scaledRun = run(scaledPage, 0, 'scaled text', 0.1, 0.1, 0.6, 0.13, 2);

        const makeRange = (textNode: Text) => {
            const range = document.createRange();
            range.setStart(textNode, 1);
            range.setEnd(textNode, textNode.length - 1);
            return range;
        };
        const firstGeometry = buildHighlightQuadsFromSelection(makeRange(firstRun.textNode!), [{
            pageNumber: 1,
            pageContainer: firstPage,
            lineBoxes: [line(firstRun)],
        }]);
        const scaledGeometry = buildHighlightQuadsFromSelection(makeRange(scaledRun.textNode!), [{
            pageNumber: 1,
            pageContainer: scaledPage,
            lineBoxes: [line(scaledRun)],
        }]);

        expect(scaledGeometry).toEqual(firstGeometry);
    });
});
