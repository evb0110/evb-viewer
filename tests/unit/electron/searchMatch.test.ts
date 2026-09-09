import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFileSync } from 'fs';
import {
    buildPdfSearchExcerpt,
    findPdfSearchMatches,
} from '@pdf-core';
import { EXCERPT_CONTEXT_CHARS } from '@electron/config/constants';
import {
    buildExcerpt,
    findPageMatches,
    iteratePageMatches,
} from '@electron/features/search/worker/searchMatch';

const DEFAULT_OPTIONS = {
    matchCase: false,
    wholeWord: false,
    useRegex: false,
};

interface ISearchConformanceCase {
    id: string;
    text: string;
    query: string;
    options?: {
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
    };
    expectedMatches: Array<{
        startOffset: number;
        endOffset: number;
    }>;
}

interface ISearchConformanceCorpus {cases: ISearchConformanceCase[];}

const searchConformanceCorpus = JSON.parse(readFileSync(
    new URL('../../../packages/contracts/searchConformanceCorpus.json', import.meta.url),
    'utf8',
)) as ISearchConformanceCorpus;

describe('search worker page match iteration', () => {
    it('keeps array match results compatible with streaming matches', () => {
        const pageText = 'Alpha beta alpha alphabet';

        expect(findPageMatches(pageText, 'alpha', DEFAULT_OPTIONS)).toEqual(
            Array.from(iteratePageMatches(pageText, 'alpha', DEFAULT_OPTIONS)),
        );
    });

    it('allows callers to stop before materializing every page match', () => {
        const pageText = 'a '.repeat(10_000);
        const matches: Array<{
            startOffset: number;
            endOffset: number;
        }> = [];

        for (const match of iteratePageMatches(pageText, 'a', DEFAULT_OPTIONS)) {
            matches.push(match);
            if (matches.length >= 5) {
                break;
            }
        }

        expect(matches).toEqual([
            {
                startOffset: 0,
                endOffset: 1,
            },
            {
                startOffset: 2,
                endOffset: 3,
            },
            {
                startOffset: 4,
                endOffset: 5,
            },
            {
                startOffset: 6,
                endOffset: 7,
            },
            {
                startOffset: 8,
                endOffset: 9,
            },
        ]);
    });

    it('preserves whole-word unicode boundaries', () => {
        expect(findPageMatches('alpha alphabet beta alpha_1 alpha', 'alpha', {
            matchCase: false,
            wholeWord: true,
            useRegex: false,
        })).toEqual([
            {
                startOffset: 0,
                endOffset: 5,
            },
            {
                startOffset: 28,
                endOffset: 33,
            },
        ]);
    });

    it('rejects unsafe regex patterns inside the worker matcher', () => {
        expect(() => findPageMatches('aaaaaaaaaaaaaaaa!', '(a+)+$', {
            matchCase: false,
            wholeWord: false,
            useRegex: true,
        })).toThrow('pattern is too complex for document search');
    });

    it.each(searchConformanceCorpus.cases)('matches the shared conformance corpus case $id', (fixture) => {
        const options = {
            matchCase: Boolean(fixture.options?.matchCase),
            wholeWord: Boolean(fixture.options?.wholeWord),
            useRegex: Boolean(fixture.options?.useRegex),
        };

        expect(findPageMatches(fixture.text, fixture.query, options)).toEqual(fixture.expectedMatches.map((match) => ({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
        })));
        expect(findPageMatches(fixture.text, fixture.query, options)).toEqual(
            findPdfSearchMatches(fixture.text, fixture.query, options),
        );
    });

    it('delegates excerpt construction to the pdf-core helper', () => {
        const text = 'alpha \n beta target gamma \t delta';
        const startOffset = 13;
        const endOffset = 19;

        expect(buildExcerpt(text, startOffset, endOffset)).toEqual(
            buildPdfSearchExcerpt(text, startOffset, endOffset, EXCERPT_CONTEXT_CHARS),
        );
    });
});
