import {
    describe,
    expect,
    it,
} from 'vitest';
import {splitContiguousPageRuns} from '@evb/scan-cleanup/core/splitContiguousPageRuns';

describe('splitContiguousPageRuns', () => {
    it('keeps a gap-free window as one run', () => {
        expect(splitContiguousPageRuns([
            4,
            5,
            6,
        ])).toEqual([[
            4,
            5,
            6,
        ]]);
    });

    it('sorts a window that leads with the requested page and splits at gaps', () => {
        expect(splitContiguousPageRuns([
            9,
            2,
            3,
            5,
            6,
            7,
            9,
        ])).toEqual([
            [
                2,
                3,
            ],
            [
                5,
                6,
                7,
            ],
            [9],
        ]);
    });

    it('returns no runs for an empty window', () => {
        expect(splitContiguousPageRuns([])).toEqual([]);
    });
});
