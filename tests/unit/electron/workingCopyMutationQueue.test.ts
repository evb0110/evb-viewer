import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';
import type * as TViMockOriginalModule2 from '@electron/file-access/workingCopyMutationCommitSignal';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const mocks = vi.hoisted(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    complete: vi.fn(),
    nextOperationId: 0,
    registrations: [] as Array<Record<string, unknown>>,
    controllers: [] as AbortController[],
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: (...args: unknown[]) => mocks.debug(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => mocks.warn(...args),
    error: vi.fn(),
})}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    normalizePathForLookup: (path: string) => path.trim().toLowerCase(),
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: vi.fn()}));
vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({
    registerMainOperation: (registration: Record<string, unknown>) => {
        mocks.registrations.push(registration);
        mocks.nextOperationId += 1;
        const controller = new AbortController();
        mocks.controllers.push(controller);
        return {
            id: `operation-${mocks.nextOperationId}`,
            signal: controller.signal,
            markCommitStarted: vi.fn(),
            complete: (...args: unknown[]) => mocks.complete(...args),
        };
    },
    cancelMainOperationsForOwner: (ownerWebContentsId: number, reason: string) => {
        mocks.registrations.forEach((registration, index) => {
            if (registration.ownerWebContentsId === ownerWebContentsId) {
                mocks.controllers[index]?.abort(new Error(reason));
            }
        });
    },
}));
vi.mock('@electron/file-access/workingCopyMutationCommitSignal', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    runWithWorkingCopyMutationCommitSignal: (_operation: unknown, callback: () => Promise<unknown>) => callback(),
}));
vi.mock('@electron/features/search/public', () => ({getCompactSearchIndexPath: (path: string) => `${path}.compact-index`}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

const byteTargets: string[] = [];
async function createByteTarget() {
    const directory = await mkdtemp(join(tmpdir(), 'mutation-start-'));
    byteTargets.push(directory);
    const path = join(directory, 'document.pdf');
    await writeFile(path, 'before');
    return path;
}

function parseLog(prefix: string, calls: unknown[][]) {
    const message = calls
        .map(call => call[0])
        .find(value => typeof value === 'string' && value.startsWith(prefix));
    expect(message).toBe(prefix);
    const call = calls.find(candidate => candidate[0] === prefix);
    expect(call?.[1]).toBeTypeOf('object');
    return call?.[1] as Record<string, unknown>;
}

describe('workingCopyMutationQueue telemetry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.nextOperationId = 0;
        mocks.registrations.length = 0;
        mocks.controllers.length = 0;
    });
    afterEach(async () => {
        await Promise.all(byteTargets.splice(0).map(path => rm(path, {
            recursive: true,
            force: true,
        })));
    });

    it('keeps its critical write out of working-copy close cancellation', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');

        await enqueueWorkingCopyMutation('/tmp/Book.pdf', async () => undefined, {kind: 'ordinary-write'});

        // The hook exists for shutdown. Closing the document has to drain this
        // write, not abort it, so the registration never opts into the
        // working-copy close predicate.
        expect(mocks.registrations).toEqual([expect.objectContaining({
            kind: 'critical-write',
            workingCopyPath: '/tmp/Book.pdf',
            cancel: expect.any(Function),
        })]);
        expect(mocks.registrations[0]).not.toHaveProperty('cancelOnWorkingCopyClose');
    });

    it('reports the queued and active owner and clears ownership after settlement', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blocker = deferred<undefined>();
        const first = enqueueWorkingCopyMutation('/tmp/Book.pdf', () => blocker.promise, {kind: 'first-write'});
        await Promise.resolve();
        const second = enqueueWorkingCopyMutation('/tmp/book.pdf', async () => undefined, {kind: 'second-write'});

        const secondEnqueue = parseLog('Working-copy mutation enqueued', mocks.warn.mock.calls);
        expect(secondEnqueue).toMatchObject({
            queueKey: '/tmp/book.pdf',
            operationId: 'operation-2',
            kind: 'second-write',
            depth: 2,
            queuedBehind: {
                operationId: 'operation-1',
                kind: 'first-write',
            },
            activeOwner: {
                operationId: 'operation-1',
                kind: 'first-write',
            },
        });
        expect(mocks.warn).toHaveBeenCalledTimes(1);

        blocker.resolve(undefined);
        await Promise.all([
            first,
            second,
        ]);

        const third = enqueueWorkingCopyMutation('/tmp/book.pdf', async () => undefined, {kind: 'third-write'});
        const thirdEnqueue = parseLog('Working-copy mutation enqueued', mocks.debug.mock.calls.slice(-1));
        expect(thirdEnqueue).toMatchObject({
            operationId: 'operation-3',
            kind: 'third-write',
            depth: 1,
            queuedBehind: null,
            activeOwner: null,
        });
        await third;
        expect(mocks.complete).toHaveBeenCalledTimes(3);
    });

    it('fails a queued stage closed when its renderer owner ends', async () => {
        const {cancelMainOperationsForOwner} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const blocker = deferred<undefined>();
        const secondStage = vi.fn(async () => undefined);
        const first = enqueueWorkingCopyMutation('/tmp/Book.pdf', () => blocker.promise, {
            ownerWebContentsId: 42,
            kind: 'first-stage',
        });
        await Promise.resolve();
        const second = enqueueWorkingCopyMutation('/tmp/Book.pdf', secondStage, {
            ownerWebContentsId: 42,
            kind: 'queued-stage',
        });

        cancelMainOperationsForOwner(42, 'renderer lifecycle ended');
        blocker.resolve(undefined);

        await expect(first).resolves.toBeUndefined();
        await expect(second).rejects.toThrow('renderer lifecycle ended');
        expect(secondStage).not.toHaveBeenCalled();
        expect(mocks.complete).toHaveBeenCalledTimes(2);
    });

    it('waits for mutation-start preparation before invoking the operation', async () => {
        const {
            enqueueWorkingCopyMutation,
            onWorkingCopyMutationStarting,
        } = await import('@electron/file-access/workingCopyMutationQueue');
        const preparation = deferred<undefined>();
        const operation = vi.fn(async () => undefined);
        const unsubscribe = onWorkingCopyMutationStarting(() => preparation.promise);

        try {
            const mutation = enqueueWorkingCopyMutation('/tmp/Book.pdf', operation);
            await Promise.resolve();

            expect(operation).not.toHaveBeenCalled();
            preparation.resolve(undefined);

            await expect(mutation).resolves.toBeUndefined();
            expect(operation).toHaveBeenCalledOnce();
        } finally {
            unsubscribe();
        }
    });

    it.each([
        'throw',
        'reject',
    ])('preserves bytes when required preparation listeners %s', async (failureKind) => {
        const {
            enqueueWorkingCopyMutation,
            onWorkingCopyMutationStarting,
        } = await import('@electron/file-access/workingCopyMutationQueue');
        const path = await createByteTarget();
        const operation = () => writeFile(path, 'after');
        const unsubscribeFirst = onWorkingCopyMutationStarting(() => {
            const error = new Error('required preparation failed');
            if (failureKind === 'throw') throw error;
            return Promise.reject(error);
        });
        const unsubscribeSecond = onWorkingCopyMutationStarting(() => Promise.reject(new Error('another preparation failed')));

        try {
            await expect(enqueueWorkingCopyMutation(path, operation)).rejects.toThrow('required preparation failed');
            expect(await readFile(path, 'utf8')).toBe('before');
        } finally {
            unsubscribeFirst();
            unsubscribeSecond();
        }
    });

    it('bounds the stack captured for mutation origins', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const nativeCaptureStackTrace = Error.captureStackTrace.bind(Error);
        const observedLimits: number[] = [];
        const captureStackTrace = vi.spyOn(Error, 'captureStackTrace').mockImplementation((error, constructor) => {
            observedLimits.push(Error.stackTraceLimit);
            nativeCaptureStackTrace(error, constructor);
        });

        try {
            await enqueueWorkingCopyMutation('/tmp/Book.pdf', async () => undefined);
        } finally {
            captureStackTrace.mockRestore();
        }

        expect(observedLimits).toHaveLength(1);
        expect(observedLimits[0]).toBeLessThanOrEqual(8);
    });

    it('refuses an expired start and never writes after its preparation completes late', async () => {
        const {
            enqueueWorkingCopyMutation,
            onWorkingCopyMutationStarting,
        } = await import('@electron/file-access/workingCopyMutationQueue');
        const path = await createByteTarget();
        const preparation = deferred<undefined>();
        const unsubscribe = onWorkingCopyMutationStarting(() => preparation.promise);
        vi.useFakeTimers();

        try {
            const first = enqueueWorkingCopyMutation(path, () => writeFile(path, 'after'));
            const refused = expect(first).rejects.toThrow('Mutation-start preparation timed out after 30000ms');
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(30_000);
            await refused;
            expect(await readFile(path, 'utf8')).toBe('before');
            preparation.resolve(undefined);
            await vi.advanceTimersByTimeAsync(0);
            expect(await readFile(path, 'utf8')).toBe('before');
            await enqueueWorkingCopyMutation(path, () => writeFile(path, 'fresh'));
            expect(await readFile(path, 'utf8')).toBe('fresh');
        } finally {
            unsubscribe();
            vi.useRealTimers();
        }
    });

    it('refuses cancellation during required preparation without waiting for it, including late completion', async () => {
        const {cancelMainOperationsForOwner} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const {
            enqueueWorkingCopyMutation,
            onWorkingCopyMutationStarting,
        } = await import('@electron/file-access/workingCopyMutationQueue');
        const preparation = deferred<undefined>();
        const path = await createByteTarget();
        const operation = () => writeFile(path, 'after');
        let preparationSignal: AbortSignal | undefined;
        const unsubscribe = onWorkingCopyMutationStarting((_path, signal) => {
            preparationSignal = signal;
            return preparation.promise;
        });

        try {
            const mutation = enqueueWorkingCopyMutation(path, operation, {ownerWebContentsId: 42});
            await Promise.resolve();

            cancelMainOperationsForOwner(42, 'renderer lifecycle ended');
            expect(preparationSignal?.aborted).toBe(true);
            await expect(mutation).rejects.toThrow('renderer lifecycle ended');
            expect(await readFile(path, 'utf8')).toBe('before');
            preparation.resolve(undefined);
            await Promise.resolve();
            expect(await readFile(path, 'utf8')).toBe('before');
        } finally {
            unsubscribe();
        }
    });

    it('does not extend a path drain with mutations admitted after it starts', async () => {
        const {
            drainWorkingCopyMutations,
            enqueueWorkingCopyMutation,
        } = await import('@electron/file-access/workingCopyMutationQueue');
        const firstBlocker = deferred<undefined>();
        const secondBlocker = deferred<undefined>();
        const first = enqueueWorkingCopyMutation('/tmp/Book.pdf', () => firstBlocker.promise);
        const drain = drainWorkingCopyMutations('/tmp/Book.pdf');
        await Promise.resolve();

        const second = enqueueWorkingCopyMutation('/tmp/Book.pdf', () => secondBlocker.promise);
        firstBlocker.resolve(undefined);
        await first;

        try {
            await drain;
        } finally {
            secondBlocker.resolve(undefined);
            await second;
            await drainWorkingCopyMutations('/tmp/Book.pdf');
        }
    });

    it('does not extend a global drain with mutations admitted after it starts', async () => {
        const {
            drainWorkingCopyMutations,
            enqueueWorkingCopyMutation,
        } = await import('@electron/file-access/workingCopyMutationQueue');
        const firstBlocker = deferred<undefined>();
        const secondBlocker = deferred<undefined>();
        const first = enqueueWorkingCopyMutation('/tmp/Book.pdf', () => firstBlocker.promise);
        const drain = drainWorkingCopyMutations();
        await Promise.resolve();

        const second = enqueueWorkingCopyMutation('/tmp/Other.pdf', () => secondBlocker.promise);
        firstBlocker.resolve(undefined);
        await first;

        try {
            await drain;
        } finally {
            secondBlocker.resolve(undefined);
            await second;
            await drainWorkingCopyMutations();
        }
    });
});
