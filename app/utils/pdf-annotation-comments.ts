import type { IAnnotationCommentSummary } from '@app/types/annotations';

function containsWord(text: string, word: string) {
    return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

export function isTextNoteComment(comment: IAnnotationCommentSummary) {
    if (comment.hasNote === true) {
        return true;
    }

    const subtype = (comment.subtype ?? '').toLowerCase();
    const label = (comment.kindLabel ?? '').toLowerCase();

    return (
        subtype.includes('popup')
        || subtype.includes('text')
        || subtype.includes('note')
        || containsWord(label, 'note')
        || containsWord(label, 'comment')
        || containsWord(label, 'sticky')
    );
}

export function compareComments(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    if (left.pageIndex !== right.pageIndex) {
        return left.pageIndex - right.pageIndex;
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

    const leftModified = left.modifiedAt ?? 0;
    const rightModified = right.modifiedAt ?? 0;
    if (leftModified !== rightModified) {
        return rightModified - leftModified;
    }

    return left.stableKey.localeCompare(right.stableKey);
}

export function matchesCommentQuery(comment: IAnnotationCommentSummary, normalizedQuery: string) {
    if (!normalizedQuery) {
        return true;
    }

    return (
        comment.text.toLowerCase().includes(normalizedQuery)
        || (comment.kindLabel ?? '').toLowerCase().includes(normalizedQuery)
        || (comment.author ?? '').toLowerCase().includes(normalizedQuery)
        || `p${comment.pageNumber}`.includes(normalizedQuery)
    );
}
