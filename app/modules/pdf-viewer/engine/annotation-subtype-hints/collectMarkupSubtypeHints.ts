import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import { isRecord } from '@contracts/runtimeGuards';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/annotation-subtype-hints/pdfSerializationSubtypeHintsTypes';

const REWRITABLE_SUBTYPE_HINTS = new Set<TMarkupSubtype>([
    'Underline',
    'StrikeOut',
    'Squiggly',
]);

function toMarkupSubtype(value: unknown): TMarkupSubtype | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'highlight') {
        return 'Highlight';
    }
    if (normalized === 'underline') {
        return 'Underline';
    }
    if (normalized === 'strikeout' || normalized === 'strikethrough') {
        return 'StrikeOut';
    }
    if (normalized === 'squiggly') {
        return 'Squiggly';
    }
    return null;
}

function isValidMarkerRect(value: unknown): value is IAnnotationMarkerRect {
    if (!isRecord(value)) {
        return false;
    }

    const {
        left,
        top,
        width,
        height,
    } = value;

    return typeof left === 'number'
        && typeof top === 'number'
        && typeof width === 'number'
        && typeof height === 'number'
        && Number.isFinite(left)
        && Number.isFinite(top)
        && Number.isFinite(width)
        && Number.isFinite(height)
        && width > 0
        && height > 0;
}

function shouldCollectMarkupSubtypeHint(comment: IAnnotationCommentSummary, subtype: TMarkupSubtype) {
    if (subtype === 'Highlight') {
        return true;
    }
    return REWRITABLE_SUBTYPE_HINTS.has(subtype);
}

function shouldCollectMarkupSubtypeHintColor(comment: IAnnotationCommentSummary) {
    return comment.colorEdited === true || comment.source === 'editor';
}

export function collectMarkupSubtypeHints(
    comments: IAnnotationCommentSummary[],
    options: {includeContents?: boolean} = {},
): IMarkupSubtypeHint[] {
    const hints: IMarkupSubtypeHint[] = [];
    const pageMarkupIndexes = new Map<number, number>();
    for (const comment of comments) {
        const subtype = toMarkupSubtype(comment.subtype);
        if (!subtype) {
            continue;
        }
        if (!isValidMarkerRect(comment.markerRect)) {
            continue;
        }
        const pageMarkupIndex = pageMarkupIndexes.get(comment.pageIndex) ?? 0;
        pageMarkupIndexes.set(comment.pageIndex, pageMarkupIndex + 1);
        if (!shouldCollectMarkupSubtypeHint(comment, subtype)) {
            continue;
        }
        hints.push({
            ...(comment.appAnnotationId ? {appAnnotationId: comment.appAnnotationId} : {}),
            annotationId: comment.annotationId,
            color: shouldCollectMarkupSubtypeHintColor(comment) ? comment.color : null,
            ...(options.includeContents ? {contents: comment.text} : {}),
            id: comment.id,
            subtype,
            pageIndex: comment.pageIndex,
            markerRect: comment.markerRect,
            ...(comment.markupGeometry?.length
                && comment.markupGeometry.every(isValidMarkerRect)
                ? {markupGeometry: comment.markupGeometry}
                : {}),
            consumed: false,
            pageMarkupIndex,
            source: comment.source,
        });
    }
    return hints;
}
