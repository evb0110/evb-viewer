import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';
import type * as TViMockOriginalModule2 from '@electron/file-access/workingCopyMutationCommitSignal';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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

function parseLog(prefix: string, calls: unknown[][]) {
    const message = calls
        .map(call => call[0])
        .find(value => typeof value === 'string' && value.startsWith(prefix));
    expect(message).toBeTypeOf('string');
    return JSON.parse((message as string).slice(prefix.length)) as Record<string, unknown>;
}

describe('workingCopyMutationQueue telemetry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.nextOperationId = 0;
        mocks.registrations.length = 0;
        mocks.controllers.length = 0;
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

        const secondEnqueue = parseLog('Working-copy mutation enqueued: ', mocks.warn.mock.calls);
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
        const thirdEnqueue = parseLog('Working-copy mutation enqueued: ', mocks.debug.mock.calls.slice(-1));
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

    it('rechecks cancellation after mutation-start preparation', async () => {
        const {cancelMainOperationsForOwner} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const {
            enqueueWorkingCopyMutation,
            onWorkingCopyMutationStarting,
        } = await import('@electron/file-access/workingCopyMutationQueue');
        const preparation = deferred<undefined>();
        const operation = vi.fn(async () => undefined);
        let preparationSignal: AbortSignal | undefined;
        const unsubscribe = onWorkingCopyMutationStarting((_path, signal) => {
            preparationSignal = signal;
            return preparation.promise;
        });

        try {
            const mutation = enqueueWorkingCopyMutation('/tmp/Book.pdf', operation, {ownerWebContentsId: 42});
            await Promise.resolve();

            cancelMainOperationsForOwner(42, 'renderer lifecycle ended');
            expect(preparationSignal?.aborted).toBe(true);
            preparation.resolve(undefined);

            await expect(mutation).rejects.toThrow('renderer lifecycle ended');
            expect(operation).not.toHaveBeenCalled();
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
