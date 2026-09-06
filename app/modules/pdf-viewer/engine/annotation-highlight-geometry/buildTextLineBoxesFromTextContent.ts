import type {
    IPdfTextContent,
    IPdfTextItem,
    IPdfTextStyle,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import type { ITextLayerTextMapping } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';

export interface ITextLineRun {
    readonly itemIndex: number;
    readonly text: string;
    readonly textDiv: HTMLElement;
    readonly textNode: Text | null;
    readonly rect: IAnnotationMarkerRect;
    readonly baseline: number;
    readonly inlineStart: number;
    readonly inlineEnd: number;
    readonly isVertical: boolean;
    readonly hasEOL: boolean;
}

export interface ITextLineBox {
    readonly runs: readonly ITextLineRun[];
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly baseline: number;
}

export interface IBuildTextLineBoxesFromTextContentOptions {
    readonly textContent: Pick<IPdfTextContent, 'items' | 'styles'>;
    readonly textMapping: ITextLayerTextMapping;
    readonly pageView: readonly number[];
    readonly pageRotation?: TPageRotation;
}

interface IPoint {
    x: number;
    y: number;
}

function isTextItem(item: IPdfTextContent['items'][number]): item is IPdfTextItem {
    return 'str' in item && typeof item.str === 'string';
}

function finiteNumber(value: unknown, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function unitVector(x: number, y: number, fallback: IPoint) {
    const length = Math.hypot(x, y);
    return length > 1e-9
        ? {
            x: x / length,
            y: y / length,
        }
        : fallback;
}

function add(point: IPoint, vector: IPoint, distance: number): IPoint {
    return {
        x: point.x + vector.x * distance,
        y: point.y + vector.y * distance,
    };
}

function firstTextNode(element: HTMLElement): Text | null {
    if (element.firstChild?.nodeType === Node.TEXT_NODE) {
        return element.firstChild as Text;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    return walker.nextNode() as Text | null;
}

function markerPointFromPdfPoint(
    point: IPoint,
    pageView: readonly number[],
    pageRotation: TPageRotation,
) {
    const xMin = pageView[0] ?? 0;
    const yMin = pageView[1] ?? 0;
    const width = (pageView[2] ?? 0) - xMin;
    const height = (pageView[3] ?? 0) - yMin;
    const normX = (point.x - xMin) / width;
    const normY = (point.y - yMin) / height;
    switch (normalizePageRotation(pageRotation)) {
        case 90:
            return {
                x: normY,
                y: normX,
            };
        case 180:
            return {
                x: 1 - normX,
                y: normY,
            };
        case 270:
            return {
                x: 1 - normY,
                y: 1 - normX,
            };
        default:
            return {
                x: normX,
                y: 1 - normY,
            };
    }
}

function lineBoxFromRun(run: ITextLineRun): ITextLineBox {
    return {
        runs: [run],
        left: run.rect.left,
        top: run.rect.top,
        right: run.rect.left + run.rect.width,
        bottom: run.rect.top + run.rect.height,
        baseline: run.baseline,
    };
}

function styleForItem(
    textContent: Pick<IPdfTextContent, 'styles'>,
    item: IPdfTextItem,
): IPdfTextStyle | null {
    return item.fontName ? textContent.styles[item.fontName] ?? null : null;
}

function buildRun(
    item: IPdfTextItem,
    itemIndex: number,
    textDiv: HTMLElement,
    text: string,
    textContent: Pick<IPdfTextContent, 'styles'>,
    pageView: readonly number[],
    pageRotation: TPageRotation,
): ITextLineBox | null {
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) {
        return null;
    }
    const values = transform.slice(0, 6).map(value => finiteNumber(value, Number.NaN));
    if (values.some(value => !Number.isFinite(value))) {
        return null;
    }
    const [
        a,
        b,
        c,
        d,
        e,
        f,
    ] = values as [number, number, number, number, number, number];
    const fontHeight = Math.max(
        Math.hypot(c, d),
        Math.abs(finiteNumber(item.height, 0)),
    );
    if (fontHeight <= 0) {
        return null;
    }
    const style = styleForItem(textContent, item);
    const ascent = finiteNumber(style?.ascent, 0.8);
    const descent = finiteNumber(style?.descent, -0.2);
    const baselineStart = {
        x: e,
        y: f,
    };
    const inlineDirection = unitVector(a, b, {
        x: 1,
        y: 0,
    });
    const crossDirection = unitVector(c, d, {
        x: 0,
        y: 1,
    });
    const width = Math.max(
        Math.abs(finiteNumber(item.width, 0)),
        Math.abs(a) > 0 ? Math.abs(a) * Math.max(1, text.length) : 0,
    );
    if (width <= 0) {
        return null;
    }
    const baselineEnd = add(baselineStart, inlineDirection, width);
    const corners = [
        add(baselineStart, crossDirection, ascent * fontHeight),
        add(baselineEnd, crossDirection, ascent * fontHeight),
        add(baselineStart, crossDirection, descent * fontHeight),
        add(baselineEnd, crossDirection, descent * fontHeight),
    ];
    const normalizedRotation = normalizePageRotation(pageRotation);
    const rect = toMarkerRectFromPdfRect([
        Math.min(...corners.map(point => point.x)),
        Math.min(...corners.map(point => point.y)),
        Math.max(...corners.map(point => point.x)),
        Math.max(...corners.map(point => point.y)),
    ], [...pageView], normalizedRotation);
    if (!rect) {
        return null;
    }
    const baselineMarker = markerPointFromPdfPoint(baselineStart, pageView, normalizedRotation);
    const isVertical = normalizedRotation === 90 || normalizedRotation === 270;
    const isFlowReversed = normalizedRotation === 180 || normalizedRotation === 270;
    const inlineStart = isVertical
        ? isFlowReversed ? rect.top + rect.height : rect.top
        : isFlowReversed ? rect.left + rect.width : rect.left;
    const inlineEnd = isVertical
        ? isFlowReversed ? rect.top : rect.top + rect.height
        : isFlowReversed ? rect.left : rect.left + rect.width;
    const run: ITextLineRun = {
        itemIndex,
        text,
        textDiv,
        textNode: firstTextNode(textDiv),
        rect,
        baseline: Number.isFinite(isVertical ? baselineMarker.x : baselineMarker.y)
            ? isVertical ? baselineMarker.x : baselineMarker.y
            : rect.top + rect.height * ascent / Math.max(0.01, ascent - descent),
        inlineStart,
        inlineEnd,
        isVertical,
        hasEOL: item.hasEOL === true,
    };
    return lineBoxFromRun(run);
}

/**
 * Builds one metric line box per registered text item. PDF.js exposes the
 * text divs and strings separately from the content items, so the text-item
 * counter intentionally advances through empty strings and marked-content
 * entries exactly as TextLayer does.
 */
export function buildTextLineBoxesFromTextContent(
    options: IBuildTextLineBoxesFromTextContentOptions,
): ITextLineBox[] {
    const boxes: ITextLineBox[] = [];
    let itemIndex = 0;
    options.textContent.items.forEach((rawItem) => {
        if (!isTextItem(rawItem)) {
            return;
        }
        const textDiv = options.textMapping.textDivs[itemIndex];
        const mappedText = options.textMapping.textContentItemsStr[itemIndex];
        itemIndex += 1;
        if (!textDiv || !rawItem.str || mappedText === undefined) {
            return;
        }
        const box = buildRun(
            rawItem,
            itemIndex - 1,
            textDiv,
            mappedText,
            options.textContent,
            options.pageView,
            normalizePageRotation(options.pageRotation ?? 0),
        );
        if (box) {
            boxes.push(box);
        }
    });
    return boxes;
}
