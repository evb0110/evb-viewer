import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface ICommentQueryMatchPart {
    text: string;
    match: boolean;
}

function normalizeTimestamp(value: number | null | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

function getAnnotationCommentCreatedAt(comment: IAnnotationCommentSummary) {
    return normalizeTimestamp(comment.createdAt);
}

export function getAnnotationCommentDisplayTimestamp(comment: IAnnotationCommentSummary) {
    return normalizeTimestamp(comment.modifiedAt)
        ?? normalizeTimestamp(comment.createdAt);
}

function getAnnotationCommentSortTimestamp(comment: IAnnotationCommentSummary) {
    return getAnnotationCommentCreatedAt(comment) ?? 0;
}

export function compareAnnotationCommentSummaries(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    if (left.pageIndex !== right.pageIndex) {
        return left.pageIndex - right.pageIndex;
    }

    const leftCreated = getAnnotationCommentSortTimestamp(left);
    const rightCreated = getAnnotationCommentSortTimestamp(right);
    if (leftCreated !== rightCreated) {
        return leftCreated - rightCreated;
    }

    const leftSort = typeof left.sortIndex === 'number' ? left.sortIndex : null;
    const rightSort = typeof right.sortIndex === 'number' ? right.sortIndex : null;

    if (leftSort !== null && rightSort !== null && leftSort !== rightSort) {
        return leftSort - rightSort;
    }

    if (leftSort !== null && rightSort === null) {
        return -1;
    }

    if (leftSort === null && rightSort !== null) {
        return 1;
    }

    return left.stableKey.localeCompare(right.stableKey);
}

export function getAnnotationCommentPreviewText(comment: IAnnotationCommentSummary) {
    const displayText = comment.displayText?.trim();
    if (displayText) {
        return displayText;
    }
    const text = comment.text.trim();
    if (text) {
        return text;
    }
    return comment.previewText?.trim() ?? '';
}

export function matchesCommentQuery(
    comment: IAnnotationCommentSummary,
    normalizedQuery: string,
    fallbackAuthor?: string | null,
) {
    if (!normalizedQuery) {
        return true;
    }

    const commentAuthor = comment.author?.trim();
    const fallback = fallbackAuthor?.trim();
    const author = commentAuthor && commentAuthor.length > 0
        ? commentAuthor
        : fallback ?? '';
    const pageNumber = String(comment.pageNumber);
    const pageTokens = [
        `p${pageNumber}`,
        `page ${pageNumber}`,
    ];

    return (
        (comment.displayText ?? '').toLowerCase().includes(normalizedQuery)
        ||
        comment.text.toLowerCase().includes(normalizedQuery)
        || (comment.previewText ?? '').toLowerCase().includes(normalizedQuery)
        || (comment.replies?.some(reply => (
            reply.contents.toLowerCase().includes(normalizedQuery)
            || (reply.author ?? '').toLowerCase().includes(normalizedQuery)
        )) ?? false)
        || (comment.kindLabel ?? '').toLowerCase().includes(normalizedQuery)
        || (comment.subtype ?? '').toLowerCase().includes(normalizedQuery)
        || author.toLowerCase().includes(normalizedQuery)
        || pageTokens.some(token => token.includes(normalizedQuery))
    );
}

export function splitByQueryMatches(text: string, normalizedQuery: string): ICommentQueryMatchPart[] {
    if (!normalizedQuery) {
        return [{
            text,
            match: false,
        }];
    }

    if (!text) {
        return [{
            text,
            match: false,
        }];
    }

    // Lowercasing can change a character's length (İ becomes i̇), so matches
    // are found in the folded text and cut from the original at the
    // original characters they cover. The text folds as a whole, as the
    // filter folds it, so a final sigma stays final; context changes a
    // character's folded value there, never its length.
    const loweredText = text.toLowerCase();
    const originalStart: number[] = [];
    const originalEnd: number[] = [];
    for (let index = 0; index < text.length;) {
        const character = String.fromCodePoint(text.codePointAt(index)!);
        for (let unit = 0; unit < character.toLowerCase().length; unit += 1) {
            originalStart.push(index);
            originalEnd.push(index + character.length);
        }
        index += character.length;
    }
    const parts: ICommentQueryMatchPart[] = [];
    const queryLength = normalizedQuery.length;
    let cursor = 0;
    let foldedCursor = 0;

    while (cursor < text.length) {
        const foldedMatch = loweredText.indexOf(normalizedQuery, foldedCursor);
        if (foldedMatch === -1) {
            parts.push({
                text: text.slice(cursor),
                match: false,
            });
            break;
        }
        const matchIndex = originalStart[foldedMatch]!;
        const matchEnd = originalEnd[foldedMatch + queryLength - 1]!;

        if (matchIndex > cursor) {
            parts.push({
                text: text.slice(cursor, matchIndex),
                match: false,
            });
        }

        parts.push({
            text: text.slice(matchIndex, matchEnd),
            match: true,
        });

        cursor = matchEnd;
        // Resume after the last original character the match touched.
        foldedCursor = foldedMatch + queryLength;
        while (foldedCursor < loweredText.length && originalStart[foldedCursor]! < matchEnd) foldedCursor += 1;
    }

    return parts.length ? parts : [{
        text,
        match: false,
    }];
}
