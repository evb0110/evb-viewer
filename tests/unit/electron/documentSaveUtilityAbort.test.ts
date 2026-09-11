import type * as TViMockOriginalModule from '@electron/resources/jobBroker';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {EventEmitter} from 'node:events';
import {
    fingerprintFileWithUtilityProcess,
    getRetainedDocumentSaveUtilityCount,
    retryRetainedDocumentSaveUtilityProcesses,
    runDocumentSaveUtilityProcess,
    shutdownRetainedDocumentSaveUtilityProcesses,
} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';
import {DOCUMENT_SAVE_SERVICE_NAME} from '@electron/processDeathRecovery';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    brokerAcquire: vi.fn(),
    fork: vi.fn(),
    stat: vi.fn(async () => ({size: 1024})),
    terminateProcessTree: vi.fn(async () => true),
}));

vi.mock('electron', () => ({utilityProcess: {fork: mocks.fork}}));
vi.mock('node:fs/promises', () => ({stat: mocks.stat}));
vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'document-save-utility': {fileName: 'document-save-utility.mjs'}}}));
vi.mock('@electron/utils/workerTask', () => ({resolveUnpackedWorkerPath: vi.fn(
    () => '/tmp/document-save-utility.mjs',
)}));
vi.mock('@electron/resources/jobBroker', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    mainJobBroker: {acquire: mocks.brokerAcquire},
}));
vi.mock('@electron/utils/processTree', () => ({terminateProcessTree: mocks.terminateProcessTree}));

function createChild(pid: number | undefined, shutdownTerminated = true) {
    const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
        pid,
        postMessage: vi.fn(),
    });
    child.postMessage.mockImplementation((value: unknown) => {
        if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'shutdown') {
            queueMicrotask(() => child.emit('message', {
                type: 'shutdown-complete',
                terminated: shutdownTerminated,
            }));
        }
    });
    return child;
}

describe('runDocumentSaveUtilityProcess cancellation', () => {
    beforeEach(() => {
        mocks.fork.mockReset();
        mocks.terminateProcessTree.mockReset();
        mocks.terminateProcessTree.mockResolvedValue(true);
    });

    afterEach(async () => {
        await retryRetainedDocumentSaveUtilityProcesses();
        vi.useRealTimers();
    });

    it('does not fork after cancellation has already been requested', async () => {
        const controller = new AbortController();
        controller.abort(new Error('save canceled before utility launch'));

        await expect(runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {
                type: 'inspect',
                sourcePath: '/tmp/source.pdf',
                expectedBytes: 1,
            },
            signal: controller.signal,
        })).rejects.toThrow('save canceled before utility launch');

        expect(mocks.fork).not.toHaveBeenCalled();
    });

    it('terminates the utility process by direct PID before reporting cancellation', async () => {
        const child = createChild(8123);
        mocks.fork.mockReturnValueOnce(child);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {
                type: 'inspect',
                sourcePath: '/tmp/source.pdf',
                expectedBytes: 1,
            },
            signal: controller.signal,
        });

        child.emit('spawn');
        controller.abort(new Error('save canceled while qpdf was running'));

        await expect(result).rejects.toThrow('save canceled while qpdf was running');
        expect(mocks.terminateProcessTree).toHaveBeenCalledWith(8123, expect.objectContaining({
            graceMs: 2_500,
            preferProcessGroup: false,
        }));
    });

    it('keeps a false termination result on the cancellation failure', async () => {
        const child = createChild(8124);
        mocks.fork.mockReturnValueOnce(child);
        mocks.terminateProcessTree.mockResolvedValueOnce(false);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            signal: controller.signal,
        });

        child.emit('spawn');
        controller.abort(new Error('save cancellation'));

        const error = await result.catch(value => value);
        expect(error).toBeInstanceOf(Error);
        expect(getUnprovenNativeTerminationDetail(error)).toContain('pid=8124');
    });

    it('retains the lease after a false proof until an owned retry proves termination', async () => {
        const release = vi.fn();
        const child = createChild(8125);
        mocks.fork.mockReturnValueOnce(child);
        mocks.terminateProcessTree.mockResolvedValueOnce(false);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            signal: controller.signal,
            resourceLease: {
                token: 'utility-lease',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                release,
            },
        });

        child.emit('spawn');
        controller.abort(new Error('save cancellation'));

        const error = await result.catch(value => value);
        expect(error).toBeInstanceOf(Error);
        expect(getUnprovenNativeTerminationDetail(error)).toContain('pid=8125');
        expect(release).not.toHaveBeenCalled();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(1);

        mocks.terminateProcessTree.mockResolvedValueOnce(true);
        await expect(retryRetainedDocumentSaveUtilityProcesses()).resolves.toBe(true);
        expect(release).toHaveBeenCalledOnce();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(0);
    });

    it('returns a valid result before pending termination settles and retains its lease on false proof', async () => {
        const release = vi.fn();
        const termination = Promise.withResolvers<boolean>();
        const child = createChild(8126);
        mocks.fork.mockReturnValueOnce(child);
        mocks.terminateProcessTree.mockReturnValueOnce(termination.promise);
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            resourceLease: {
                token: 'utility-lease',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                release,
            },
        });

        child.emit('spawn');
        child.emit('message', {
            type: 'result',
            ok: true,
            bytes: 1024,
            sha256: 'a'.repeat(64),
        });

        await expect(result).resolves.toEqual({
            bytes: 1024,
            sha256: 'a'.repeat(64),
        });
        expect(release).not.toHaveBeenCalled();
        termination.resolve(false);
        await vi.waitFor(() => expect(getRetainedDocumentSaveUtilityCount()).toBe(1));
        expect(release).not.toHaveBeenCalled();

        await Promise.resolve();
        mocks.terminateProcessTree.mockResolvedValueOnce(true);
        await retryRetainedDocumentSaveUtilityProcesses();
        expect(release).toHaveBeenCalledOnce();
    });

    it('does not treat a late direct-child exit as descendant termination proof', async () => {
        const release = vi.fn();
        const child = createChild(8126);
        mocks.fork.mockReturnValueOnce(child);
        mocks.terminateProcessTree.mockResolvedValueOnce(false);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            signal: controller.signal,
            resourceLease: {
                token: 'utility-lease',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                release,
            },
        });

        child.emit('spawn');
        controller.abort(new Error('save cancellation'));
        await expect(result).rejects.toThrow('save cancellation');
        child.emit('exit', 0);

        expect(release).not.toHaveBeenCalled();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(1);

        mocks.terminateProcessTree.mockResolvedValueOnce(true);
        await expect(retryRetainedDocumentSaveUtilityProcesses()).resolves.toBe(true);
        expect(release).toHaveBeenCalledOnce();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(0);
    });

    it('reports unproven retained cleanup during shutdown without releasing its lease', async () => {
        const release = vi.fn();
        const child = createChild(8127);
        mocks.fork.mockReturnValueOnce(child);
        mocks.terminateProcessTree.mockResolvedValueOnce(false);
        mocks.terminateProcessTree.mockResolvedValueOnce(false);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            signal: controller.signal,
            resourceLease: {
                token: 'utility-lease',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                release,
            },
        });

        child.emit('spawn');
        controller.abort(new Error('save cancellation'));
        await expect(result).rejects.toThrow('save cancellation');

        await expect(shutdownRetainedDocumentSaveUtilityProcesses())
            .rejects.toThrow('cleanup remains unproven (1 retained process)');
        expect(release).not.toHaveBeenCalled();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(1);

        mocks.terminateProcessTree.mockResolvedValueOnce(true);
        await expect(shutdownRetainedDocumentSaveUtilityProcesses()).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledOnce();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(0);
    });

    it('retains ownership when the worker cannot prove native descendants are gone', async () => {
        const release = vi.fn();
        const child = createChild(8131, false);
        mocks.fork.mockReturnValueOnce(child);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            signal: controller.signal,
            resourceLease: {
                token: 'utility-lease',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                release,
            },
        });

        child.emit('spawn');
        controller.abort(new Error('native descendant cancellation'));

        const error = await result.catch(value => value);
        expect(getUnprovenNativeTerminationDetail(error)).toContain('pid=8131');
        expect(release).not.toHaveBeenCalled();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(1);
        expect(mocks.terminateProcessTree).toHaveBeenCalledWith(8131, expect.any(Object));

        child.emit('message', {
            type: 'shutdown-complete',
            terminated: true,
        });
        await expect(retryRetainedDocumentSaveUtilityProcesses()).resolves.toBe(true);
        expect(release).toHaveBeenCalledOnce();
    });

    it('waits for the spawned utility PID before attempting termination', async () => {
        const assignedPid = {value: undefined as number | undefined};
        const child = createChild(undefined);
        Object.defineProperty(child, 'pid', {get: () => assignedPid.value});
        mocks.fork.mockReturnValueOnce(child);
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
        });

        child.emit('message', {
            type: 'result',
            ok: true,
            bytes: 1024,
            sha256: 'a'.repeat(64),
        });
        await Promise.resolve();
        expect(mocks.terminateProcessTree).not.toHaveBeenCalled();

        assignedPid.value = 8127;
        child.emit('spawn');
        await expect(result).resolves.toEqual({
            bytes: 1024,
            sha256: 'a'.repeat(64),
        });
        expect(mocks.terminateProcessTree).toHaveBeenCalledWith(8127, expect.any(Object));
    });

    it('does not terminate an exposed pre-spawn PID when the spawn event never arrives', async () => {
        vi.useFakeTimers();
        const release = vi.fn();
        const child = createChild(8128);
        mocks.fork.mockReturnValueOnce(child);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            signal: controller.signal,
            resourceLease: {
                token: 'utility-lease',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                release,
            },
        });
        const rejection = result.catch(value => value);

        controller.abort(new Error('cancel before utility spawn'));
        await vi.advanceTimersByTimeAsync(2_500);
        const error = await rejection;

        expect(getUnprovenNativeTerminationDetail(error)).toContain('pid=8128');
        expect(mocks.terminateProcessTree).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(1);

        child.emit('exit', 0);
        await expect(retryRetainedDocumentSaveUtilityProcesses()).resolves.toBe(true);
        expect(release).toHaveBeenCalledOnce();
    });

    it('does not publish a request when cancellation wins before a delayed spawn', async () => {
        const child = createChild(8129);
        mocks.fork.mockReturnValueOnce(child);
        const controller = new AbortController();
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {type: 'inspect'},
            signal: controller.signal,
        });

        controller.abort(new Error('cancel before request publication'));
        child.emit('spawn');

        await expect(result).rejects.toThrow('cancel before request publication');
        expect(child.postMessage).not.toHaveBeenCalledWith({type: 'inspect'});
        expect(child.postMessage).toHaveBeenCalledWith({type: 'shutdown'});
        expect(mocks.terminateProcessTree).toHaveBeenCalledWith(8129, expect.any(Object));
    });

    it('retains an unproven lease when timeout settles before a late spawn', async () => {
        vi.useFakeTimers();
        const release = vi.fn();
        const child = createChild(8130);
        mocks.fork.mockReturnValueOnce(child);
        const result = runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 1,
            request: {type: 'inspect'},
            resourceLease: {
                token: 'utility-lease',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 1,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                release,
            },
        });
        const rejection = result.catch(value => value);

        await vi.advanceTimersByTimeAsync(2_500 + 1);
        await vi.advanceTimersByTimeAsync(0);
        const error = await rejection;
        expect(getUnprovenNativeTerminationDetail(error)).toContain('pid=8130');
        expect(release).not.toHaveBeenCalled();
        expect(getRetainedDocumentSaveUtilityCount()).toBe(1);

        child.emit('spawn');
        expect(child.postMessage).not.toHaveBeenCalled();
        mocks.terminateProcessTree.mockResolvedValueOnce(true);
        await expect(retryRetainedDocumentSaveUtilityProcesses()).resolves.toBe(true);
        expect(release).toHaveBeenCalledOnce();
    });

    it('prices fingerprint admission as one bounded interactive utility slot', async () => {
        mocks.brokerAcquire.mockRejectedValueOnce(new Error('stop after admission'));

        await expect(fingerprintFileWithUtilityProcess('/tmp/source.pdf'))
            .rejects.toThrow('stop after admission');
        expect(mocks.brokerAcquire).toHaveBeenCalledWith(expect.objectContaining({
            ownerId: 'document-fingerprint:/tmp/source.pdf',
            kind: 'document-save-utility',
            priority: 'foreground',
            admissionClass: 'interactive',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 256 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }));
        expect(mocks.fork).not.toHaveBeenCalled();
    });
});
