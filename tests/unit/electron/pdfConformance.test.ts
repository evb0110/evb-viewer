import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const workerState: { mode: 'malformed-result' | 'runtime-error' | 'startup-error' | 'success' } = {mode: 'startup-error'};
    const workerCtor = vi.fn();
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
    const factsRead = vi.fn(async (
        buffer: Buffer,
        bufferOffset: number,
        length: number,
        position: number | bigint | null,
    ) => readBytes(factsBytes, buffer, bufferOffset, length, position));
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async (filePath: string) => ({
        read: filePath.endsWith('/facts.json') ? factsRead : rangeRead,
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
        workerCtor,
        loggerWarn,
        runNativeToolCommand,
        rangeBytes,
        setRangeBytes,
        setFactsBytes,
        rangeRead,
        factsRead,
        close,
        open,
        mkdtemp,
        writeFile,
        rm,
        stat,
        load,
    };
});

vi.mock('worker_threads', () => ({Worker: class {
    private readonly onceHandlers = new Map<string, Set<(arg: unknown) => void>>();

    private readonly onHandlers = new Map<string, Set<(arg: unknown) => void>>();

    constructor(script: string, options: unknown) {
        mocks.workerCtor(script, options);
        queueMicrotask(() => {
            switch (mocks.workerState.mode) {
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

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: () => ({qpdf: '/mock/qpdf'}),
}));
vi.mock('@electron/features/page-ops/main/nativePageOpsPath', () => ({resolveNativePageOpsPath: () => '/mock/page-ops'}));
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
            isSigned: true,
            isEncrypted: true,
            pdfaLevel: 'PDF/A-2B',
            canIncrementalSave: false,
        });
        expect(mocks.open).toHaveBeenCalledWith('/tmp/partial.pdf', 'r');
        expect(mocks.open).toHaveBeenCalledWith('/tmp/pdf-page-ops-facts/facts.json', 'r');
        expect(mocks.rangeRead).toHaveBeenCalledWith(
            expect.any(Buffer),
            0,
            160,
            0n,
        );
        expect(mocks.rangeRead.mock.calls[0]?.[2]).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(mocks.close).toHaveBeenCalledTimes(2);
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
            isSigned: true,
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

        const result = await analyzePdfConformanceFileDirect('/tmp/sparse-2gib.pdf');

        expect(result.canIncrementalSave).toBe(true);
        expect(mocks.open).toHaveBeenCalledTimes(2);
        expect(mocks.rangeRead.mock.calls.length).toBeGreaterThan(500);
        expect(mocks.rangeRead.mock.calls.every(call =>
            call[2] <= 4 * 1024 * 1024,
        )).toBe(true);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/page-ops',
            [
                'pdf-conformance',
                '--input',
                '/tmp/sparse-2gib.pdf',
                '--output',
                '/tmp/pdf-page-ops-facts/facts.json',
                '--qpdf',
                '/mock/qpdf',
            ],
            expect.objectContaining({
                maxStdoutBytes: 64 * 1024,
                rejectOnStdoutTruncation: true,
            }),
        );
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
                '--output',
                '/tmp/pdf-page-ops-facts/facts.json',
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
        expect(mocks.open).toHaveBeenCalledWith('/tmp/pdf-page-ops-facts/facts.json', 'r');
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
            errors: ['PDF opening validation returned an invalid page count'],
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
            errors: ['PDF opening validation returned an invalid page count'],
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
