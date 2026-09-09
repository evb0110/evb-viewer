import {
    copyFile,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { assembleSearchablePdfStreaming } from '@electron/features/ocr/worker/assembleSearchablePdfStreaming';
import { runOcrCommand } from '@electron/features/ocr/worker/runOcrCommand';
import { resolveTestQpdfBinary } from '@tests/helpers/resolveTestQpdfBinary';

vi.mock('@electron/features/ocr/worker/runOcrCommand', {spy: true});

let tempDir: string | null = null;

async function createPdf(path: string, pageCount: number) {
    const pdf = await PDFDocument.create();
    for (let page = 1; page <= pageCount; page += 1) {
        const pdfPage = pdf.addPage([
            200 + page,
            300 + page,
        ]);
        pdfPage.drawText(`page-${page}`);
    }
    await writeFile(path, await pdf.save());
}

afterEach(async () => {
    vi.mocked(runOcrCommand).mockClear();
    if (tempDir) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        tempDir = null;
    }
});

describe('streaming OCR PDF assembly', () => {
    it('replaces selected pages through qpdf without buffering the full source', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-streaming-test-'));
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        await createPdf(originalPath, 3);
        await createPdf(replacementPath, 1);

        const outputPath = await assembleSearchablePdfStreaming({
            qpdfBinary: resolveTestQpdfBinary(),
            originalPdfPath: originalPath,
            ocrPageEntries: [[
                2,
                replacementPath,
            ]],
            pageCount: 3,
            tempDir,
            sessionId: 'test',
            trackTempFile: path => path,
            mutatePage: (_originalPage, ocrPage, output) => copyFile(ocrPage, output).then(() => undefined),
        });

        const output = await PDFDocument.load(await readFile(outputPath));
        expect(output.getPageCount()).toBe(3);
        expect(output.getPages().map(page => page.getSize())).toEqual([
            {
                width: 201,
                height: 301,
            },
            {
                width: 201,
                height: 301,
            },
            {
                width: 203,
                height: 303,
            },
        ]);
    });

    it('extracts every replaced source page with a page-count-independent number of qpdf runs', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-ocr-streaming-test-'));
        tempDir = root;
        const originalPath = join(root, 'original.pdf');
        await createPdf(originalPath, 8);
        const replacedPages = [
            1,
            2,
            3,
            5,
            8,
        ];
        const ocrPageEntries = await Promise.all(replacedPages.map(async (pageNumber) => {
            const path = join(root, `ocr-${pageNumber}.pdf`);
            const pdf = await PDFDocument.create();
            pdf.addPage([
                500 + pageNumber,
                700 + pageNumber,
            ]);
            await writeFile(path, await pdf.save());
            return [
                pageNumber,
                path,
            ] as const;
        }));

        const extractedSourceWidths: number[] = [];
        const outputPath = await assembleSearchablePdfStreaming({
            qpdfBinary: resolveTestQpdfBinary(),
            originalPdfPath: originalPath,
            ocrPageEntries,
            pageCount: 8,
            tempDir: root,
            sessionId: 'batched',
            trackTempFile: path => path,
            mutatePage: async (originalPagePath, ocrPagePath, output) => {
                const source = await PDFDocument.load(await readFile(originalPagePath));
                extractedSourceWidths.push(Math.round(source.getPage(0).getWidth()));
                await copyFile(ocrPagePath, output);
            },
        });

        expect(vi.mocked(runOcrCommand).mock.calls).toHaveLength(2);
        expect(extractedSourceWidths.sort((left, right) => left - right)).toEqual(
            replacedPages.map(pageNumber => 200 + pageNumber),
        );

        const output = await PDFDocument.load(await readFile(outputPath));
        expect(output.getPages().map(page => Math.round(page.getWidth()))).toEqual([
            501,
            502,
            503,
            204,
            505,
            206,
            207,
            508,
        ]);
        expect((await readdir(root)).some(name => name.endsWith('-source-pages'))).toBe(false);
    });

    it('mutates replacement pages concurrently within the OCR concurrency bound', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-streaming-test-'));
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        await createPdf(originalPath, 6);
        await createPdf(replacementPath, 1);

        let inFlight = 0;
        let peakInFlight = 0;
        await assembleSearchablePdfStreaming({
            qpdfBinary: resolveTestQpdfBinary(),
            originalPdfPath: originalPath,
            ocrPageEntries: [
                1,
                2,
                3,
                4,
                5,
                6,
            ].map(pageNumber => [
                pageNumber,
                replacementPath,
            ] as const),
            pageCount: 6,
            tempDir,
            sessionId: 'concurrent',
            trackTempFile: path => path,
            mutatePage: async (_originalPage, ocrPage, output) => {
                inFlight += 1;
                peakInFlight = Math.max(peakInFlight, inFlight);
                await new Promise(resolve => setTimeout(resolve, 20));
                await copyFile(ocrPage, output);
                inFlight -= 1;
            },
        });

        expect(peakInFlight).toBeGreaterThan(1);
        expect(peakInFlight).toBeLessThanOrEqual(6);
    });
});
