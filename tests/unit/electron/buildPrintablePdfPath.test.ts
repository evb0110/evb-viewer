import type * as TViMockOriginalModule from '@electron/resources/jobBroker';
import type * as TViMockOriginalModule2 from '@electron/features/documents/main/resolvePdfPrintLayoutAdmission';

import {EventEmitter} from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {buildPrintablePdfPath} from '@electron/features/documents/main/buildPrintablePdfPath';
import {requirePageNumber} from '@contracts/pageNumbers';

const GIB = 1024 * 1024 * 1024;

const mocks = vi.hoisted(() => ({
    acquire: vi.fn(),
    fork: vi.fn(),
    release: vi.fn(),
    resolveAdmission: vi.fn(() => ({
        estimatedResidentBytes: 6.8 * 1024 * 1024 * 1024,
        childMaxOldSpaceMib: 5_939,
    })),
    terminateProcessTree: vi.fn(async () => true),
}));

vi.mock('electron', () => ({utilityProcess: {fork: mocks.fork}}));
vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'pdf-print-layout': {fileName: 'pdf-print-layout.mjs'}}}));
vi.mock('@electron/utils/workerTask', () => ({resolveUnpackedWorkerPath: () => '/tmp/pdf-print-layout.mjs'}));
vi.mock('@electron/resources/jobBroker', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    mainJobBroker: {acquire: mocks.acquire},
}));
vi.mock('@electron/features/documents/main/resolvePdfPrintLayoutAdmission', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    resolvePdfPrintLayoutAdmission: mocks.resolveAdmission,
}));
vi.mock('@electron/utils/processTree', () => ({terminateProcessTree: mocks.terminateProcessTree}));

function createChild(pid = 9_123) {
    return Object.assign(new EventEmitter(), {
        pid,
        postMessage: vi.fn(),
    });
}

function build() {
    return buildPrintablePdfPath({
        inputPath: '/tmp/source.pdf',
        outputPath: '/tmp/printable.pdf',
        printOptions: {
            pageNumbers: [
                requirePageNumber(1),
                requirePageNumber(2),
            ],
            viewMode: 'facing',
            orientation: 'auto',
        },
    });
}

async function waitForFork() {
    await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledOnce());
}

describe('buildPrintablePdfPath', () => {
    beforeEach(() => {
        mocks.acquire.mockReset();
        mocks.fork.mockReset();
        mocks.release.mockReset();
        mocks.resolveAdmission.mockClear();
        mocks.terminateProcessTree.mockReset();
        mocks.terminateProcessTree.mockResolvedValue(true);
        mocks.acquire.mockResolvedValue({release: mocks.release});
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses one coherent broker reservation and V8 heap ceiling', async () => {
        const child = createChild();
        mocks.fork.mockReturnValue(child);
        const result = build();
        await waitForFork();

        expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'pdf-print-layout',
            admissionClass: 'bulk',
            resources: expect.objectContaining({estimatedResidentBytes: 6.8 * GIB}),
        }));
        expect(mocks.fork).toHaveBeenCalledWith(
            '/tmp/pdf-print-layout.mjs',
            [],
            expect.objectContaining({execArgv: ['--max-old-space-size=5939']}),
        );

        child.emit('spawn');
        expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            viewMode: 'facing',
            pageNumbers: [
                1,
                2,
            ],
        }));
        child.emit('message', {
            type: 'result',
            ok: true,
            bytes: 1_024,
        });

        await expect(result).resolves.toEqual({bytes: 1_024});
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it.each([
        {
            name: 'invalid output',
            emit: (child: EventEmitter) => child.emit('message', {
                type: 'result',
                ok: true,
                bytes: 0,
            }),
            message: 'returned an invalid result',
        },
        {
            name: 'reported child failure',
            emit: (child: EventEmitter) => child.emit('message', {
                type: 'result',
                ok: false,
                error: 'layout failed',
            }),
            message: 'layout failed',
        },
        {
            name: 'unexpected child exit',
            emit: (child: EventEmitter) => child.emit('exit', null),
            message: 'Close other documents or print a smaller page range',
        },
    ])('releases the broker lease after $name', async ({
        emit,
        message,
    }) => {
        const child = createChild();
        mocks.fork.mockReturnValue(child);
        const result = build();
        await waitForFork();

        emit(child);

        await expect(result).rejects.toThrow(message);
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('releases the broker lease after cancellation', async () => {
        const child = createChild();
        mocks.fork.mockReturnValue(child);
        const controller = new AbortController();
        const result = buildPrintablePdfPath({
            inputPath: '/tmp/source.pdf',
            outputPath: '/tmp/printable.pdf',
            printOptions: {
                viewMode: 'facing',
                orientation: 'auto',
            },
            signal: controller.signal,
        });
        await waitForFork();

        controller.abort(new Error('print canceled'));

        await expect(result).rejects.toThrow('print canceled');
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('releases the broker lease after the layout timeout', async () => {
        vi.useFakeTimers();
        const child = createChild();
        mocks.fork.mockReturnValue(child);
        const result = build();
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.fork).toHaveBeenCalledOnce();
        const rejection = expect(result).rejects.toThrow('preparation timed out');

        await vi.advanceTimersByTimeAsync(10 * 60_000);

        await rejection;
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('refuses an undersized host before broker acquisition', async () => {
        mocks.resolveAdmission.mockImplementationOnce(() => {
            throw new RangeError('PDF print layout requires at least 2 GiB of available processing memory');
        });

        await expect(build()).rejects.toThrow('requires at least 2 GiB');
        expect(mocks.acquire).not.toHaveBeenCalled();
        expect(mocks.fork).not.toHaveBeenCalled();
    });
});
