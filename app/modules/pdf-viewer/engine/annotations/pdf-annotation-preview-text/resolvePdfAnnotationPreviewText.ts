import {isFiniteNumber} from '@contracts/runtimeGuards';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';

const MAX_PREVIEW_TEXT_LENGTH = 280;

const TARGET_RECT_PADDING = 0.006;

const MIN_CROSS_AXIS_OVERLAP_RATIO = 0.35;

const MIN_UNPADDED_CROSS_AXIS_OVERLAP_RATIO = 0.5;

const TEXT_RANGE_EPSILON = 1e-6;

interface ITextPreviewItemGeometry {
    readonly text: string;
    readonly rect: Readonly<IAnnotationMarkerRect>;
    /** The page axis the text runs along, and whether it runs against it. */
    readonly horizontal: boolean;
    readonly reversed: boolean;
}

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

function expandMarkerRect(rect: IAnnotationMarkerRect) {
    return normalizeMarkerRect({
        left: rect.left - TARGET_RECT_PADDING,
        top: rect.top - TARGET_RECT_PADDING,
        width: rect.width + TARGET_RECT_PADDING * 2,
        height: rect.height + TARGET_RECT_PADDING * 2,
    }) ?? rect;
}

// The item's box from its own corners: it runs along its text matrix from its
// origin for its width, and up for its height, and the whole viewport
// transform, with its rotation and UserUnit, places those corners on the page.
function toTextItemGeometry(
    item: IPdfTextPreviewItem,
    viewport: IPdfTextPreviewViewport,
): Omit<ITextPreviewItemGeometry, 'text'> | null {
    const [
        a,
        b,
        c,
        d,
        e,
        f,
    ] = item.transform ?? [];
    const [
        va,
        vb,
        vc,
        vd,
        ve,
        vf,
    ] = viewport.transform;
    if (![
        a,
        b,
        c,
        d,
        e,
        f,
    ].every(isFiniteNumber)) {
        return null;
    }
    const along = Math.hypot(a!, b!);
    const up = Math.hypot(c!, d!);
    const width = Math.abs(item.width ?? 0);
    const height = Math.max(up, Math.abs(item.height ?? 0));
    if (along <= 0 || up <= 0 || width <= 0 || height <= 0) {
        return null;
    }
    const place = (x: number, y: number) => [
        va! * x + vc! * y + ve!,
        vb! * x + vd! * y + vf!,
    ] as const;
    const origin = place(e!, f!);
    const end = place(e! + a! / along * width, f! + b! / along * width);
    const top = place(e! + c! / up * height, f! + d! / up * height);
    const corners = [
        origin,
        end,
        top,
        [
            end[0] - origin[0] + top[0],
            end[1] - origin[1] + top[1],
        ] as const,
    ];
    const xs = corners.map(([x]) => x / viewport.width);
    const ys = corners.map(([
        , y,
    ]) => y / viewport.height);
    const rect = normalizeMarkerRect({
        left: Math.min(...xs),
        top: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    });
    const dx = end[0] - origin[0];
    const dy = end[1] - origin[1];
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    return rect ? {
        rect,
        horizontal,
        reversed: horizontal ? dx < 0 : dy < 0,
    } : null;
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
    {
        text, rect: textRect, horizontal: isHorizontal, reversed,
    }: ITextPreviewItemGeometry,
    targetRect: IAnnotationMarkerRect,
) {
    const expandedTarget = expandMarkerRect(targetRect);

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
    const fromRatio = clamp01((Math.max(inlineStart, targetInlineStart) - inlineStart) / inlineLength);
    const toRatio = clamp01((Math.min(inlineEnd, targetInlineEnd) - inlineStart) / inlineLength);
    // Text running against the page axis starts at its far end.
    const startRatio = reversed ? 1 - toRatio : fromRatio;
    const endRatio = reversed ? 1 - fromRatio : toRatio;
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
    item: ITextPreviewItemGeometry,
    targets: readonly IAnnotationMarkerRect[],
) {
    const {text} = item;
    const ranges = mergeTextRanges(
        targets.flatMap((target) => {
            const range = toTextRangeForTarget(item, target);
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
    textItems: readonly ITextPreviewItemGeometry[],
) {
    if (!isTextMarkupSubtype(subtype) || textItems.length === 0 || targets.length === 0) {
        return null;
    }

    const segments: string[] = [];
    for (const item of textItems) {
        segments.push(...extractTextItemSegments(item, targets));
    }

    const previewText = joinPreviewSegments(segments);
    return previewText || null;
}

/** Prepares ordered text geometry for one page extraction, shared by its highlights. */
export function createPdfAnnotationPreviewTextResolver(
    textItems: readonly IPdfTextPreviewItem[],
    viewport: IPdfTextPreviewViewport | null | undefined,
) {
    const geometry: readonly ITextPreviewItemGeometry[] = textItems.length > 0 && hasUsableViewport(viewport)
        ? textItems.flatMap((item) => {
            const text = item.str ?? '';
            if (!text.trim()) {
                return [];
            }
            const geometry = toTextItemGeometry(item, viewport);
            return geometry ? [{
                text,
                ...geometry,
            }] : [];
        })
        : [];

    return (subtype: string | null | undefined, targets: readonly IAnnotationMarkerRect[]) => (
        resolvePreviewTextForTargets(subtype, targets, geometry)
    );
}

/** Extracts derived text when the caller already has canonical marker rects. */
export function resolvePdfAnnotationPreviewTextFromMarkerRects(
    subtype: string | null | undefined,
    targetRects: readonly IAnnotationMarkerRect[],
    textItems: readonly IPdfTextPreviewItem[],
    viewport: IPdfTextPreviewViewport | null | undefined,
) {
    if (!isTextMarkupSubtype(subtype) || targetRects.length === 0) {
        return null;
    }
    return createPdfAnnotationPreviewTextResolver(textItems, viewport)(subtype, targetRects);
}
