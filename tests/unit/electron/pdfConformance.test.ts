import type * as TNodeFsPromises from 'node:fs/promises';
import type * as TJobBrokerModule from '@electron/resources/jobBroker';
import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';
import type * as TPdfCore from '@pdf-core';
import {
    getUnprovenNativeTerminationDetail,
    markUnprovenNativeTermination,
} from '@electron/utils/nativeTerminationProof';
import {createWorkerTaskErrorFrame} from '@electron/utils/workerTask';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const workerState: {
        mode: 'error-frame' | 'malformed-result' | 'runtime-error' | 'startup-error' | 'success';
        errorFrame?: unknown
    } = {mode: 'startup-error'};
    const workerCtor = vi.fn();
    const broker = {current: null as TJobBrokerModule.JobBroker | null};
    const loggerWarn = vi.fn();
    const runNativeToolCommand = vi.fn();
    let rangeBytes: Buffer<ArrayBufferLike> = Buffer.from('%PDF-1.7\n', 'latin1');
    let factsBytes: Buffer<ArrayBufferLike> = Buffer.from(JSON.stringify({
        isEncrypted: false,
        isTagged: false,
        hasAcroForm: false,
        hasXfa: false,
    }), 'utf8');
    const setRangeBytes = (bytes: Buffer<ArrayBufferLike>) => {
        rangeBytes = bytes;
    };
    const setFactsBytes = (bytes: Buffer<ArrayBufferLike>) => {
        factsBytes = bytes;
    };
    const readBytes = async (
        source: Buffer,
        buffer: Buffer,
        bufferOffset: number,
        length: number,
        position: number | bigint | null,
        sparse = false,
    ) => {
        const sourceOffset = Number(position ?? 0);
        const bytesRead = sparse && sourceOffset >= source.length
            ? length
            : Math.min(length, Math.max(0, source.length - sourceOffset));
        if (bytesRead > 0) {
            buffer.fill(0, bufferOffset, bufferOffset + bytesRead);
            const copyStart = Math.min(sourceOffset, source.length);
            const copyEnd = Math.min(
                source.length,
                sourceOffset + bytesRead,
            );
            if (copyEnd > copyStart) {
                source.copy(
                    buffer,
                    bufferOffset + copyStart - sourceOffset,
                    copyStart,
                    copyEnd,
                );
            }
        }
        return {bytesRead};
    };
    const rangeRead = vi.fn(async (
        buffer: Buffer,
        bufferOffset: number,
        length: number,
        position: number | bigint | null,
    ) => readBytes(rangeBytes, buffer, bufferOffset, length, position, true));
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async (_filePath: string) => ({
        read: rangeRead,
        close,
    }));
    const mkdtemp = vi.fn(async () => '/tmp/pdf-page-ops-facts');
    const writeFile = vi.fn(async () => undefined);
    const rm = vi.fn(async () => undefined);
    const load = vi.fn();
    const stat = vi.fn(async () => ({
        isFile: () => true,
        size: rangeBytes.length,
    }));

    return {
        workerState,
        broker,
        sparseMarkerResults: false,
        workerCtor,
        loggerWarn,
        runNativeToolCommand,
        rangeBytes,
        setRangeBytes,
        setFactsBytes,
        readFacts: () => factsBytes.toString('utf8'),
        rangeRead,
        close,
        open,
        mkdtemp,
        writeFile,
        rm,
        stat,
        load,
    };
});

vi.mock('@electron/resources/jobBroker', async importOriginal => {
    const actual = await importOriginal<typeof TJobBrokerModule>();
    return {
        ...actual,
        mainJobBroker: {run: <T>(request: TJobBrokerModule.IJobBrokerRequest, work: () => Promise<T>) => mocks.broker.current!.run(request, work)},
    };
});
beforeEach(async () => {
    const {JobBroker} = await vi.importActual<typeof TJobBrokerModule>('@electron/resources/jobBroker');
    mocks.broker.current = new JobBroker({
        cpuTokens: 2,
        estimatedResidentBytes: 512 * 1024 * 1024,
        nativeProcesses: 2,
        ioWeight: 1,
    });
});
vi.mock('@pdf-core', async importOriginal => {
    const actual = await importOriginal<typeof TPdfCore>();
    return {
        ...actual,
        hasPdfEncryptMarkersInPdfText: (text: string) => (
            mocks.sparseMarkerResults ? false : actual.hasPdfEncryptMarkersInPdfText(text)
        ),
        detectPdfaLevelFromPdfText: (text: string) => (
            mocks.sparseMarkerResults ? null : actual.detectPdfaLevelFromPdfText(text)
        ),
    };
});

vi.mock('worker_threads', () => ({Worker: class {
    private readonly onceHandlers = new Map<string, Set<(arg: unknown) => void>>();

    private readonly onHandlers = new Map<string, Set<(arg: unknown) => void>>();

    constructor(script: string, options: unknown) {
        mocks.workerCtor(script, options);
        queueMicrotask(() => {
            switch (mocks.workerState.mode) {
                case 'error-frame':
                    this.emit('online', undefined);
                    this.emit('message', {
                        type: 'result',
                        ok: false,
                        errorFrame: mocks.workerState.errorFrame,
                    });
                    return;
                case 'startup-error':
                    this.emit('error', new Error('PDF worker missing'));
                    return;
                case 'runtime-error':
                    this.emit('online', undefined);
                    this.emit('error', new Error('worker crashed after startup'));
                    return;
                case 'malformed-result':
                    this.emit('online', undefined);
                    this.emit('message', {
                        type: 'result',
                        ok: true,
                        data: {
                            isSigned: false,
                            isEncrypted: false,
                            isTagged: false,
                            pdfaLevel: null,
                            hasAcroForm: false,
                            hasXfa: false,
                            canIncrementalSave: 'yes',
                            saveRestrictions: [],
                        },
                    });
                    return;
                case 'success':
                    this.emit('online', undefined);
                    this.emit('message', {
                        type: 'result',
                        ok: true,
                        data: {
                            isSigned: false,
                            isEncrypted: false,
                            isTagged: false,
                            pdfaLevel: null,
                            hasAcroForm: false,
                            hasXfa: false,
                            canIncrementalSave: true,
                            saveRestrictions: [],
                        },
                    });
                    return;
                default:
                    return;
            }
        });
    }

    on(event: string, callback: (arg: unknown) => void) {
        const handlers = this.onHandlers.get(event) ?? new Set();
        handlers.add(callback);
        this.onHandlers.set(event, handlers);
        return this;
    }

    once(event: string, callback: (arg: unknown) => void) {
        const handlers = this.onceHandlers.get(event) ?? new Set();
        handlers.add(callback);
        this.onceHandlers.set(event, handlers);
        return this;
    }

    removeAllListeners(event?: string) {
        if (event) {
            this.onceHandlers.delete(event);
            this.onHandlers.delete(event);
            return this;
        }

        this.onceHandlers.clear();
        this.onHandlers.clear();
        return this;
    }

    removeListener(event: string, callback: (arg: unknown) => void) {
        this.onceHandlers.get(event)?.delete(callback);
        this.onHandlers.get(event)?.delete(callback);
        return this;
    }

    terminate() {
        return Promise.resolve(0);
    }

    private emit(event: string, payload: unknown) {
        const onHandlers = [...(this.onHandlers.get(event) ?? [])];
        for (const handler of onHandlers) {
            handler(payload);
        }

        const onceHandlers = [...(this.onceHandlers.get(event) ?? [])];
        this.onceHandlers.delete(event);
        for (const handler of onceHandlers) {
            handler(payload);
        }
    }
}}));

vi.mock('fs/promises', () => ({
    open: mocks.open,
    mkdtemp: mocks.mkdtemp,
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('pdf-lib', () => {
    function MockPDFDict(this: unknown) {
        void this;
    }
    const MockPDFName = { of: (name: string) => name };

    return {
        PDFDict: MockPDFDict,
        PDFDocument: { load: mocks.load },
        PDFName: MockPDFName,
    };
});

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: async (...args: unknown[]) => {
    const result = await mocks.runNativeToolCommand(...args) as {stdout: string} | undefined;
    return (args[1] as string[])[0] === 'pdf-conformance'
        ? {
            ...result,
            stdout: mocks.readFacts(),
        }
        : result;
}}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({qpdf: '/mock/qpdf'}),
}));
vi.mock('@electron/features/page-ops/main/resolveNativePageOpsPath', () => ({resolveNativePageOpsPath: () => '/mock/page-ops'}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
})}));

const {
    analyzePdfConformanceFile,
    validatePdfFile,
    validatePdfFileForOpening,
    validatePdfFileForSave,
} = await import('@electron/features/documents/main/pdfConformance');
const { analyzePdfConformanceFileDirect } = await import('@electron/features/documents/main/analyzePdfConformanceFileDirect');

function createNativeStructuralFacts(options: {
    signed?: boolean;
    encrypted?: boolean;
    tagged?: boolean;
    acroForm?: boolean;
    xfa?: boolean;
} = {}) {
    return Buffer.from(JSON.stringify({
        isSigned: options.signed ?? false,
        isEncrypted: options.encrypted ?? false,
        isTagged: options.tagged ?? false,
        hasAcroForm: options.acroForm ?? false,
        hasXfa: options.xfa ?? false,
    }), 'utf8');
}

describe('analyzePdfConformanceFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'startup-error';
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: mocks.rangeBytes.length,
        });
        mocks.setFactsBytes(createNativeStructuralFacts());
    });

    it('returns the worker result when the worker starts successfully', async () => {
        mocks.workerState.mode = 'success';

        const result = await analyzePdfConformanceFile('/tmp/input.pdf');

        expect(result).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.workerCtor.mock.calls[0]?.[1]).not.toHaveProperty('resourceLimits');
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).not.toHaveBeenCalled();
    });

    it('surfaces startup failures without falling back to direct main-thread analysis', async () => {
        await expect(analyzePdfConformanceFile('/tmp/input.pdf'))
            .rejects
            .toThrow('PDF conformance worker failed before becoming ready: PDF worker missing');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('surfaces runtime worker failures without falling back to the main thread', async () => {
        mocks.workerState.mode = 'runtime-error';

        await expect(analyzePdfConformanceFile('/tmp/runtime-failure.pdf'))
            .rejects
            .toThrow('worker crashed after startup');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed worker result payloads', async () => {
        mocks.workerState.mode = 'malformed-result';

        await expect(analyzePdfConformanceFile('/tmp/malformed-result.pdf'))
            .rejects
            .toThrow('PDF conformance worker returned an invalid payload');

        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    });
});

describe('analyzePdfConformanceFileDirect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        mocks.setFactsBytes(createNativeStructuralFacts());
        mocks.setRangeBytes(Buffer.from('%PDF-1.7\n', 'latin1'));
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 9,
        });
    });

    it('uses native qpdf structure and bounded marker reads without a whole-file read', async () => {
        mocks.setRangeBytes(Buffer.from(`
            %PDF-1.7
            <pdfaid:part>2</pdfaid:part>
            <pdfaid:conformance>b</pdfaid:conformance>
            /ByteRange [0 10 20 30]
            /Encrypt 42 0 R
        `, 'latin1'));
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 160,
        });
        mocks.setFactsBytes(createNativeStructuralFacts({encrypted: true}));

        const result = await analyzePdfConformanceFileDirect('/tmp/partial.pdf');

        expect(result).toMatchObject({
            isSigned: false,
            isEncrypted: true,
            pdfaLevel: 'PDF/A-2B',
            canIncrementalSave: false,
        });
        expect(mocks.open).toHaveBeenCalledWith('/tmp/partial.pdf', 'r');
        expect(mocks.rangeRead).toHaveBeenCalledWith(
            expect.any(Buffer),
            0,
            160,
            0n,
        );
        expect(mocks.rangeRead.mock.calls[0]?.[2]).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it('scans conformance markers across bounded windows without decoding the whole PDF', async () => {
        const scanBoundary = 4 * 1024 * 1024;
        const data = Buffer.alloc(scanBoundary + 256, 0x20);
        data.write('/ByteRange [0 10 20 30]', scanBoundary - 12, 'latin1');
        data.write('/Encrypt 42 0 R', scanBoundary + 32, 'latin1');
        data.write(
            '<pdfaid:part>3</pdfaid:part><pdfaid:conformance>u</pdfaid:conformance>',
            scanBoundary + 64,
            'latin1',
        );
        mocks.setRangeBytes(data);
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: data.length,
        });
        mocks.setFactsBytes(createNativeStructuralFacts({encrypted: true}));

        const result = await analyzePdfConformanceFileDirect('/tmp/large-partial.pdf');

        expect(result).toMatchObject({
            isSigned: false,
            isEncrypted: true,
            pdfaLevel: 'PDF/A-3U',
            canIncrementalSave: false,
        });
        expect(mocks.rangeRead.mock.calls.every(call =>
            call[2] <= 4 * 1024 * 1024,
        )).toBe(true);
    });

    it('retains tagged, AcroForm, XFA, and save restriction semantics', async () => {
        mocks.setFactsBytes(createNativeStructuralFacts({
            tagged: true,
            acroForm: true,
            xfa: true,
        }));

        const result = await analyzePdfConformanceFileDirect('/tmp/forms.pdf');

        expect(result).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: true,
            pdfaLevel: null,
            hasAcroForm: true,
            hasXfa: true,
            canIncrementalSave: false,
            saveRestrictions: [
                'xfa_forms_are_not_supported_for_rewrite',
                'tagged_pdf_requires_structure_preservation',
                'incremental_save_not_supported',
            ],
        });
    });

    it('analyzes a sparse multi-gigabyte path without an encoded-size refusal', async () => {
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 2 * 1024 * 1024 * 1024 + 1,
        });
        mocks.setFactsBytes(createNativeStructuralFacts());
        // The sparse fixture contains a PDF header and zero-filled holes.
        // Marker parsing is covered with real cross-window bytes above; here
        // use its known result while exercising every large-file range read.
        const reads: Array<{
            length: number;
            position: number | bigint | null;
        }> = [];
        const normalRead = mocks.rangeRead.getMockImplementation()!;
        mocks.rangeRead.mockImplementation(async (buffer, offset, length, position) => {
            reads.push({
                length,
                position,
            });
            // Recording the buffer argument would retain two GiB of mock
            // history. Keep the observable ranges and release each buffer.
            mocks.rangeRead.mockClear();
            buffer.fill(0, offset, offset + length);
            return {bytesRead: length};
        });
        mocks.sparseMarkerResults = true;
        try {
            const result = await analyzePdfConformanceFileDirect('/tmp/sparse-2gib.pdf');

            expect(result.canIncrementalSave).toBe(true);
            expect(mocks.open).toHaveBeenCalledTimes(1);
            expect(reads.length).toBeGreaterThan(500);
            expect(reads.every(read => read.length <= 4 * 1024 * 1024)).toBe(true);
            expect(reads.at(-1)?.position).toBe(2n * 1024n * 1024n * 1024n);
            expect(mocks.close).toHaveBeenCalledTimes(1);
            expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
                '/mock/page-ops',
                [
                    'pdf-conformance',
                    '--input',
                    '/tmp/sparse-2gib.pdf',
                    '--qpdf',
                    '/mock/qpdf',
                ],
                expect.objectContaining({
                    maxStdoutBytes: 64 * 1024,
                    rejectOnStdoutTruncation: true,
                }),
            );
        } finally {
            mocks.sparseMarkerResults = false;
            mocks.rangeRead.mockImplementation(normalRead);
        }
    }, 15_000);

    it('fails with a typed capability error when qpdf structure is unavailable', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('qpdf unavailable'));

        await expect(analyzePdfConformanceFileDirect('/tmp/unavailable.pdf'))
            .rejects
            .toMatchObject({
                name: 'PdfConformanceCapabilityError',
                code: 'native-failure',
            });
        expect(mocks.open).not.toHaveBeenCalled();
    });
});

describe('validatePdfFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        mocks.setFactsBytes(createNativeStructuralFacts());
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 9,
        });
    });

    it('uses qpdf validation when qpdf completes', async () => {
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            stdout: 'checking /tmp/input.pdf\nwarning: repaired xref',
            stderr: '',
            exitCode: 0,
        });

        const result = await validatePdfFile('/tmp/input.pdf');

        expect(result).toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: ['warning: repaired xref'],
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/mock/qpdf', [
            '--check',
            '/tmp/input.pdf',
        ], {
            timeoutMs: 30_000,
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(validate-pdf)',
        });
        expect(mocks.open).not.toHaveBeenCalled();
    });

    it('scales qpdf validation time for a legitimate large PDF', async () => {
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 1024 * 1024 * 1024,
        });

        await validatePdfFile('/tmp/large.pdf');

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/mock/qpdf', [
            '--check',
            '/tmp/large.pdf',
        ], expect.objectContaining({ timeoutMs: 90_000 }));
    });

    it('accepts a qpdf timeout when structural fallback can load the PDF', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('qpdf(validate-pdf) timed out after 30000ms'));
        mocks.setFactsBytes(createNativeStructuralFacts());

        const result = await validatePdfFile('/tmp/slow.pdf');

        expect(result).toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: ['qpdf validation timed out after 30000ms; fallback PDF structure validation succeeded.'],
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(2);
        expect(mocks.runNativeToolCommand).toHaveBeenLastCalledWith(
            '/mock/page-ops',
            [
                'pdf-conformance',
                '--input',
                '/tmp/slow.pdf',
                '--qpdf',
                '/mock/qpdf',
            ],
            expect.objectContaining({
                maxStdoutBytes: 64 * 1024,
                timeoutMs: 10 * 60 * 1000,
            }),
        );
        expect(mocks.loggerWarn).toHaveBeenCalledOnce();
    });

    it('keeps a qpdf timeout invalid when structural fallback cannot load the PDF', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('qpdf(validate-pdf) timed out after 30000ms'));
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('bad xref'));

        const result = await validatePdfFile('/tmp/broken.pdf');

        expect(result).toEqual({
            isValid: false,
            tool: 'qpdf',
            errors: ['qpdf(validate-pdf) timed out after 30000ms; fallback PDF structure validation failed: '
                + 'Native PDF conformance structure was unavailable for "/tmp/broken.pdf": bad xref'],
            warnings: [],
        });
    });

    it('keeps structural timeout fallback available for a large path', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('qpdf(validate-pdf) timed out after 30000ms'));
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 2 * 1024 * 1024 * 1024 + 1,
        });
        mocks.setFactsBytes(createNativeStructuralFacts());

        const result = await validatePdfFile('/tmp/oversized.pdf');

        expect(result).toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: ['qpdf validation timed out after 155000ms; fallback PDF structure validation succeeded.'],
        });
        expect(mocks.rangeRead).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(2);
    });
});

describe('validatePdfFileForOpening', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '882\n',
            stderr: '',
            exitCode: 0,
        });
    });

    it('uses the bounded page-tree check instead of the whole-file qpdf scan', async () => {
        const result = await validatePdfFileForOpening('/tmp/large.pdf');

        expect(result).toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/mock/qpdf', [
            '--show-npages',
            '/tmp/large.pdf',
        ], {
            timeoutMs: 10_000,
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(validate-pdf-opening)',
        });
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalledWith(
            '/mock/qpdf',
            expect.arrayContaining(['--check']),
            expect.anything(),
        );
    });

    it('rejects a malformed page count', async () => {
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            stdout: 'not-a-page-count\n',
            stderr: '',
            exitCode: 0,
        });

        await expect(validatePdfFileForOpening('/tmp/broken.pdf')).resolves.toEqual({
            isValid: false,
            tool: 'qpdf',
            errors: ['PDF structural validation returned an invalid page count'],
            warnings: [],
        });
    });

    it('rejects a non-canonical page count', async () => {
        mocks.runNativeToolCommand.mockResolvedValueOnce({
            stdout: '00882\n',
            stderr: '',
            exitCode: 0,
        });

        await expect(validatePdfFileForOpening('/tmp/broken.pdf')).resolves.toEqual({
            isValid: false,
            tool: 'qpdf',
            errors: ['PDF structural validation returned an invalid page count'],
            warnings: [],
        });
    });

    it('keeps qpdf opening failures fail-closed', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('damaged xref table'));

        await expect(validatePdfFileForOpening('/tmp/broken.pdf')).resolves.toEqual({
            isValid: false,
            tool: 'qpdf',
            errors: ['damaged xref table'],
            warnings: [],
        });
    });
});

describe('validatePdfFileForSave', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '882\n',
            stderr: '',
            exitCode: 0,
        });
    });

    it('uses the structural page-tree check without a whole-file qpdf scan', async () => {
        await expect(validatePdfFileForSave('/tmp/large.pdf')).resolves.toMatchObject({
            isValid: true,
            tool: 'qpdf',
        });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/mock/qpdf', [
            '--show-npages',
            '/tmp/large.pdf',
        ], expect.objectContaining({
            timeoutMs: 10_000,
            commandLabel: 'qpdf(validate-pdf-structure)',
        }));
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalledWith(
            '/mock/qpdf',
            expect.arrayContaining(['--check']),
            expect.anything(),
        );
    });
});

describe('native reader termination refusal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerState.mode = 'startup-error';
    });

    it.each([
        validatePdfFileForOpening,
        validatePdfFileForSave,
        validatePdfFile,
    ])('preserves a marked validation failure before an aborted signal can replace it', async validate => {
        const failure = markUnprovenNativeTermination(new Error('Native read is not settled'), 'native reader still owns its input');
        const controller = new AbortController();
        controller.abort(new Error('Caller closed the document'));
        mocks.runNativeToolCommand.mockRejectedValueOnce(failure);
        await expect(validate('/tmp/input.pdf', {signal: controller.signal})).rejects.toBe(failure);
        expect(getUnprovenNativeTerminationDetail(failure)).toBe('native reader still owns its input');
    });

    it('refuses fallback after a marked primary timeout', async () => {
        const failure = markUnprovenNativeTermination(new Error('qpdf(validate-pdf) timed out after 30000ms'), 'primary qpdf tree remains alive');
        mocks.runNativeToolCommand.mockRejectedValueOnce(failure);
        await expect(validatePdfFile('/tmp/input.pdf')).rejects.toBe(failure);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledOnce();
    });

    it.each([
        validatePdfFileForOpening,
        validatePdfFileForSave,
        validatePdfFile,
    ])('keeps completed validation failures invalid and current cancellation a refusal', async validate => {
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('damaged xref table'));
        await expect(validate('/tmp/input.pdf')).resolves.toMatchObject({
            isValid: false,
            errors: ['damaged xref table'],
        });
        const controller = new AbortController();
        const closed = new Error('Caller closed the document');
        controller.abort(closed);
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('damaged xref table'));
        await expect(validate('/tmp/input.pdf', {signal: controller.signal})).rejects.toBe(closed);
    });

    it('preserves marked fallback failure instead of fulfilling an invalid result', async () => {
        const failure = markUnprovenNativeTermination(new Error('Native structure read did not settle'), 'structural child tree remains alive');
        mocks.runNativeToolCommand.mockRejectedValueOnce(new Error('qpdf(validate-pdf) timed out after 30000ms'));
        mocks.runNativeToolCommand.mockRejectedValueOnce(failure);
        await expect(validatePdfFile('/tmp/input.pdf')).rejects.toBe(failure);
        expect(getUnprovenNativeTerminationDetail(failure)).toBe('structural child tree remains alive');
    });

    it('carries an actual structural callee failure through a cloned worker frame and the main decoder', async () => {
        const failure = markUnprovenNativeTermination(new Error('Native conformance read did not settle'), 'native descendant may still hold PDF bytes');
        mocks.runNativeToolCommand.mockRejectedValueOnce(failure);
        const observed = await analyzePdfConformanceFileDirect('/tmp/input.pdf').catch((error: unknown) => error);
        expect(observed).toBe(failure);
        mocks.workerState.mode = 'error-frame';
        mocks.workerState.errorFrame = structuredClone(createWorkerTaskErrorFrame(observed));
        const decoded = await analyzePdfConformanceFile('/tmp/input.pdf').catch((error: unknown) => error);
        expect(decoded).toBeInstanceOf(Error);
        expect(getUnprovenNativeTerminationDetail(decoded)).toBe('native descendant may still hold PDF bytes');
        expect(decoded).toMatchObject({message: 'Native conformance read did not settle'});
    });
});


// Real file opens and the main handler/read-lease owner, isolated from the direct-parser mocks above.
describe('conformance admission through the main handler', () => {
    async function mainHarness() {
        const {EventEmitter} = await import('node:events');
        const fs = await vi.importActual<typeof TNodeFsPromises>('node:fs/promises');
        const {join} = await import('node:path');
        const {tmpdir} = await import('node:os');
        const {JobBroker} = await vi.importActual<typeof TJobBrokerModule>('@electron/resources/jobBroker');
        const resources = {
            cpuTokens: 2,
            estimatedResidentBytes: 512 * 1024 * 1024,
            nativeProcesses: 2,
            ioWeight: 1,
        };
        const broker = new JobBroker(resources);
        const directory = await fs.mkdtemp(join(tmpdir(), 'conformance-main-admission-'));
        const opened = new Set<string>(); const closed = new Set<string>();
        const handles: TNodeFsPromises.FileHandle[] = [];
        const operations = new Map<string, {
            controller: AbortController;
            completed: boolean
        }>();
        let workerActive = 0;
        const records: Array<{
            emit: (event: string, value: unknown) => boolean;
            fence: ReturnType<typeof Promise.withResolvers<number>> | null
        }> = [];
        vi.resetModules();
        vi.doMock('fs/promises', () => ({
            ...fs,
            open: async (path: string, flags: string) => {
                const handle = await fs.open(path, flags);
                opened.add(path); handles.push(handle);
                const close = handle.close.bind(handle);
                handle.close = async () => { await close(); closed.add(path); };
                return handle;
            },
        }));
        vi.doMock('@electron/resources/jobBroker', () => ({mainJobBroker: broker}));
        vi.doMock('worker_threads', () => ({
            isMainThread: true,
            Worker: class extends EventEmitter {
                readonly record = {
                    emit: (event: string, value: unknown) => {
                        if (event === 'exit' && !this.ended) { this.ended = true; workerActive--; }
                        return this.emit(event, value);
                    },
                    fence: null as ReturnType<typeof Promise.withResolvers<number>> | null,
                };
                private ended = false;
                constructor() { super(); records.push(this.record); workerActive++; }
                postMessage() {}
                async terminate() {
                    const code = await (this.record.fence?.promise ?? Promise.resolve(0));
                    if (!this.ended) { this.ended = true; workerActive--; this.emit('exit', code); }
                    return code;
                }
            },
        }));
        // Each fixture stands for an open document whose bytes are a file of its own.
        vi.doMock('@electron/file-access/documentStore', () => ({
            getWorkingCopyBackingEntry: () => ({ref: 'document'}),
            runWithWorkingCopyReadBacking: (path: string, read: (physicalPath: string) => Promise<unknown>) => read(path),
            statOpenDocument: () => ({size: 1, modifiedAt: 1}),
        }));
        vi.doMock('@electron/file-access/workingCopyQuarantine', () => ({quarantineWorkingCopy: vi.fn()}));
        vi.doMock('@electron/features/documents/main/documentFilePathResolution', () => ({
            resolveExistingReadablePdfPath: async (path: string) => path,
            assertWithinIpcReadBudget: vi.fn(),
            resolveExistingReadableDocumentOrImagePath: async (path: string) => path,
            resolveReadablePathSync: (path: string) => path,
        }));
        vi.doMock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({registerMainOperation: (request: {workingCopyPath: string}) => {
            const operation = {
                controller: new AbortController(),
                completed: false,
            }; operations.set(request.workingCopyPath, operation);
            return {
                signal: operation.controller.signal,
                complete: () => { operation.completed = true; },
            };
        }}));
        const {handleAnalyzePdfConformance} = await import('@electron/features/documents/main/documentPdfValidationHandlers');
        const reads = await import('@electron/features/documents/main/documentFileReadHandlers');
        const profile = {
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        };
        return {
            broker,
            resources,
            records,
            operations,
            opened,
            closed,
            reads,
            directory,
            fs,
            profile,
            active: () => workerActive,
            async fixture(index: number) { const path = join(directory, `source-${index}.pdf`); await fs.writeFile(path, '%PDF-1.4\n%%EOF\n'); return path; },
            run: (path: string) => handleAnalyzePdfConformance({senderId: 13}, path),
            finish(index: number) { records[index]!.emit('online', undefined); records[index]!.emit('message', {
                type: 'result',
                ok: true,
                data: profile,
            }); },
            async close() {
                for (const operation of operations.values()) operation.controller.abort(new Error('test cleanup'));
                for (const record of records) { record.fence?.resolve(0); record.emit('exit', 0); }
                await Promise.all(handles.map(handle => handle.close().catch(() => undefined)));
                for (const name of [
                    'fs/promises',
                    '@electron/resources/jobBroker',
                    'worker_threads',
                    '@electron/file-access/documentStore',
                    '@electron/file-access/workingCopyQuarantine',
                    '@electron/features/documents/main/documentFilePathResolution',
                    '@electron/operation-lifecycle/mainOperationLifecycle',
                ]) vi.doUnmock(name);
                vi.resetModules(); await fs.rm(directory, {
                    recursive: true,
                    force: true,
                });
            },
        };
    }

    it('queues twelve distinct real-file reads, cancels one, and holds capacity through worker termination', async () => {
        const h = await mainHarness();
        const blocker = await h.broker.acquire({
            ownerId: 'occupied',
            kind: 'test',
            priority: 'user',
            resources: h.resources,
        });
        const paths = await Promise.all(Array.from({length: 12}, (_, i) => h.fixture(i)));
        const tasks = paths.map(path => h.run(path).catch((error: unknown) => error));
        try {
            await vi.waitFor(() => expect(h.records.length > 0 || h.broker.getSnapshot().queued === 12).toBe(true));
            expect(h.records).toHaveLength(0);
            expect(h.broker.getSnapshot().queued).toBe(12);
            h.operations.get(paths[11]!)!.controller.abort(new Error('working copy closed while queued'));
            expect(await tasks[11]).toBeInstanceOf(Error);
            expect(h.operations.get(paths[11]!)!.completed).toBe(true);
            expect(h.records).toHaveLength(0);
            blocker.release();
            await vi.waitFor(() => expect(h.records).toHaveLength(1));
            const fence = Promise.withResolvers<number>(); h.records[0]!.fence = fence;
            h.finish(0);
            await Promise.resolve();
            expect(h.active()).toBe(1);
            expect(h.broker.getSnapshot()).toMatchObject({
                active: 1,
                queued: 10,
                used: h.resources,
            });
            expect(h.records).toHaveLength(1);
            fence.resolve(0);
            for (let i = 1; i < 11; i++) {
                await vi.waitFor(() => expect(h.records).toHaveLength(i + 1));
                expect(h.active()).toBe(1);
                expect(h.broker.getSnapshot().used).toEqual(h.resources);
                h.finish(i);
            }
            const results = await Promise.all(tasks.slice(0, 11));
            expect(results).toEqual(Array.from({length: 11}, () => h.profile));
            expect(h.active()).toBe(0);
            expect(h.broker.getSnapshot()).toMatchObject({
                active: 0,
                queued: 0,
            });
        } finally { await h.close(); }
    });

    it.each([
        'marked-frame',
        'runtime-error',
        'empty-exit',
        'invalid-payload',
        'invalid-result',
        'ignored-cancel',
        'ordinary-frame',
        'startup-error',
    ] as const)(
        'keeps capacity only when descendant settlement is unproven: %s', async mode => {
            const h = await mainHarness();
            const path = await h.fixture(0);
            const task = h.run(path).catch((error: unknown) => error);
            try {
                await vi.waitFor(() => expect(h.records).toHaveLength(1));
                const worker = h.records[0]!;
                const error = new Error('worker failure');
                if (mode !== 'startup-error') worker.emit('online', undefined);
                if (mode === 'runtime-error' || mode === 'startup-error') worker.emit('error', error);
                else if (mode === 'empty-exit') worker.emit('exit', 0);
                else if (mode === 'invalid-payload') worker.emit('message', {type: 'unexpected'});
                else if (mode === 'invalid-result') worker.emit('message', {
                    type: 'result',
                    ok: true,
                    data: {},
                });
                else if (mode === 'ignored-cancel') {
                    vi.useFakeTimers();
                    h.operations.get(path)!.controller.abort(new Error('cooperative cancellation ignored'));
                    await vi.advanceTimersByTimeAsync(5_000);
                    vi.useRealTimers();
                } else {
                    const payload = mode === 'marked-frame' ? markUnprovenNativeTermination(error, 'native qpdf alive') : error;
                    worker.emit('message', {
                        type: 'result',
                        ok: false,
                        errorFrame: createWorkerTaskErrorFrame(payload),
                    });
                }
                const observed = await task;
                expect(observed).toBeInstanceOf(Error);
                const marked = ![
                    'ordinary-frame',
                    'startup-error',
                ].includes(mode);
                expect(getUnprovenNativeTerminationDetail(observed) !== undefined).toBe(marked);
                expect(h.broker.getSnapshot()).toMatchObject({
                    active: marked ? 1 : 0,
                    queued: 0,
                });
                if (marked) expect(h.broker.getSnapshot().used).toEqual(h.resources);
                expect(h.active()).toBe(0);
            } finally { vi.useRealTimers(); await h.close(); }
        },
    );
});
