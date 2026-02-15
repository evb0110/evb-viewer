import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';

export interface IMarkupSubtypeHint {
    subtype: TMarkupSubtype;
    pageIndex: number;
    markerRect: IAnnotationMarkerRect;
    consumed: boolean;
}

const SUBTYPE_HINTS = new Set<TMarkupSubtype>([
    'Underline',
    'StrikeOut',
]);

function isMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return value === 'Highlight'
        || value === 'Underline'
        || value === 'StrikeOut'
        || value === 'Squiggly';
}

function isValidMarkerRect(value: unknown): value is IAnnotationMarkerRect {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<IAnnotationMarkerRect>;
    return Number.isFinite(candidate.left)
        && Number.isFinite(candidate.top)
        && Number.isFinite(candidate.width)
        && Number.isFinite(candidate.height)
        && (candidate.width as number) > 0
        && (candidate.height as number) > 0;
}

export function collectMarkupSubtypeHints(comments: IAnnotationCommentSummary[]): IMarkupSubtypeHint[] {
    const hints: IMarkupSubtypeHint[] = [];
    for (const comment of comments) {
        if (comment.source !== 'editor') {
            continue;
        }
        if (!isMarkupSubtype(comment.subtype) || !SUBTYPE_HINTS.has(comment.subtype)) {
            continue;
        }
        if (!isValidMarkerRect(comment.markerRect)) {
            continue;
        }
        hints.push({
            subtype: comment.subtype,
            pageIndex: comment.pageIndex,
            markerRect: comment.markerRect,
            consumed: false,
        });
    }
    return hints;
}

export function groupMarkupSubtypeHintsByPage(hints: IMarkupSubtypeHint[]) {
    const hintsByPage = new Map<number, IMarkupSubtypeHint[]>();
    for (const hint of hints) {
        const pageHints = hintsByPage.get(hint.pageIndex);
        if (pageHints) {
            pageHints.push(hint);
            continue;
        }
        hintsByPage.set(hint.pageIndex, [hint]);
    }
    return hintsByPage;
}
