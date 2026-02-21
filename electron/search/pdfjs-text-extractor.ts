import { readFile } from 'fs/promises';
// Must use the legacy build — the default build uses DOMMatrix and other
// browser-only APIs that don't exist in Node.js worker threads.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('pdfjs-text-extractor');

interface IPageText {
    pageNumber: number;
    text: string;
}

export async function extractTextWithPdfjs(pdfPath: string): Promise<IPageText[]> {
    log.debug(`Extracting text with pdfjs-dist: ${pdfPath}`);

    const data = new Uint8Array(await readFile(pdfPath));
    const doc = await getDocument({
        data,
        isEvalSupported: false,
    }).promise;

    try {
        const pages: IPageText[] = [];

        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent({disableNormalization: true});

            const parts: string[] = [];
            for (const item of content.items) {
                if ('str' in item) {
                    const textItem = item as TextItem;
                    parts.push(textItem.str);
                    if (textItem.hasEOL) {
                        parts.push('\n');
                    }
                }
            }

            pages.push({
                pageNumber: i,
                text: parts.join(''),
            });
        }

        log.debug(`Extracted ${pages.length} pages with pdfjs-dist`);
        return pages;
    } finally {
        await doc.destroy();
    }
}
