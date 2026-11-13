import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import {
    mkdtemp,
    readdir,
    readFile,
    readlink,
    rm,
} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {toSearchIpcError} from '@electron/features/search/main/searchErrors';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as TWorkerTaskModule from '@electron/utils/workerTask';
import {SEARCH_INDEX_TEXT_BUDGET} from '@contracts/searchIndexWire';
import {MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH} from '@contracts/documentTextCatalog';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireRequestId} from '@contracts/shared';


const fake = vi.hoisted(() => ({
    broker: null as TJobBrokerModule.JobBroker | null,
    workerStopped: null as Promise<void> | null,
    workerActive: 0,
    nativeTextStarted: null as (() => void) | null,
    nativeTextFailure: null as Error | null,
    pageTexts: new Map<number, string>(),
    evbOcrText: null as string | null,
    visibilityStarted: null as (() => void) | null,
    visibilityRelease: null as Promise<void> | null,
    pdftotextRanges: [] as string[],
    missingCjkDataPages: new Set<number>(),
    pdfjsPages: [] as number[],
    pdfjsRelease: null as Promise<void> | null,
    indexArgs: [] as string[],
    indexLines: [] as string[],
    indexCoverage: null as Record<string, unknown> | null,
    indexFailure: null as Error | null,
}));

vi.mock('@electron/resources/jobBroker', async importOriginal => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    return {
        ...actual,
        mainJobBroker: {run: <T>(request: TJobBrokerModule.IJobBrokerRequest, work: () => Promise<T>) => fake.broker!.run(request, work)},
    };
});
beforeEach(async () => {
    const {JobBroker} = await vi.importActual<typeof TJobBrokerModule>('@electron/resources/jobBroker');
    fake.broker = new JobBroker({
        cpuTokens: 1,
        nativeProcesses: 2,
        estimatedResidentBytes: 512 * 1024 * 1024,
        ioWeight: 1,
    });
    fake.workerStopped = null;
    fake.workerActive = 0;
});
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({async runNativeToolCommand(command: string, args: string[], options: {
    stdin?: AsyncIterable<string>;
    onStdout?: (chunk: string) => void;
    signal?: AbortSignal;
}) {
    const result = (stdout: string) => ({
        stdout,
        stderr: '',
        exitCode: 0,
    });
    if (command === '/fake/qpdf' && args[0] === '--show-npages') {
        return result(`${fake.pageTexts.size}\n`);
    }
    if (command === '/fake/pdftotext') {
        if (fake.nativeTextFailure) {
            fake.nativeTextStarted?.();
            await new Promise<void>(resolve => {
                if (options.signal?.aborted) resolve();
                else options.signal?.addEventListener('abort', () => resolve(), {once: true});
            });
            throw fake.nativeTextFailure;
        }
        const firstPage = Number(args[args.indexOf('-f') + 1]);
        const lastPage = Number(args[args.indexOf('-l') + 1]);
        fake.pdftotextRanges.push(`${firstPage}-${lastPage}`);
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
    if (args[0] === 'ocr-text-visibility') {
        const pageNumbers = (await readFile(args[args.indexOf('--pages-file') + 1]!, 'utf8')).trim().split('\n').map(Number);
        fake.visibilityStarted?.();
        await fake.visibilityRelease;
        return result(JSON.stringify({
            format: 'evb-pdf-ocr-text-visibility',
            schemaVersion: 3,
            pages: pageNumbers.map(pageNumber => ({
                pageNumber,
                evbOcrLayer: true,
                paintedText: false,
                hiddenText: false,
                uncertain: null,
                unsupported: null,
                evbOcrLines: [{
                    block: 0,
                    text: fake.evbOcrText,
                    left: 0,
                    right: 100,
                    baseline: 100,
                    size: 10,
                }],
            })),
        }));
    }
    if (args[0] === 'stat') {
        return result(JSON.stringify(fake.indexCoverage));
    }
    if (args[0] === 'search') {
        return result(JSON.stringify({
            results: [],
            truncated: false,
            coverage: fake.indexCoverage,
        }));
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
    qpdf: '/fake/qpdf',
})}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: () => '/fake/evb-pdf-search'}));
vi.mock('@electron/file-access/documentStore', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    assertWorkingCopyRevisionCurrent: async () => undefined,
}));
// Without evb-pdf-page-ops, text extraction keeps Poppler's layout reading of every page.
vi.mock('@electron/features/page-ops/public/nativePageOpsPath', () => ({resolveNativePageOpsPath: () => fake.evbOcrText === null ? null : '/fake/evb-pdf-page-ops'}));
vi.mock('@electron/utils/workerTask', async importOriginal => ({
    ...await importOriginal<typeof TWorkerTaskModule>(),
    resolveUnpackedWorkerPath: () => '/fake/pdf-text-worker.js',
    async runResultWorkerTask(options: {
        workerData: {
            firstPage: number;
            lastPage: number
        };
        onProgressMessage: (message: unknown) => boolean;
        signal?: AbortSignal;
    }) {
        fake.workerActive++;
        try {
            for (let pageNumber = options.workerData.firstPage; pageNumber <= options.workerData.lastPage; pageNumber += 1) {
                fake.pdfjsPages.push(pageNumber);
                options.onProgressMessage({
                    type: 'page',
                    page: {
                        pageNumber,
                        text: `pdfjs page ${pageNumber}`,
                    },
                });
                if (fake.pdfjsRelease) await Promise.race([
                    fake.pdfjsRelease,
                    new Promise<void>(resolve => {
                        if (options.signal?.aborted) resolve();
                        else options.signal?.addEventListener('abort', () => resolve(), {once: true});
                    }),
                ]);
                if (options.signal?.aborted) break;
            }
            return undefined;
        } finally {
            await fake.workerStopped;
            fake.workerActive--;
        }
    },
}));

const {streamPdfPageTexts} = await import('@electron/features/search/pdfPageTexts');
const {buildSearchIndex} = await import('@electron/features/search/searchIndex');
const {readDocumentTextSnapshot} = await import('@electron/features/ocr/main/documentText');

afterEach(() => {
    fake.nativeTextStarted = null;
    fake.nativeTextFailure = null;
    fake.pageTexts = new Map();
    fake.evbOcrText = null;
    fake.visibilityStarted = null;
    fake.visibilityRelease = null;
    fake.pdftotextRanges = [];
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
    it('reports a read page while grouped visibility is pending and keeps progress monotonic', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-progress-'));
        fake.evbOcrText = 'recognized first page';
        fake.pageTexts.set(1, 'layout fragments');
        fake.pageTexts.set(512, 'last page');
        fake.indexCoverage = {
            pageCount: 512,
            pagesScanned: 512,
            pagesWritten: 2,
            truncated: false,
            missingTextPageSample: [],
        };
        let release!: () => void;
        fake.visibilityRelease = new Promise((resolve) => {
            release = resolve;
        });
        const inspecting = new Promise<void>((resolve) => {
            fake.visibilityStarted = resolve;
        });
        const progress: number[] = [];
        const indexed = buildSearchIndex({
            indexPath: join(directory, 'index'),
            documentRevision: 'revision',
            readPageCount: () => Promise.resolve(512),
            readPages: (signal, pageCount, onProgress) => streamPdfPageTexts(
                join(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'),
                {
                    signal,
                    ...(pageCount === undefined ? {} : {lastPage: pageCount}),
                },
                onProgress,
            ),
        }, pageNumber => progress.push(pageNumber));
        try {
            await inspecting;
            expect([...progress]).toEqual([1]);
            release();
            await indexed;
            expect(progress.at(-1)).toBe(512);
            expect(progress.every((pageNumber, index) => pageNumber >= (progress[index - 1] ?? 0))).toBe(true);
            expect(JSON.parse(fake.indexLines[0]!)).toEqual({
                pageNumber: 1,
                text: 'recognized first page',
            });
        } finally {
            release();
            await indexed;
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('streams the PDF.js reading of a window Poppler lacks CJK data for', async () => {
        fake.pageTexts.set(1, 'poppler 1');
        fake.pageTexts.set(2, 'poppler 2');
        fake.missingCjkDataPages.add(2);
        let release!: () => void;
        fake.pdfjsRelease = new Promise((resolve) => {
            release = resolve;
        });

        const pages = streamPdfPageTexts(join(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
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

describe('document text snapshot budget', () => {
    it('rejects a snapshot at the page that crosses the budget and reads no later page window', async () => {
        for (let pageNumber = 1; pageNumber <= 1_000; pageNumber += 1) {
            fake.pageTexts.set(pageNumber, Array.from({length: 2_500}, (_, word) => `p${pageNumber}w${word}`).join(' '));
        }

        await expect(readDocumentTextSnapshot(
            '/working-copy/document.pdf',
            join(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'),
            requireDocumentRevisionToken('revision'),
            1_000,
        )).rejects.toThrow(`Document text exceeds ${MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH} characters; export it in page windows`);
        // Page 363 crosses 8 MiB of text, inside the second 256-page window.
        expect(fake.pdftotextRanges).toEqual([
            '1-256',
            '257-512',
        ]);
    });
});

// The native boundary supplies a valid capped index; the real service and job
// registry must deliver that fact through results and terminal renderer events.
describe('search service coverage', () => {
    it.each([
        false,
        true,
    ])('retains capped coverage (warmup: %s)', async (warmup) => {
        fake.indexCoverage = {
            pageCount: 3,
            pagesScanned: 2,
            pagesWritten: 1,
            truncated: true,
            missingTextPageSample: [],
        };
        const sender = Object.assign(new EventEmitter(), {
            id: 71,
            send: vi.fn(),
            isDestroyed: () => false,
        });
        const {createSearchService} = await import('@electron/features/search/main/searchService');
        const service = createSearchService();
        try {
            service.subscribeProgress({sender: sender as never});
            const response = await service.run({sender: sender as never}, {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
                requestIdPrefix: 'coverage',
                query: 'last-page-only',
                warmup,
                pageCount: 3,
                resolveDocument: async () => ({
                    indexPath: '/unused/index',
                    documentRevision: 'revision',
                    async* readPages() {},
                }),
            });
            expect(response).toEqual({
                results: [],
                truncated: false,
                coverage: fake.indexCoverage,
            });
            const events = vi.mocked(sender.send).mock.calls.map(call => call[1]);
            expect(events).toContainEqual(expect.objectContaining({
                processed: 2,
                total: 3,
                status: 'success',
                coverage: fake.indexCoverage,
            }));
        } finally {
            await service.shutdown();
        }
    });

    // Split panes in one window share one renderer; each pane owns its own search.
    it('keeps one pane searching while another pane of the same window searches', async () => {
        fake.indexCoverage = {
            pageCount: 1,
            pagesScanned: 1,
            pagesWritten: 1,
            truncated: false,
            missingTextPageSample: [],
        };
        const sender = Object.assign(new EventEmitter(), {
            id: 72,
            send: vi.fn(),
            isDestroyed: () => false,
        });
        const document = {
            indexPath: '/unused/index',
            documentRevision: 'revision',
            async* readPages() {},
        };
        const firstPaneDocument = Promise.withResolvers<typeof document>();
        const request = (requestId: string, resolveDocument: (signal: AbortSignal) => Promise<typeof document>) => ({
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            requestId: requireRequestId(requestId),
            requestIdPrefix: 'search',
            query: 'needle',
            resolveDocument,
        });
        const {createSearchService} = await import('@electron/features/search/main/searchService');
        const service = createSearchService();
        try {
            const firstPane = service.run({sender: sender as never}, request('first-pane', () => firstPaneDocument.promise));
            const found = {
                results: [],
                truncated: false,
                coverage: fake.indexCoverage,
            };
            await expect(service.run({sender: sender as never}, request('second-pane', async () => document))).resolves.toEqual(found);
            firstPaneDocument.resolve(document);
            await expect(firstPane).resolves.toEqual(found);

            const unnamed = service.run({sender: sender as never}, request('canceled-pane', signal => new Promise((_resolve, reject) => {
                const abort = () => reject(new Error('Search canceled'));
                if (signal.aborted) abort();
                signal.addEventListener('abort', abort, {once: true});
            })));
            expect(service.cancel({sender: sender as never})).toEqual({canceled: true});
            await expect(unnamed).resolves.toMatchObject({canceled: true});
        } finally {
            await service.shutdown();
        }
    });

    // A reloaded page starts with no search state, so its old requests have no reader.
    it.each([
        'did-start-navigation',
        'render-process-gone',
        'destroyed',
    ])('stops the searches of a page that goes away (%s)', async (end) => {
        const sender = Object.assign(new EventEmitter(), {
            id: 73,
            send: vi.fn(),
            isDestroyed: () => false,
        });
        const started = Promise.withResolvers<AbortSignal>();
        const {createSearchService} = await import('@electron/features/search/main/searchService');
        const service = createSearchService();
        try {
            const search = service.run({sender: sender as never}, {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
                requestId: requireRequestId('reloaded-page'),
                requestIdPrefix: 'search',
                query: 'needle',
                resolveDocument: signal => new Promise((_resolve, reject) => {
                    started.resolve(signal);
                    signal.addEventListener('abort', () => reject(new Error('Search canceled')), {once: true});
                }),
            });
            const signal = await started.promise;

            sender.emit(end, {}, 'app://renderer/', false, true);

            expect(signal.aborted).toBe(true);
            await expect(search).resolves.toMatchObject({canceled: true});
        } finally {
            await service.shutdown();
        }
    });
});


describe('PDF.js admission and producer cancellation (native-seam test)', () => {
    const request = (signal?: AbortSignal) => ({
        ownerId: 'occupied-capacity',
        kind: 'test-blocker',
        priority: 'background' as const,
        resources: {
            cpuTokens: 1,
            nativeProcesses: 0,
            estimatedResidentBytes: 256 * 1024 * 1024,
            ioWeight: 1,
        },
        ...(signal ? {signal} : {}),
    });
    const path = () => join(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
    function useFallback() { fake.pageTexts.set(1, 'Poppler text'); fake.missingCjkDataPages.add(1); }

    it('never constructs a queued fallback worker after the producer signal is canceled', async () => {
        useFallback();
        const broker = fake.broker!;
        const blocker = await broker.acquire(request());
        const controller = new AbortController();
        const pages = streamPdfPageTexts(path(), {signal: controller.signal});
        const pending = pages.next();
        const observed = pending.catch((error: unknown) => error);
        await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));
        expect(fake.workerActive).toBe(0);
        const reason = new Error('queued document closed');
        controller.abort(reason);
        expect(await observed).toBe(reason);
        await pages.return(undefined);
        blocker.release();
        expect(fake.pdfjsPages).toEqual([]);
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('awaits an active fallback worker exit before returning its paid vector', async () => {
        useFallback();
        const broker = fake.broker!;
        const producer = Promise.withResolvers<undefined>();
        const terminated = Promise.withResolvers<undefined>();
        fake.pdfjsRelease = producer.promise;
        fake.workerStopped = terminated.promise;
        const pages = streamPdfPageTexts(path());
        expect((await pages.next()).value).toMatchObject({pageNumber: 1});
        const leaving = pages.return(undefined);
        const controller = new AbortController();
        const competitor = broker.acquire(request(controller.signal));
        await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));
        expect(fake.workerActive).toBe(1);
        expect(broker.getSnapshot().active).toBe(1);
        terminated.resolve(undefined); producer.resolve(undefined);
        await leaving;
        const lease = await competitor;
        expect(fake.workerActive).toBe(0);
        lease.release();
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('does not start a queued worker after a bare iterator return', async () => {
        useFallback();
        const broker = fake.broker!;
        const blocker = await broker.acquire(request());
        const pages = streamPdfPageTexts(path());
        const first = pages.next();
        await vi.waitFor(() => expect(broker.getSnapshot().queued).toBe(1));
        const leaving = pages.return(undefined);
        // Release the test blocker so even a broken implementation settles and can be reported.
        // A pending async-generator next() otherwise prevents its return() finally from running.
        blocker.release();
        await first; await leaving;
        expect(fake.pdfjsPages).toEqual([]);
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it.each([
        false,
        true,
    ])('keeps the native termination outcome when a bare return cancels a pending read (marked: %s)', async marked => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        const started = Promise.withResolvers<undefined>();
        const error = new Error('pdftotext cancelled');
        if (marked) markUnprovenNativeTermination(error, 'native reader did not settle');
        fake.pageTexts.set(1, 'native text');
        fake.nativeTextStarted = () => started.resolve(undefined);
        fake.nativeTextFailure = error;
        const pages = streamPdfPageTexts(path());
        const pending = pages.next().catch((cause: unknown) => cause);
        await started.promise;
        const leaving = pages.return(undefined);
        try {
            if (marked) expect(await pending).toBe(error);
            else expect(await pending).toEqual({
                value: undefined,
                done: true,
            });
        } finally {
            await leaving;
        }
    });
});
