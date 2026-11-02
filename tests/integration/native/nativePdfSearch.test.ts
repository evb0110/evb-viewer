import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {streamPdfPageTexts} from '@electron/features/search/pdfPageTexts';
import * as workerTasks from '@electron/utils/workerTask';
import {findPdfSearchMatches} from '@pdf-core/pdfSearchAlgorithms';

describe('native PDF search integration', () => {
    it.each([
        'failure',
        'abort',
    ] as const)('preserves Poppler search results or cancellation after a partial RTL reread: %s', async (outcome) => {
        const pdfPath = resolve('tests/fixtures/electron/semtext/search.pdf');
        const popplerPages = [];
        for await (const page of streamPdfPageTexts(pdfPath)) popplerPages.push(page);
        expect(popplerPages).toHaveLength(2);
        const worker = vi.spyOn(workerTasks, 'runResultWorkerTask');
        const controller = new AbortController();
        const reason = new Error('Reader canceled the RTL search');
        const readSearchPages = async (signal?: AbortSignal) => {
            const pages = [];
            for await (const page of streamPdfPageTexts(pdfPath, {
                visiblePageOnly: true,
                signal,
            })) pages.push(page);
            return pages;
        };
        try {
            // The first page arrives before the worker fails on the second.
            // Neither page of that range may replace the Poppler search text.
            worker.mockImplementation(async (options) => {
                options.onProgressMessage?.({
                    type: 'page',
                    page: {
                        pageNumber: 1,
                        text: 'incomplete reread',
                    },
                });
                if (outcome === 'abort') {
                    controller.abort(reason);
                    throw reason;
                }
                throw new Error('PDF.js could not reread the second RTL page');
            });
            if (outcome === 'abort') {
                await expect(readSearchPages(controller.signal)).rejects.toBe(reason);
            } else {
                const pages = await readSearchPages();
                expect(pages).toEqual(popplerPages);
                const matches = pages.flatMap(page => findPdfSearchMatches(page.text, 'abc')
                    .map(match => ({
                        pageNumber: page.pageNumber,
                        text: page.text.slice(match.startOffset, match.endOffset),
                    })));
                expect(matches).toEqual([
                    {
                        pageNumber: 1,
                        text: 'abc',
                    },
                    {
                        pageNumber: 2,
                        text: 'abc',
                    },
                ]);
            }
            expect(worker).toHaveBeenCalled();
        } finally {
            worker.mockRestore();
        }
    }, 20_000);
});
