import {isFiniteNumber} from '@contracts/runtimeGuards';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';

interface IPdfAnnotationTextPreviewRecord {
    subtype?: string | null | undefined;
    rect?: number[] | null | undefined;
    quadPoints?: ArrayLike<number> | null | undefined;
}

const MAX_PREVIEW_TEXT_LENGTH = 280;

const TARGET_RECT_PADDING = 0.006;

const MIN_CROSS_AXIS_OVERLAP_RATIO = 0.35;

const MIN_UNPADDED_CROSS_AXIS_OVERLAP_RATIO = 0.5;

const TEXT_RANGE_EPSILON = 1e-6;

interface ITextRange {
    end: number;
    start: number;
}


function hasUsableViewport(viewport: IPdfTextPreviewViewport | null | undefined): viewport is IPdfTextPreviewViewport {
    return Boolean(
        viewport
        && viewport.transform.length >= 6
        && viewport.transform.slice(0, 6).every(isFiniteNumber)
        && viewport.width > 0
        && viewport.height > 0,
    );
}

function matrixTransform(left: number[], right: number[]) {
    return [
        left[0]! * right[0]! + left[2]! * right[1]!,
        left[1]! * right[0]! + left[3]! * right[1]!,
        left[0]! * right[2]! + left[2]! * right[3]!,
        left[1]! * right[2]! + left[3]! * right[3]!,
        left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
        left[1]! * right[4]! + left[3]! * right[5]! + left[5]!,
    ];
}

function clampPreviewText(text: string) {
    if (text.length <= MAX_PREVIEW_TEXT_LENGTH) {
        return text;
    }
    return `${text.slice(0, MAX_PREVIEW_TEXT_LENGTH - 1).trimEnd()}...`;
}

function joinPreviewSegments(segments: string[]) {
    return clampPreviewText(
        segments
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
    );
}

function toQuadRects(
    quadPoints: ArrayLike<number> | null | undefined,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation,
) {
    const rects: IAnnotationMarkerRect[] = [];
    if (!quadPoints || quadPoints.length < 8) {
        return rects;
    }

    for (let index = 0; index + 7 < quadPoints.length; index += 8) {
        const xs = [
            quadPoints[index],
            quadPoints[index + 2],
            quadPoints[index + 4],
            quadPoints[index + 6],
        ].filter(isFiniteNumber);
        const ys = [
            quadPoints[index + 1],
            quadPoints[index + 3],
            quadPoints[index + 5],
            quadPoints[index + 7],
        ].filter(isFiniteNumber);
        if (xs.length === 0 || ys.length === 0) {
            continue;
        }

        const rect = toMarkerRectFromPdfRect(
            [
                Math.min(...xs),
                Math.min(...ys),
                Math.max(...xs),
                Math.max(...ys),
            ],
            pageView,
            pageRotation,
        );
        if (rect) {
            rects.push(rect);
        }
    }

    return rects;
}

function resolveAnnotationTargetRects(
    annotation: IPdfAnnotationTextPreviewRecord,
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation,
) {
    const quadRects = toQuadRects(annotation.quadPoints, pageView, pageRotation);
    if (quadRects.length > 0) {
        return quadRects;
    }

    const rect = annotation.rect
        ? toMarkerRectFromPdfRect(annotation.rect, pageView, pageRotation)
        : null;
    return rect ? [rect] : [];
}

function expandMarkerRect(rect: IAnnotationMarkerRect) {
    return normalizeMarkerRect({
        left: rect.left - TARGET_RECT_PADDING,
        top: rect.top - TARGET_RECT_PADDING,
        width: rect.width + TARGET_RECT_PADDING * 2,
        height: rect.height + TARGET_RECT_PADDING * 2,
    }) ?? rect;
}

function toTextItemMarkerRect(
    item: IPdfTextPreviewItem,
    viewport: IPdfTextPreviewViewport,
) {
    const transform = item.transform;
    if (!transform || transform.length < 6 || !transform.slice(0, 6).every(isFiniteNumber)) {
        return null;
    }

    const tx = matrixTransform(viewport.transform, transform);
    const scale = Math.abs(viewport.scale ?? 1) || 1;
    const fontHeight = Math.max(
        Math.hypot(tx[2]!, tx[3]!),
        Math.abs(item.height ?? 0) * scale,
    );
    const width = Math.abs(item.width ?? 0) * scale;
    if (fontHeight <= 0 || width <= 0) {
        return null;
    }

    return normalizeMarkerRect({
        left: tx[4]! / viewport.width,
        top: (tx[5]! - fontHeight) / viewport.height,
        width: width / viewport.width,
        height: fontHeight / viewport.height,
    });
}

function intervalOverlap(start: number, end: number, targetStart: number, targetEnd: number) {
    return Math.max(0, Math.min(end, targetEnd) - Math.max(start, targetStart));
}

function intervalContains(value: number, start: number, end: number) {
    return value >= start - TEXT_RANGE_EPSILON && value <= end + TEXT_RANGE_EPSILON;
}

function clamp01(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

function toTextRangeForTarget(
    text: string,
    textRect: IAnnotationMarkerRect,
    targetRect: IAnnotationMarkerRect,
) {
    const expandedTarget = expandMarkerRect(targetRect);
    const isHorizontal = textRect.width >= textRect.height;

    const inlineStart = isHorizontal ? textRect.left : textRect.top;
    const inlineLength = isHorizontal ? textRect.width : textRect.height;
    const inlineEnd = inlineStart + inlineLength;
    const expandedTargetInlineStart = isHorizontal ? expandedTarget.left : expandedTarget.top;
    const expandedTargetInlineLength = isHorizontal ? expandedTarget.width : expandedTarget.height;
    const expandedTargetInlineEnd = expandedTargetInlineStart + expandedTargetInlineLength;
    const inlineOverlap = intervalOverlap(
        inlineStart,
        inlineEnd,
        expandedTargetInlineStart,
        expandedTargetInlineEnd,
    );
    if (inlineLength <= 0 || inlineOverlap <= 0) {
        return null;
    }

    const crossStart = isHorizontal ? textRect.top : textRect.left;
    const crossLength = isHorizontal ? textRect.height : textRect.width;
    const crossEnd = crossStart + crossLength;
    const targetCrossStart = isHorizontal ? targetRect.top : targetRect.left;
    const targetCrossLength = isHorizontal ? targetRect.height : targetRect.width;
    const targetCrossEnd = targetCrossStart + targetCrossLength;
    const unpaddedCrossOverlap = intervalOverlap(
        crossStart,
        crossEnd,
        targetCrossStart,
        targetCrossEnd,
    );
    const crossCenter = crossStart + crossLength / 2;
    const crossCenterInsideTarget = intervalContains(crossCenter, targetCrossStart, targetCrossEnd);
    if (
        !crossCenterInsideTarget
        && crossLength > 0
        && unpaddedCrossOverlap / crossLength < MIN_UNPADDED_CROSS_AXIS_OVERLAP_RATIO
    ) {
        return null;
    }

    const expandedTargetCrossStart = isHorizontal ? expandedTarget.top : expandedTarget.left;
    const expandedTargetCrossLength = isHorizontal ? expandedTarget.height : expandedTarget.width;
    const expandedTargetCrossEnd = expandedTargetCrossStart + expandedTargetCrossLength;
    const crossOverlap = intervalOverlap(
        crossStart,
        crossEnd,
        expandedTargetCrossStart,
        expandedTargetCrossEnd,
    );
    const minCrossLength = Math.min(crossLength, expandedTargetCrossLength);
    if (minCrossLength <= 0 || crossOverlap / minCrossLength < MIN_CROSS_AXIS_OVERLAP_RATIO) {
        return null;
    }

    const targetInlineStart = isHorizontal ? targetRect.left : targetRect.top;
    const targetInlineLength = isHorizontal ? targetRect.width : targetRect.height;
    const targetInlineEnd = targetInlineStart + targetInlineLength;
    const startRatio = clamp01((Math.max(inlineStart, targetInlineStart) - inlineStart) / inlineLength);
    const endRatio = clamp01((Math.min(inlineEnd, targetInlineEnd) - inlineStart) / inlineLength);
    if (endRatio <= startRatio) {
        return null;
    }

    let start = Math.floor(startRatio * text.length + TEXT_RANGE_EPSILON);
    let end = Math.ceil(endRatio * text.length - TEXT_RANGE_EPSILON);
    if (start <= 1 && end >= text.length - 1) {
        start = 0;
        end = text.length;
    }
    if (end <= start) {
        end = Math.min(text.length, start + 1);
    }

    return end > start
        ? {
            start,
            end,
        }
        : null;
}

function mergeTextRanges(ranges: ITextRange[]) {
    const ordered = [...ranges]
        .filter(range => range.end > range.start)
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: ITextRange[] = [];

    for (const range of ordered) {
        const previous = merged.at(-1);
        if (!previous || range.start > previous.end) {
            merged.push({ ...range });
            continue;
        }
        previous.end = Math.max(previous.end, range.end);
    }

    return merged;
}

function extractTextItemSegments(
    item: IPdfTextPreviewItem,
    viewport: IPdfTextPreviewViewport,
    targets: readonly IAnnotationMarkerRect[],
) {
    const text = item.str ?? '';
    if (!text.trim()) {
        return [];
    }

    const rect = toTextItemMarkerRect(item, viewport);
    if (!rect) {
        return [];
    }

    const ranges = mergeTextRanges(
        targets.flatMap((target) => {
            const range = toTextRangeForTarget(text, rect, target);
            return range ? [range] : [];
        }),
    );

    return ranges
        .map(range => text.slice(range.start, range.end).trim())
        .filter(Boolean);
}

function resolvePreviewTextForTargets(
    subtype: string | null | undefined,
    targets: readonly IAnnotationMarkerRect[],
    textItems: readonly IPdfTextPreviewItem[],
    viewport: IPdfTextPreviewViewport | null | undefined,
) {
    if (!isTextMarkupSubtype(subtype) || textItems.length === 0 || !hasUsableViewport(viewport) || targets.length === 0) {
        return null;
    }

    const segments: string[] = [];
    for (const item of textItems) {
        segments.push(...extractTextItemSegments(item, viewport, targets));
    }

    const previewText = joinPreviewSegments(segments);
    return previewText || null;
}

/** Extracts derived text when the caller already has canonical marker rects. */
export function resolvePdfAnnotationPreviewTextFromMarkerRects(
    subtype: string | null | undefined,
    targetRects: readonly IAnnotationMarkerRect[],
    textItems: readonly IPdfTextPreviewItem[],
    viewport: IPdfTextPreviewViewport | null | undefined,
) {
    return resolvePreviewTextForTargets(subtype, targetRects, textItems, viewport);
}

export function resolvePdfAnnotationPreviewText(
    annotation: IPdfAnnotationTextPreviewRecord,
    textItems: readonly IPdfTextPreviewItem[],
    pageView: number[] | null | undefined,
    pageRotation: TPageRotation,
    viewport: IPdfTextPreviewViewport | null | undefined,
) {
    const targets = resolveAnnotationTargetRects(annotation, pageView, pageRotation);
    return resolvePreviewTextForTargets(annotation.subtype, targets, textItems, viewport);
}
