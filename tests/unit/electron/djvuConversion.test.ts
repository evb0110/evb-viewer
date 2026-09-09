import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

type TMockListener = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
    class MockEmitter {
        private readonly listeners = new Map<string, Set<TMockListener>>();

        on(event: string, listener: TMockListener) {
            const eventListeners = this.listeners.get(event) ?? new Set<TMockListener>();
            eventListeners.add(listener);
            this.listeners.set(event, eventListeners);
            return this;
        }

        removeListener(event: string, listener: TMockListener) {
            this.listeners.get(event)?.delete(listener);
            return this;
        }

        emit(event: string, ...args: unknown[]) {
            for (const listener of this.listeners.get(event) ?? []) {
                listener(...args);
            }
        }

        unpipe = vi.fn();

        destroy = vi.fn();
    }

    class MockProcess extends MockEmitter {
        readonly stdout = new MockEmitter();

        readonly stderr = new MockEmitter();

        readonly pid: number;

        readonly kill = vi.fn();

        constructor(pid: number) {
            super();
            this.pid = pid;
        }

        close(code: number | null = 0) {
            this.emit('close', code);
        }
    }

    interface ISpawnCall {
        command: string;
        args: string[];
        proc: MockProcess;
    }
    type TSpawnMode = 'success' | 'fail-ranges' | 'fail-merge' | 'hang-ranges' | 'hang-merge' | 'hang-registered' | 'million-page-progress';

    const spawnCalls: ISpawnCall[] = [];
    let spawnMode: TSpawnMode = 'success';
    let quotaFailure: Error | null = null;
    let nextPid = 1000;

    function isRangeDdjvuCall(command: string, args: string[]) {
        return command === '/tools/ddjvu' && args.some(arg => arg.startsWith('-page='));
    }

    function isQpdfCall(command: string) {
        return command === '/tools/qpdf';
    }

    function isRegisteredCombineCall(command: string) {
        return command === '/tools/evb-pdf-image-combine';
    }

    const spawn = vi.fn((command: string, args: string[]) => {
        const proc = new MockProcess(nextPid++);
        const call = {
            command,
            args,
            proc,
        };
        spawnCalls.push(call);

        queueMicrotask(() => {
            if (spawnMode === 'hang-ranges' && isRangeDdjvuCall(command, args)) {
                return;
            }
            if (spawnMode === 'hang-merge' && isQpdfCall(command)) {
                return;
            }
            if (spawnMode === 'hang-registered' && isRegisteredCombineCall(command)) {
                return;
            }
            if (spawnMode === 'million-page-progress' && command === '/tools/ddjvu' && args.includes('-page=1-1000000')) {
                const totalPages = 1_000_000;
                const pagesPerChunk = 4_096;
                for (let startPage = 1; startPage <= totalPages; startPage += pagesPerChunk) {
                    const endPage = Math.min(totalPages, startPage + pagesPerChunk - 1);
                    let chunk = '';
                    for (let page = startPage; page <= endPage; page += 1) {
                        chunk += `-------- page ${page}\n`;
                    }
                    proc.stderr.emit('data', Buffer.from(chunk));
                }
                proc.close(0);
                return;
            }
            if (spawnMode === 'fail-ranges' && isRangeDdjvuCall(command, args)) {
                proc.stderr.emit('data', Buffer.from('range conversion failed'));
                proc.close(1);
                return;
            }
            if (spawnMode === 'fail-merge' && isQpdfCall(command)) {
                proc.stderr.emit('data', Buffer.from('merge failed'));
                proc.close(1);
                return;
            }
            proc.close(0);
        });

        return proc;
    });
    const createDjvuDiskQuotaMonitor = vi.fn(async (options: {signal?: AbortSignal;}) => {
        const controller = new AbortController();
        const signal = options.signal
            ? AbortSignal.any([
                options.signal,
                controller.signal,
            ])
            : controller.signal;
        return {
            signal,
            async checkNow() {
                if (quotaFailure) {
                    controller.abort(quotaFailure);
                    throw quotaFailure;
                }
            },
            get failure() {
                return quotaFailure;
            },
            stop: vi.fn(async () => undefined),
        };
    });

    return {
        spawn,
        spawnCalls,
        setSpawnMode: (mode: TSpawnMode) => {
            spawnMode = mode;
        },
        setQuotaFailure: (error: Error | null) => {
            quotaFailure = error;
        },
        createDjvuDiskQuotaMonitor,
        mkdtemp: vi.fn(async () => '/tmp/djvu-pages-test'),
        readFile: vi.fn(),
        rm: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({size: 4096})),
        unlink: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        existsSync: vi.fn(() => true),
        terminateDetachedChildProcess: vi.fn(async (proc: MockProcess) => {
            proc.close(143);
        }),
        loggerWarn: vi.fn(),
    };
});

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('fs', () => ({existsSync: mocks.existsSync}));
vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));
vi.mock('os', () => ({tmpdir: () => '/tmp'}));
vi.mock('@electron/resources/hostResourceProfile', () => ({getHostResourceProfileSnapshot: () => ({
    logicalCpus: 5,
    totalRamBytes: 16 * 1024 * 1024 * 1024,
    safeMode: false,
    detectedTier: 'medium',
    performanceMode: 'auto',
    tier: 'medium',
})}));
vi.mock('@electron/features/djvu/main/buildDjvuRuntimeEnv', () => ({buildDjvuRuntimeEnv: () => ({PATH: '/bin'})}));
vi.mock('@electron/features/djvu/main/nativeToolPaths', () => ({getDjvuNativeToolPaths: () => ({
    ddjvu: '/tools/ddjvu',
    djvused: '/tools/djvused',
})}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({qpdf: '/tools/qpdf'}),
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.loggerWarn,
})}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));
vi.mock('@electron/features/djvu/main/djvuArtifactManifest', () => ({
    DJVU_ARTIFACT_MAX_TOTAL_BYTES: 4 * 1024 * 1024 * 1024,
    createDjvuDiskQuotaMonitor: mocks.createDjvuDiskQuotaMonitor,
    openDjvuArtifactJob: vi.fn(async (_sourcePath: string, ranges: Array<{
        startPage: number;
        endPage: number;
    }>) => {
        const manifest = {ranges: ranges.map(range => ({
            ...range,
            outputPath: `/tmp/djvu-pages-test/pages-${range.startPage}-${range.endPage}.pdf`,
            status: 'pending' as const,
        }))};
        return {
            directory: '/tmp/djvu-pages-test',
            manifestPath: '/tmp/djvu-pages-test/manifest.json',
            manifest,
            maxTotalBytes: 4 * 1024 * 1024 * 1024,
            close: vi.fn(async () => {}),
            updateRange: vi.fn(async (index: number, update: object) => {
                Object.assign(manifest.ranges[index]!, update);
            }),
        };
    }),
}));

const {
    cancelConversion,
    convertDjvuToPdfFile,
    renderDjvuPageToImage,
    resolveDjvuRangeWorkerCount,
    runRegisteredDjvuProcess,
} = await import('@electron/features/djvu/main/ddjvuConversion');
const { PdfCombineCapabilityError } = await import('@electron/image/pdfCombineErrors');
const { configureMainJobBroker } = await import('@electron/resources/jobBroker');

configureMainJobBroker({
    logicalCpus: 5,
    totalRamBytes: 16 * 1024 * 1024 * 1024,
    safeMode: false,
    detectedTier: 'medium',
    performanceMode: 'auto',
    tier: 'medium',
});

describe('resolveDjvuRangeWorkerCount', () => {
    it('does not clamp a two-core host up to two conversion workers', () => {
        expect(resolveDjvuRangeWorkerCount(25, 2, 'medium')).toBe(1);
        expect(resolveDjvuRangeWorkerCount(25, 1, 'high')).toBe(1);
    });

    it('keeps one core free and respects the page count', () => {
        expect(resolveDjvuRangeWorkerCount(25, 5, 'medium')).toBe(4);
        expect(resolveDjvuRangeWorkerCount(2, 16, 'high')).toBe(2);
    });

    it('clamps low-tier range conversion to one worker', () => {
        expect(resolveDjvuRangeWorkerCount(25, 16, 'low')).toBe(1);
        expect(resolveDjvuRangeWorkerCount(0, 16, 'low')).toBe(0);
    });
});

describe('convertDjvuToPdfFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.spawnCalls.length = 0;
        mocks.setSpawnMode('success');
        mocks.setQuotaFailure(null);
    });

    it('splits large full-document conversions into parallel native page ranges', async () => {
        const progress = vi.fn();

        const result = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-1', {
            pageCount: 25,
            onProgress: progress,
        });

        expect(result).toEqual({
            success: true,
            outputPath: '/output.pdf',
            fileSize: 4096,
        });
        const ddjvuCalls = mocks.spawnCalls.filter(call => call.command === '/tools/ddjvu');
        expect(ddjvuCalls.map(call => call.args.find(arg => arg.startsWith('-page=')))).toEqual([
            '-page=1-7',
            '-page=8-13',
            '-page=14-19',
            '-page=20-25',
        ]);
        expect(mocks.spawnCalls.at(-1)).toMatchObject({
            command: '/tools/qpdf',
            args: [
                '--empty',
                '--pages',
                '/tmp/djvu-pages-test/pages-1-7.pdf',
                '/tmp/djvu-pages-test/pages-8-13.pdf',
                '/tmp/djvu-pages-test/pages-14-19.pdf',
                '/tmp/djvu-pages-test/pages-20-25.pdf',
                '--',
                '/output.pdf',
            ],
        });
        expect(progress).toHaveBeenLastCalledWith(95);
        expect(mocks.rm).not.toHaveBeenCalledWith('/tmp/djvu-pages-test', expect.anything());
    });

    it('keeps small conversions on the single native process path', async () => {
        await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-2', {pageCount: 4});

        expect(mocks.spawnCalls).toHaveLength(1);
        expect(mocks.spawnCalls[0]).toMatchObject({
            command: '/tools/ddjvu',
            args: [
                '-format=pdf',
                '-verbose',
                '/input.djvu',
                '/output.pdf',
            ],
        });
    });

    it('reports million-page single-process progress without page-sized state', async () => {
        mocks.setSpawnMode('million-page-progress');
        const totalPages = 1_000_000;
        let progressCalls = 0;
        let lastProgress = 0;
        let progressDecreased = false;

        const result = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-million-page-progress', {
            pageCount: totalPages,
            pages: `1-${totalPages}`,
            onProgress: percent => {
                progressCalls += 1;
                progressDecreased ||= percent < lastProgress;
                lastProgress = percent;
            },
        });

        expect(result).toEqual({
            success: true,
            outputPath: '/output.pdf',
            fileSize: 4096,
        });
        expect(progressCalls).toBe(totalPages);
        expect(lastProgress).toBe(90);
        expect(progressDecreased).toBe(false);
        expect(mocks.spawnCalls).toHaveLength(1);
    });

    it('fails a small explicit-page conversion when the live output quota is crossed', async () => {
        mocks.setQuotaFailure(new Error('DjVu disk quota exceeded: simulated ENOSPC'));

        const result = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-small-quota', {
            pageCount: 24,
            pages: '2',
        });

        expect(result).toMatchObject({
            success: false,
            error: 'DjVu disk quota exceeded: simulated ENOSPC',
        });
        expect(mocks.spawnCalls).toHaveLength(1);
        expect(mocks.unlink).toHaveBeenCalledWith('/output.pdf');
    });

    it('renders requested DjVu page modes through registered ddjvu processes', async () => {
        const result = await renderDjvuPageToImage('/input.djvu', '/mask.pbm', 7, 'job-mask', {
            format: 'pbm',
            mode: 'mask',
        });

        expect(result).toEqual({
            success: true,
            outputPath: '/mask.pbm',
            fileSize: 4096,
        });
        expect(mocks.spawnCalls).toHaveLength(1);
        expect(mocks.spawnCalls[0]).toMatchObject({
            command: '/tools/ddjvu',
            args: [
                '-format=pbm',
                '-page=7',
                '-mode=mask',
                '/input.djvu',
                '/mask.pbm',
            ],
        });
    });

    it('falls back to the single process path when parallel range conversion fails', async () => {
        mocks.setSpawnMode('fail-ranges');

        const result = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-3', {pageCount: 24});

        expect(result.success, result.error).toBe(true);
        expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to single process'));
        expect(mocks.unlink).toHaveBeenCalledWith('/output.pdf');
        expect(mocks.spawnCalls.filter(call => call.command === '/tools/ddjvu')).toHaveLength(5);
        expect(mocks.spawnCalls.at(-1)).toMatchObject({
            command: '/tools/ddjvu',
            args: [
                '-format=pdf',
                '-verbose',
                '/input.djvu',
                '/output.pdf',
            ],
        });
    });

    it('never falls back to an unbounded single process after a parallel quota failure', async () => {
        mocks.setQuotaFailure(new Error('DjVu disk quota exceeded: simulated range growth'));

        const result = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-range-quota', {pageCount: 24});

        expect(result).toMatchObject({
            success: false,
            error: 'DjVu disk quota exceeded: simulated range growth',
        });
        expect(mocks.spawnCalls.filter(call => (
            call.command === '/tools/ddjvu'
            && !call.args.some(arg => arg.startsWith('-page='))
        ))).toHaveLength(0);
        expect(mocks.loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('falling back to single process'));
    });

    it.each([
        {
            label: 'the former 256-page threshold',
            pageCount: 256,
            chunkSize: 4096,
        },
        {
            label: 'the former 256 MiB threshold',
            pageCount: 24,
            chunkSize: 257 * 1024 * 1024,
        },
    ])('returns a typed native capability error at $label without a byte fallback', async ({
        chunkSize,
        pageCount,
    }) => {
        mocks.setSpawnMode('fail-merge');
        mocks.stat.mockImplementation(async (...args: unknown[]) => ({size: String(args[0]).includes('/tmp/djvu-pages-test/') ? chunkSize : 4096}));

        const error = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-large-merge', { pageCount })
            .catch((caughtError: unknown) => caughtError);

        expect(error).toBeInstanceOf(PdfCombineCapabilityError);
        expect(error).toMatchObject({
            code: 'native-failure',
            name: 'PdfCombineCapabilityError',
            operation: 'djvu-pdf-merge',
            cause: expect.any(Error),
        });

        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.spawnCalls.filter(call => (
            call.command === '/tools/ddjvu'
            && !call.args.some(arg => arg.startsWith('-page='))
        ))).toHaveLength(0);
        expect(mocks.spawnCalls.at(-1)).toMatchObject({command: '/tools/qpdf'});
    });

    it('does not restart a canceled parallel conversion as a single-process conversion', async () => {
        mocks.setSpawnMode('hang-ranges');

        const convertPromise = convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-4', {pageCount: 24});
        await vi.waitFor(() => {
            expect(mocks.spawnCalls.length).toBeGreaterThan(0);
        });

        const canceled = await cancelConversion('job-4');
        const result = await convertPromise;

        expect(canceled).toBe(true);
        expect(result).toEqual({
            success: false,
            outputPath: '/output.pdf',
            fileSize: 0,
            error: 'DjVu conversion canceled',
        });
        expect(mocks.spawnCalls.filter(call => (
            call.command === '/tools/ddjvu'
            && !call.args.some(arg => arg.startsWith('-page='))
        ))).toHaveLength(0);
    });

    it('does not run a byte merge fallback after qpdf merge cancellation', async () => {
        mocks.setSpawnMode('hang-merge');

        const convertPromise = convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-merge-cancel', {pageCount: 24});
        await vi.waitFor(() => {
            expect(mocks.spawnCalls.some(call => call.command === '/tools/qpdf')).toBe(true);
        });

        const canceled = await cancelConversion('job-merge-cancel');
        const result = await convertPromise;

        expect(canceled).toBe(true);
        expect(result).toEqual({
            success: false,
            outputPath: '/output.pdf',
            fileSize: 0,
            error: 'DjVu conversion canceled',
        });
        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.spawnCalls.filter(call => (
            call.command === '/tools/ddjvu'
            && !call.args.some(arg => arg.startsWith('-page='))
        ))).toHaveLength(0);
    });

    it('cancels registered compact child processes by parent job prefix', async () => {
        mocks.setSpawnMode('hang-registered');

        const processPromise = runRegisteredDjvuProcess(
            'job-5-compact-combine',
            '/tools/evb-pdf-image-combine',
            [
                '--compact-manifest',
                '/tmp/manifest.tsv',
            ],
        );
        await vi.waitFor(() => {
            expect(mocks.spawnCalls.length).toBe(1);
        });

        const canceled = await cancelConversion('job-5');
        const result = await processPromise;

        expect(canceled).toBe(true);
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            success: false,
            error: 'DjVu conversion canceled',
        });
    });
});
