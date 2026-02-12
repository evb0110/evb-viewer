import {
    readFile,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { runCommand } from '@electron/ocr/worker/run-command';

export async function getPageCount(
    qpdfBinary: string,
    pdfPath: string,
    fallback: number,
): Promise<number> {
    try {
        const result = await runCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ]);
        const parsed = parseInt((result.stdout ?? '').trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    } catch {
        // Use fallback
    }
    return fallback;
}

export async function assembleSearchablePdf(
    originalPdfPath: string,
    ocrPdfMap: Map<number, string>,
    pageCount: number,
    tempDir: string,
    sessionId: string,
    qpdfBinary: string,
    log: TWorkerLog,
    trackTempFile: (path: string) => string,
): Promise<string> {
    log('debug', `Overlaying ${ocrPdfMap.size} text layers onto original PDF`);

    const { PDFDocument } = await import('pdf-lib');
    const overlayDoc = await PDFDocument.create();

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const ocrPath = ocrPdfMap.get(pageNum);
        if (ocrPath) {
            const ocrPdfBytes = await readFile(ocrPath);
            const ocrPdf = await PDFDocument.load(ocrPdfBytes);
            const [copiedPage] = await overlayDoc.copyPages(ocrPdf, [0]);
            overlayDoc.addPage(copiedPage);
        } else {
            overlayDoc.addPage([
                1,
                1,
            ]);
        }
    }

    const overlayPdfPath = trackTempFile(join(tempDir, `${sessionId}-overlay.pdf`));
    const overlayBytes = await overlayDoc.save();
    await writeFile(overlayPdfPath, overlayBytes);

    const mergedPdfPath = trackTempFile(join(tempDir, `${sessionId}-merged.pdf`));

    await runCommand(qpdfBinary, [
        originalPdfPath,
        '--overlay',
        overlayPdfPath,
        '--',
        '--',
        mergedPdfPath,
    ], { allowedExitCodes: [
        0,
        3,
    ] });

    return mergedPdfPath;
}
