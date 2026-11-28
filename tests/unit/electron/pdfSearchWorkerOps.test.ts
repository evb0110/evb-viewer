import type * as TFsModule from 'node:fs';
import type * as TFsPromisesModule from 'node:fs/promises';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {encodePdfSearchWasmRequest, PDF_SEARCH_WASM_MAX_INDEX_BYTES} from '@contracts/searchIndexWire';
import {PdfSearchNativeError, type createPdfSearchWasmRunner} from '@electron/features/search/pdfSearchWasmRunner';

interface IFakeHandleScenario {
    statSize: number;
    mtimeMs?: number;
    ctimeMs?: number;
    ino?: number;
    isFile?: boolean;
    totalBytesAvailable?: number;
    maxBytesPerRead?: number;
    readCalls: number;
    totalBytesRequested: number;
    totalBytesRead: number;
    closed: boolean;
}

const fsHooks = vi.hoisted(() => ({
    readFileCalls: 0,
    scenarios: new Map<string, IFakeHandleScenario>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof TFsPromisesModule>();
    return {
        ...actual,
        readFile(path: TFsModule.PathLike | TFsPromisesModule.FileHandle, options?: Parameters<typeof TFsPromisesModule.readFile>[1]) {
            fsHooks.readFileCalls += 1;
            const scenario = fsHooks.scenarios.get(String(path));
            if (scenario) {
                return Promise.reject(new Error('readFile must not be used for search index reads'));
            }
            return actual.readFile(path, options as never);
        },
        stat(path: TFsModule.PathLike, options?: Parameters<typeof TFsPromisesModule.stat>[1]) {
            const scenario = fsHooks.scenarios.get(String(path));
            if (!scenario) {
                return actual.stat(path, options as never);
            }
            return Promise.resolve({
                isFile: () => scenario.isFile ?? true,
                size: scenario.statSize,
                mtimeMs: scenario.mtimeMs ?? 1,
                ctimeMs: scenario.ctimeMs ?? 1,
                ino: scenario.ino ?? 1,
            }) as ReturnType<typeof TFsPromisesModule.stat>;
        },
        async open(path: TFsModule.PathLike, flags?: string | number, mode?: TFsModule.Mode) {
            const scenario = fsHooks.scenarios.get(String(path));
            if (!scenario) {
                return actual.open(path, flags, mode);
            }
            const available = scenario.totalBytesAvailable ?? scenario.statSize;
            const fakeHandle = {
                stat() {
                    return Promise.resolve({
                        isFile: () => scenario.isFile ?? true,
                        size: scenario.statSize,
                        mtimeMs: scenario.mtimeMs ?? 1,
                        ctimeMs: scenario.ctimeMs ?? 1,
                        ino: scenario.ino ?? 1,
                    });
                },
                read(buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position: number | null = 0) {
                    scenario.readCalls += 1;
                    scenario.totalBytesRequested += length;
                    const start = position ?? 0;
                    const remaining = Math.max(0, available - start);
                    const capPerRead = scenario.maxBytesPerRead ?? length;
                    const bytesRead = Math.min(length, remaining, capPerRead);
                    if (bytesRead > 0) {
                        for (let i = 0; i < bytesRead; i += 1) {
                            buffer[offset + i] = (start + i) & 0xff;
                        }
                    }
                    scenario.totalBytesRead += bytesRead;
                    return Promise.resolve({
                        bytesRead,
                        buffer,
                    });
                },
                close() {
                    scenario.closed = true;
                    return Promise.resolve();
                },
            };
            return fakeHandle as unknown as TFsPromisesModule.FileHandle;
        },
    };
});

const {createPdfSearchWorkerIndexCache, executePdfSearchWorkerCommand} = await import('@electron/features/search/pdfSearchWorkerOps');

function createStubRunner(): ReturnType<typeof createPdfSearchWasmRunner> {
    return {
        run: vi.fn(() => new Uint8Array(0)),
        dispose: vi.fn(),
        memoryBytes: () => 0,
    };
}

describe('pdfSearchWorkerOps bounded index reads', () => {
    const directories: string[] = [];

    afterEach(async () => {
        fsHooks.readFileCalls = 0;
        fsHooks.scenarios.clear();
        for (const directory of directories.splice(0)) {
            await rm(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects oversized index files (> 320 MiB) on stat and search from fstat without reading the file', async () => {
        const indexPath = '/virtual/oversized.evb-search-index';
        const runner = createStubRunner();

        for (const command of [
            {
                op: 'stat' as const,
                indexPath,
                documentRevision: 'rev-1',
            },
            {
                op: 'search' as const,
                indexPath,
                documentRevision: 'rev-1',
                query: 'needle',
                limit: 10,
                contextChars: 12,
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
        ]) {
            const scenario: IFakeHandleScenario = {
                statSize: PDF_SEARCH_WASM_MAX_INDEX_BYTES + 1,
                readCalls: 0,
                totalBytesRequested: 0,
                totalBytesRead: 0,
                closed: false,
            };
            fsHooks.scenarios.set(indexPath, scenario);

            const error = await executePdfSearchWorkerCommand(runner, command).catch((err: unknown) => err);
            expect(error).toBeInstanceOf(PdfSearchNativeError);
            expect((error as PdfSearchNativeError).code).toBe('too-large');
            expect(fsHooks.readFileCalls).toBe(0);
            expect(scenario.readCalls).toBe(0);
            expect(scenario.closed).toBe(true);
            expect(runner.run).not.toHaveBeenCalled();
        }
    });

    it('bounds reads to cap + 1 bytes when an index file grows concurrently past the cap', async () => {
        const indexPath = '/virtual/growing.evb-search-index';
        const cap = 1024;
        const scenario: IFakeHandleScenario = {
            statSize: 128,
            totalBytesAvailable: cap * 10,
            readCalls: 0,
            totalBytesRequested: 0,
            totalBytesRead: 0,
            closed: false,
        };
        fsHooks.scenarios.set(indexPath, scenario);
        const runner = createStubRunner();

        const error = await executePdfSearchWorkerCommand(
            runner,
            {
                op: 'search',
                indexPath,
                documentRevision: 'rev-1',
                query: 'needle',
                limit: 10,
                contextChars: 12,
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            {maxIndexBytes: cap},
        ).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(PdfSearchNativeError);
        expect((error as PdfSearchNativeError).code).toBe('too-large');
        expect(scenario.totalBytesRead).toBeLessThanOrEqual(cap + 1);
        expect(scenario.totalBytesRequested).toBeLessThanOrEqual(cap + 1);
        expect(scenario.closed).toBe(true);
        expect(runner.run).not.toHaveBeenCalled();
    });

    it('returns stale for a missing index file and io error for a directory path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-ops-'));
        directories.push(directory);
        const missingPath = join(directory, 'missing.evb-search-index');
        const subDir = join(directory, 'dir-as-index');
        await mkdir(subDir);
        const runner = createStubRunner();

        await expect(
            executePdfSearchWorkerCommand(runner, {
                op: 'stat',
                indexPath: missingPath,
                documentRevision: 'rev-1',
            }),
        ).resolves.toEqual({stale: true});

        const dirError = await executePdfSearchWorkerCommand(runner, {
            op: 'stat',
            indexPath: subDir,
            documentRevision: 'rev-1',
        }).catch((err: unknown) => err);
        expect(dirError).toBeInstanceOf(PdfSearchNativeError);
        expect((dirError as PdfSearchNativeError).code).toBe('io');
    });

    it('reads a real on-disk index file up to the exact cap and passes exact bytes to the runner', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-ops-'));
        directories.push(directory);
        const indexPath = join(directory, 'exact.evb-search-index');
        const payload = Buffer.from(Array.from({length: 512}, (_, index) => (index * 31 + 7) & 0xff));
        await writeFile(indexPath, payload);

        let capturedRequest: Uint8Array | null = null;
        const runner: ReturnType<typeof createPdfSearchWasmRunner> = {
            run: vi.fn((request: Uint8Array) => {
                capturedRequest = request;
                return Buffer.from(
                    JSON.stringify({
                        pageCount: 1,
                        pagesScanned: 1,
                        pagesWritten: 1,
                        truncated: false,
                        missingTextPageSample: [],
                    }),
                );
            }),
            dispose: vi.fn(),
            memoryBytes: () => 0,
        };

        const result = await executePdfSearchWorkerCommand(
            runner,
            {
                op: 'stat',
                indexPath,
                documentRevision: 'rev-1',
            },
            {maxIndexBytes: 512},
        );
        expect(result).toEqual({
            pageCount: 1,
            pagesScanned: 1,
            pagesWritten: 1,
            truncated: false,
            missingTextPageSample: [],
        });
        expect(capturedRequest).not.toBeNull();
        expect(Buffer.from(capturedRequest!)).toEqual(
            Buffer.from(
                encodePdfSearchWasmRequest(
                    {
                        op: 'stat',
                        documentRevision: 'rev-1',
                    },
                    payload,
                ),
            ),
        );
    });

    it('packs repeated short growth reads cleanly and rejects invalid maxIndexBytes overrides', async () => {
        const indexPath = '/virtual/short-reads.evb-search-index';
        const scenario: IFakeHandleScenario = {
            statSize: 16,
            totalBytesAvailable: 80,
            maxBytesPerRead: 3,
            readCalls: 0,
            totalBytesRequested: 0,
            totalBytesRead: 0,
            closed: false,
        };
        fsHooks.scenarios.set(indexPath, scenario);

        let capturedRequest: Uint8Array | null = null;
        const runner: ReturnType<typeof createPdfSearchWasmRunner> = {
            run: vi.fn((request: Uint8Array) => {
                capturedRequest = request;
                return Buffer.from(
                    JSON.stringify({
                        pageCount: 1,
                        pagesScanned: 1,
                        pagesWritten: 1,
                        truncated: false,
                        missingTextPageSample: [],
                    }),
                );
            }),
            dispose: vi.fn(),
            memoryBytes: () => 0,
        };

        await executePdfSearchWorkerCommand(
            runner,
            {
                op: 'stat',
                indexPath,
                documentRevision: 'rev-1',
            },
            {maxIndexBytes: 128},
        );
        expect(scenario.closed).toBe(true);
        expect(capturedRequest).not.toBeNull();
        const expectedPayload = Uint8Array.from({length: 80}, (_, i) => i & 0xff);
        expect(Buffer.from(capturedRequest!)).toEqual(
            Buffer.from(
                encodePdfSearchWasmRequest(
                    {
                        op: 'stat',
                        documentRevision: 'rev-1',
                    },
                    expectedPayload,
                ),
            ),
        );

        const invalidCapError = await executePdfSearchWorkerCommand(
            runner,
            {
                op: 'stat',
                indexPath,
                documentRevision: 'rev-1',
            },
            {maxIndexBytes: Number.NaN},
        ).catch((err: unknown) => err);
        expect(invalidCapError).toBeInstanceOf(PdfSearchNativeError);
        expect((invalidCapError as PdfSearchNativeError).code).toBe('invalid-request');
    });

    it('caches index bytes in-worker across repeated queries without re-reading disk, and evicts on new revision, evict op, byte cap, idle, and pressure', async () => {
        const indexPath = '/virtual/cached.evb-search-index';
        const scenario: IFakeHandleScenario = {
            statSize: 64,
            readCalls: 0,
            totalBytesRequested: 0,
            totalBytesRead: 0,
            closed: false,
        };
        fsHooks.scenarios.set(indexPath, scenario);

        const indexCache = createPdfSearchWorkerIndexCache({maxBytes: 128, idleTtlMs: 50});
        let runnerMemory = 1024;
        const runner: ReturnType<typeof createPdfSearchWasmRunner> = {
            run: vi.fn(() =>
                Buffer.from(
                    JSON.stringify({
                        results: [],
                        truncated: false,
                        coverage: {
                            pageCount: 1,
                            pagesScanned: 1,
                            pagesWritten: 1,
                            truncated: false,
                            missingTextPageSample: [],
                        },
                    }),
                ),
            ),
            dispose: vi.fn(),
            memoryBytes: () => runnerMemory,
        };

        const searchCmd = (documentRevision: string) => ({
            op: 'search' as const,
            indexPath,
            documentRevision,
            query: 'needle',
            limit: 10,
            contextChars: 12,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        });

        // Cold search reads disk once and populates worker cache.
        await executePdfSearchWorkerCommand(runner, searchCmd('rev-1'), {indexCache});
        expect(scenario.readCalls).toBeGreaterThan(0);
        const readsAfterCold = scenario.readCalls;
        expect(indexCache.stats()).toEqual({entryCount: 1, totalBytes: 64});

        // Second search for the same revision hits in-worker cache with zero disk reads.
        await executePdfSearchWorkerCommand(runner, searchCmd('rev-1'), {indexCache});
        expect(scenario.readCalls).toBe(readsAfterCold);

        // Searching a different revision immediately evicts rev-1 and reads disk again.
        await executePdfSearchWorkerCommand(runner, searchCmd('rev-2'), {indexCache});
        expect(scenario.readCalls).toBeGreaterThan(readsAfterCold);
        const readsAfterRev2 = scenario.readCalls;

        // Explicit evict op removes the cached document entry.
        await executePdfSearchWorkerCommand(runner, {op: 'evict', indexPath}, {indexCache});
        expect(indexCache.stats()).toEqual({entryCount: 0, totalBytes: 0});
        await executePdfSearchWorkerCommand(runner, searchCmd('rev-2'), {indexCache});
        expect(scenario.readCalls).toBeGreaterThan(readsAfterRev2);

        // Byte-bounded LRU eviction drops oldest documents to stay <= maxBytes (128).
        indexCache.set('/virtual/doc-b.idx', 'rev-1', new Uint8Array(64));
        expect(indexCache.stats().totalBytes).toBe(128);
        indexCache.set('/virtual/doc-c.idx', 'rev-1', new Uint8Array(64));
        expect(indexCache.stats().totalBytes).toBe(128);
        expect(indexCache.get(indexPath, 'rev-2', 1024)).toBeNull();
        expect(indexCache.get('/virtual/doc-c.idx', 'rev-1', 1024)).not.toBeNull();

        // WASM memory pressure (memoryBytes dropping from >0 to 0) evicts cached entries.
        runner.run = vi.fn(() => {
            runnerMemory = 0;
            return Buffer.from(
                JSON.stringify({
                    pageCount: 1,
                    pagesScanned: 1,
                    pagesWritten: 1,
                    truncated: false,
                    missingTextPageSample: [],
                }),
            );
        });
        await executePdfSearchWorkerCommand(
            runner,
            {
                op: 'stat',
                indexPath: '/virtual/doc-c.idx',
                documentRevision: 'rev-1',
            },
            {indexCache},
        );
        expect(indexCache.stats()).toEqual({entryCount: 0, totalBytes: 0});

        // Idle TTL clears cached entries automatically.
        vi.useFakeTimers();
        try {
            indexCache.set('/virtual/idle.idx', 'rev-1', new Uint8Array(32));
            expect(indexCache.stats().entryCount).toBe(1);
            await vi.advanceTimersByTimeAsync(75);
            expect(indexCache.stats()).toEqual({entryCount: 0, totalBytes: 0});
        } finally {
            vi.useRealTimers();
        }
    });

    it('suppresses a cache fill when eviction arrives while disk I/O is in flight', async () => {
        const indexPath = '/virtual/evict-during-io.evb-search-index';
        const indexCache = createPdfSearchWorkerIndexCache({maxBytes: 1024, idleTtlMs: 0});
        const runner: ReturnType<typeof createPdfSearchWasmRunner> = {
            run: vi.fn(() => {
                // Simulate an eviction control arriving after disk I/O started and before set().
                indexCache.evict(indexPath);
                return Buffer.from(
                    JSON.stringify({
                        pageCount: 1,
                        pagesScanned: 1,
                        pagesWritten: 1,
                        truncated: false,
                        missingTextPageSample: [],
                    }),
                );
            }),
            dispose: vi.fn(),
            memoryBytes: () => 1024,
        };
        fsHooks.scenarios.set(indexPath, {
            statSize: 64,
            readCalls: 0,
            totalBytesRequested: 0,
            totalBytesRead: 0,
            closed: false,
        });

        await executePdfSearchWorkerCommand(
            runner,
            {
                op: 'stat',
                indexPath,
                documentRevision: 'rev-1',
            },
            {indexCache},
        );
        expect(indexCache.stats()).toEqual({entryCount: 0, totalBytes: 0});
    });

    it('re-reads when an index file is replaced on disk with the same revision and returns stale when deleted', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-search-ops-disk-replace-'));
        directories.push(directory);
        const indexPath = join(directory, 'replaceable.evb-search-index');
        const initialBytes = Buffer.from('initial-full-index-bytes');
        await writeFile(indexPath, initialBytes);

        const seenPayloads: Buffer[] = [];
        const runner: ReturnType<typeof createPdfSearchWasmRunner> = {
            run: vi.fn((request: Uint8Array) => {
                const headerLen = new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(8, true);
                seenPayloads.push(Buffer.from(request.subarray(12 + headerLen)));
                return Buffer.from(
                    JSON.stringify({
                        results: [],
                        truncated: false,
                        coverage: {
                            pageCount: 1,
                            pagesScanned: 1,
                            pagesWritten: 1,
                            truncated: false,
                            missingTextPageSample: [],
                        },
                    }),
                );
            }),
            dispose: vi.fn(),
            memoryBytes: () => 1024,
        };
        const indexCache = createPdfSearchWorkerIndexCache({maxBytes: 4096, idleTtlMs: 0});
        const searchCmd = {
            op: 'search' as const,
            indexPath,
            documentRevision: 'rev-same',
            query: 'sample',
            limit: 10,
            contextChars: 12,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        };

        await executePdfSearchWorkerCommand(runner, searchCmd, {indexCache});
        expect(seenPayloads.at(-1)).toEqual(initialBytes);

        // Overwrite the index file on disk with a different payload under the same documentRevision.
        const replacedBytes = Buffer.from('replaced-partial-index');
        await writeFile(indexPath, replacedBytes);
        await executePdfSearchWorkerCommand(runner, searchCmd, {indexCache});
        expect(seenPayloads.at(-1)).toEqual(replacedBytes);

        // Deleting the index file on disk invalidates the worker cache and returns stale.
        await rm(indexPath);
        await expect(executePdfSearchWorkerCommand(runner, searchCmd, {indexCache})).resolves.toEqual({stale: true});
        expect(indexCache.stats()).toEqual({entryCount: 0, totalBytes: 0});
    });
});
