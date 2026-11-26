import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getUnprovenNativeTerminationDetail,
    markUnprovenNativeTermination,
} from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    broker: null as TJobBrokerModule.JobBroker | null,
    runNativeToolCommand: vi.fn(),
}));

vi.mock('@electron/resources/jobBroker', async importOriginal => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    return {
        ...actual,
        mainJobBroker: {
            run: <T>(
                request: TJobBrokerModule.IJobBrokerRequest,
                work: (context: TJobBrokerModule.IJobBrokerRunContext) => Promise<T>,
            ) => mocks.broker!.run(request, work),
        },
    };
});
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({
    runNativeToolCommand: mocks.runNativeToolCommand,
}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({
    getPdfNativeToolPaths: () => ({qpdf: '/mock/qpdf'}),
}));

const {
    fingerprintFileWithUtilityProcess,
    validateDocumentSaveStagingFile,
} = await import('@electron/features/documents/main/fingerprintFileWithUtilityProcess');
const {verifyPdfTempFile} = await import('@electron/features/documents/main/verifyPdfTempFile');

describe('in-process document save fingerprinting and validation', () => {
    let dir: string;
    let pdfPath: string;
    const samplePdf = '%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n';

    beforeEach(async () => {
        vi.clearAllMocks();
        const {
            JobBroker,
            MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
            MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
        } = await vi.importActual<typeof TJobBrokerModule>('@electron/resources/jobBroker');
        mocks.broker = new JobBroker({
            cpuTokens: 4,
            estimatedResidentBytes: 1024 * 1024 * 1024,
            nativeProcesses: 4,
            ioWeight: 8,
        }, {
            maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
            interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
        });
        dir = await mkdtemp(join(tmpdir(), 'evb-doc-save-inproc-'));
        pdfPath = join(dir, 'staged.pdf');
        await writeFile(pdfPath, samplePdf);
    });

    afterEach(async () => {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    });

    it('fingerprints a file asynchronously in main under an interactive broker slot', async () => {
        const result = await fingerprintFileWithUtilityProcess(pdfPath);

        expect(result.bytes).toBe(Buffer.byteLength(samplePdf));
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(result.contentFingerprint).toMatch(/^sha256-full-v1:[a-f0-9]{64}$/u);
        expect(mocks.broker!.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('rejects immediately without running when already aborted', async () => {
        const controller = new AbortController();
        controller.abort(new Error('save canceled before validation'));

        await expect(validateDocumentSaveStagingFile({
            type: 'validate',
            sourcePath: pdfPath,
            expectedBytes: Buffer.byteLength(samplePdf),
            validationBinary: '/mock/qpdf',
        }, {
            timeoutMs: 1_000,
            signal: controller.signal,
        })).rejects.toThrow('save canceled before validation');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('validates a targeted save with an object between 256 KiB and 1 MiB and passes lease proof sink', async () => {
        const object = `<< /Payload (${'.'.repeat(300 * 1024)}) >>`;
        mocks.runNativeToolCommand.mockImplementation(async (_binary, args, options) => {
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            expect(options).toMatchObject({
                timeoutMs: 60_000,
                maxStdoutBytes: 1024 * 1024,
                maxStderrBytes: 256 * 1024,
                onTerminationProof: expect.any(Function),
            });
            return {
                exitCode: 0,
                stdout: object,
                stderr: '',
            };
        });

        const result = await verifyPdfTempFile(pdfPath, {
            changedObjectRefs: ['1 0 R'],
        });

        expect(result).toMatchObject({
            bytes: Buffer.byteLength(samplePdf),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(2);
        expect(mocks.broker!.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('retains the broker lease when native validation termination is unproven on cancellation', async () => {
        const failure = markUnprovenNativeTermination(new Error('native timeout'), 'qpdf still owns staged bytes');
        const started = Promise.withResolvers<AbortSignal | undefined>();
        const pending = Promise.withResolvers<{
            exitCode: number;
            stdout: string;
            stderr: string;
        }>();
        mocks.runNativeToolCommand.mockImplementation((_binary, args, options) => {
            if (args[0] === '--check') {
                return Promise.resolve({
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                });
            }
            options?.onTerminationProof?.(Promise.resolve(false));
            started.resolve(options?.signal);
            return pending.promise;
        });

        const controller = new AbortController();
        const task = verifyPdfTempFile(pdfPath, {
            signal: controller.signal,
            changedObjectRefs: ['3 0 R'],
        });
        const signal = await started.promise;
        controller.abort(new Error('save canceled while qpdf was running'));
        expect(signal?.aborted).toBe(true);
        pending.reject(failure);

        const observed = await task.catch((error: unknown) => error);
        expect(observed).toBe(failure);
        expect(getUnprovenNativeTerminationDetail(observed)).toBe('qpdf still owns staged bytes');
        expect(mocks.broker!.getSnapshot()).toMatchObject({
            active: 1,
            used: {
                cpuTokens: 1,
                nativeProcesses: 1,
            },
        });
    });
});
