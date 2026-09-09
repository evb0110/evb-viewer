import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { clamp01 } from '@app/modules/pdf-viewer/engine/annotation-geometry/clamp01';
import { toCanonicalTextMarkupGeometry } from '@app/modules/pdf-viewer/engine/annotation-geometry/canonicalTextMarkupGeometry';
import type {
    ITextLineBox,
    ITextLineRun,
} from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/buildTextLineBoxesFromTextContent';
import {
    ADJACENT_RUN_GAP,
    BASELINE_TOLERANCE,
} from '@app/modules/pdf-viewer/engine/annotation-highlight-geometry/mergeLineBoxesOnBaseline';

export interface IHighlightSelectionPage {
    readonly pageNumber: number;
    readonly pageContainer: HTMLElement;
    readonly lineBoxes: readonly ITextLineBox[];
}

export interface IHighlightPageGeometry {
    readonly pageNumber: number;
    readonly quadPoints: readonly IAnnotationMarkerRect[];
    readonly selectedText: string;
}

interface ISelectedRun {
    readonly run: ITextLineRun;
    readonly node: Text;
    readonly nodeStart: number;
    readonly nodeEnd: number;
    readonly textStart: number;
    readonly textEnd: number;
}

interface INormalizedSelectionExtent {
    readonly inlineStart: number;
    readonly inlineEnd: number;
    readonly crossStart: number | null;
    readonly crossEnd: number | null;
}

function boundaryOffset(
    node: Text,
    length: number,
    container: Node,
    offset: number,
    isStart: boolean,
) {
    if (container === node) {
        return Math.max(0, Math.min(length, offset));
    }
    return isStart ? 0 : length;
}

function selectedOffsets(range: Range, run: ITextLineRun) {
    const textNodes = run.textNodes.length > 0
        ? run.textNodes
        : run.textNode ? [run.textNode] : [];
    let textOffset = 0;
    return textNodes.flatMap((node) => {
        const length = node.length;
        const nodeTextStart = textOffset;
        textOffset += length;
        if (length <= 0
            || !range.intersectsNode(node)
            || range.comparePoint(node, length) < 0
            || range.comparePoint(node, 0) > 0) {
            return [];
        }
        const nodeStart = boundaryOffset(node, length, range.startContainer, range.startOffset, true);
        const nodeEnd = boundaryOffset(node, length, range.endContainer, range.endOffset, false);
        return nodeEnd > nodeStart ? [{
            node,
            nodeStart,
            nodeEnd,
            textStart: nodeTextStart + nodeStart,
            textEnd: nodeTextStart + nodeEnd,
        }] : [];
    });
}

function pageRectFor(pageContainer: HTMLElement) {
    const rect = pageContainer.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
}

function normalizedSelectionExtent(
    selected: ISelectedRun,
    pageRect: ReturnType<typeof pageRectFor>,
): INormalizedSelectionExtent {
    const selectedRange = document.createRange();
    selectedRange.setStart(selected.node, selected.nodeStart);
    selectedRange.setEnd(selected.node, selected.nodeEnd);
    const clientRects = Array.from(selectedRange.getClientRects?.() ?? [])
        .filter(rect => rect.width > 0 && rect.height > 0);
    if (clientRects.length > 0 && pageRect) {
        const isVertical = selected.run.isVertical;
        const normalizedRects = clientRects.map(rect => {
            const left = clamp01((rect.left - pageRect.left) / pageRect.width);
            const right = clamp01(((rect.right ?? rect.left + rect.width) - pageRect.left) / pageRect.width);
            const top = clamp01((rect.top - pageRect.top) / pageRect.height);
            const bottom = clamp01(((rect.bottom ?? rect.top + rect.height) - pageRect.top) / pageRect.height);
            return {
                left,
                right,
                top,
                bottom,
            };
        }).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
        if (normalizedRects.length > 0) {
            return {
                inlineStart: Math.min(...normalizedRects.map(rect => isVertical ? rect.top : rect.left)),
                inlineEnd: Math.max(...normalizedRects.map(rect => isVertical ? rect.bottom : rect.right)),
                crossStart: Math.min(...normalizedRects.map(rect => isVertical ? rect.left : rect.top)),
                crossEnd: Math.max(...normalizedRects.map(rect => isVertical ? rect.right : rect.bottom)),
            };
        }
    }
    const fullRect = selected.run.textDiv.getBoundingClientRect();
    if (fullRect.width > 0 && fullRect.height > 0 && pageRect) {
        const isVertical = selected.run.isVertical;
        const fullStart = isVertical ? fullRect.top : fullRect.left;
        const fullEnd = isVertical ? fullRect.bottom : fullRect.right;
        const start = fullStart + (fullEnd - fullStart) * selected.textStart / Math.max(1, selected.run.text.length);
        const end = fullStart + (fullEnd - fullStart) * selected.textEnd / Math.max(1, selected.run.text.length);
        const pageStart = isVertical ? pageRect.top : pageRect.left;
        const pageSize = isVertical ? pageRect.height : pageRect.width;
        return {
            inlineStart: clamp01((Math.min(start, end) - pageStart) / pageSize),
            inlineEnd: clamp01((Math.max(start, end) - pageStart) / pageSize),
            crossStart: null,
            crossEnd: null,
        };
    }
    const start = selected.run.inlineStart + (selected.run.inlineEnd - selected.run.inlineStart)
        * selected.textStart / Math.max(1, selected.run.text.length);
    const end = selected.run.inlineStart + (selected.run.inlineEnd - selected.run.inlineStart)
        * selected.textEnd / Math.max(1, selected.run.text.length);
    return {
        inlineStart: Math.min(start, end),
        inlineEnd: Math.max(start, end),
        crossStart: null,
        crossEnd: null,
    };
}

function selectedTextForRuns(selectedRuns: readonly ISelectedRun[]) {
    const ordered = [...selectedRuns].sort((left, right) => left.run.itemIndex - right.run.itemIndex
        || left.textStart - right.textStart);
    return ordered.reduce((parts, selected, index) => {
        const previous = ordered[index - 1];
        if (previous) {
            const sameLine = Math.abs(previous.run.baseline - selected.run.baseline) <= BASELINE_TOLERANCE;
            const previousInlineStart = Math.min(previous.run.inlineStart, previous.run.inlineEnd);
            const previousInlineEnd = Math.max(previous.run.inlineStart, previous.run.inlineEnd);
            const selectedInlineStart = Math.min(selected.run.inlineStart, selected.run.inlineEnd);
            const selectedInlineEnd = Math.max(selected.run.inlineStart, selected.run.inlineEnd);
            const gap = Math.max(0, Math.max(previousInlineStart, selectedInlineStart)
                - Math.min(previousInlineEnd, selectedInlineEnd));
            parts.push(sameLine && gap <= ADJACENT_RUN_GAP ? '' : ' ');
        }
        parts.push(selected.run.text.slice(selected.textStart, selected.textEnd));
        return parts;
    }, [] as string[])
        .join('')
        .replace(/\s+/gu, ' ')
        .trim();
}

function selectedRunsForLine(range: Range, line: ITextLineBox) {
    return line.runs.flatMap(run => selectedOffsets(range, run).map(offsets => ({
        run,
        ...offsets,
    })));
}

function lineRect(
    line: ITextLineBox,
    selectedRuns: readonly ISelectedRun[],
    pageRect: ReturnType<typeof pageRectFor>,
) {
    const extents = selectedRuns.map(selected => normalizedSelectionExtent(
        selected,
        pageRect,
    ));
    const isVertical = line.runs[0]?.isVertical === true;
    const inlineStart = Math.min(...extents.map(extent => extent.inlineStart));
    const inlineEnd = Math.max(...extents.map(extent => extent.inlineEnd));
    const metricCrossStart = isVertical ? line.left : line.top;
    const metricCrossEnd = isVertical ? line.right : line.bottom;
    const hasDomCrossAxis = extents.every(extent => extent.crossStart !== null && extent.crossEnd !== null);
    const crossStart = hasDomCrossAxis
        ? Math.min(...extents.map(extent => extent.crossStart!))
        : metricCrossStart;
    const crossEnd = hasDomCrossAxis
        ? Math.max(...extents.map(extent => extent.crossEnd!))
        : metricCrossEnd;
    return inlineEnd > inlineStart && crossEnd > crossStart
        ? {
            left: isVertical ? crossStart : inlineStart,
            top: isVertical ? inlineStart : crossStart,
            width: isVertical ? crossEnd - crossStart : inlineEnd - inlineStart,
            height: isVertical ? inlineEnd - inlineStart : crossEnd - crossStart,
        }
        : null;
}

/**
 * Splits one DOM selection by rendered page and line. A usable DOM range
 * supplies both display axes for the selected text. Metric line boxes remain
 * the fallback for a missing DOM measurement, so stored geometry stays
 * normalized and scale independent.
 */
export function buildHighlightQuadsFromSelection(
    range: Range,
    pages: readonly IHighlightSelectionPage[],
): IHighlightPageGeometry[] {
    if (range.collapsed) {
        return [];
    }
    return pages.flatMap((page) => {
        const pageRect = pageRectFor(page.pageContainer);
        const selectedLines = page.lineBoxes
            .map(line => ({
                line,
                selectedRuns: selectedRunsForLine(range, line),
            }))
            .filter(({selectedRuns}) => selectedRuns.length > 0);
        const selectedRuns = selectedLines.flatMap(({selectedRuns: runs}) => runs);
        if (selectedRuns.length === 0) {
            return [];
        }
        const quads = selectedLines.flatMap(({
            line,
            selectedRuns: runs,
        }) => {
            const rect = lineRect(line, runs, pageRect);
            return rect ? [rect] : [];
        });
        const quadPoints = toCanonicalTextMarkupGeometry(quads);
        return quadPoints.length > 0
            ? [{
                pageNumber: page.pageNumber,
                quadPoints,
                selectedText: selectedTextForRuns(selectedRuns),
            }]
            : [];
    });
}
