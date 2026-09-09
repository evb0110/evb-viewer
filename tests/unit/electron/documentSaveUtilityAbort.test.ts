import type * as TViMockOriginalModule from '@electron/resources/jobBroker';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {EventEmitter} from 'node:events';
import {
    fingerprintFileWithUtilityProcess,
    runDocumentSaveUtilityProcess,
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

describe('runDocumentSaveUtilityProcess cancellation', () => {
    beforeEach(() => {
        mocks.fork.mockReset();
        mocks.terminateProcessTree.mockReset();
        mocks.terminateProcessTree.mockResolvedValue(true);
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
        const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(() => true),
            pid: 8123,
            postMessage: vi.fn(),
        });
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
        const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(() => true),
            pid: 8124,
            postMessage: vi.fn(),
        });
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
