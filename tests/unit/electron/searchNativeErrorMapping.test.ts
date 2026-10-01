import {
    mkdtemp,
    readdir,
    readlink,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {toSearchIpcError} from '@electron/features/search/main/searchErrors';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as TWorkerTaskModule from '@electron/utils/workerTask';
import {SEARCH_INDEX_TEXT_BUDGET} from '@contracts/searchIndexWire';


const fake = vi.hoisted(() => ({
    pageTexts: new Map<number, string>(),
    missingCjkDataPages: new Set<number>(),
    pdfjsPages: [] as number[],
    pdfjsRelease: null as Promise<void> | null,
    indexArgs: [] as string[],
    indexLines: [] as string[],
    indexCoverage: null as Record<string, unknown> | null,
    indexFailure: null as Error | null,
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({async runNativeToolCommand(command: string, args: string[], options: {
    stdin?: AsyncIterable<string>;
    onStdout?: (chunk: string) => void;
}) {
    if (command === '/fake/pdfinfo') {
        return {
            stdout: `Pages: ${fake.pageTexts.size}\n`,
            stderr: '',
            exitCode: 0,
        };
    }
    if (command === '/fake/pdftotext') {
        const firstPage = Number(args[args.indexOf('-f') + 1]);
        const lastPage = Number(args[args.indexOf('-l') + 1]);
        let stderr = '';
        for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
            if (fake.missingCjkDataPages.has(pageNumber)) {
                stderr += 'Syntax Error: Missing language pack for \'Adobe-Japan1\' mapping\n';
            }
            options.onStdout?.(`${fake.pageTexts.get(pageNumber) ?? ''}\f`);
        }
        return {
            stdout: '',
            stderr,
            exitCode: 0,
        };
    }
    if (fake.indexFailure) {
        throw fake.indexFailure;
    }
    fake.indexArgs = args;
    let input = '';
    for await (const chunk of options.stdin ?? []) {
        input += chunk;
    }
    fake.indexLines = input.split('\n').filter(Boolean);
    return {
        stdout: JSON.stringify(fake.indexCoverage ?? {
            pageCount: 3,
            pagesScanned: 1,
            pagesWritten: 1,
            truncated: true,
            missingTextPageSample: [],
        }),
        stderr: '',
        exitCode: 0,
    };
}}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({
    pdfinfo: '/fake/pdfinfo',
    pdftotext: '/fake/pdftotext',
})}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/fake/evb-pdf-search'}));
vi.mock('@electron/utils/workerTask', async importOriginal => ({
    ...await importOriginal<typeof TWorkerTaskModule>(),
    resolveUnpackedWorkerPath: () => '/fake/pdf-text-worker.js',
    async runResultWorkerTask(options: {
        workerData: {
            firstPage: number;
            lastPage: number
        };
        onProgressMessage: (message: unknown) => boolean;
    }) {
        for (let pageNumber = options.workerData.firstPage; pageNumber <= options.workerData.lastPage; pageNumber += 1) {
            fake.pdfjsPages.push(pageNumber);
            options.onProgressMessage({
                type: 'page',
                page: {
                    pageNumber,
                    text: `pdfjs page ${pageNumber}`,
                },
            });
            await fake.pdfjsRelease;
        }
        return undefined;
    },
}));

const {streamPdfPageTexts} = await import('@electron/features/search/pdfPageTexts');
const {buildSearchIndex} = await import('@electron/features/search/searchIndex');

afterEach(() => {
    fake.pageTexts = new Map();
    fake.missingCjkDataPages = new Set();
    fake.pdfjsPages = [];
    fake.pdfjsRelease = null;
    fake.indexArgs = [];
    fake.indexLines = [];
    fake.indexCoverage = null;
    fake.indexFailure = null;
});

describe('native search error mapping', () => {
    it.each([
        [
            'invalid-request',
            'SEARCH_INVALID_PAYLOAD',
            false,
        ],
        [
            'too-large',
            'SEARCH_WORKER_LIMIT',
            false,
        ],
        [
            'corrupt-xref',
            'SEARCH_WORKER_ERROR',
            false,
        ],
        [
            'unsupported-filter',
            'SEARCH_WORKER_ERROR',
            false,
        ],
        [
            'io',
            'SEARCH_WORKER_ERROR',
            true,
        ],
        [
            'native-failure',
            'SEARCH_WORKER_ERROR',
            true,
        ],
    ] as const)('maps %s exclusively by code', (nativeCode, searchCode, retryable) => {
        const error = Object.assign(new Error('translated detail'), {code: nativeCode});
        expect(toSearchIpcError(error).errorEnvelope).toMatchObject({
            code: searchCode,
            retryable,
        });
    });
});

describe('search index text budget', () => {
    it('streams the PDF.js reading of a window Poppler lacks CJK data for', async () => {
        fake.pageTexts.set(1, 'poppler 1');
        fake.pageTexts.set(2, 'poppler 2');
        fake.missingCjkDataPages.add(2);
        let release!: () => void;
        fake.pdfjsRelease = new Promise((resolve) => {
            release = resolve;
        });

        const pages = streamPdfPageTexts('/doc.pdf')[Symbol.asyncIterator]();
        // The first page arrives while the worker is still reading the window.
        expect((await pages.next()).value).toEqual({
            pageNumber: 1,
            text: 'pdfjs page 1',
        });
        expect(fake.pdfjsPages).toEqual([1]);
        release();
        expect((await pages.next()).value).toEqual({
            pageNumber: 2,
            text: 'pdfjs page 2',
        });
        expect((await pages.next()).done).toBe(true);
    });

    it('reports the first page over the budget to the index and stops reading pages there', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-budget-'));
        const pageTexts = [
            'small page',
            'x'.repeat(SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes + 1),
            'never read',
        ];
        const pulled: number[] = [];
        try {
            await buildSearchIndex({
                indexPath: join(directory, 'index'),
                documentRevision: 'revision',
                readPageCount: () => Promise.resolve(pageTexts.length),
                async* readPages() {
                    for (const [
                        index,
                        text,
                    ] of pageTexts.entries()) {
                        pulled.push(index + 1);
                        yield {
                            pageNumber: index + 1,
                            text,
                        };
                    }
                },
            });

            // What the indexer makes of the report is its own contract
            // (pdf-search a_page_over_the_budget_ends_the_index_as_truncated).
            expect(fake.indexLines.map(line => JSON.parse(line) as unknown)).toEqual([
                {
                    pageNumber: 1,
                    text: 'small page',
                },
                {
                    pageNumber: 2,
                    overBudget: true,
                },
            ]);
            expect(pulled).toEqual([
                1,
                2,
            ]);
            expect(fake.indexArgs).toEqual(expect.arrayContaining([
                '--page-count',
                '3',
            ]));
            expect(fake.indexArgs.slice(fake.indexArgs.indexOf('--max-page-text-bytes'))).toEqual([
                '--max-page-text-bytes',
                String(SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes),
                '--max-total-text-bytes',
                String(SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes),
            ]);
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    // A command can fail before it reads its input (build check, admission,
    // spawn); the extracted text file must not stay open behind it.
    it.runIf(process.platform === 'linux')('leaves no open input file when the indexer fails before reading it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-input-'));
        fake.indexFailure = new Error('evb-pdf-search failed to start');
        try {
            await expect(buildSearchIndex({
                indexPath: join(directory, 'index'),
                documentRevision: 'revision',
                async* readPages() {
                    yield {
                        pageNumber: 1,
                        text: 'page',
                    };
                },
            })).rejects.toThrow('evb-pdf-search failed to start');
            const openFiles = await Promise.all((await readdir('/proc/self/fd')).map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')));
            expect(openFiles.filter(target => target.startsWith(directory))).toEqual([]);
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it.each([
        [
            'a negative page count',
            {pageCount: -1},
        ],
        [
            'a negative written page count',
            {pagesWritten: -1},
        ],
        [
            'more pages written than scanned',
            {pagesWritten: 3},
        ],
        [
            'more pages scanned than the document has',
            {pagesScanned: 3},
        ],
        [
            'a page without text beyond the pages scanned',
            {
                pagesScanned: 1,
                missingTextPageSample: [2],
            },
        ],
        [
            'page 0 among the pages without text',
            {missingTextPageSample: [0]},
        ],
    ])('refuses a coverage report with %s', async (_label, malformed) => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-coverage-'));
        fake.indexCoverage = {
            pageCount: 2,
            pagesScanned: 2,
            pagesWritten: 1,
            truncated: false,
            missingTextPageSample: [2],
            ...malformed,
        };
        try {
            await expect(buildSearchIndex({
                indexPath: join(directory, 'index'),
                documentRevision: 'revision',
                async* readPages() {
                    yield {
                        pageNumber: 1,
                        text: 'page',
                    };
                },
            })).rejects.toThrow('evb-pdf-search index returned an invalid coverage report');
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});
