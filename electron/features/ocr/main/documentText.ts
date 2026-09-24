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
import {
    streamPdfPageTexts,
    type IPageText,
} from '@electron/features/search/public';
import { assertWorkingCopyRevisionSidecarCurrent } from '@electron/file-access/documentRevisionSidecar';

// The PDF text layer is the document's only text; OCR writes into it.

function digest(parts: readonly string[]) {
    const hash = createHash('sha256');
    for (const part of parts) {
        hash.update(part).update('\0');
    }
    return hash.digest('hex');
}

function toTextPages(pages: readonly IPageText[], maxTextLength: number) {
    let textLength = 0;
    const textPages: IDocumentTextCatalogPage[] = [];
    for (const page of pages) {
        if (!page.text.trim()) {
            continue;
        }
        textLength += page.text.length;
        if (textLength > maxTextLength) {
            throw new RangeError(`Document text exceeds ${maxTextLength} characters; export it in page windows`);
        }
        textPages.push({
            pageNumber: requirePageNumber(page.pageNumber),
            text: page.text,
            source: 'pdf-native',
            contentDigest: digest([
                String(page.pageNumber),
                page.text,
            ]),
        });
    }
    return textPages;
}

async function readPages(pdfPath: string, range: {
    firstPage?: number;
    lastPage?: number
}, signal?: AbortSignal) {
    const pages: IPageText[] = [];
    for await (const page of streamPdfPageTexts(pdfPath, {
        ...range,
        signal,
    })) {
        pages.push(page);
    }
    return pages;
}

export async function readDocumentTextSnapshot(
    workingCopyPath: string,
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount: number | undefined,
    signal?: AbortSignal,
): Promise<IDocumentTextSnapshot> {
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const pageTexts = await readPages(pdfPath, pageCount === undefined ? {} : {lastPage: pageCount}, signal);
    const pages = toTextPages(pageTexts, MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH);
    return {
        documentRevision,
        pageCount: pageCount ?? pageTexts.length,
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
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const pages = toTextPages(
        await readPages(pdfPath, {
            firstPage: window.firstPage,
            lastPage,
        }, signal),
        MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH,
    );
    return {
        documentRevision,
        pageCount,
        firstPage: window.firstPage,
        lastPage,
        pages,
        contentDigest: digest(pages.map(page => page.contentDigest)),
    };
}
