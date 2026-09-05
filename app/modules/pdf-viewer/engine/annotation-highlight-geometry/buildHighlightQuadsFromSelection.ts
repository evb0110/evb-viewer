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
    readonly start: number;
    readonly end: number;
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

function selectedOffsets(range: Range, run: ITextLineRun): {
    start: number;
    end: number
} | null {
    const node = run.textNode;
    const length = node?.length ?? run.text.length;
    if (!node || length <= 0) {
        return null;
    }
    if (!range.intersectsNode(node)
        || range.comparePoint(node, length) < 0
        || range.comparePoint(node, 0) > 0) {
        return null;
    }
    const start = boundaryOffset(node, length, range.startContainer, range.startOffset, true);
    const end = boundaryOffset(node, length, range.endContainer, range.endOffset, false);
    return end > start ? {
        start,
        end,
    } : null;
}

function pageRectFor(pageContainer: HTMLElement) {
    const rect = pageContainer.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
}

function normalizedInlineExtent(
    selected: ISelectedRun,
    pageRect: ReturnType<typeof pageRectFor>,
) {
    const selectedRange = document.createRange();
    selectedRange.setStart(selected.run.textNode!, selected.start);
    selectedRange.setEnd(selected.run.textNode!, selected.end);
    const clientRects = Array.from(selectedRange.getClientRects?.() ?? [])
        .filter(rect => rect.width > 0 && rect.height > 0);
    if (clientRects.length > 0 && pageRect) {
        const isVertical = selected.run.isVertical;
        const pageStart = isVertical ? pageRect.top : pageRect.left;
        const pageSize = isVertical ? pageRect.height : pageRect.width;
        return {
            left: clamp01((Math.min(...clientRects.map(rect => isVertical ? rect.top : rect.left)) - pageStart) / pageSize),
            right: clamp01((Math.max(...clientRects.map(rect => isVertical ? rect.bottom : rect.right)) - pageStart) / pageSize),
        };
    }
    const fullRect = selected.run.textDiv.getBoundingClientRect();
    if (fullRect.width > 0 && pageRect) {
        const isVertical = selected.run.isVertical;
        const fullStart = isVertical ? fullRect.top : fullRect.left;
        const fullEnd = isVertical ? fullRect.bottom : fullRect.right;
        const start = fullStart + (fullEnd - fullStart) * selected.start / Math.max(1, selected.run.text.length);
        const end = fullStart + (fullEnd - fullStart) * selected.end / Math.max(1, selected.run.text.length);
        const pageStart = isVertical ? pageRect.top : pageRect.left;
        const pageSize = isVertical ? pageRect.height : pageRect.width;
        return {
            left: clamp01((Math.min(start, end) - pageStart) / pageSize),
            right: clamp01((Math.max(start, end) - pageStart) / pageSize),
        };
    }
    const start = selected.run.inlineStart + (selected.run.inlineEnd - selected.run.inlineStart)
        * selected.start / Math.max(1, selected.run.text.length);
    const end = selected.run.inlineStart + (selected.run.inlineEnd - selected.run.inlineStart)
        * selected.end / Math.max(1, selected.run.text.length);
    return {
        left: Math.min(start, end),
        right: Math.max(start, end),
    };
}

function selectedTextForRuns(selectedRuns: readonly ISelectedRun[]) {
    const ordered = [...selectedRuns].sort((left, right) => left.run.itemIndex - right.run.itemIndex);
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
        parts.push(selected.run.text.slice(selected.start, selected.end));
        return parts;
    }, [] as string[])
        .join('')
        .replace(/\s+/gu, ' ')
        .trim();
}

function selectedRunsForLine(range: Range, line: ITextLineBox) {
    return line.runs.flatMap((run) => {
        const offsets = selectedOffsets(range, run);
        return offsets ? [{
            run,
            ...offsets,
        }] : [];
    });
}

function lineRect(
    line: ITextLineBox,
    selectedRuns: readonly ISelectedRun[],
    pageRect: ReturnType<typeof pageRectFor>,
) {
    const extents = selectedRuns.map(selected => normalizedInlineExtent(
        selected,
        pageRect,
    ));
    const isVertical = line.runs[0]?.isVertical === true;
    const lineInlineStart = isVertical ? line.top : line.left;
    const lineInlineEnd = isVertical ? line.bottom : line.right;
    const inlineStart = Math.max(lineInlineStart, Math.min(...extents.map(extent => extent.left)));
    const inlineEnd = Math.min(lineInlineEnd, Math.max(...extents.map(extent => extent.right)));
    const crossStart = isVertical ? line.left : line.top;
    const crossEnd = isVertical ? line.right : line.bottom;
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
 * Splits one DOM selection by rendered page and line. DOM ranges supply only
 * the partial inline endpoints. The line boxes carry the metric-derived
 * vertical bounds, so browser zoom never enters the stored geometry.
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
