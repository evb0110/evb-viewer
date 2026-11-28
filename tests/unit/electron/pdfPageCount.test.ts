import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {PdfPageOpsNativeError} from '@node-runtime/pdfPageOpsWasmRunner';
import {PDF_PAGE_SIZE_SIDECAR_FORMAT, PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION} from '@evb/scan-cleanup/core/pdfPageSizes';
import {createAbortError} from '@electron/utils/abort';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';

const mocks = vi.hoisted(() => ({
    resolvePdfPageOpsWasmPath: vi.fn<() => string | null>(() => '/fake/evb-pdf-page-ops.wasm'),
    runDesktopPageOpsWasm: vi.fn(),
    runDesktopQpdfWasm: vi.fn(),
}));

vi.mock('@node-runtime/pdfPageOpsWasmRunner', async (importOriginal) => {
    const original = await importOriginal<typeof import('@node-runtime/pdfPageOpsWasmRunner')>();
    return {
        ...original,
        resolvePdfPageOpsWasmPath: mocks.resolvePdfPageOpsWasmPath,
    };
});
vi.mock('@electron/native-tools/pdfPageOpsWorkerClient', () => ({
    runDesktopPageOpsWasm: mocks.runDesktopPageOpsWasm,
}));
vi.mock('@electron/native-tools/qpdfWasmWorkerClient', () => ({
    runDesktopQpdfWasm: mocks.runDesktopQpdfWasm,
}));

describe('getPdfPageCount', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.resolvePdfPageOpsWasmPath.mockReturnValue('/fake/evb-pdf-page-ops.wasm');
        tempDir = await mkdtemp(join(tmpdir(), 'pdf-page-count-unit-'));
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {recursive: true, force: true});
            tempDir = '';
        }
    });

    it('uses the warm evb-pdf-page-ops worker without instantiating qpdf and forwards broker/cancel options', async () => {
        const brokerRun = {
            leaseId: 'lease-1',
            onTerminationProof: vi.fn(),
        };
        const onTerminationProof = vi.fn();
        mocks.runDesktopPageOpsWasm.mockImplementationOnce(async (_wasmPath: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(
                outputPath,
                `${JSON.stringify({
                    format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
                    schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
                    pageCount: 14,
                    declaredPageCount: 14,
                    reachablePageCount: 14,
                    chunkBytes: 4 * 1024 * 1024,
                    dominantImageAnalysis: 'unavailable',
                })}\n{"chunkIndex":0}\n`,
            );
            return {stdout: '', stderr: '', exitCode: 0};
        });

        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        const count = await getPdfPageCount(join(tempDir, 'sample.pdf'), {
            cancelGroup: 'group-1',
            brokerRun: brokerRun as never,
            onTerminationProof,
        });

        expect(count).toBe(14);
        expect(mocks.runDesktopPageOpsWasm).toHaveBeenCalledOnce();
        expect(mocks.runDesktopPageOpsWasm.mock.calls[0]?.[1]).toEqual([
            'page-sizes',
            '--input',
            join(tempDir, 'sample.pdf'),
            '--output',
            expect.stringMatching(/page-sizes\.jsonl$/u),
            '--metadata-only',
        ]);
        expect(mocks.runDesktopPageOpsWasm.mock.calls[0]?.[2]).toMatchObject({
            commandLabel: 'evb-pdf-page-ops(page-count)',
            cancelGroup: 'group-1',
            brokerRun,
            onTerminationProof,
        });
        expect(mocks.runDesktopQpdfWasm).not.toHaveBeenCalled();
    });

    it.each([
        ['encrypted PDF', new PdfPageOpsNativeError('encrypted', 'PDF is encrypted')],
        ['corrupt xref PDF', new PdfPageOpsNativeError('corrupt-xref', 'Damaged cross-reference table')],
    ])('falls back to qpdf on %s and preserves exact page count', async (_label, pageOpsError) => {
        mocks.runDesktopPageOpsWasm.mockRejectedValueOnce(pageOpsError);
        mocks.runDesktopQpdfWasm.mockResolvedValueOnce({
            stdout: '7\n',
            stderr: 'WARNING: repaired xref',
            exitCode: 3,
        });

        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        await expect(getPdfPageCount(join(tempDir, 'fallback.pdf'))).resolves.toBe(7);

        expect(mocks.runDesktopPageOpsWasm).toHaveBeenCalledOnce();
        expect(mocks.runDesktopQpdfWasm).toHaveBeenCalledOnce();
    });

    it('falls back to qpdf when evb-pdf-page-ops is unavailable, header counts mismatch, or sidecar format/schema is unsupported', async () => {
        mocks.resolvePdfPageOpsWasmPath.mockReturnValueOnce(null);
        mocks.runDesktopQpdfWasm.mockResolvedValueOnce({stdout: '3\n', stderr: '', exitCode: 0});

        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        await expect(getPdfPageCount(join(tempDir, 'no-wasm.pdf'))).resolves.toBe(3);
        expect(mocks.runDesktopPageOpsWasm).not.toHaveBeenCalled();

        mocks.runDesktopPageOpsWasm.mockImplementationOnce(async (_wasmPath: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(
                outputPath,
                `${JSON.stringify({
                    format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
                    schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
                    pageCount: 5,
                    declaredPageCount: 5,
                    reachablePageCount: 4,
                    chunkBytes: 4 * 1024 * 1024,
                    dominantImageAnalysis: 'unavailable',
                })}\n`,
            );
            return {stdout: '', stderr: '', exitCode: 0};
        });
        mocks.runDesktopQpdfWasm.mockResolvedValueOnce({stdout: '4\n', stderr: '', exitCode: 3});
        await expect(getPdfPageCount(join(tempDir, 'mismatch.pdf'))).resolves.toBe(4);

        // Unsupported schemaVersion must be rejected by the shared sidecar header decoder.
        mocks.runDesktopPageOpsWasm.mockImplementationOnce(async (_wasmPath: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1]!;
            await writeFile(
                outputPath,
                `${JSON.stringify({
                    format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
                    schemaVersion: 99,
                    pageCount: 9,
                    declaredPageCount: 9,
                    reachablePageCount: 9,
                    chunkBytes: 4 * 1024 * 1024,
                    dominantImageAnalysis: 'unavailable',
                })}\n`,
            );
            return {stdout: '', stderr: '', exitCode: 0};
        });
        mocks.runDesktopQpdfWasm.mockResolvedValueOnce({stdout: '9\n', stderr: '', exitCode: 0});
        await expect(getPdfPageCount(join(tempDir, 'unsupported-schema.pdf'))).resolves.toBe(9);
        expect(mocks.runDesktopQpdfWasm).toHaveBeenCalledTimes(3);
    });

    it('preserves qpdf error semantics when both engines reject a malformed PDF or return an invalid count', async () => {
        mocks.runDesktopPageOpsWasm.mockRejectedValueOnce(new PdfPageOpsNativeError('corrupt-xref', 'corrupt'));
        mocks.runDesktopQpdfWasm.mockRejectedValueOnce(new Error('qpdf(page-count) failed with exit code 2'));

        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        await expect(getPdfPageCount(join(tempDir, 'broken.pdf'))).rejects.toThrow('qpdf(page-count) failed with exit code 2');

        mocks.runDesktopPageOpsWasm.mockRejectedValueOnce(new PdfPageOpsNativeError('corrupt-xref', 'corrupt'));
        mocks.runDesktopQpdfWasm.mockResolvedValueOnce({stdout: 'not-a-number', stderr: '', exitCode: 0});
        await expect(getPdfPageCount(join(tempDir, 'invalid-count.pdf'))).rejects.toThrow('Failed to read PDF page count');
    });

    it('never falls back to qpdf on abort, timeout, or unproven termination', async () => {
        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');

        // Pre-aborted signal short-circuits immediately.
        const preAborted = new AbortController();
        preAborted.abort(createAbortError('canceled before start'));
        await expect(getPdfPageCount(join(tempDir, 'a.pdf'), {signal: preAborted.signal})).rejects.toThrow('canceled before start');
        expect(mocks.runDesktopPageOpsWasm).not.toHaveBeenCalled();
        expect(mocks.runDesktopQpdfWasm).not.toHaveBeenCalled();

        // Abort during page-ops rethrows without falling back to qpdf.
        mocks.runDesktopPageOpsWasm.mockRejectedValueOnce(createAbortError('canceled mid-run'));
        await expect(getPdfPageCount(join(tempDir, 'b.pdf'))).rejects.toThrow('canceled mid-run');
        expect(mocks.runDesktopQpdfWasm).not.toHaveBeenCalled();

        // Timeout during page-ops rethrows without falling back to qpdf.
        mocks.runDesktopPageOpsWasm.mockRejectedValueOnce(new Error('evb-pdf-page-ops(page-count) timed out after 120000ms'));
        await expect(getPdfPageCount(join(tempDir, 'c.pdf'))).rejects.toThrow('timed out after 120000ms');
        expect(mocks.runDesktopQpdfWasm).not.toHaveBeenCalled();

        // Unproven termination rethrows without falling back to qpdf.
        const unproven = markUnprovenNativeTermination(new Error('unproven'), 'worker did not exit');
        mocks.runDesktopPageOpsWasm.mockRejectedValueOnce(unproven);
        await expect(getPdfPageCount(join(tempDir, 'd.pdf'))).rejects.toBe(unproven);
        expect(mocks.runDesktopQpdfWasm).not.toHaveBeenCalled();
    });
});
