import {
    access,
    mkdtemp,
    open,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    PDFDocument,
    StandardFonts,
    rgb,
} from 'pdf-lib';
import {
    afterAll,
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {rewriteQpdfArgsToVirtualPaths} from '@node-runtime/qpdfWasmRunner';
import {
    extractQpdfWarnings,
    QPDF_SUCCESS_EXIT_CODES,
} from '@pdf-core/qpdfCommands';
import {validateDocumentSaveStagingFile} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';
import {
    validatePdfFile,
    validatePdfFileForOpening,
    validatePdfFileForSave,
} from '@electron/features/documents/main/pdfConformance';
import {analyzePdfConformancePath} from '@electron/features/documents/main/pdfConformancePathAnalysis';
import {optimizePdfForSave} from '@electron/features/documents/main/pdfSaveAsOptimization';
import {
    runQpdfCommand,
    verifyPdfStructureStrict,
} from '@electron/features/page-ops/main/qpdf';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {shutdownPdfPageOpsWorkers} from '@electron/native-tools/pdfPageOpsWorkerClient';
import {
    resolveDesktopQpdfPath,
    runDesktopQpdfWasm,
    shutdownQpdfWasmWorkers,
} from '@electron/native-tools/qpdfWasmWorkerClient';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {rewritePdfWithQpdf} from '@electron/pdf/pdfAppendBase';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';

const TIMEOUT_MS = 120_000;
const SINGLE_STREAM_OVER_2GIB_BYTES = 2_254_857_830; // ~2.1 GiB (> 2^31 - 1)

async function createSamplePdf(filePath: string, pageCount: number) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i += 1) {
        const page = document.addPage([
            612,
            792,
        ]);
        page.drawText(`Sample page ${i + 1}`, {
            color: rgb(0.1, 0.1, 0.1),
            font,
            size: 16,
            x: 72,
            y: 720,
        });
    }
    await writeFile(filePath, await document.save());
}

/**
 * Creates a sparse PDF containing a single stream larger than 2 GiB (> 2^31 - 1).
 * Uses a sparse hole so negligible disk blocks are allocated while exercising
 * real 64-bit file offsets and wasm32's 32-bit `std::string` stream limit.
 */
async function createSparseSingleStreamOver2GibPdf(
    filePath: string,
    payloadBytes: number,
    options: {corruptXref?: boolean} = {},
) {
    const handle = await open(filePath, 'w');
    try {
        const enc = (text: string) => Buffer.from(text, 'latin1');
        let pos = 0;
        const offsets: number[] = [0];

        const writeAtCursor = async (buf: Buffer) => {
            await handle.write(buf, 0, buf.byteLength, pos);
            pos += buf.byteLength;
        };

        await writeAtCursor(enc('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));

        offsets[1] = pos;
        await writeAtCursor(enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));

        offsets[2] = pos;
        await writeAtCursor(enc('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));

        offsets[3] = pos;
        await writeAtCursor(
            enc('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n'),
        );

        offsets[4] = pos;
        await writeAtCursor(enc(`4 0 obj\n<< /Length ${payloadBytes} >>\nstream\n`));
        pos += payloadBytes - 1;
        await writeAtCursor(Buffer.from([0x20]));
        await writeAtCursor(enc('\nendstream\nendobj\n'));

        const xrefStart = options.corruptXref ? 1 : pos;
        let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
        for (let i = 1; i < offsets.length; i += 1) {
            xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
        }
        xref += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
        await writeAtCursor(enc(xref));
        return pos;
    } finally {
        await handle.close();
    }
}

describe('desktop evb-qpdf.wasm integration', () => {
    let tempRoot = '';

    afterEach(async () => {
        if (tempRoot) {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
            tempRoot = '';
        }
    });

    afterAll(() => {
        shutdownQpdfWasmWorkers();
        shutdownPdfPageOpsWorkers();
    });

    it('rewrites host paths strictly to virtual paths and handles Unicode/spaces/subset extraction/exit codes', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-qpdf-wasm-'));
        const unicodeInput = join(tempRoot, '日本語 файл with spaces.pdf');
        const subsetOutput = join(tempRoot, 'out 子セット.pdf');
        await createSamplePdf(unicodeInput, 3);

        // Verify virtual-path translation never leaks host paths (including
        // Windows drive letters, UNC paths, --encrypt, NUL, and cwd) into qpdf argv.
        const rewritten = rewriteQpdfArgsToVirtualPaths([
            unicodeInput,
            '--pages',
            unicodeInput,
            '1,3',
            '--',
            subsetOutput,
        ]);
        expect(rewritten.virtualArgs).toEqual([
            '/in/0.pdf',
            '--pages',
            '/in/0.pdf',
            '1,3',
            '--',
            '/out/0.pdf',
        ]);
        expect(rewritten.inputs).toHaveLength(1);
        expect(rewritten.outputHostPath).toBe(subsetOutput);

        const winEncrypt = rewriteQpdfArgsToVirtualPaths([
            '--encrypt',
            'user-pass',
            'owner-pass',
            '256',
            '--',
            'C:\\Users\\test\\in.pdf',
            '\\\\server\\share\\out.pdf',
        ]);
        expect(winEncrypt.virtualArgs).toEqual([
            '--encrypt',
            'user-pass',
            'owner-pass',
            '256',
            '--',
            '/in/0.pdf',
            '/out/0.pdf',
        ]);
        expect(winEncrypt.inputs[0]?.hostPath).toBe('C:\\Users\\test\\in.pdf');
        expect(winEncrypt.outputHostPath).toBe('\\\\server\\share\\out.pdf');

        const winNull = rewriteQpdfArgsToVirtualPaths([
            '--decode-level=none',
            'C:\\Users\\test\\in.pdf',
            'NUL',
        ], undefined, 'win32');
        expect(winNull.virtualArgs).toEqual([
            '--decode-level=none',
            '/in/0.pdf',
            '/dev/null',
        ]);
        expect(winNull.outputHostPath).toBeNull();

        const posixNul = rewriteQpdfArgsToVirtualPaths([
            '--decode-level=none',
            '/tmp/in.pdf',
            'NUL',
        ], undefined, 'linux');
        expect(posixNul.virtualArgs).toEqual([
            '--decode-level=none',
            '/in/0.pdf',
            '/out/0.pdf',
        ]);
        expect(posixNul.outputHostPath).toBe('NUL');

        const trailingEncrypt = rewriteQpdfArgsToVirtualPaths([
            unicodeInput,
            '--pages',
            unicodeInput,
            '1',
            '--',
            '--encrypt',
            'user-pass',
            'owner-pass',
            '256',
            '--',
            subsetOutput,
        ]);
        expect(trailingEncrypt.virtualArgs).toEqual([
            '/in/0.pdf',
            '--pages',
            '/in/0.pdf',
            '1',
            '--',
            '--encrypt',
            'user-pass',
            'owner-pass',
            '256',
            '--',
            '/out/0.pdf',
        ]);
        expect(trailingEncrypt.outputHostPath).toBe(subsetOutput);

        // Preserve embedded NULs and exact UTF-8 newlines (matching runNativeCommand's
        // UTF-8 stdout contract without Emscripten line-splitting artifacts).
        const binaryStreamPdf = join(tempRoot, 'binary-stream.pdf');
        const payload = Buffer.from([
            0x41,
            0x00,
            0x42,
            0x0A,
            0x00,
            0x43,
        ]);
        {
            const enc = (text: string) => Buffer.from(text, 'latin1');
            const chunks: Buffer[] = [];
            let offset = 0;
            const offsets: number[] = [0];
            const push = (chunk: Buffer) => {
                chunks.push(chunk);
                offset += chunk.byteLength;
            };
            push(enc('%PDF-1.7\n'));
            offsets[1] = offset;
            push(enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
            offsets[2] = offset;
            push(enc('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));
            offsets[3] = offset;
            push(enc('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n'));
            offsets[4] = offset;
            push(enc(`4 0 obj\n<< /Length ${payload.byteLength} >>\nstream\n`));
            push(payload);
            push(enc('\nendstream\nendobj\n'));
            const xrefPos = offset;
            let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
            for (let i = 1; i < offsets.length; i += 1) {
                xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
            }
            xref += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
            push(enc(xref));
            await writeFile(binaryStreamPdf, Buffer.concat(chunks));
        }
        const rawStreamResult = await runDesktopQpdfWasm([
            binaryStreamPdf,
            '--show-object=4',
            '--raw-stream-data',
        ], {
            timeoutMs: TIMEOUT_MS,
            allowedExitCodes: [0],
            commandLabel: 'qpdf(test-raw-stream-nul)',
        });
        expect(Buffer.from(rawStreamResult.stdout, 'utf8')).toEqual(payload);

        // Strict verification rejects duplicate dictionary keys via both qpdf and page-ops --strict.
        const duplicateDatesFixture = resolve('native/pdf-page-ops/tests/fixtures/page-engine/duplicate-info-dates.pdf');
        await expect(verifyPdfStructureStrict(duplicateDatesFixture)).rejects.toThrow();
        const pageOpsPath = resolveNativePageOpsPath();
        expect(pageOpsPath).not.toBeNull();
        await expect(runNativeToolCommand(pageOpsPath!, [
            'pdf-conformance',
            '--input',
            duplicateDatesFixture,
            '--strict',
        ], {timeoutMs: TIMEOUT_MS})).rejects.toThrow(/duplicate dictionary key/u);

        // Run real --pages subset extraction on Unicode + spaces host paths.
        await runQpdfCommand([
            unicodeInput,
            '--pages',
            unicodeInput,
            '1,3',
            '--',
            subsetOutput,
        ], {
            timeoutMs: TIMEOUT_MS,
            allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(test-subset)',
        });
        expect(await getPdfPageCount(subsetOutput)).toBe(2);
        await expect(verifyPdfStructureStrict(subsetOutput)).resolves.toBeUndefined();

        // Corrupt input triggers a clean error without poisoning subsequent commands
        // (fresh Emscripten instance per command).
        const corruptPath = join(tempRoot, 'corrupt.pdf');
        await writeFile(corruptPath, Buffer.from('%PDF-1.4\nnot-a-valid-pdf\n', 'ascii'));
        await expect(runDesktopQpdfWasm([
            '--check',
            corruptPath,
        ], {
            timeoutMs: TIMEOUT_MS,
            allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
        })).rejects.toThrow(/exited with code 2/u);

        // Subsequent command on the same worker pool succeeds cleanly.
        expect(await getPdfPageCount(unicodeInput)).toBe(3);

        // Preserve exit code 3 + warnings when qpdf repairs a damaged xref.
        const rawBytes = await readFile(unicodeInput);
        const damagedPath = join(tempRoot, 'damaged-xref.pdf');
        const repairedPath = join(tempRoot, 'repaired.pdf');
        const damagedBytes = Buffer.from(rawBytes.toString('latin1').replace(/startxref\s+\d+/u, 'startxref\n1'), 'latin1');
        await writeFile(damagedPath, damagedBytes);
        const repairedResult = await runDesktopQpdfWasm([
            damagedPath,
            repairedPath,
        ], {
            timeoutMs: TIMEOUT_MS,
            allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(test-warning-exit)',
        });
        expect(repairedResult.exitCode).toBe(3);
        expect(extractQpdfWarnings(repairedResult.stderr).length).toBeGreaterThan(0);
        expect(await getPdfPageCount(repairedPath)).toBe(3);
    }, TIMEOUT_MS);

    it('passes open, annotate, save (with all verification gates), and reopen on a 2.1 GiB single-stream PDF while failing closed on optimize/repair without truncation', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-qpdf-2gib-stream-'));
        const pdfPath = join(tempRoot, 'single-stream-2.1gib.pdf');
        const originalBytes = await createSparseSingleStreamOver2GibPdf(pdfPath, SINGLE_STREAM_OVER_2GIB_BYTES);
        expect(originalBytes).toBeGreaterThan(2_147_483_647);

        const pageOpsPath = resolveNativePageOpsPath();
        expect(pageOpsPath).not.toBeNull();

        // 1. Open gate: validatePdfFileForOpening succeeds cleanly.
        const openValidation = await validatePdfFileForOpening(pdfPath);
        expect(openValidation.isValid).toBe(true);
        expect(await getPdfPageCount(pdfPath)).toBe(1);

        // 2. Annotate & Save: append a FreeText annotation via evb-pdf-page-ops.wasm.
        const mutationsPath = join(tempRoot, 'mutations.json');
        const expectedAnnotationText = 'Saved annotation on 2.1 GiB single-stream PDF';
        await writeFile(mutationsPath, `${JSON.stringify({freeTextNotes: [{
            author: 'integration-test',
            color: null,
            createdAt: 1,
            markerRect: {
                height: 0.08,
                left: 0.2,
                top: 0.2,
                width: 0.3,
            },
            pageIndex: 0,
            stableKey: 'single-stream-2gib:note-1',
            text: expectedAnnotationText,
        }]})}\n`, 'utf8');

        await runNativeToolCommand(pageOpsPath!, [
            'save-mutations',
            '--input',
            pdfPath,
            '--output',
            pdfPath,
            '--mutations-file',
            mutationsPath,
            '--modified-at',
            'D:20261127120000Z',
            '--append',
            '--append-in-place',
        ], {timeoutMs: TIMEOUT_MS});

        const savedStat = await stat(pdfPath);
        expect(savedStat.size).toBeGreaterThan(originalBytes);

        // 3. ALL Save verification gates MUST pass cleanly (routing cleanly to
        //    evb-pdf-page-ops.wasm structural verification where evb-qpdf.wasm
        //    hits wasm32's 32-bit single-stream limit).
        const saveValidation = await validatePdfFileForSave(pdfPath);
        expect(saveValidation.isValid).toBe(true);

        const fullValidation = await validatePdfFile(pdfPath);
        expect(fullValidation.isValid).toBe(true);

        await expect(verifyPdfStructureStrict(pdfPath)).resolves.toBeUndefined();

        const stagingValidation = await validateDocumentSaveStagingFile({
            type: 'validate',
            sourcePath: pdfPath,
            expectedBytes: savedStat.size,
            validationBinary: resolveDesktopQpdfPath(),
            changedObjectRefs: ['1 0 R'],
        }, {timeoutMs: TIMEOUT_MS});
        expect(stagingValidation.bytes).toBe(savedStat.size);

        // 4. Reopen & verify: parse annotations back via evb-pdf-page-ops.wasm
        //    and confirm the saved annotation persisted intact with zero truncation.
        const parsedSidecarPath = join(tempRoot, 'parsed-annotations.ndjson');
        await runNativeToolCommand(pageOpsPath!, [
            'parse-annotations',
            '--input',
            pdfPath,
            '--output',
            parsedSidecarPath,
            '--modified-at',
            'D:20261127120000Z',
        ], {timeoutMs: TIMEOUT_MS});
        const parsedText = await readFile(parsedSidecarPath, 'utf8');
        expect(parsedText).toContain(expectedAnnotationText);
        expect((await stat(pdfPath)).size).toBe(savedStat.size);

        // 5. Fail-closed Repair: rewritePdfWithQpdf MUST reject with typed 'too-large'
        //    and MUST NOT write any truncated output file.
        const repairOutputPath = join(tempRoot, 'repaired-should-not-exist.pdf');
        let repairError: unknown;
        try {
            await rewritePdfWithQpdf(pdfPath, repairOutputPath);
        } catch (error) {
            repairError = error;
        }
        expect(hasNativeErrorCode(repairError)).toBe(true);
        expect((repairError as {code: string}).code).toBe('too-large');
        await expect(access(repairOutputPath)).rejects.toMatchObject({code: 'ENOENT'});

        // 5b. Even when stderr capture is tightly capped, a basic_string stream-limit
        //     failure still classifies as typed 'too-large' and never publishes output.
        const cappedRepairOutputPath = join(tempRoot, 'repaired-capped-stderr.pdf');
        let cappedError: unknown;
        try {
            await runDesktopQpdfWasm([
                '--warning-exit-0',
                pdfPath,
                cappedRepairOutputPath,
            ], {
                timeoutMs: TIMEOUT_MS,
                allowedExitCodes: QPDF_SUCCESS_EXIT_CODES,
                maxStderrBytes: 16,
                commandLabel: 'qpdf(test-capped-stderr-too-large)',
            });
        } catch (error) {
            cappedError = error;
        }
        expect(hasNativeErrorCode(cappedError)).toBe(true);
        expect((cappedError as {code: string}).code).toBe('too-large');
        await expect(access(cappedRepairOutputPath)).rejects.toMatchObject({code: 'ENOENT'});

        // 6. Fail-closed Optimize: explicit optimizePdfForSave MUST reject with typed
        //    'too-large' and leave the original >2.1 GiB PDF intact with no truncated output.
        let optimizeError: unknown;
        try {
            await optimizePdfForSave(pdfPath, {
                force: true,
                skipSemanticPreflight: true,
                label: 'qpdf(test-optimize-2gib)',
            });
        } catch (error) {
            optimizeError = error;
        }
        expect(hasNativeErrorCode(optimizeError)).toBe(true);
        expect((optimizeError as {code: string}).code).toBe('too-large');
        expect((await stat(pdfPath)).size).toBe(savedStat.size);

        // 7. Fail-closed Conformance Repair: corrupt-xref on a 2.1 GiB single-stream PDF
        //    fails closed with structural-output-too-large and writes no truncated output.
        const corrupt2GibPath = join(tempRoot, 'corrupt-2.1gib.pdf');
        await createSparseSingleStreamOver2GibPdf(corrupt2GibPath, SINGLE_STREAM_OVER_2GIB_BYTES, {
            corruptXref: true,
        });
        await expect(analyzePdfConformancePath(corrupt2GibPath, {
            markerEvidence: 'structural-only',
        })).rejects.toMatchObject({code: 'structural-output-too-large'});

        // Confirm no orphan staging temp files remain in tempRoot.
        const leftovers = (await readdir(tempRoot)).filter(name => name.includes('.evb-wasm-'));
        expect(leftovers).toEqual([]);
    }, 180_000);
});
