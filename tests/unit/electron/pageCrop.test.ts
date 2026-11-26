import type * as TViMockJobBroker from '@electron/resources/jobBroker';
import {
    mkdtemp,
    readFile,
    rm,
    truncate,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PdfPageOpsCapabilityError } from '@electron/features/page-ops/main/pageOpsErrors';
import { markUnprovenNativeTermination } from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    broker: null as InstanceType<typeof TViMockJobBroker.JobBroker> | null,
    nativePageOpsPath: null as string | null,
    readFileCount: 0,
    runNativeToolCommand: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
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
vi.mock('fs/promises', async () => {
    const actual = await vi.importActual('fs/promises') as {
        [key: string]: unknown;
        readFile: typeof readFile;
    };
    return {
        ...actual,
        readFile: (...args: Parameters<typeof actual.readFile>) => {
            mocks.readFileCount += 1;
            return actual.readFile(...args);
        },
    };
});
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/features/page-ops/main/resolveNativePageOpsPath', () => ({resolveNativePageOpsPath: () => mocks.nativePageOpsPath}));

const { JobBroker } = await import('@electron/resources/jobBroker');
const {
    cropPages,
    getPageGeometry,
    removeCropFromPages,
} = await import('@electron/features/page-ops/main/crop');

const originalEnv = { ...process.env };

async function createPdf(path: string, options?: { inheritedCropBox?: [number, number, number, number] }) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([
        200,
        100,
    ]);

    if (options?.inheritedCropBox) {
        page.node.Parent()?.set(PDFName.of('CropBox'), pdfDoc.context.obj(options.inheritedCropBox));
    }

    await writeFile(path, await pdfDoc.save());
}

describe('page crop operations', () => {
    let tempDir = '';
    let pdfPath = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.broker = new JobBroker({
            cpuTokens: 4,
            estimatedResidentBytes: 4 * 1024 ** 3,
            nativeProcesses: 1,
            ioWeight: 8,
        });
        mocks.readFileCount = 0;
        mocks.nativePageOpsPath = null;
        process.env = { ...originalEnv };
        tempDir = await mkdtemp(join(tmpdir(), 'page-crop-test-'));
        pdfPath = join(tempDir, 'sample.pdf');
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('uses native page geometry without loading the PDF in JavaScript', async () => {
        await createPdf(pdfPath, { inheritedCropBox: [
            20,
            10,
            180,
            90,
        ] });
        mocks.nativePageOpsPath = '/native/evb-pdf-page-ops';
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args.slice(0, 1)).toEqual(['page-geometry']);
            return {
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                    mediaBox: {
                        x: 0,
                        y: 0,
                        width: 200,
                        height: 100,
                    },
                    cropBox: {
                        x: 20,
                        y: 10,
                        width: 160,
                        height: 80,
                    },
                    rotation: 0,
                    userUnit: 2,
                }),
            };
        });
        const loadSpy = vi.spyOn(PDFDocument, 'load');

        try {
            await expect(getPageGeometry(pdfPath, 1)).resolves.toEqual({
                mediaBox: {
                    x: 0,
                    y: 0,
                    width: 200,
                    height: 100,
                },
                cropBox: {
                    x: 20,
                    y: 10,
                    width: 160,
                    height: 80,
                },
                rotation: 0,
                userUnit: 2,
            });
        } finally {
            expect(loadSpy).not.toHaveBeenCalled();
            loadSpy.mockRestore();
        }
    });

    it('fails closed when native page geometry fails', async () => {
        await createPdf(pdfPath);
        await truncate(pdfPath, 2 * 1024 * 1024 * 1024 + 1);
        mocks.nativePageOpsPath = '/native/evb-pdf-page-ops';
        mocks.runNativeToolCommand.mockRejectedValue(new Error('native geometry unavailable'));
        const loadSpy = vi.spyOn(PDFDocument, 'load');

        try {
            await expect(getPageGeometry(pdfPath, 1)).rejects.toMatchObject({
                name: 'PdfPageOpsCapabilityError',
                code: 'native-failure',
                operation: 'get-page-geometry',
            });
            expect(mocks.readFileCount).toBe(0);
            expect(loadSpy).not.toHaveBeenCalled();
        } finally {
            loadSpy.mockRestore();
        }
    });

    it('fails closed with native-unavailable when native page-ops is missing', async () => {
        await createPdf(pdfPath);
        const loadSpy = vi.spyOn(PDFDocument, 'load');

        try {
            await expect(cropPages(pdfPath, [1], {
                top: 1,
                bottom: 1,
                left: 1,
                right: 1,
            })).rejects.toBeInstanceOf(PdfPageOpsCapabilityError);
            await expect(removeCropFromPages(pdfPath, [1])).rejects.toMatchObject({
                name: 'PdfPageOpsCapabilityError',
                code: 'native-unavailable',
                operation: 'remove-crop',
            });
            await expect(getPageGeometry(pdfPath, 1)).rejects.toMatchObject({
                name: 'PdfPageOpsCapabilityError',
                code: 'native-unavailable',
                operation: 'get-page-geometry',
            });
            expect(mocks.readFileCount).toBe(0);
            expect(loadSpy).not.toHaveBeenCalled();
        } finally {
            loadSpy.mockRestore();
        }
    });

    it('propagates cancellation while native page geometry is running', async () => {
        await createPdf(pdfPath);
        mocks.nativePageOpsPath = '/native/evb-pdf-page-ops';
        mocks.runNativeToolCommand.mockImplementation(async (
            _binaryPath: string,
            _args: string[],
            options: {signal?: AbortSignal},
        ) => {
            await new Promise<never>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    const error = new Error('Operation aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, {once: true});
            });
            throw new Error('unreachable');
        });
        const controller = new AbortController();
        const request = getPageGeometry(pdfPath, 1, undefined, controller.signal);
        controller.abort();

        await expect(request).rejects.toMatchObject({name: 'AbortError'});
    });

    it('appends the native crop in place without parsing the document in JavaScript', async () => {
        await createPdf(pdfPath);
        mocks.nativePageOpsPath = '/native/evb-pdf-page-ops';
        let capturedArgs: string[] = [];
        let capturedMutations: unknown = null;
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            capturedArgs = [...args];
            const mutationsPath = args[args.indexOf('--mutations-file') + 1]!;
            capturedMutations = JSON.parse(await readFile(mutationsPath, 'utf8'));
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\nnative crop');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const loadSpy = vi.spyOn(PDFDocument, 'load');
        let javaScriptParseCount = 0;

        try {
            await cropPages(pdfPath, [1], {
                top: 10,
                bottom: 10,
                left: 10,
                right: 10,
            });
        } finally {
            javaScriptParseCount = loadSpy.mock.calls.length;
            loadSpy.mockRestore();
        }

        expect(javaScriptParseCount).toBe(0);
        expect(capturedArgs[0]).toBe('save-mutations');
        expect(capturedArgs[capturedArgs.indexOf('--input') + 1]).toBe(pdfPath);
        expect(capturedArgs[capturedArgs.indexOf('--output') + 1]).toBe(pdfPath);
        expect(capturedArgs).toContain('--append');
        expect(capturedArgs).toContain('--append-in-place');
        expect(capturedMutations).toEqual({
            pageCrops: [{
                pageIndex: 0,
                top: 10,
                bottom: 10,
                left: 10,
                right: 10,
            }],
        });
        await expect(readFile(pdfPath, 'utf8')).resolves.toBe('%PDF-1.7\nnative crop');
    });

    it.each([
        [
            'crop',
            () => cropPages(pdfPath, [1], {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
            }, 9),
        ],
        [
            'removeCrop',
            () => removeCropFromPages(pdfPath, [1], 9),
        ],
    ])('queues %s behind an active native lease and releases when finished', async (_kind, runOp) => {
        await createPdf(pdfPath);
        mocks.nativePageOpsPath = '/native/evb-pdf-page-ops';
        mocks.runNativeToolCommand.mockImplementationOnce(async (_binaryPath: string, args: string[]) => {
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\nbrokered crop');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
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
            expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
            expect(mocks.broker!.getSnapshot()).toMatchObject({
                active: 1,
                queued: 1,
            });

            blockerGate.resolve();
            await blockerDone;
            await expect(opPromise).resolves.toBeUndefined();
            expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(1);
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
            () => cropPages(pdfPath, [1], {
                top: 1,
                bottom: 1,
                left: 1,
                right: 1,
            }, 9),
        ],
        [
            'removeCrop',
            () => removeCropFromPages(pdfPath, [1], 9),
        ],
    ])('retains its broker lease when %s ends without termination proof', async (_kind, runOp) => {
        await createPdf(pdfPath);
        mocks.nativePageOpsPath = '/native/evb-pdf-page-ops';
        const unproven = markUnprovenNativeTermination(new Error('crop child hung'), 'crop child still alive');
        mocks.runNativeToolCommand.mockImplementationOnce(async (
            _binaryPath: string,
            _args: string[],
            options: { onTerminationProof?: (proof: Promise<boolean>) => void },
        ) => {
            options.onTerminationProof?.(Promise.resolve(false));
            throw unproven;
        });

        await expect(runOp()).rejects.toMatchObject({
            name: 'PdfPageOpsCapabilityError',
            code: 'native-failure',
            cause: unproven,
        });
        expect(mocks.broker!.getSnapshot()).toMatchObject({
            active: 1,
            used: { nativeProcesses: 1 },
        });
    });
});
