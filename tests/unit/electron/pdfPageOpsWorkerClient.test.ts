import {EventEmitter} from 'node:events';
import type * as TFsModule from 'node:fs';
import type * as TWasmRunnerModule from '@node-runtime/pdfPageOpsWasmRunner';
import type * as TQpdfRunnerModule from '@node-runtime/qpdfWasmRunner';
import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface IMockWorkerRecord {
    emitter: EventEmitter;
    messages: Array<{
        id: number;
        args: string[];
    }>;
    terminateCalls: number;
    terminateImpl?: () => Promise<number>;
    reply: (id: number, stdout?: string) => void;
}

const mocks = vi.hoisted<{
    workers: IMockWorkerRecord[];
    configuredBroker: TJobBrokerModule.JobBroker | null;
    nextTerminateImpl: (() => Promise<number>) | null;
}>(() => ({
    workers: [],
    configuredBroker: null,
    nextTerminateImpl: null,
}));

vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof TFsModule>()),
    existsSync: () => true,
}));

vi.mock('@node-runtime/pdfPageOpsWasmRunner', async (importOriginal) => ({
    ...(await importOriginal<typeof TWasmRunnerModule>()),
    loadPdfPageOpsWasmModule: vi.fn(async () => ({}) as WebAssembly.Module),
}));

vi.mock('@node-runtime/qpdfWasmRunner', async (importOriginal) => ({
    ...(await importOriginal<typeof TQpdfRunnerModule>()),
    loadQpdfWasmModule: vi.fn(async () => ({}) as WebAssembly.Module),
    resolveDesktopQpdfWasmPath: () => '/fake/evb-qpdf.wasm',
    resolveDesktopQpdfMjsPath: () => '/fake/evb-qpdf.mjs',
}));

vi.mock('@electron/resources/jobBroker', async (importOriginal) => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    return {
        ...actual,
        getConfiguredMainJobBroker: () => mocks.configuredBroker,
    };
});

vi.mock('node:worker_threads', () => ({
    Worker: class MockWorker extends EventEmitter {
        private readonly record: IMockWorkerRecord;

        constructor() {
            super();
            const terminateImpl = mocks.nextTerminateImpl ?? undefined;
            mocks.nextTerminateImpl = null;
            this.record = {
                emitter: this,
                messages: [],
                terminateCalls: 0,
                ...(terminateImpl ? {terminateImpl} : {}),
                reply: (id: number, stdout = '{}') => {
                    this.emit('message', {
                        id,
                        ok: true,
                        data: {
                            stdout,
                            stderr: '',
                            exitCode: 0,
                        },
                    });
                },
            };
            mocks.workers.push(this.record);
        }

        ref() {
            return this;
        }

        unref() {
            return this;
        }

        postMessage(message: {id: number; args: string[]}) {
            this.record.messages.push(message);
        }

        terminate() {
            this.record.terminateCalls += 1;
            return this.record.terminateImpl ? this.record.terminateImpl() : Promise.resolve(0);
        }
    },
}));

describe('pdfPageOpsWorkerClient idle eviction', () => {
    beforeEach(() => {
        mocks.workers.length = 0;
        mocks.configuredBroker = null;
        mocks.nextTerminateImpl = null;
        vi.useFakeTimers();
    });

    afterEach(async () => {
        const {shutdownPdfPageOpsWorkers} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        shutdownPdfPageOpsWorkers();
        mocks.configuredBroker = null;
        mocks.nextTerminateImpl = null;
        vi.useRealTimers();
    });

    it('arms idle eviction for an unrelated worker that finishes while a targeted session close waits in the queue', async () => {
        const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        const wasmPath = '/fake/evb-pdf-page-ops.wasm';

        const taskA = runDesktopPageOpsWasm(wasmPath, [
            'ocr-text-visibility',
            '--session-id',
            '42',
            '--input',
            '/fake/a.pdf',
            '--pages',
            '1',
        ]);
        const taskB = runDesktopPageOpsWasm(wasmPath, ['page-geometry', '--input', '/fake/b.pdf', '--page', '1']);

        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.workers).toHaveLength(2);
        const workerA = mocks.workers[0]!;
        const workerB = mocks.workers[1]!;
        expect(workerA.messages).toHaveLength(1);
        expect(workerB.messages).toHaveLength(1);

        const closeA = runDesktopPageOpsWasm(wasmPath, ['ocr-text-visibility', '--close-session', '42']);

        // Worker B finishes while worker A is still busy and the targeted close
        // for session 42 remains queued for worker A.
        workerB.reply(workerB.messages[0]!.id);
        await taskB;

        // Finish worker A's visibility request; worker A then drains its close.
        workerA.reply(workerA.messages[0]!.id);
        await taskA;
        expect(workerA.messages).toHaveLength(2);
        workerA.reply(workerA.messages[1]!.id);
        await closeA;

        // Both idle workers must be evicted once the idle TTL elapses.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(workerA.terminateCalls).toBe(1);
        expect(workerB.terminateCalls).toBe(1);
    });
});

describe('WASM worker JobBroker admission and settlement', () => {
    beforeEach(() => {
        mocks.workers.length = 0;
        mocks.configuredBroker = null;
        mocks.nextTerminateImpl = null;
    });

    afterEach(async () => {
        const {shutdownPdfPageOpsWorkers} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        const {shutdownQpdfWasmWorkers} = await import('@electron/native-tools/qpdfWasmWorkerClient');
        shutdownPdfPageOpsWorkers();
        await shutdownQpdfWasmWorkers();
        mocks.configuredBroker = null;
        mocks.nextTerminateImpl = null;
    });

    it('acquires a leaf broker lease before taking a worker slot for unleased page-ops and qpdf calls', async () => {
        const {JobBroker} = await import('@electron/resources/jobBroker');
        const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        const {runDesktopQpdfWasm} = await import('@electron/native-tools/qpdfWasmWorkerClient');
        const broker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 2,
        });
        mocks.configuredBroker = broker;

        // Hold an active leaf lease so no second leaf can escape while capacity is full.
        const blockingLeaf = await broker.acquire({
            ownerId: 'existing-leaf',
            kind: 'native-command',
            priority: 'user',
            admissionClass: 'leaf',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });

        const pageOpsTask = runDesktopPageOpsWasm('/fake/evb-pdf-page-ops.wasm', [
            'page-geometry',
            '--input',
            '/fake/a.pdf',
            '--page',
            '1',
        ]);
        const qpdfTask = runDesktopQpdfWasm(['--show-npages', '/fake/a.pdf']);
        await Promise.resolve();
        await Promise.resolve();

        // Broker must gate admission BEFORE any worker slot is allocated.
        expect(mocks.workers).toHaveLength(0);
        expect(broker.getSnapshot()).toMatchObject({active: 1, queued: 2});

        blockingLeaf.release();
        await vi.waitFor(() => expect(mocks.workers).toHaveLength(1));
        expect(broker.getSnapshot()).toMatchObject({active: 1, queued: 1});
        mocks.workers[0]!.reply(mocks.workers[0]!.messages[0]!.id, '{"ok":true}');
        await expect(pageOpsTask).resolves.toMatchObject({exitCode: 0});

        await vi.waitFor(() => expect(mocks.workers).toHaveLength(2));
        mocks.workers[1]!.reply(mocks.workers[1]!.messages[0]!.id, '1\n');
        await expect(qpdfTask).resolves.toMatchObject({stdout: '1\n'});
        expect(broker.getSnapshot()).toMatchObject({active: 0, queued: 0});
    });

    it('runs under the exact active parent brokerRun without taking a second lease on page-ops and qpdf', async () => {
        const {JobBroker} = await import('@electron/resources/jobBroker');
        const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        const {runDesktopQpdfWasm} = await import('@electron/native-tools/qpdfWasmWorkerClient');
        const broker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 2,
        });
        mocks.configuredBroker = broker;

        await broker.run(
            {
                ownerId: 'parent-job',
                kind: 'pdf-conformance',
                priority: 'user',
                resources: {
                    cpuTokens: 2,
                    estimatedResidentBytes: 512 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 2,
                },
            },
            async (brokerRun) => {
                const pageOpsPromise = runDesktopPageOpsWasm('/fake/evb-pdf-page-ops.wasm', ['pdf-conformance', '--input', '/fake/a.pdf'], {
                    brokerRun,
                });
                await vi.waitFor(() => expect(mocks.workers).toHaveLength(1));
                expect(broker.getSnapshot()).toMatchObject({active: 1, queued: 0});
                mocks.workers[0]!.reply(mocks.workers[0]!.messages[0]!.id, '{}');
                await pageOpsPromise;

                const qpdfPromise = runDesktopQpdfWasm(['--show-npages', '/fake/a.pdf'], {brokerRun});
                await vi.waitFor(() => expect(mocks.workers).toHaveLength(2));
                expect(broker.getSnapshot()).toMatchObject({active: 1, queued: 0});
                mocks.workers[1]!.reply(mocks.workers[1]!.messages[0]!.id, '3\n');
                await qpdfPromise;
            },
        );
        expect(broker.getSnapshot()).toMatchObject({active: 0, queued: 0});
    });

    it('retains broker charges until worker termination settles and permanently on failed termination proof', async () => {
        const {JobBroker} = await import('@electron/resources/jobBroker');
        const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        const {runDesktopQpdfWasm} = await import('@electron/native-tools/qpdfWasmWorkerClient');
        const broker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 2,
            ioWeight: 2,
        });
        mocks.configuredBroker = broker;

        const terminateGate = Promise.withResolvers<number>();
        mocks.nextTerminateImpl = () => terminateGate.promise;
        const pageOpsAbort = new AbortController();
        const pageOpsPromise = runDesktopPageOpsWasm(
            '/fake/evb-pdf-page-ops.wasm',
            ['page-geometry', '--input', '/fake/a.pdf', '--page', '1'],
            {signal: pageOpsAbort.signal},
        );
        await vi.waitFor(() => expect(mocks.workers).toHaveLength(1));
        pageOpsAbort.abort(new DOMException('canceled', 'AbortError'));
        await Promise.resolve();
        // Worker termination is still pending, so the leaf broker charge stays active.
        expect(broker.getSnapshot()).toMatchObject({active: 1, used: {nativeProcesses: 1}});

        terminateGate.resolve(0);
        await expect(pageOpsPromise).rejects.toThrow('canceled');
        await vi.waitFor(() => expect(broker.getSnapshot()).toMatchObject({active: 0, used: {nativeProcesses: 0}}));

        // When worker termination fails to prove exit, the broker retains the charge.
        mocks.nextTerminateImpl = () => Promise.reject(new Error('terminate failed'));
        const qpdfAbort = new AbortController();
        const qpdfPromise = runDesktopQpdfWasm(['--check', '/fake/a.pdf'], {signal: qpdfAbort.signal});
        await vi.waitFor(() => expect(mocks.workers).toHaveLength(2));
        qpdfAbort.abort(new DOMException('aborted', 'AbortError'));
        await expect(qpdfPromise).rejects.toThrow('aborted');
        await Promise.resolve();
        expect(broker.getSnapshot()).toMatchObject({active: 1, used: {nativeProcesses: 1}});
    });

    it('cancels a task waiting on broker admission via cancelGroup without spawning a worker', async () => {
        const {JobBroker} = await import('@electron/resources/jobBroker');
        const {cancelDesktopQpdfWasmGroupAndWait, runDesktopQpdfWasm} = await import('@electron/native-tools/qpdfWasmWorkerClient');
        const broker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 2,
        });
        mocks.configuredBroker = broker;

        const blockingLeaf = await broker.acquire({
            ownerId: 'existing-leaf',
            kind: 'native-command',
            priority: 'user',
            admissionClass: 'leaf',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 128 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        });
        try {
            const task = runDesktopQpdfWasm(['--check', '/fake/a.pdf'], {cancelGroup: 'qpdf-wait-group'});
            await Promise.resolve();
            expect(mocks.workers).toHaveLength(0);
            expect(broker.getSnapshot().queued).toBe(1);

            await expect(cancelDesktopQpdfWasmGroupAndWait('qpdf-wait-group')).resolves.toBe(true);
            await expect(task).rejects.toThrow('Operation canceled');
            expect(mocks.workers).toHaveLength(0);
            expect(broker.getSnapshot().queued).toBe(0);
        } finally {
            blockingLeaf.release();
        }
    });

    it('enforces a single deadline across broker admission for page-ops calls', async () => {
        vi.useFakeTimers();
        try {
            const {JobBroker} = await import('@electron/resources/jobBroker');
            const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
            const broker = new JobBroker({
                cpuTokens: 2,
                estimatedResidentBytes: 512 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 2,
            });
            mocks.configuredBroker = broker;

            const blockingLeaf = await broker.acquire({
                ownerId: 'existing-leaf',
                kind: 'native-command',
                priority: 'user',
                admissionClass: 'leaf',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 128 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            });
            try {
                const task = runDesktopPageOpsWasm(
                    '/fake/evb-pdf-page-ops.wasm',
                    ['page-geometry', '--input', '/fake/a.pdf', '--page', '1'],
                    {timeoutMs: 20, commandLabel: 'page-ops(deadline)'},
                );
                const settled = task.catch((error: unknown) => error);
                await vi.advanceTimersByTimeAsync(25);
                const error = await settled;
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toBe('page-ops(deadline) timed out after 20ms');
                expect(mocks.workers).toHaveLength(0);
                expect(broker.getSnapshot().queued).toBe(0);
            } finally {
                blockingLeaf.release();
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes multiple visibility-session holders sequentially so the lease stays charged until every holder settles', async () => {
        const {JobBroker} = await import('@electron/resources/jobBroker');
        const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        const broker = new JobBroker({
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 2,
            ioWeight: 2,
        });
        mocks.configuredBroker = broker;
        const wasmPath = '/fake/evb-pdf-page-ops.wasm';

        // Seed two warm workers that both hold visibility session 99.
        const openA = runDesktopPageOpsWasm(wasmPath, [
            'ocr-text-visibility',
            '--session-id',
            '99',
            '--input',
            '/fake/a.pdf',
            '--pages',
            '1',
        ]);
        const openB = runDesktopPageOpsWasm(wasmPath, [
            'ocr-text-visibility',
            '--session-id',
            '99',
            '--input',
            '/fake/b.pdf',
            '--pages',
            '1',
        ]);
        await vi.waitFor(() => expect(mocks.workers).toHaveLength(2));
        const workerA = mocks.workers[0]!;
        const workerB = mocks.workers[1]!;
        workerA.reply(workerA.messages[0]!.id);
        workerB.reply(workerB.messages[0]!.id);
        await Promise.all([openA, openB]);
        expect(broker.getSnapshot()).toMatchObject({active: 0, queued: 0});

        // Close session 99: holder A errors, then holder B runs under the same still-active lease.
        const closePromise = runDesktopPageOpsWasm(wasmPath, ['ocr-text-visibility', '--close-session', '99']);
        await vi.waitFor(() => expect(workerA.messages).toHaveLength(2));
        // Only holder A is dispatched first; holder B waits sequentially.
        expect(workerB.messages).toHaveLength(1);
        expect(broker.getSnapshot()).toMatchObject({active: 1, used: {nativeProcesses: 1}});

        workerA.emitter.emit('message', {
            id: workerA.messages[1]!.id,
            ok: false,
            error: 'close holder A failed',
        });

        // Holder B must now receive its close while the lease is STILL held!
        await vi.waitFor(() => expect(workerB.messages).toHaveLength(2));
        expect(broker.getSnapshot()).toMatchObject({active: 1, used: {nativeProcesses: 1}});

        // Fail holder B's termination proof via unexpected exit -> lease stays retained.
        workerB.terminateImpl = () => Promise.reject(new Error('terminate failed'));
        workerB.emitter.emit('exit', 1);

        await expect(closePromise).rejects.toThrow('close holder A failed');
        await Promise.resolve();
        expect(broker.getSnapshot()).toMatchObject({active: 1, used: {nativeProcesses: 1}});
    });

    it('stops dispatching subsequent visibility-session holders once the absolute deadline has elapsed', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000);
            const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
            const wasmPath = '/fake/evb-pdf-page-ops.wasm';

            const openA = runDesktopPageOpsWasm(wasmPath, [
                'ocr-text-visibility',
                '--session-id',
                '100',
                '--input',
                '/fake/a.pdf',
                '--pages',
                '1',
            ]);
            const openB = runDesktopPageOpsWasm(wasmPath, [
                'ocr-text-visibility',
                '--session-id',
                '100',
                '--input',
                '/fake/b.pdf',
                '--pages',
                '1',
            ]);
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.workers).toHaveLength(2);
            const workerA = mocks.workers[0]!;
            const workerB = mocks.workers[1]!;
            workerA.reply(workerA.messages[0]!.id);
            workerB.reply(workerB.messages[0]!.id);
            await Promise.all([openA, openB]);

            const closePromise = runDesktopPageOpsWasm(wasmPath, ['ocr-text-visibility', '--close-session', '100'], {
                timeoutMs: 30,
                commandLabel: 'page-ops(close-deadline)',
            });
            const closeOutcome = closePromise.catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(0);
            expect(workerA.messages).toHaveLength(2);
            // Advance system clock past the 30 ms deadline without firing the deadline timer.
            vi.setSystemTime(1_085);
            workerA.reply(workerA.messages[1]!.id);

            const error = await closeOutcome;
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe('page-ops(close-deadline) timed out after 30ms');
            expect(workerB.messages).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('removes the deterministic clone staging directory on aborted staged write rollback', async () => {
        const {mkdir, mkdtemp, rm, stat, writeFile} = await import('node:fs/promises');
        const {tmpdir} = await import('node:os');
        const {join} = await import('node:path');
        const {getCloneStagingDirPath} = await import('@node-runtime/pdfPageOpsWasmRunner');
        const {runDesktopPageOpsWasm} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        const tempDir = await mkdtemp(join(tmpdir(), 'evb-clone-rollback-'));
        try {
            const inputPath = join(tempDir, 'input.pdf');
            const outputPath = join(tempDir, 'output.pdf');
            const abortController = new AbortController();
            const task = runDesktopPageOpsWasm(
                '/fake/evb-pdf-page-ops.wasm',
                ['save-mutations', '--input', inputPath, '--output', outputPath, '--append'],
                {signal: abortController.signal},
            );
            await vi.waitFor(() => expect(mocks.workers).toHaveLength(1));
            const msg = mocks.workers[0]!.messages[0] as {id: number; args: string[]; stagedOutputPath?: string};
            expect(msg.stagedOutputPath).toBeTruthy();
            const cloneDir = getCloneStagingDirPath(msg.stagedOutputPath!);
            await mkdir(cloneDir, {recursive: true});
            await writeFile(join(cloneDir, 'copy'), 'cloned-bytes', 'utf8');

            abortController.abort(new DOMException('aborted', 'AbortError'));
            await expect(task).rejects.toThrow('aborted');
            await expect(stat(cloneDir)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(tempDir, {recursive: true, force: true});
        }
    });
});
