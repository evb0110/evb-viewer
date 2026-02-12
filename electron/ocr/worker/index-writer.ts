import {
    mkdir,
    rename,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type {
    IOcrIndexV2Manifest,
    IOcrIndexV2Page,
    IOcrPageWithWords,
    TWorkerLog,
} from '@electron/ocr/worker/types';

export async function writeOcrIndexV2(
    workingCopyPath: string,
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
    languages: string[],
    extractionDpi: number,
    log: TWorkerLog,
): Promise<void> {
    const ocrDir = `${workingCopyPath}.ocr`;
    await mkdir(ocrDir, { recursive: true });

    const manifest: IOcrIndexV2Manifest = {
        version: 2,
        createdAt: Date.now(),
        source: { pdfPath: workingCopyPath },
        pageCount,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages,
            renderDpi: extractionDpi,
        },
        pages: {},
    };

    for (const pd of ocrPageData) {
        const pageFile = `page-${String(pd.pageNumber).padStart(4, '0')}.json`;

        const pageData: IOcrIndexV2Page = {
            pageNumber: pd.pageNumber,
            rotation: 0,
            render: {
                dpi: extractionDpi,
                imagePx: {
                    w: pd.imageWidth,
                    h: pd.imageHeight,
                },
            },
            text: pd.text,
            words: pd.words,
        };

        const pagePath = join(ocrDir, pageFile);
        const tempPath = `${pagePath}.tmp`;
        await writeFile(tempPath, JSON.stringify(pageData), 'utf-8');
        await rename(tempPath, pagePath);

        manifest.pages[pd.pageNumber] = { path: pageFile };
    }

    const manifestPath = join(ocrDir, 'manifest.json');
    const tempManifestPath = `${manifestPath}.tmp`;
    await writeFile(tempManifestPath, JSON.stringify(manifest), 'utf-8');
    await rename(tempManifestPath, manifestPath);

    log('debug', `Wrote OCR index v2 to ${ocrDir} with ${ocrPageData.length} pages`);
}

export async function writeOcrIndexV1(
    indexPath: string,
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
): Promise<void> {
    const indexPageData = ocrPageData.map(pd => ({
        pageNumber: pd.pageNumber,
        words: pd.words,
        text: pd.text,
        pageWidth: pd.imageWidth,
        pageHeight: pd.imageHeight,
    }));

    const indexContent = JSON.stringify({
        version: 1,
        pageCount,
        pages: indexPageData,
    });

    await writeFile(`${indexPath}.index.json`, indexContent, 'utf-8');
}
