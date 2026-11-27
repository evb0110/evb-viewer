import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {JobBroker} from '@electron/resources/jobBroker';
import {runResultWorkerTask} from '@electron/utils/workerTask';
import {
    getUnprovenNativeTerminationDetail,
    markUnprovenNativeTermination,
} from '@electron/utils/nativeTerminationProof';

// A worker that answers a cancel the way a native-tool worker does when it
// could not prove its child process died.
const CANCELLED_WORKER_SOURCE = `
import {parentPort} from 'node:worker_threads';
parentPort.on('message', (message) => {
    if (message?.type !== 'cancel') return;
    parentPort.postMessage({
        type: 'result',
        ok: false,
        error: 'canceled',
        errorFrame: {
            message: 'canceled',
            canceled: true,
            terminationUnproven: 'worker child pid 4242 still alive',
        },
    });
});
parentPort.postMessage({type: 'ready'});
`;

const LEASE = {
    cpuTokens: 1,
    estimatedResidentBytes: 1,
    nativeProcesses: 1,
    ioWeight: 1,
};

async function writeWorker(source = CANCELLED_WORKER_SOURCE, fileName = 'cancelled-worker.mjs') {
    const dir = await mkdtemp(join(tmpdir(), 'worker-task-real-'));
    onTestFinished(() => rm(dir, {
        recursive: true,
        force: true,
    }));
    const workerPath = join(dir, fileName);
    await writeFile(workerPath, source);
    return workerPath;
}

const EXITING_WORKER_SOURCE = `
import {parentPort} from 'node:worker_threads';
parentPort.postMessage({type: 'ready'});
setTimeout(() => process.exit(1), 25);
`;

describe('result worker task on a real worker thread', () => {
    it('settles a cancel whose frozen AggregateError reason already reports a member\'s unproven termination', async () => {
        const workerPath = await writeWorker();
        const broker = new JobBroker(LEASE);
        const jobAbort = new AbortController();
        // Sol's probe: a joined stop whose member already carries a mark, frozen
        // by the code that produced it. The aggregate reports the member's mark
        // without carrying one, so it still cannot take this worker's.
        const frozenReason = Object.freeze(new AggregateError([
            markUnprovenNativeTermination(new Error('sibling stop'), 'sibling child alive'),
        ], 'shared job stopped'));
        const ready = Promise.withResolvers<void>();

        const outcome = broker.run({
            ownerId: 'real-worker',
            kind: 'conformance',
            priority: 'user',
            resources: LEASE,
        }, ({onTerminationProof}) => runResultWorkerTask({
            workerPath,
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: jobAbort.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 30_000,
            onProgressMessage: (payload) => {
                if ((payload as {type?: unknown} | null)?.type !== 'ready') {return false;}
                ready.resolve();
                return true;
            },
            onTerminationProof,
        })).catch((cause: unknown) => cause);
        await ready.promise;
        jobAbort.abort(frozenReason);

        const error = await outcome;
        // The frozen reason cannot carry the mark, so the rejection wraps it.
        expect(error).toMatchObject({
            message: 'shared job stopped',
            cause: frozenReason,
        });
        expect(getUnprovenNativeTerminationDetail(error)).toBe('worker child pid 4242 still alive');
        // The worker's own child was never proven gone, so its lease stays charged.
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it('settles a cancel with a frozen null-prototype abort reason without hanging', async () => {
        const workerPath = await writeWorker();
        const broker = new JobBroker(LEASE);
        const jobAbort = new AbortController();
        const frozenNullProto = Object.freeze(Object.create(null)) as object;
        const ready = Promise.withResolvers<void>();

        const outcome = broker.run({
            ownerId: 'real-worker-null-proto',
            kind: 'conformance',
            priority: 'user',
            resources: LEASE,
        }, ({onTerminationProof}) => runResultWorkerTask({
            workerPath,
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: jobAbort.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 30_000,
            onProgressMessage: (payload) => {
                if ((payload as {type?: unknown} | null)?.type !== 'ready') {return false;}
                ready.resolve();
                return true;
            },
            onTerminationProof,
        })).catch((cause: unknown) => cause);
        await ready.promise;
        jobAbort.abort(frozenNullProto);

        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
            name: 'AbortError',
            message: 'The operation was aborted',
            cause: frozenNullProto,
        });
        expect(getUnprovenNativeTerminationDetail(error)).toBe('worker child pid 4242 still alive');
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it('wraps a frozen exit error in asCrashOutcome so a crashing real worker settles and keeps its lease', async () => {
        const workerPath = await writeWorker(EXITING_WORKER_SOURCE, 'exiting-worker.mjs');
        const broker = new JobBroker(LEASE);
        const ready = Promise.withResolvers<void>();
        let capturedExitError: Error | undefined;

        const outcome = broker.run({
            ownerId: 'real-worker-frozen-exit',
            kind: 'conformance',
            priority: 'user',
            resources: LEASE,
        }, ({onTerminationProof}) => runResultWorkerTask({
            workerPath,
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: (code) => {
                capturedExitError = Object.freeze(new Error(`exit: ${code}`));
                return capturedExitError;
            },
            onProgressMessage: (payload) => {
                if ((payload as {type?: unknown} | null)?.type !== 'ready') {return false;}
                ready.resolve();
                return true;
            },
            onTerminationProof,
        })).catch((cause: unknown) => cause);

        await ready.promise;
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(capturedExitError).toBeDefined();
        expect(error).toMatchObject({
            message: 'exit: 1',
            cause: capturedExitError,
        });
        expect(getUnprovenNativeTerminationDetail(error)).toContain('stopped without settling');
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it('wraps an extensible Proxy that silently discards the termination mark', async () => {
        const workerPath = await writeWorker();
        const broker = new JobBroker(LEASE);
        const jobAbort = new AbortController();
        const droppingProxy = new Proxy(new Error('proxy cancel'), {
            set: () => true,
        });
        const ready = Promise.withResolvers<void>();

        const outcome = broker.run({
            ownerId: 'real-worker-dropping-proxy',
            kind: 'conformance',
            priority: 'user',
            resources: LEASE,
        }, ({onTerminationProof}) => runResultWorkerTask({
            workerPath,
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: jobAbort.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 30_000,
            onProgressMessage: (payload) => {
                if ((payload as {type?: unknown} | null)?.type !== 'ready') {return false;}
                ready.resolve();
                return true;
            },
            onTerminationProof,
        })).catch((cause: unknown) => cause);
        await ready.promise;
        jobAbort.abort(droppingProxy);

        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBe(droppingProxy);
        expect(error).toMatchObject({
            message: 'proxy cancel',
            cause: droppingProxy,
        });
        expect(getUnprovenNativeTerminationDetail(error)).toBe('worker child pid 4242 still alive');
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it('falls back to default message when a frozen Error has a non-coercible message getter', async () => {
        const workerPath = await writeWorker();
        const broker = new JobBroker(LEASE);
        const jobAbort = new AbortController();
        const strangeError = new Error('ignored');
        Object.defineProperty(strangeError, 'message', {
            get: () => Object.create(null) as string,
            configurable: true,
        });
        Object.freeze(strangeError);
        const ready = Promise.withResolvers<void>();

        const outcome = broker.run({
            ownerId: 'real-worker-noncoercible-message',
            kind: 'conformance',
            priority: 'user',
            resources: LEASE,
        }, ({onTerminationProof}) => runResultWorkerTask({
            workerPath,
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: code => new Error(`exit: ${code}`),
            signal: jobAbort.signal,
            createCancelMessage: () => ({type: 'cancel'}),
            cooperativeCancelDelayMs: 30_000,
            onProgressMessage: (payload) => {
                if ((payload as {type?: unknown} | null)?.type !== 'ready') {return false;}
                ready.resolve();
                return true;
            },
            onTerminationProof,
        })).catch((cause: unknown) => cause);
        await ready.promise;
        jobAbort.abort(strangeError);

        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
            message: 'The operation was aborted',
            cause: strangeError,
        });
        expect(getUnprovenNativeTerminationDetail(error)).toBe('worker child pid 4242 still alive');
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it('guards mark lookup in asCrashOutcome when an exit error Proxy throws on symbol read', async () => {
        const workerPath = await writeWorker(EXITING_WORKER_SOURCE, 'exiting-throwing-proxy.mjs');
        const broker = new JobBroker(LEASE);
        const ready = Promise.withResolvers<void>();
        let capturedProxy: Error | undefined;

        const outcome = broker.run({
            ownerId: 'real-worker-throwing-exit-proxy',
            kind: 'conformance',
            priority: 'user',
            resources: LEASE,
        }, ({onTerminationProof}) => runResultWorkerTask({
            workerPath,
            workerData: null,
            invalidPayloadMessage: 'invalid payload',
            createWorkerExitError: (code) => {
                const frozen = Object.freeze(new Error(`exit: ${code}`));
                capturedProxy = new Proxy(frozen, {
                    get(target, prop, receiver) {
                        if (prop === Symbol.for('evb.unprovenNativeTermination')) {
                            throw new Error('symbol read failed');
                        }
                        return Reflect.get(target, prop, receiver);
                    },
                });
                return capturedProxy;
            },
            onProgressMessage: (payload) => {
                if ((payload as {type?: unknown} | null)?.type !== 'ready') {return false;}
                ready.resolve();
                return true;
            },
            onTerminationProof,
        })).catch((cause: unknown) => cause);

        await ready.promise;
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(capturedProxy).toBeDefined();
        expect(error).not.toBe(capturedProxy);
        expect(error).toMatchObject({
            message: 'exit: 1',
            cause: capturedProxy,
        });
        expect(getUnprovenNativeTerminationDetail(error)).toContain('stopped without settling');
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });
});
