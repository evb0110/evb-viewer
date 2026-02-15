import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    getCommentText,
    hasEditorCommentPayload,
    type IPdfjsEditor,
} from '@app/composables/pdf/pdfAnnotationUtils';

vi.mock('pdfjs-dist', () => ({PDFDateString: {toDateObject: vi.fn(() => null)}}));

describe('getCommentText', () => {
    it('returns direct string comments', () => {
        const editor: IPdfjsEditor = { comment: 'hello' };
        expect(getCommentText(editor)).toBe('hello');
    });

    it('returns text from object comments', () => {
        const editor: IPdfjsEditor = { comment: { text: 'note' } };
        expect(getCommentText(editor)).toBe('note');
    });

    it('returns empty string when reading comment throws', () => {
        const editor = {} as IPdfjsEditor;
        Object.defineProperty(editor, 'comment', {get() {
            throw new Error('unavailable');
        }});

        expect(getCommentText(editor)).toBe('');
    });
});

describe('hasEditorCommentPayload', () => {
    it('returns true for non-empty string comments', () => {
        const editor: IPdfjsEditor = { comment: 'note' };
        expect(hasEditorCommentPayload(editor)).toBe(true);
    });

    it('returns true for non-deleted object comments with text', () => {
        const editor: IPdfjsEditor = {comment: {
            text: 'note',
            deleted: false,
        }};
        expect(hasEditorCommentPayload(editor)).toBe(true);
    });

    it('returns false for deleted object comments', () => {
        const editor: IPdfjsEditor = {comment: {
            text: 'note',
            deleted: true,
        }};
        expect(hasEditorCommentPayload(editor)).toBe(false);
    });

    it('returns false when reading comment throws', () => {
        const editor = {} as IPdfjsEditor;
        Object.defineProperty(editor, 'comment', {get() {
            throw new Error('unavailable');
        }});

        expect(hasEditorCommentPayload(editor)).toBe(false);
    });
});
