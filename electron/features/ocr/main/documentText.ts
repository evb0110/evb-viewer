import { createHash } from 'node:crypto';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH,
    MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH,
    type IDocumentTextCatalogPage,
    type IDocumentTextCatalogWindow,
    type IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';
import { requirePageNumber } from '@contracts/pageNumbers';
import { streamPdfPageTexts } from '@electron/features/search/public';
import { assertWorkingCopyRevisionCurrent } from '@electron/file-access/documentRevisionStore';

// The PDF text layer is the document's only text; OCR writes into it.

function digest(parts: readonly string[]) {
    const hash = createHash('sha256');
    for (const part of parts) {
        hash.update(part).update('\0');
    }
    return hash.digest('hex');
}

/**
 * Reads the requested pages into catalog pages. The budget is applied as each
 * page arrives, so a document over it stops extraction at the page that
 * crosses it instead of after reading every page.
 */
async function readTextPages(pdfPath: string, range: {
    firstPage?: number;
    lastPage?: number
}, maxTextLength: number, signal?: AbortSignal) {
    let pageCount = 0;
    let textLength = 0;
    const pages: IDocumentTextCatalogPage[] = [];
    for await (const page of streamPdfPageTexts(pdfPath, {
        ...range,
        signal,
    })) {
        pageCount += 1;
        if (!page.text.trim()) {
            continue;
        }
        textLength += page.text.length;
        if (textLength > maxTextLength) {
            throw new RangeError(`Document text exceeds ${maxTextLength} characters; export it in page windows`);
        }
        pages.push({
            pageNumber: requirePageNumber(page.pageNumber),
            text: page.text,
            source: 'pdf-native',
            contentDigest: digest([
                String(page.pageNumber),
                page.text,
            ]),
        });
    }
    return {
        pageCount,
        pages,
    };
}

export async function readDocumentTextSnapshot(
    workingCopyPath: string,
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount: number | undefined,
    signal?: AbortSignal,
): Promise<IDocumentTextSnapshot> {
    await assertWorkingCopyRevisionCurrent(workingCopyPath, documentRevision);
    const {
        pageCount: readPageCount,
        pages,
    } = await readTextPages(
        pdfPath,
        pageCount === undefined ? {} : {lastPage: pageCount},
        MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH,
        signal,
    );
    return {
        documentRevision,
        pageCount: pageCount ?? readPageCount,
        pages,
        contentDigest: digest(pages.map(page => page.contentDigest)),
    };
}

export async function readDocumentTextWindow(
    workingCopyPath: string,
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    window: {
        firstPage: number;
        lastPage: number;
        pageCount?: number | undefined
    },
    signal?: AbortSignal,
): Promise<IDocumentTextCatalogWindow> {
    const pageCount = window.pageCount ?? window.lastPage;
    const lastPage = Math.min(window.lastPage, pageCount);
    if (window.firstPage < 1 || lastPage - window.firstPage + 1 > MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES) {
        throw new RangeError(`Document text windows hold 1-${MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES} pages`);
    }
    await assertWorkingCopyRevisionCurrent(workingCopyPath, documentRevision);
    const {pages} = await readTextPages(pdfPath, {
        firstPage: window.firstPage,
        lastPage,
    }, MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH, signal);
    return {
        documentRevision,
        pageCount,
        firstPage: window.firstPage,
        lastPage,
        pages,
        contentDigest: digest(pages.map(page => page.contentDigest)),
    };
}
