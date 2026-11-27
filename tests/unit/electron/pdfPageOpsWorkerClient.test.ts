import {EventEmitter} from 'node:events';
import type * as TFsModule from 'node:fs';
import type * as TWasmRunnerModule from '@node-runtime/pdfPageOpsWasmRunner';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IMockWorkerRecord {
    emitter: EventEmitter;
    messages: Array<{
        id: number;
        args: string[];
    }>;
    terminateCalls: number;
    reply: (id: number, stdout?: string) => void;
}

const mocks = vi.hoisted<{
    workers: IMockWorkerRecord[];
}>(() => ({workers: []}));

vi.mock('node:fs', async importOriginal => ({
    ...await importOriginal<typeof TFsModule>(),
    existsSync: () => true,
}));

vi.mock('@node-runtime/pdfPageOpsWasmRunner', async importOriginal => ({
    ...await importOriginal<typeof TWasmRunnerModule>(),
    loadPdfPageOpsWasmModule: vi.fn(async () => ({} as WebAssembly.Module)),
}));

vi.mock('node:worker_threads', () => ({
    Worker: class MockWorker extends EventEmitter {
        private readonly record: IMockWorkerRecord;

        constructor() {
            super();
            this.record = {
                emitter: this,
                messages: [],
                terminateCalls: 0,
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

        postMessage(message: {
            id: number;
            args: string[];
        }) {
            this.record.messages.push(message);
        }

        terminate() {
            this.record.terminateCalls += 1;
            return Promise.resolve(0);
        }
    },
}));

describe('pdfPageOpsWorkerClient idle eviction', () => {
    beforeEach(() => {
        mocks.workers.length = 0;
        vi.useFakeTimers();
    });

    afterEach(async () => {
        const {shutdownPdfPageOpsWorkers} = await import('@electron/native-tools/pdfPageOpsWorkerClient');
        shutdownPdfPageOpsWorkers();
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
        const taskB = runDesktopPageOpsWasm(wasmPath, [
            'page-geometry',
            '--input',
            '/fake/b.pdf',
            '--page',
            '1',
        ]);

        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.workers).toHaveLength(2);
        const workerA = mocks.workers[0]!;
        const workerB = mocks.workers[1]!;
        expect(workerA.messages).toHaveLength(1);
        expect(workerB.messages).toHaveLength(1);

        const closeA = runDesktopPageOpsWasm(wasmPath, [
            'ocr-text-visibility',
            '--close-session',
            '42',
        ]);

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
