import type * as TViMockFs from 'fs';
import type * as TViMockJobBroker from '@electron/resources/jobBroker';
import type * as TViMockWorkerTask from '@electron/utils/workerTask';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { decodeCropWorkerInput } from '@electron/features/page-ops/main/cropWorkerProtocol';
import { markUnprovenNativeTermination } from '@electron/utils/nativeTerminationProof';

const CROP_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['page-ops-crop'].fileName;

const mocks = vi.hoisted(() => ({
    broker: null as InstanceType<typeof TViMockJobBroker.JobBroker> | null,
    forceWorkerExists: false,
    runResultWorkerTask: vi.fn(),
    cropPagesLocal: vi.fn(),
    removeCropFromPagesLocal: vi.fn(),
}));

vi.mock('fs', async importOriginal => {
    const actual = await importOriginal<typeof TViMockFs>();
    return {
        ...actual,
        existsSync: (path: Parameters<typeof actual.existsSync>[0]) => (
            mocks.forceWorkerExists && String(path).endsWith(CROP_WORKER_FILENAME)
                ? true
                : actual.existsSync(path)
        ),
    };
});
vi.mock('@electron/resources/jobBroker', async importOriginal => {
    const actual = await importOriginal<typeof TViMockJobBroker>();
    return {
        ...actual,
        mainJobBroker: new Proxy({} as TViMockJobBroker.JobBroker, {
            get(_target, property, receiver) {
                const broker = mocks.broker;
                if (!broker) {
                    throw new Error('JobBroker mock was accessed before beforeEach');
                }
                const value = Reflect.get(broker, property, receiver);
                return typeof value === 'function' ? value.bind(broker) : value;
            },
        }),
    };
});
vi.mock('@electron/utils/workerTask', async importOriginal => ({
    ...(await importOriginal<typeof TViMockWorkerTask>()),
    runResultWorkerTask: (...args: unknown[]) => mocks.runResultWorkerTask(...args),
}));
vi.mock('@electron/features/page-ops/main/cropLocal', () => ({
    cropPagesLocal: (...args: unknown[]) => mocks.cropPagesLocal(...args),
    removeCropFromPagesLocal: (...args: unknown[]) => mocks.removeCropFromPagesLocal(...args),
}));
vi.mock('@electron/features/page-ops/main/nativeCrop', () => ({assertPageOpsLocalFallbackAllowed: vi.fn(async () => undefined)}));

const {JobBroker} = await import('@electron/resources/jobBroker');
const {
    cropPages,
    removeCropFromPages,
} = await import('@electron/features/page-ops/main/crop');

describe('decodeCropWorkerInput', () => {
    it('reconstructs every crop worker input variant', () => {
        expect(decodeCropWorkerInput({
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [
                1,
                3,
            ],
            margins: {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
                physical: true,
                ignored: true,
            },
            senderWebContentsId: 9,
            ignored: true,
        })).toEqual({
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [
                1,
                3,
            ],
            margins: {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
                physical: true,
            },
            senderWebContentsId: 9,
        });
        expect(decodeCropWorkerInput({
            type: 'removeCrop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [2],
        })).toEqual({
            type: 'removeCrop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [2],
        });
    });

    it.each([
        null,
        {},
        {
            type: 'crop',
            workingCopyPath: '',
            pages: [1],
            margins: {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [0],
            margins: {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [1.5],
            margins: {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [1],
            margins: {
                top: -1,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [1],
            margins: {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                physical: 'true',
            },
        },
        {
            type: 'removeCrop',
            workingCopyPath: '/tmp/work.pdf',
            pages: '1',
        },
        {
            type: 'getPageGeometry',
            workingCopyPath: '/tmp/work.pdf',
            pageNumber: 1,
        },
    ])('rejects malformed worker payloads (%j)', (value) => {
        expect(decodeCropWorkerInput(value)).toBeNull();
    });
});

describe('crop worker broker admission', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.forceWorkerExists = true;
        mocks.broker = new JobBroker({
            cpuTokens: 4,
            estimatedResidentBytes: 4 * 1024 ** 3,
            nativeProcesses: 1,
            ioWeight: 8,
        });
    });

    it.each([
        [
            'crop',
            () => cropPages('/tmp/work.pdf', [1], {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
            }, 9),
        ],
        [
            'removeCrop',
            () => removeCropFromPages('/tmp/work.pdf', [1], 9),
        ],
    ])('queues %s behind an active native lease and releases when finished', async (_kind, runOp) => {
        mocks.runResultWorkerTask.mockResolvedValueOnce(undefined);
        const originalRun = mocks.broker!.run.bind(mocks.broker);
        const queued = Promise.withResolvers<void>();
        vi.spyOn(mocks.broker!, 'run').mockImplementation((request, work) => {
            if (request.kind === 'page-ops-crop') {
                queued.resolve();
            }
            return originalRun(request, work);
        });
        const blockerGate = Promise.withResolvers<void>();
        const blockerDone = originalRun({
            ownerId: 'blocker',
            kind: 'native-command',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 64 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 1,
            },
        }, () => blockerGate.promise);

        const opPromise = runOp();
        try {
            await queued.promise;
            await new Promise<void>(resolve => queueMicrotask(resolve));
            expect(mocks.runResultWorkerTask).not.toHaveBeenCalled();
            expect(mocks.broker!.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
            });

            blockerGate.resolve();
            await blockerDone;
            await expect(opPromise).resolves.toBeUndefined();
            expect(mocks.runResultWorkerTask).toHaveBeenCalledTimes(1);
            expect(mocks.broker!.getSnapshot().active).toBe(0);
        } finally {
            blockerGate.resolve();
            await blockerDone.catch(() => undefined);
            await opPromise.catch(() => undefined);
        }
    });

    it.each([
        [
            'crop',
            () => cropPages('/tmp/work.pdf', [1], {
                top: 1,
                bottom: 1,
                left: 1,
                right: 1,
            }, 9),
        ],
        [
            'removeCrop',
            () => removeCropFromPages('/tmp/work.pdf', [1], 9),
        ],
    ])('retains its broker lease when the %s worker ends without termination proof', async (_kind, runOp) => {
        const unproven = markUnprovenNativeTermination(new Error('crop worker hung'), 'crop child still alive');
        mocks.runResultWorkerTask.mockImplementationOnce(async (options: {
            onTerminationProof?: (proof: Promise<boolean>) => void;
        }) => {
            options.onTerminationProof?.(Promise.resolve(false));
            throw unproven;
        });

        await expect(runOp()).rejects.toBe(unproven);
        expect(mocks.broker!.getSnapshot()).toMatchObject({
            active: 1,
            used: {nativeProcesses: 1},
        });
    });

    it.each([
        [
            'crop',
            () => cropPages('/tmp/work.pdf', [1], {
                top: 1,
                bottom: 1,
                left: 1,
                right: 1,
            }, 9),
            () => mocks.cropPagesLocal,
        ],
        [
            'removeCrop',
            () => removeCropFromPages('/tmp/work.pdf', [1], 9),
            () => mocks.removeCropFromPagesLocal,
        ],
    ])('releases the worker lease before falling back locally on %s startup error', async (_kind, runOp, getFallbackMock) => {
        mocks.runResultWorkerTask.mockImplementationOnce(async (options: {
            createStartupError?: (message: string) => Error;
        }) => {
            throw options.createStartupError?.('worker failed before ready') ?? new Error('unexpected missing factory');
        });
        let nestedAcquired = false;
        getFallbackMock().mockImplementationOnce(async () => {
            expect(mocks.broker!.getSnapshot().active).toBe(0);
            await mocks.broker!.run({
                ownerId: 'crop-local-fallback',
                kind: 'native-command',
                priority: 'user',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 64 * 1024 * 1024,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            }, async () => {
                nestedAcquired = true;
            });
        });

        await expect(runOp()).resolves.toBeUndefined();
        expect(mocks.runResultWorkerTask).toHaveBeenCalledTimes(1);
        expect(nestedAcquired).toBe(true);
        expect(mocks.broker!.getSnapshot().active).toBe(0);
    });
});
