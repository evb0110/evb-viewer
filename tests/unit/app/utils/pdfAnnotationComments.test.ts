import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    getAnnotationCommentPreviewText,
    matchesCommentQuery,
    splitByQueryMatches,
} from '@app/utils/pdfAnnotationComments';
import {requireEpochMs} from '@contracts/timestamps';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'comment-1',
        stableKey: 'ann:0:stable-comment-1',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Sample note text',
        kindLabel: 'Inline Note',
        subtype: 'Text',
        author: null,
        modifiedAt: requireEpochMs(1700000000000),
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
        ...overrides,
    };
}

describe('pdfAnnotationComments', () => {
    it('matches by explicit comment author', () => {
        const comment = createComment({author: 'Eugene'});

        expect(matchesCommentQuery(comment, 'eugene')).toBe(true);
    });

    it('matches by fallback author when comment author is missing', () => {
        const comment = createComment();

        expect(matchesCommentQuery(comment, 'eugene', 'Eugene')).toBe(true);
    });

    it('does not match missing author query without fallback', () => {
        const comment = createComment();

        expect(matchesCommentQuery(comment, 'eugene')).toBe(false);
    });

    it('uses selected annotation preview text when note text is empty', () => {
        const comment = createComment({
            text: '',
            previewText: 'Highlighted paragraph',
        });

        expect(getAnnotationCommentPreviewText(comment)).toBe('Highlighted paragraph');
    });

    it('prefers explicit note text over selected annotation preview text', () => {
        const comment = createComment({
            text: 'Sticky note',
            previewText: 'Highlighted paragraph',
        });

        expect(getAnnotationCommentPreviewText(comment)).toBe('Sticky note');
    });

    it('prefers transient display text during save reload handoff', () => {
        const comment = createComment({
            displayText: 'An Introductionto',
            text: 'An Introduction to Koranic and d',
            previewText: 'An Introduction to Koranic and d',
        });

        expect(getAnnotationCommentPreviewText(comment)).toBe('An Introductionto');
    });

    it('matches by selected annotation preview text', () => {
        const comment = createComment({
            text: '',
            previewText: 'Highlighted paragraph',
        });

        expect(matchesCommentQuery(comment, 'paragraph')).toBe(true);
    });

    it('matches by transient display text', () => {
        const comment = createComment({
            displayText: 'An Introductionto',
            text: 'An Introduction to Koranic and d',
        });

        expect(matchesCommentQuery(comment, 'introductionto')).toBe(true);
    });

    it('matches by annotation subtype', () => {
        const comment = createComment({
            kindLabel: null,
            subtype: 'StrikeOut',
        });

        expect(matchesCommentQuery(comment, 'strike')).toBe(true);
    });

    it('matches long page labels in addition to compact page tokens', () => {
        const comment = createComment({
            pageIndex: 2,
            pageNumber: 3,
        });

        expect(matchesCommentQuery(comment, 'page 3')).toBe(true);
        expect(matchesCommentQuery(comment, 'p3')).toBe(true);
    });

    it('splits text into highlighted and non-highlighted parts', () => {
        expect(splitByQueryMatches('Eugene Eugene', 'euge')).toEqual([
            {
                text: 'Euge',
                match: true,
            },
            {
                text: 'ne ',
                match: false,
            },
            {
                text: 'Euge',
                match: true,
            },
            {
                text: 'ne',
                match: false,
            },
        ]);
    });

    it('returns a single plain part when query is empty', () => {
        expect(splitByQueryMatches('Eugene', '')).toEqual([{
            text: 'Eugene',
            match: false,
        }]);
    });

    it('highlights the matched characters when lowercasing changes a character length', () => {
        // İ lowercases to two code units, which used to shift every later highlight.
        expect(splitByQueryMatches('İXabcX', 'x')).toEqual([
            {
                text: 'İ',
                match: false,
            },
            {
                text: 'X',
                match: true,
            },
            {
                text: 'abc',
                match: false,
            },
            {
                text: 'X',
                match: true,
            },
        ]);
        expect(splitByQueryMatches('İİ', 'i')).toEqual([
            {
                text: 'İ',
                match: true,
            },
            {
                text: 'İ',
                match: true,
            },
        ]);
    });
});
