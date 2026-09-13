import {
    describe,
    expect,
    it,
} from 'vitest';
import type { TTranslateFn } from '@i18n-app';
import { formatDocumentSearchResultsSummary } from '@app/modules/document-viewer/providers/formatDocumentSearchResultsSummary';

const t: TTranslateFn = (key, ...args) => {
    const params = args[0];
    if (key === 'searchResults.searching') {
        return 'Searching...';
    }
    if (key === 'searchResults.resultCount') {
        return `${typeof params === 'object' && params && 'count' in params ? params.count : 0} results`;
    }
    if (key === 'searchResults.forQuery') {
        return `for "${typeof params === 'object' && params && 'query' in params ? params.query : ''}"`;
    }
    return key;
};

describe('formatDocumentSearchResultsSummary', () => {
    it('uses a stable searching label for active searches with no streamed matches yet', () => {
        expect(formatDocumentSearchResultsSummary({
            isSearching: true,
            query: 'редац',
            resultCount: 0,
            t,
        })).toBe('Searching...');
    });

    it('uses the result count once matches exist or the search has completed', () => {
        expect(formatDocumentSearchResultsSummary({
            isSearching: true,
            query: 'редац',
            resultCount: 3,
            t,
        })).toBe('3 results for "редац"');

        expect(formatDocumentSearchResultsSummary({
            isSearching: false,
            query: 'редац',
            resultCount: 0,
            t,
        })).toBe('0 results for "редац"');
    });
});
