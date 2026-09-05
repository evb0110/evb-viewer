import {
    describe,
    expect,
    it,
} from 'vitest';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';
import { isNoteEligible } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isNoteEligible';
import { isSelectionInteractionTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionInteractionTool';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'id',
        stableKey: 'ann:0:key',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
        ...overrides,
    };
}

describe('isNoteEligible', () => {
    it('returns true when hasNote is explicitly true regardless of subtype', () => {
        expect(isNoteEligible('highlight', true)).toBe(true);
        expect(isNoteEligible(null, true)).toBe(true);
    });

    it('returns true for note-like subtypes', () => {
        expect(isNoteEligible('Text')).toBe(true);
        expect(isNoteEligible('FreeText')).toBe(true);
        expect(isNoteEligible('typewriter')).toBe(true);
        expect(isNoteEligible('note-linked')).toBe(true);
        expect(isNoteEligible('note-inline')).toBe(true);
    });

    it('matches subtype substrings for popup and note', () => {
        expect(isNoteEligible('SomethingPopup')).toBe(true);
        expect(isNoteEligible('SomeNoteThing')).toBe(true);
    });

    it('returns false for non-note subtypes when no other signals are provided', () => {
        expect(isNoteEligible('ink')).toBe(false);
        expect(isNoteEligible(null)).toBe(false);
        expect(isNoteEligible(undefined)).toBe(false);
    });

    it('returns true when source is editor and text has non-empty content', () => {
        expect(isNoteEligible('highlight', false, 'editor', 'hello')).toBe(true);
    });

    it('returns true for an empty text-markup regardless of source or text', () => {
        expect(isNoteEligible('highlight', false, 'editor')).toBe(true);
        expect(isNoteEligible('highlight', false, 'pdf')).toBe(true);
        expect(isNoteEligible('highlight', false, 'editor', '   ')).toBe(true);
        expect(isNoteEligible('highlight', false, 'pdf', '   ')).toBe(true);
        expect(isNoteEligible('underline', false, 'editor', '   ')).toBe(true);
        expect(isNoteEligible('underline', false, 'pdf', '   ')).toBe(true);
        expect(isNoteEligible('strikeout', false, 'editor', '   ')).toBe(true);
        expect(isNoteEligible('strikeout', false, 'pdf', '   ')).toBe(true);
        expect(isNoteEligible('squiggly', false, 'editor', '   ')).toBe(true);
        expect(isNoteEligible('squiggly', false, 'pdf', '   ')).toBe(true);
    });

    it('returns true for a PDF-originated text-markup with derived text', () => {
        expect(isNoteEligible('highlight', false, 'pdf', 'hello')).toBe(true);
    });
});

describe('compareAnnotationCommentSummaries', () => {
    it('returns negative when left has a smaller pageIndex', () => {
        const left = createComment({pageIndex: 0});
        const right = createComment({pageIndex: 5});
        expect(compareAnnotationCommentSummaries(left, right)).toBeLessThan(0);
    });

    it('returns positive when left has a larger pageIndex', () => {
        const left = createComment({pageIndex: 7});
        const right = createComment({pageIndex: 2});
        expect(compareAnnotationCommentSummaries(left, right)).toBeGreaterThan(0);
    });

    it('orders by sortIndex when pageIndex matches', () => {
        const left = createComment({
            pageIndex: 1,
            sortIndex: 1,
        });
        const right = createComment({
            pageIndex: 1,
            sortIndex: 5,
        });
        expect(compareAnnotationCommentSummaries(left, right)).toBeLessThan(0);
    });

    it('orders by creation time before source-local sort indexes', () => {
        const older = createComment({
            pageIndex: 1,
            sortIndex: 5,
            createdAt: 100,
            modifiedAt: 100,
        });
        const newer = createComment({
            pageIndex: 1,
            sortIndex: 1,
            createdAt: 200,
            modifiedAt: 200,
        });
        expect(compareAnnotationCommentSummaries(older, newer)).toBeLessThan(0);
    });

    it('treats a comment with sortIndex as preceding one without', () => {
        const left = createComment({
            pageIndex: 1,
            sortIndex: 3,
        });
        const right = createComment({
            pageIndex: 1,
            sortIndex: null,
        });
        expect(compareAnnotationCommentSummaries(left, right)).toBe(-1);
        expect(compareAnnotationCommentSummaries(right, left)).toBe(1);
    });

    it('does not reorder undated annotations by edit time', () => {
        const left = createComment({
            pageIndex: 0,
            sortIndex: 1,
            modifiedAt: 100,
        });
        const right = createComment({
            pageIndex: 0,
            sortIndex: 0,
            modifiedAt: 200,
        });
        expect(compareAnnotationCommentSummaries(left, right)).toBeGreaterThan(0);
    });

    it('keeps creation order stable when a note is edited later', () => {
        const createdFirstEditedLater = createComment({
            pageIndex: 0,
            createdAt: 100,
            modifiedAt: 1_000,
        });
        const createdSecond = createComment({
            pageIndex: 0,
            stableKey: 'ann:0:second',
            createdAt: 200,
            modifiedAt: 200,
        });

        expect(compareAnnotationCommentSummaries(createdFirstEditedLater, createdSecond)).toBeLessThan(0);
    });

    it('keeps undated legacy annotations before dated additions on the same page', () => {
        const legacy = createComment({
            pageIndex: 0,
            sortIndex: 10,
        });
        const addedLater = createComment({
            pageIndex: 0,
            sortIndex: 0,
            createdAt: 200,
            modifiedAt: 200,
        });
        expect(compareAnnotationCommentSummaries(legacy, addedLater)).toBeLessThan(0);
    });

    it('falls back to stableKey comparison when all other fields match', () => {
        const left = createComment({
            pageIndex: 0,
            stableKey: 'ann:0:a',
        });
        const right = createComment({
            pageIndex: 0,
            stableKey: 'ann:0:b',
        });
        expect(compareAnnotationCommentSummaries(left, right)).toBeLessThan(0);
        expect(compareAnnotationCommentSummaries(right, left)).toBeGreaterThan(0);
    });
});

describe('isSelectionInteractionTool', () => {
    it('returns true only for the select tool', () => {
        expect(isSelectionInteractionTool('select')).toBe(true);
    });

    it('returns false for other authoring tools', () => {
        expect(isSelectionInteractionTool('highlight')).toBe(false);
        expect(isSelectionInteractionTool('underline')).toBe(false);
        expect(isSelectionInteractionTool('strikethrough')).toBe(false);
        expect(isSelectionInteractionTool('draw')).toBe(false);
        expect(isSelectionInteractionTool('rectangle')).toBe(false);
        expect(isSelectionInteractionTool('text')).toBe(false);
    });

    it('returns false for the none tool', () => {
        expect(isSelectionInteractionTool('none')).toBe(false);
    });

    it('returns false for stamp', () => {
        expect(isSelectionInteractionTool('stamp')).toBe(false);
    });
});
