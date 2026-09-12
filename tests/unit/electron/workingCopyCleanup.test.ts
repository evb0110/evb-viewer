import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    existsSync,
    mkdirSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    clearAllWorkingCopies,
    cleanupWorkingCopy,
    settleAllWorkingCopyMaterializations,
} from '@electron/file-access/workingCopyCleanup';
import {
    clearWorkingCopyQuarantinesForTests,
    quarantineWorkingCopy,
} from '@electron/file-access/workingCopyQuarantine';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

// The module reads its dependent-settlement bound from the environment once, at
// import time. A wedged dependent has to be provable in a unit test without
// spending the production 30 seconds on it, so the override has to be in place
// before the import — which is what `vi.hoisted` buys. The process environment
// outlives this file, so whatever was there before is put back once the suite is
// done; a leaked 50ms bound would silently reshape any later suite that imports
// the same module.
const dependentSettleBound = vi.hoisted(() => {
    const previousValue = process.env.EVB_WORKING_COPY_DEPENDENT_SETTLE_TIMEOUT_MS;
    process.env.EVB_WORKING_COPY_DEPENDENT_SETTLE_TIMEOUT_MS = '50';
    return {
        timeoutMs: 50,
        restore: () => {
            if (previousValue === undefined) {
                delete process.env.EVB_WORKING_COPY_DEPENDENT_SETTLE_TIMEOUT_MS;
                return;
            }
            process.env.EVB_WORKING_COPY_DEPENDENT_SETTLE_TIMEOUT_MS = previousValue;
        },
    };
});
const DEPENDENT_SETTLE_TIMEOUT_MS = dependentSettleBound.timeoutMs;

afterAll(dependentSettleBound.restore);

const state = vi.hoisted(() => ({
    cancelClosingOperations: vi.fn((_workingCopyPath: string, _reason?: string): Array<{
        id: string;
        kind: 'abortable-work' | 'critical-write';
        settled: Promise<void>;
    }> => []),
    cancelMaterialization: vi.fn(),
    ensureMaterialized: vi.fn(),
    fenceRegistrations: [] as number[],
    hasWorkingCopySyncRequired: vi.fn((_workingCopyPath: string) => false),
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    operations: [] as Array<{
        aborted: boolean;
        commitStarted: boolean;
        id: string;
        kind: 'abortable-work' | 'critical-write';
        workingCopyPath: string;
    }>,
    tempRoot: '',
    workingCopyMap: new Map<string, {
        admissionSnapshot?: {
            mtimeNs: bigint;
            size: bigint;
        };
        backingState: 'eager' | 'materializing';
        originalPath: string;
        ownerWebContentsId?: number;
        registeredAtMs: number;
        registrationId: number;
        role: 'current';
    }>(),
}));

vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    clearRetiredWorkingCopyOriginals: vi.fn(),
    forgetRetiredWorkingCopyOriginal: vi.fn(),
    forgetWorkingCopyOriginalPath: (path: string) => state.workingCopyMap.delete(path),
    getWorkingCopyOwnerWebContentsId: (path: string) => state.workingCopyMap.get(path)?.ownerWebContentsId,
    normalizePathForLookup: (path: string) => {
        const resolvedPath = resolve(path.trim());
        try {
            return realpathSync.native(resolvedPath);
        } catch {
            return resolvedPath;
        }
    },
    rememberRetiredWorkingCopyOriginal: vi.fn(),
    runWithWorkingCopyRegistrationFence: async (
        path: string,
        registrationId: number,
        operation: (entry: unknown) => unknown,
    ) => {
        state.fenceRegistrations.push(registrationId);
        const entry = state.workingCopyMap.get(path);
        if (!entry || entry.registrationId !== registrationId) {
            return {matched: false as const};
        }
        return {
            matched: true as const,
            value: await operation(entry),
        };
    },
    workingCopyMap: state.workingCopyMap,
}));

vi.mock('@electron/file-access/workingCopyMaterialization', () => ({
    cancelWorkingCopyMaterialization: state.cancelMaterialization,
    ensureWorkingCopyMaterialized: state.ensureMaterialized,
}));

vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({
    // The real function refuses to cancel anything once the caller has stopped
    // owning the registration it is closing, and the close path depends on that
    // `null` to keep its hands off a replacement document. The mock keeps that
    // contract and delegates only the list of dependents to the test.
    cancelMainOperationsForClosingWorkingCopy: (
        workingCopyPath: string,
        reason: string,
        ownership: {isRegistrationCurrent: () => boolean},
    ) => (
        ownership.isRegistrationCurrent()
            ? state.cancelClosingOperations(workingCopyPath, reason)
            : null
    ),
    snapshotCancellableWorkingCopyDependents: (workingCopyPath: string) => state.operations.filter(operation => (
        operation.workingCopyPath === workingCopyPath && !operation.commitStarted
    )),
    snapshotMainOperations: () => state.operations,
    waitForMainOperationsSettled: async (
        canceledOperations: ReadonlyArray<{
            id: string;
            settled: Promise<void>;
        }>,
        options: {timeoutMs: number},
    ) => {
        // The losing side of the race is still armed once the race resolves. The
        // handle is cleared on both outcomes, so a settlement does not leave a
        // timer behind for whatever runs next in this file.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let outcome: 'settled' | 'timeout';
        try {
            outcome = await Promise.race([
                Promise.allSettled(canceledOperations.map(operation => operation.settled))
                    .then(() => 'settled' as const),
                new Promise<'timeout'>((resolveTimeout) => {
                    timeoutHandle = setTimeout(() => resolveTimeout('timeout'), options.timeoutMs);
                    timeoutHandle.unref?.();
                }),
            ]);
        } finally {
            clearTimeout(timeoutHandle);
        }
        if (outcome === 'settled') {
            return {
                settled: true,
                pending: [],
            };
        }
        const pendingIds = new Set(canceledOperations.map(operation => operation.id));
        return {
            settled: false,
            pending: state.operations.filter(operation => pendingIds.has(operation.id)),
        };
    },
}));

vi.mock('@electron/file-access/workingCopyDirectory', () => ({
    isWorkingCopyDirectoryName: (name: string) => name.startsWith('pdf-work-'),
    safeRemoveDirectory: vi.fn(async () => false),
}));

vi.mock('@electron/utils/appTempDir', () => ({
    getAppTempDir: () => state.tempRoot,
    getLegacyAppTempDirPath: () => join(dirname(state.tempRoot), 'evb-viewer'),
}));

vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({drainWorkingCopyMutations: vi.fn(async () => undefined)}));

vi.mock('@electron/file-access/documentRevisionStore', () => ({
    clearWorkingCopyRevisionInitializations: vi.fn(),
    forgetWorkingCopyRevisionInitialization: vi.fn(),
    hasWorkingCopySyncRequired: (...args: [string]) => state.hasWorkingCopySyncRequired(...args),
}));

vi.mock('@electron/file-access/pageIdentityStore', () => ({
    clearPageIdentityStoreInitializations: vi.fn(),
    forgetPageIdentityStoreInitialization: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => state.logger}));

function registerWorkingCopy(
    workingPath: string,
    originalPath: string,
    backingState: 'eager' | 'materializing',
    registrationId = 73,
) {
    state.workingCopyMap.set(workingPath, {
        backingState,
        originalPath,
        ownerWebContentsId: 7,
        registeredAtMs: Date.now(),
        registrationId,
        role: 'current',
    });
}

describe('working-copy cleanup materialization retirement', () => {
    beforeEach(async () => {
        state.tempRoot = await mkdtemp(join(tmpdir(), 'evb-working-copy-cleanup-'));
        state.cancelClosingOperations.mockClear();
        state.cancelClosingOperations.mockImplementation(() => []);
        state.cancelMaterialization.mockReset();
        state.ensureMaterialized.mockReset();
        state.fenceRegistrations.length = 0;
        state.hasWorkingCopySyncRequired.mockReset();
        state.hasWorkingCopySyncRequired.mockReturnValue(false);
        state.logger.debug.mockClear();
        state.logger.error.mockClear();
        state.logger.info.mockClear();
        state.logger.warn.mockClear();
        state.operations.length = 0;
        state.workingCopyMap.clear();
    });

    afterEach(async () => {
        clearWorkingCopyQuarantinesForTests();
        await rm(state.tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('joins demanded materialization for the captured registration before retirement', async () => {
        const originalPath = join(state.tempRoot, 'original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-demand', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'materializing');
        state.operations.push(
            {
                aborted: false,
                commitStarted: false,
                id: 'background-flight',
                kind: 'abortable-work',
                workingCopyPath: workingPath,
            },
            {
                aborted: false,
                commitStarted: false,
                id: 'demand-waiter',
                kind: 'critical-write',
                workingCopyPath: workingPath,
            },
        );
        const materialization = createDeferred<{
            logicalRef: string;
            physicalWorkingCopyPath: string;
            sourceFingerprint: string;
        }>();
        state.ensureMaterialized.mockReturnValue(materialization.promise);

        const cleanup = cleanupWorkingCopy(workingPath, 7);
        await vi.waitFor(() => {
            expect(state.ensureMaterialized).toHaveBeenCalledOnce();
        });

        expect(state.cancelMaterialization).not.toHaveBeenCalled();
        expect(existsSync(dirname(workingPath))).toBe(true);

        state.operations.length = 0;
        materialization.resolve({
            logicalRef: workingPath,
            physicalWorkingCopyPath: workingPath,
            sourceFingerprint: 'sha256-full-v1:abc',
        });
        await cleanup;

        expect(state.fenceRegistrations).toEqual([
            73,
            73,
        ]);
        expect(existsSync(dirname(workingPath))).toBe(false);
        expect(existsSync(originalPath)).toBe(true);
    });

    it('cancels and settles a background-only materializer before deletion', async () => {
        const originalPath = join(state.tempRoot, 'background-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-background', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'partial');
        registerWorkingCopy(workingPath, originalPath, 'materializing');
        state.operations.push(
            {
                aborted: false,
                commitStarted: false,
                id: 'stale-registration-flight',
                kind: 'abortable-work',
                workingCopyPath: workingPath,
            },
            {
                aborted: false,
                commitStarted: false,
                id: 'background-flight',
                kind: 'abortable-work',
                workingCopyPath: workingPath,
            },
        );
        const materialization = createDeferred<never>();
        state.ensureMaterialized.mockReturnValue(materialization.promise);
        state.cancelMaterialization.mockImplementation(() => {
            state.operations.length = 0;
            materialization.reject(new Error('cancelled'));
            return true;
        });

        await cleanupWorkingCopy(workingPath, 7);

        expect(state.cancelMaterialization).toHaveBeenCalledWith(
            'background-flight',
            'Working-copy materialization cancelled during cleanup',
        );
        expect(state.fenceRegistrations).toEqual([
            73,
            73,
        ]);
        expect(existsSync(dirname(workingPath))).toBe(false);
        expect(existsSync(originalPath)).toBe(true);
    });

    it('retains a working copy with unresolved document transition evidence', async () => {
        const originalPath = join(state.tempRoot, 'unresolved-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-unresolved', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'stale-working');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        state.hasWorkingCopySyncRequired.mockReturnValue(true);

        await cleanupWorkingCopy(workingPath, 7);

        expect(existsSync(dirname(workingPath))).toBe(true);
        expect(state.ensureMaterialized).not.toHaveBeenCalled();
        expect(state.fenceRegistrations).toEqual([]);
    });

    it('waits for an already-aborted shutdown flight when new demand admission is closed', async () => {
        const originalPath = join(state.tempRoot, 'shutdown-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-shutdown', 'working.pdf');
        registerWorkingCopy(workingPath, originalPath, 'materializing');
        state.operations.push({
            aborted: true,
            commitStarted: false,
            id: 'aborted-background-flight',
            kind: 'abortable-work',
            workingCopyPath: workingPath,
        });
        state.ensureMaterialized.mockRejectedValue(new Error('Main process is shutting down'));
        state.cancelMaterialization.mockImplementation(() => {
            setImmediate(() => {
                state.operations.length = 0;
            });
            return false;
        });

        await settleAllWorkingCopyMaterializations();

        expect(state.cancelMaterialization).toHaveBeenCalledWith(
            'aborted-background-flight',
            'Working-copy materialization cancelled during cleanup',
        );
        expect(state.workingCopyMap.has(workingPath)).toBe(true);
    });

    it('stops long native work on the working copy before its directory goes away', async () => {
        const originalPath = join(state.tempRoot, 'running-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-running', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        let directoryExistedAtCancel = false;
        state.cancelClosingOperations.mockImplementationOnce(() => {
            directoryExistedAtCancel = existsSync(dirname(workingPath));
            return [{
                id: 'scan-cleanup',
                kind: 'critical-write' as const,
                settled: Promise.resolve(),
            }];
        });

        await cleanupWorkingCopy(workingPath, 7);

        expect(state.cancelClosingOperations).toHaveBeenCalledWith(workingPath, 'Working copy is closing');
        expect(directoryExistedAtCancel).toBe(true);
        expect(existsSync(dirname(workingPath))).toBe(false);
    });

    it('holds the working copy until every cancelled dependent has settled', async () => {
        const originalPath = join(state.tempRoot, 'settling-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-settling', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        const dependent = createDeferred<'settled'>();
        let directoryExistedAtCancel = false;
        // Recorded from inside the dependent's own settlement, which is the last
        // instant at which the close is still waiting. If the close deleted the
        // directory or dropped the registration before its dependent stopped,
        // this snapshot is what catches it -- the assertions after `await
        // cleanup` cannot, because by then both are gone either way.
        let stateWhenDependentStopped: {
            directoryExists: boolean;
            registered: boolean;
        } | null = null;
        state.cancelClosingOperations.mockImplementationOnce(() => {
            directoryExistedAtCancel = existsSync(dirname(workingPath));
            return [{
                id: 'scan-cleanup',
                kind: 'critical-write' as const,
                settled: dependent.promise.then(() => {
                    stateWhenDependentStopped = {
                        directoryExists: existsSync(dirname(workingPath)),
                        registered: state.workingCopyMap.has(workingPath),
                    };
                }),
            }];
        });

        const cleanup = cleanupWorkingCopy(workingPath, 7);
        // The cancellation the close issues is the observable signal that it has
        // reached the point of waiting; nothing here sleeps for a fixed span.
        await vi.waitFor(() => {
            expect(state.cancelClosingOperations).toHaveBeenCalledWith(workingPath, 'Working copy is closing');
        });
        // The dependent has been asked to stop but has not stopped yet: the
        // directory its worker is still reading has to stay where it is.
        expect(directoryExistedAtCancel).toBe(true);
        expect(state.workingCopyMap.has(workingPath)).toBe(true);
        expect(existsSync(dirname(workingPath))).toBe(true);

        dependent.resolve('settled');
        await cleanup;

        expect(stateWhenDependentStopped).toEqual({
            directoryExists: true,
            registered: true,
        });
        expect(state.workingCopyMap.has(workingPath)).toBe(false);
        expect(existsSync(dirname(workingPath))).toBe(false);
        expect(existsSync(originalPath)).toBe(true);
    });

    it('retains the working copy when a cancelled dependent never stops', async () => {
        const originalPath = join(state.tempRoot, 'wedged-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-wedged', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        // A worker wedged in native code never acknowledges its termination, so
        // its operation record never completes.
        const wedged = createDeferred<'settled'>();
        state.operations.push({
            aborted: true,
            commitStarted: false,
            id: 'scan-cleanup',
            kind: 'critical-write',
            workingCopyPath: workingPath,
        });
        state.cancelClosingOperations.mockImplementationOnce(() => [{
            id: 'scan-cleanup',
            kind: 'critical-write' as const,
            settled: wedged.promise.then(() => undefined),
        }]);

        await cleanupWorkingCopy(workingPath, 7);

        // Deleting here is the production incident: Poppler keeps reading the
        // file and the user's close turns into a failure.
        expect(existsSync(dirname(workingPath))).toBe(true);
        expect(existsSync(workingPath)).toBe(true);
        expect(state.workingCopyMap.has(workingPath)).toBe(true);
        expect(state.logger.warn).toHaveBeenCalledWith(expect.stringContaining(
            `Retained the working copy directory for "${workingPath}"`,
        ));
        expect(state.logger.warn).toHaveBeenCalledWith(expect.stringContaining('critical-write#scan-cleanup'));
        expect(state.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(`within ${DEPENDENT_SETTLE_TIMEOUT_MS}ms`),
        );
        // Retention is the designed outcome of an unprovable stop. Reporting it
        // at error level would turn the user's tab close into an application
        // error report, which is the incident this path exists to avoid.
        expect(state.logger.error).not.toHaveBeenCalled();

        wedged.resolve('settled');
    });

    it('leaves a working copy re-registered while dependents settled alone', async () => {
        const originalPath = join(state.tempRoot, 'replaced-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-replaced', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager', 73);
        const dependent = createDeferred<'settled'>();
        state.cancelClosingOperations.mockImplementationOnce(() => [{
            id: 'scan-cleanup',
            kind: 'critical-write' as const,
            settled: dependent.promise.then(() => undefined),
        }]);

        const cleanup = cleanupWorkingCopy(workingPath, 7);
        // The cancellation the close issues is the observable point at which it
        // is waiting on its dependent; nothing here sleeps for a fixed span.
        await vi.waitFor(() => {
            expect(state.cancelClosingOperations).toHaveBeenCalledWith(workingPath, 'Working copy is closing');
        });
        // The user reopened the document on the same path while the close was
        // still waiting. That is a different working copy with its own lifetime.
        registerWorkingCopy(workingPath, originalPath, 'eager', 74);
        dependent.resolve('settled');
        await cleanup;

        expect(state.workingCopyMap.get(workingPath)?.registrationId).toBe(74);
        expect(existsSync(dirname(workingPath))).toBe(true);
        expect(existsSync(workingPath)).toBe(true);
        expect(state.logger.warn).toHaveBeenCalledWith(expect.stringContaining(
            `Skipped cleanup for a working copy re-registered while its dependents settled "${workingPath}"`,
        ));
    });

    it('stops a dependent that appears while the first ones are settling', async () => {
        const originalPath = join(state.tempRoot, 'late-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-late', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        const late = createDeferred<'settled'>();
        let directoryExistedWhenLateDependentStopped = false;
        state.cancelClosingOperations
            .mockImplementationOnce(() => [{
                id: 'scan-cleanup',
                kind: 'critical-write' as const,
                settled: Promise.resolve(),
            }])
            // A job that registered against this working copy after the first
            // cancellation pass. One pass does not prove the copy is unused.
            .mockImplementationOnce(() => [{
                id: 'late-indexing',
                kind: 'abortable-work' as const,
                settled: late.promise.then(() => undefined),
            }]);

        const cleanup = cleanupWorkingCopy(workingPath, 7);
        // The second cancellation round is the observable point at which the
        // close has taken the late dependent on and is waiting for it. Until
        // `late` resolves it cannot get past that, so this reads the directory
        // exactly while a job is still holding the copy -- no fixed sleep.
        await vi.waitFor(() => {
            expect(state.cancelClosingOperations).toHaveBeenCalledTimes(2);
        });
        directoryExistedWhenLateDependentStopped = existsSync(dirname(workingPath));
        late.resolve('settled');
        await cleanup;

        expect(directoryExistedWhenLateDependentStopped).toBe(true);
        expect(state.cancelClosingOperations.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(existsSync(dirname(workingPath))).toBe(false);
        expect(state.logger.error).not.toHaveBeenCalled();
    });

    it('retains a working copy a dependent joined after the last cancellation round', async () => {
        const originalPath = join(state.tempRoot, 'rejoined-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-rejoined', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        // The cancellation rounds report nothing left to stop, and only then
        // does a job register against this path. It was never asked to stop, so
        // the bytes it reads are not free.
        state.cancelClosingOperations.mockImplementation(() => {
            state.operations.push({
                aborted: false,
                commitStarted: false,
                id: 'late-joiner',
                kind: 'abortable-work',
                workingCopyPath: workingPath,
            });
            return [];
        });

        await cleanupWorkingCopy(workingPath, 7);

        expect(existsSync(dirname(workingPath))).toBe(true);
        expect(existsSync(workingPath)).toBe(true);
        expect(state.logger.warn).toHaveBeenCalledWith(expect.stringContaining(
            'operation(s) still hold this working copy',
        ));
        expect(state.logger.error).not.toHaveBeenCalled();
    });

    it('deletes a working copy whose dependents stop on the last cancellation round', async () => {
        const originalPath = join(state.tempRoot, 'last-round-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-last-round', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        // Every one of the four rounds finds another dependent, and every one of
        // them stops when asked. The cancellation made after the last round finds
        // nothing left, which is the same proof the loop accepts on any earlier
        // round: spending the budget is not itself a failure to stop.
        let rounds = 0;
        state.cancelClosingOperations.mockImplementation(() => {
            rounds += 1;
            if (rounds > 4) {
                return [];
            }
            return [{
                id: `dependent-${rounds}`,
                kind: 'abortable-work' as const,
                settled: Promise.resolve(),
            }];
        });

        await cleanupWorkingCopy(workingPath, 7);

        expect(rounds).toBeGreaterThan(4);
        expect(state.workingCopyMap.has(workingPath)).toBe(false);
        expect(existsSync(dirname(workingPath))).toBe(false);
        // Retention here would strand the directory for the rest of the session
        // over dependents that demonstrably stopped.
        expect(state.logger.warn).not.toHaveBeenCalled();
        expect(state.logger.error).not.toHaveBeenCalled();
    });

    it('retires but does not delete a quarantined working copy', async () => {
        const originalPath = join(state.tempRoot, 'quarantined-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-quarantined', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        // A scan-cleanup run whose native tree was never proven dead. The
        // document is closed either way; only the bytes stay behind.
        quarantineWorkingCopy(workingPath, 'evb-scan-cleanup process tree (pid=4242) was not proven dead');

        await cleanupWorkingCopy(workingPath, 7);

        expect(state.workingCopyMap.has(workingPath)).toBe(false);
        expect(existsSync(workingPath)).toBe(true);
        expect(state.logger.warn).toHaveBeenCalledWith(expect.stringContaining(
            'the working copy is quarantined (evb-scan-cleanup process tree (pid=4242) was not proven dead)',
        ));
        expect(state.logger.error).not.toHaveBeenCalled();
    });

    it('waits for shutdown dependents before deleting and retains the ones that do not stop', async () => {
        const settling = {
            originalPath: join(state.tempRoot, 'shutdown-settling-original.pdf'),
            workingPath: join(state.tempRoot, 'pdf-work-shutdown-settling', 'working.pdf'),
        };
        const wedged = {
            originalPath: join(state.tempRoot, 'shutdown-wedged-original.pdf'),
            workingPath: join(state.tempRoot, 'pdf-work-shutdown-wedged', 'working.pdf'),
        };
        for (const copy of [
            settling,
            wedged,
        ]) {
            mkdirSync(dirname(copy.workingPath), {recursive: true});
            writeFileSync(copy.originalPath, 'original');
            writeFileSync(copy.workingPath, 'managed');
            registerWorkingCopy(copy.workingPath, copy.originalPath, 'eager');
        }
        const stopping = createDeferred<'settled'>();
        let directoryExistedWhileStopping = false;
        // Both paths are closed concurrently, so a counter shared between them
        // would let the wedged path's rounds decide when the settling path stops
        // reporting dependents. Each path counts its own rounds.
        const roundsByPath = new Map<string, number>();
        // Shutdown has already requested cancellation of everything, but a
        // cancel is a request: the abortable readers of these bytes still have
        // to be observed stopping.
        state.operations.push({
            aborted: true,
            commitStarted: false,
            id: 'shutdown-wedged-indexing',
            kind: 'abortable-work',
            workingCopyPath: wedged.workingPath,
        });
        state.cancelClosingOperations.mockImplementation((workingCopyPath: string) => {
            const round = (roundsByPath.get(workingCopyPath) ?? 0) + 1;
            roundsByPath.set(workingCopyPath, round);
            if (workingCopyPath === wedged.workingPath) {
                return [{
                    id: 'shutdown-wedged-indexing',
                    kind: 'abortable-work' as const,
                    settled: new Promise<void>(() => {}),
                }];
            }
            if (round > 1) {
                return [];
            }
            return [{
                id: 'shutdown-settling-ocr',
                kind: 'abortable-work' as const,
                settled: stopping.promise.then(() => {
                    directoryExistedWhileStopping = existsSync(dirname(settling.workingPath));
                }),
            }];
        });

        const shutdown = clearAllWorkingCopies();
        stopping.resolve('settled');
        await shutdown;

        expect(directoryExistedWhileStopping).toBe(true);
        expect(existsSync(dirname(settling.workingPath))).toBe(false);
        expect(existsSync(wedged.workingPath)).toBe(true);
        expect(state.workingCopyMap.has(wedged.workingPath)).toBe(true);
        expect(state.logger.warn).toHaveBeenCalledWith(expect.stringContaining(
            `Retained the working copy directory for "${wedged.workingPath}"`,
        ));
        // Shutdown reports unsaved work as a fault. A reader that could not be
        // proven stopped is not that, so it must not become one.
        expect(state.logger.error).not.toHaveBeenCalled();
    });

    it('keeps its hands off a path re-registered on the last cancellation round', async () => {
        const originalPath = join(state.tempRoot, 'exhausted-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-exhausted', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager', 73);
        // Every round finds another dependent, so the close spends its whole
        // round budget, and the user reopens the document on the same path just
        // as the budget runs out.
        let rounds = 0;
        state.cancelClosingOperations.mockImplementation(() => {
            rounds += 1;
            if (rounds >= 4) {
                registerWorkingCopy(workingPath, originalPath, 'eager', 74);
            }
            return [{
                id: `dependent-${rounds}`,
                kind: 'abortable-work' as const,
                settled: Promise.resolve(),
            }];
        });

        await cleanupWorkingCopy(workingPath, 7);

        expect(state.workingCopyMap.get(workingPath)?.registrationId).toBe(74);
        expect(existsSync(workingPath)).toBe(true);
        // Losing the registration is not the same answer as "a dependent would
        // not stop", and reporting it as the latter would blame a document that
        // was never asked to close.
        expect(state.logger.warn).toHaveBeenCalledWith(expect.stringContaining(
            `Skipped cleanup for a working copy re-registered while its dependents settled "${workingPath}"`,
        ));
        expect(state.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining(
            'had not stopped',
        ));
        expect(state.logger.error).not.toHaveBeenCalled();
    });

    it('never deletes an original backing located under the managed directory', async () => {
        const workingPath = join(state.tempRoot, 'pdf-work-protected-original', 'working.pdf');
        const originalPath = join(dirname(workingPath), 'source.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');

        await cleanupWorkingCopy(workingPath, 7);

        expect(existsSync(originalPath)).toBe(true);
        expect(state.fenceRegistrations).toEqual([73]);
    });
});
