import {existsSync} from 'node:fs';
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
import {encodeSearchIndexInputLine} from '@contracts/searchIndexWire';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {mainJobBroker} from '@electron/resources/jobBroker';

function resolvePdfSearchPath() {
    const path = resolve(
        '.tmp',
        'pdf-search',
        `${process.platform}-${process.arch}`,
        'bin',
        `evb-pdf-search${process.platform === 'win32' ? '.exe' : ''}`,
    );
    if (!existsSync(path)) {
        throw new Error(`${path} is missing; build it with pnpm run build:pdf-search`);
    }
    return path;
}

function searchWrittenPagesArgs(query: string) {
    return [
        'search',
        '--pages-from-stdin',
        '--document-revision',
        'revision',
        '--query',
        query,
        '--limit',
        '500',
        '--context',
        '8',
    ];
}

/** Every broker admission slot is free: no native command leases remain active or queued. */
function expectNativeCommandSlotsFree() {
    expect(mainJobBroker.getSnapshot()).toMatchObject({
        active: 0,
        queued: 0,
    });
}

describe('evb-pdf-search over written pages', () => {
    it('matches a leading-space literal across blank layout space and multibyte text across a line break', async () => {
        const blank = ' '.repeat(256 * 1024);
        const pages = [
            {
                pageNumber: 1,
                text: `${blank}x needle`,
            },
            {
                pageNumber: 2,
                text: '\u{1D538} naïve café\nrésumé',
            },
        ];
        const search = async (query: string) => JSON.parse((await runNativeToolCommand(resolvePdfSearchPath(), searchWrittenPagesArgs(query), {
            commandLabel: 'evb-pdf-search(provisional search)',
            stdin: (async function* () {
                for (const page of pages) yield encodeSearchIndexInputLine(page);
            })(),
        })).stdout) as {results: Array<Record<string, unknown>>};

        expect((await search(' needle')).results).toEqual([expect.objectContaining({
            pageNumber: 1,
            matchIndex: 0,
            startOffset: blank.length + 1,
            endOffset: blank.length + 8,
            excerpt: expect.objectContaining({match: ' needle'}),
        })]);
        // A space in the query matches the line break; offsets count UTF-16 units.
        expect((await search('café résumé')).results).toEqual([expect.objectContaining({
            pageNumber: 2,
            startOffset: 9,
            endOffset: 20,
            excerpt: expect.objectContaining({match: 'café\nrésumé'}),
        })]);
        expectNativeCommandSlotsFree();
    });

    it('ends the child and frees its command slot when a search is canceled mid-stream', async () => {
        const controller = new AbortController();
        const cancelReason = new Error('Search canceled');
        const spawned = Promise.withResolvers<number>();
        const firstPageSent = Promise.withResolvers<undefined>();
        const releaseStdin = Promise.withResolvers<undefined>();
        const closed = Promise.withResolvers<undefined>();
        const search = runNativeToolCommand(resolvePdfSearchPath(), searchWrittenPagesArgs('needle'), {
            commandLabel: 'evb-pdf-search(provisional search)',
            signal: controller.signal,
            onSpawn: pid => spawned.resolve(pid),
            onClose: () => {
                closed.resolve(undefined);
            },
            stdin: (async function* () {
                yield encodeSearchIndexInputLine({
                    pageNumber: 1,
                    text: 'a needle',
                });
                firstPageSent.resolve(undefined);
                // Keep stdin open past abort and child exit to verify cancellation does not wait on EOF.
                await releaseStdin.promise;
            })(),
        });
        const earlyFailure = search.then(
            () => Promise.reject(new Error('Provisional search succeeded unexpectedly before cancellation')),
            (error: unknown) => Promise.reject(error),
        );
        try {
            const pid = await Promise.race([
                spawned.promise,
                earlyFailure,
            ]);
            await Promise.race([
                firstPageSent.promise,
                earlyFailure,
            ]);
            controller.abort(cancelReason);

            await expect(search).rejects.toBe(cancelReason);
            await closed.promise;
            expect(() => process.kill(pid, 0)).toThrow();
            expectNativeCommandSlotsFree();
        } finally {
            releaseStdin.resolve(undefined);
        }
    });

    it('refuses a page cut off mid-line when its input closes, and frees its command slot', async () => {
        const line = encodeSearchIndexInputLine({
            pageNumber: 1,
            text: 'a needle',
        });
        await expect(runNativeToolCommand(resolvePdfSearchPath(), searchWrittenPagesArgs('needle'), {
            commandLabel: 'evb-pdf-search(provisional search)',
            stdin: (async function* () {
                yield line.slice(0, line.length / 2);
            })(),
        })).rejects.toThrow(/Invalid search index input page/u);
        expectNativeCommandSlotsFree();
    });
});

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
