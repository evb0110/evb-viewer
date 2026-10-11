import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_DOCUMENT_SEARCH_OPTIONS,
    getDocumentSearchQueryError,
    resolveDocumentSearchQuery,
} from '@app/modules/document-viewer/providers/documentSearch';

describe('document search query validation', () => {
    it.each([
        [
            '  hello  ',
            'hello',
        ],
        [
            '  " hello "  ',
            ' hello ',
        ],
        [
            '"  "',
            '  ',
        ],
        [
            '""',
            '',
        ],
        [
            '^"hello"$',
            '^"hello"$',
        ],
    ])('normalizes UI query %j to literal %j', (input, expected) => {
        expect(resolveDocumentSearchQuery(input)).toBe(expected);
    });

    it('distinguishes syntax, length and unsafe input from valid literal and Unicode queries', () => {
        const regex = {
            ...DEFAULT_DOCUMENT_SEARCH_OPTIONS,
            useRegex: true,
        };
        expect(getDocumentSearchQueryError('[', regex)?.key).toBe('searchResults.invalidRegex');
        expect(getDocumentSearchQueryError('(a+)+', regex)?.key).toBe('searchResults.regexTooComplex');
        expect(getDocumentSearchQueryError('a'.repeat(513), regex)).toEqual({
            key: 'searchResults.queryTooLong',
            count: 512,
        });
        expect(getDocumentSearchQueryError('a'.repeat(2049), DEFAULT_DOCUMENT_SEARCH_OPTIONS)).toEqual({
            key: 'searchResults.queryTooLong',
            count: 2048,
        });
        for (const query of [
            '[',
            'Жёлтый',
            '日本語',
        ]) expect(getDocumentSearchQueryError(query, DEFAULT_DOCUMENT_SEARCH_OPTIONS)).toBeNull();
        expect(getDocumentSearchQueryError('^"hello"$', regex)).toBeNull();
    });

});
