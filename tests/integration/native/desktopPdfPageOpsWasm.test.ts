import {execFile} from 'node:child_process';
import {
    access,
    mkdtemp,
    open,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
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
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {shutdownPdfPageOpsWorkers} from '@electron/native-tools/pdfPageOpsWorkerClient';
import {cancelNativeCommandGroupAndWait} from '@electron/native-tools/runNativeCommand';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;

async function runQpdf(args: string[]) {
    return execFileAsync(getPdfNativeToolPaths().qpdf, args, {
        encoding: 'utf8',
        maxBuffer: 512 * 1024,
        timeout: TIMEOUT_MS,
    });
}

async function createMultiPagePdf(filePath: string, pageCount: number, sizes?: Array<[number, number]>) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i += 1) {
        const [
            width,
            height,
        ] = sizes?.[i] ?? [
            612,
            792,
        ];
        const page = document.addPage([
            width,
            height,
        ]);
        page.drawText(`Page ${i + 1}`, {
            color: rgb(0.1, 0.1, 0.1),
            font,
            size: 18,
            x: 72,
            y: height - 72,
        });
    }
    await writeFile(filePath, await document.save());
}

/**
 * Builds a valid >2.1 GiB sparse PDF whose large unreferenced stream body is a
 * zero-filled sparse hole so the test uses negligible disk blocks while still
 * forcing 64-bit offsets above 2^31.
 */
async function createSparseMultiGibPdf(filePath: string, payloadBytes: number) {
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
        await writeAtCursor(enc('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n'));

        offsets[4] = pos;
        await writeAtCursor(enc(`4 0 obj\n<< /Length ${payloadBytes} >>\nstream\n`));
        // Advance past the payload via sparse write of the final byte.
        pos += payloadBytes - 1;
        await writeAtCursor(Buffer.from([0x20]));
        await writeAtCursor(enc('\nendstream\nendobj\n'));

        const xrefStart = pos;
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

describe('desktop evb-pdf-page-ops.wasm host-file streaming integration', () => {
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
        shutdownPdfPageOpsWorkers();
    });

    it('runs page-structure edits, queries, decrypt, print-layout, and text-box-appearance via WASM', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-desktop-page-ops-wasm-'));
        const wasmPath = resolveNativePageOpsPath();
        expect(wasmPath).not.toBeNull();
        expect(wasmPath!.endsWith('evb-pdf-page-ops.wasm')).toBe(true);

        const pdfA = join(tempRoot, 'a.pdf');
        const pdfB = join(tempRoot, 'b.pdf');
        await createMultiPagePdf(pdfA, 3, [
            [
                612,
                792,
            ],
            [
                500,
                700,
            ],
            [
                400,
                600,
            ],
        ]);
        await createMultiPagePdf(pdfB, 2);

        // delete-pages with output aliasing input
        const pagesFile = join(tempRoot, 'delete.txt');
        await writeFile(pagesFile, '2\n', 'utf8');
        await runNativeToolCommand(wasmPath!, [
            'delete-pages',
            '--input',
            pdfA,
            '--output',
            pdfA,
            '--pages-file',
            pagesFile,
        ]);
        expect((await PDFDocument.load(await readFile(pdfA))).getPageCount()).toBe(2);
        await runQpdf([
            '--check',
            pdfA,
        ]);

        // merge-pages
        const merged = join(tempRoot, 'merged.pdf');
        await runNativeToolCommand(wasmPath!, [
            'merge-pages',
            '--input',
            pdfA,
            '--source',
            pdfB,
            '--output',
            merged,
        ]);
        expect((await PDFDocument.load(await readFile(merged))).getPageCount()).toBe(4);

        // page-geometry
        const geomRes = await runNativeToolCommand(wasmPath!, [
            'page-geometry',
            '--input',
            merged,
            '--page',
            '2',
        ]);
        const geom = JSON.parse(geomRes.stdout) as {
            mediaBox: {
                width: number;
                height: number;
            };
        };
        expect(geom.mediaBox.width).toBe(400);
        expect(geom.mediaBox.height).toBe(600);

        // page-sizes --metadata-only
        const sizesPath = join(tempRoot, 'sizes.jsonl');
        await runNativeToolCommand(wasmPath!, [
            'page-sizes',
            '--input',
            merged,
            '--output',
            sizesPath,
            '--metadata-only',
        ]);
        const sizeLines = (await readFile(sizesPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(sizeLines[0]).toMatchObject({
            format: 'evb-pdf-page-sizes',
            pageCount: 4,
            dominantImageAnalysis: 'unavailable',
        });

        // read-document-catalog & pdf-conformance & append-admission
        const catalogRes = await runNativeToolCommand(wasmPath!, [
            'read-document-catalog',
            '--input',
            merged,
        ]);
        expect(JSON.parse(catalogRes.stdout)).toMatchObject({
            bookmarks: [],
            pageLabels: [],
        });

        const confRes = await runNativeToolCommand(wasmPath!, [
            'pdf-conformance',
            '--input',
            merged,
        ]);
        expect(JSON.parse(confRes.stdout)).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            hasAcroForm: false,
            hasXfa: false,
        });

        const admRes = await runNativeToolCommand(wasmPath!, [
            'append-admission',
            '--input',
            merged,
        ]);
        expect(JSON.parse(admRes.stdout)).toEqual({
            verdict: 'appendable',
            reason: null,
        });

        // parse-annotations & annotation-index & embedded-shape-index
        const parseOut = join(tempRoot, 'annots.jsonl');
        await runNativeToolCommand(wasmPath!, [
            'parse-annotations',
            '--input',
            merged,
            '--output',
            parseOut,
            '--modified-at',
            'D:20260101000000Z',
        ]);
        expect(JSON.parse((await readFile(parseOut, 'utf8')).split('\n')[0]!)).toMatchObject({pageCount: 4});

        const indexOut = join(tempRoot, 'index.jsonl');
        await runNativeToolCommand(wasmPath!, [
            'annotation-index',
            '--input',
            merged,
            '--output',
            indexOut,
        ]);
        expect(JSON.parse((await readFile(indexOut, 'utf8')).split('\n')[0]!)).toMatchObject({pageCount: 4});

        const shapesOut = join(tempRoot, 'shapes.jsonl');
        await runNativeToolCommand(wasmPath!, [
            'embedded-shape-index',
            '--input',
            merged,
            '--output',
            shapesOut,
        ]);
        expect(JSON.parse((await readFile(shapesOut, 'utf8')).split('\n')[0]!)).toMatchObject({pageCount: 4});

        // decrypt plain -> outcome 'opened', no output PDF created
        const plainDecrypted = join(tempRoot, 'plain-decrypted.pdf');
        await runNativeToolCommand(wasmPath!, [
            'decrypt',
            '--input',
            merged,
            '--output',
            plainDecrypted,
        ]);
        await expect(access(plainDecrypted)).rejects.toMatchObject({code: 'ENOENT'});
        expect(JSON.parse(await readFile(`${plainDecrypted}.decrypt.json`, 'utf8'))).toMatchObject({
            outcome: 'opened',
            wasEncrypted: false,
        });

        // decrypt encrypted -> outcome 'rewritten' with valid decrypted PDF
        const encryptedPath = join(tempRoot, 'encrypted.pdf');
        await runQpdf([
            '--encrypt',
            'secret123',
            'owner456',
            '256',
            '--',
            merged,
            encryptedPath,
        ]);
        const passwordFile = join(tempRoot, 'pw.txt');
        await writeFile(passwordFile, 'secret123\n', 'utf8');
        const decryptedOut = join(tempRoot, 'decrypted.pdf');
        await runNativeToolCommand(wasmPath!, [
            'decrypt',
            '--input',
            encryptedPath,
            '--output',
            decryptedOut,
            '--password-file',
            passwordFile,
        ]);
        expect(JSON.parse(await readFile(`${decryptedOut}.decrypt.json`, 'utf8'))).toMatchObject({
            outcome: 'rewritten',
            wasEncrypted: true,
        });
        expect((await PDFDocument.load(await readFile(decryptedOut))).getPageCount()).toBe(4);

        // print-layout: single+auto on clean PDF writes no output; facing writes 2 spread sheets
        const autoOut = join(tempRoot, 'print-auto.pdf');
        await runNativeToolCommand(wasmPath!, [
            'print-layout',
            '--input',
            merged,
            '--output',
            autoOut,
            '--view-mode',
            'single',
            '--orientation',
            'auto',
        ]);
        await expect(access(autoOut)).rejects.toMatchObject({code: 'ENOENT'});

        const facingOut = join(tempRoot, 'print-facing.pdf');
        await runNativeToolCommand(wasmPath!, [
            'print-layout',
            '--input',
            merged,
            '--output',
            facingOut,
            '--view-mode',
            'facing',
            '--orientation',
            'landscape',
        ]);
        expect((await PDFDocument.load(await readFile(facingOut))).getPageCount()).toBe(2);

        // text-box-appearance
        const tbaReq = join(tempRoot, 'tba-req.json');
        const tbaPdf = join(tempRoot, 'tba.pdf');
        const tbaMeta = join(tempRoot, 'tba-meta.json');
        await writeFile(tbaReq, JSON.stringify({
            page: {
                view: [
                    0,
                    0,
                    612,
                    792,
                ],
                rotation: 0,
                userUnit: 1,
            },
            textBoxes: [{
                textBox: {
                    pageIndex: 0,
                    stableKey: 'wasm-tba-1',
                    text: 'Hello WASM',
                    rect: [
                        60,
                        680,
                        260,
                        740,
                    ],
                    fontSize: 14,
                    color: [
                        17,
                        34,
                        51,
                    ],
                    rotation: 0,
                },
            }],
        }), 'utf8');
        await runNativeToolCommand(wasmPath!, [
            'text-box-appearance',
            '--input',
            tbaReq,
            '--output',
            tbaPdf,
            '--metadata-file',
            tbaMeta,
        ]);
        expect((await stat(tbaPdf)).size).toBeGreaterThan(0);
        const meta = JSON.parse(await readFile(tbaMeta, 'utf8')) as {
            textBoxes: unknown[];
        };
        expect(meta.textBoxes).toHaveLength(1);
    }, TIMEOUT_MS);

    it('streams a >2.1 GiB sparse PDF through WASM with bounded RSS and in-place incremental save', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-desktop-page-ops-sparse-'));
        const wasmPath = resolveNativePageOpsPath()!;
        const sparsePdf = join(tempRoot, 'sparse-2.1gib.pdf');
        const payloadBytes = 2_200_000_000;
        const initialSize = await createSparseMultiGibPdf(sparsePdf, payloadBytes);
        expect(initialSize).toBeGreaterThan(2_147_483_648);

        const rssBefore = process.memoryUsage().rss;

        const admRes = await runNativeToolCommand(wasmPath, [
            'append-admission',
            '--input',
            sparsePdf,
        ]);
        expect(JSON.parse(admRes.stdout)).toMatchObject({
            verdict: 'unverified',
            reason: expect.any(String),
        });

        const geomRes = await runNativeToolCommand(wasmPath, [
            'page-geometry',
            '--input',
            sparsePdf,
            '--page',
            '1',
        ]);
        expect(JSON.parse(geomRes.stdout)).toMatchObject({
            mediaBox: {
                width: 612,
                height: 792,
            },
        });

        const mutationsPath = join(tempRoot, 'note.json');
        const bindingsPath = join(tempRoot, 'bindings.json');
        await writeFile(mutationsPath, JSON.stringify({notes: [{
            author: 'sparse-test',
            color: '#ffff00',
            createdAt: 1,
            markerRect: {
                left: 0.1,
                top: 0.1,
                width: 0.1,
                height: 0.1,
            },
            open: false,
            pageIndex: 0,
            stableKey: 'sparse-2gib-note',
            text: 'Appended past 2.1 GiB via WASM',
        }]}), 'utf8');

        await runNativeToolCommand(wasmPath, [
            'save-mutations',
            '--input',
            sparsePdf,
            '--output',
            sparsePdf,
            '--mutations-file',
            mutationsPath,
            '--identity-bindings-file',
            bindingsPath,
            '--modified-at',
            'D:20260829120000Z',
            '--append',
            '--append-in-place',
        ]);

        const finalSize = (await stat(sparsePdf)).size;
        expect(finalSize).toBeGreaterThan(initialSize);
        const report = JSON.parse(await readFile(bindingsPath, 'utf8')) as {identityBindings: Array<{annotationId: string}>};
        expect(report.identityBindings.length).toBeGreaterThanOrEqual(1);

        // Re-verify append-admission and parse-annotations on the >2.1 GiB mutated file.
        const parseOut = join(tempRoot, 'sparse-annots.jsonl');
        await runNativeToolCommand(wasmPath, [
            'parse-annotations',
            '--input',
            sparsePdf,
            '--output',
            parseOut,
            '--modified-at',
            'D:20260829120000Z',
        ]);
        const parsedContent = await readFile(parseOut, 'utf8');
        expect(parsedContent).toContain('Appended past 2.1 GiB via WASM');

        const rssDeltaBytes = process.memoryUsage().rss - rssBefore;
        // Must stay orders of magnitude below the 2.1 GiB file size.
        expect(rssDeltaBytes).toBeLessThan(256 * 1024 * 1024);

        // Separate-output (non-in-place) append on >2.1 GiB sparse PDF must preserve holes.
        const separateOut = join(tempRoot, 'sparse-2.1gib-separate-out.pdf');
        await runNativeToolCommand(wasmPath, [
            'save-mutations',
            '--input',
            sparsePdf,
            '--output',
            separateOut,
            '--mutations-file',
            mutationsPath,
            '--modified-at',
            'D:20260829120001Z',
            '--append',
        ]);
        const separateStat = await stat(separateOut);
        expect(separateStat.size).toBeGreaterThan(finalSize);
        if (process.platform !== 'win32' && typeof separateStat.blocks === 'number') {
            // Physical allocated bytes (512B blocks) must remain orders of magnitude below 2.1 GiB.
            expect(separateStat.blocks * 512).toBeLessThan(64 * 1024 * 1024);
        }
    }, TIMEOUT_MS);

    it('enforces read-only alias refusal, u32 bounds, crop parity, and immediate group cancellation', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-desktop-page-ops-guards-'));
        const wasmPath = resolveNativePageOpsPath()!;
        const inputPdf = join(tempRoot, 'input.pdf');
        await createMultiPagePdf(inputPdf, 2);
        const originalBytes = await readFile(inputPdf);

        // Read-only sidecar commands must refuse overwriting their input PDF.
        for (const args of [
            ['parse-annotations', '--input', inputPdf, '--output', inputPdf, '--modified-at', 'D:20260829120000Z'],
            ['annotation-index', '--input', inputPdf, '--output', inputPdf],
            ['shape-index', '--input', inputPdf, '--output', inputPdf],
            ['page-sizes', '--input', inputPdf, '--output', inputPdf],
        ]) {
            await expect(runNativeToolCommand(wasmPath, args)).rejects.toThrow(/must not overwrite/u);
        }
        expect(await readFile(inputPdf)).toEqual(Buffer.from(originalBytes));

        // --append-in-place must reject distinct --input and --output paths.
        const mutPath = join(tempRoot, 'empty-muts.json');
        await writeFile(mutPath, JSON.stringify({}), 'utf8');
        await expect(runNativeToolCommand(wasmPath, [
            'save-mutations',
            '--input',
            inputPdf,
            '--output',
            join(tempRoot, 'other.pdf'),
            '--mutations-file',
            mutPath,
            '--modified-at',
            'D:20260829120000Z',
            '--append',
            '--append-in-place',
        ])).rejects.toThrow(/identical input and output paths/u);

        // --page must reject values above u32::MAX.
        await expect(runNativeToolCommand(wasmPath, [
            'page-geometry',
            '--input',
            inputPdf,
            '--page',
            '4294967297',
        ])).rejects.toThrow(/32-bit integer/u);

        // crop & remove-crop CLI parity.
        const cropPages = join(tempRoot, 'crop-pages.txt');
        const croppedPdf = join(tempRoot, 'cropped.pdf');
        const uncroppedPdf = join(tempRoot, 'uncropped.pdf');
        await writeFile(cropPages, '1\n', 'utf8');
        await runNativeToolCommand(wasmPath, [
            'crop',
            '--input',
            inputPdf,
            '--output',
            croppedPdf,
            '--pages-file',
            cropPages,
            '--top',
            '36',
            '--bottom',
            '36',
            '--left',
            '36',
            '--right',
            '36',
        ]);
        const croppedGeom = JSON.parse((await runNativeToolCommand(wasmPath, [
            'page-geometry',
            '--input',
            croppedPdf,
            '--page',
            '1',
        ])).stdout) as {cropBox: {width: number; height: number}};
        expect(croppedGeom.cropBox.width).toBeCloseTo(612 - 72, 1);
        expect(croppedGeom.cropBox.height).toBeCloseTo(792 - 72, 1);

        await runNativeToolCommand(wasmPath, [
            'remove-crop',
            '--input',
            croppedPdf,
            '--output',
            uncroppedPdf,
            '--pages-file',
            cropPages,
        ]);
        const uncroppedGeom = JSON.parse((await runNativeToolCommand(wasmPath, [
            'page-geometry',
            '--input',
            uncroppedPdf,
            '--page',
            '1',
        ])).stdout) as {
            cropBox: {width: number; height: number} | null;
            mediaBox: {width: number; height: number};
        };
        expect(uncroppedGeom.cropBox).toBeNull();
        expect(uncroppedGeom.mediaBox.width).toBeCloseTo(612, 1);
        expect(uncroppedGeom.mediaBox.height).toBeCloseTo(792, 1);

        // Cold-start group cancellation must cancel immediately and settle via cancelNativeCommandGroupAndWait.
        shutdownPdfPageOpsWorkers();
        const cancelGroup = `wasm-cancel-test-${Date.now()}`;
        const pending = runNativeToolCommand(wasmPath, [
            'page-geometry',
            '--input',
            inputPdf,
            '--page',
            '1',
        ], {cancelGroup});
        const canceled = await cancelNativeCommandGroupAndWait(cancelGroup);
        expect(canceled).toBe(true);
        await expect(pending).rejects.toThrow(/canceled|aborted/iu);
    }, TIMEOUT_MS);
});
