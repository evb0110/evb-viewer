import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import {isBrowserPageOpsWasmFailure} from '@contracts/browserPageOpsWorker';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH,
    MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH,
    type IDocumentTextCatalogPage,
    type IDocumentTextCatalogWindow,
    type IDocumentTextSnapshot,
    type IDocumentTextPageLayout,
} from '@contracts/documentTextCatalog';
import {requirePageNumber} from '@contracts/pageNumbers';
import {normalizeExtractedPageText} from '@pdf-core/pdfSearchAlgorithms';
import {readOcrLayerLayout} from '@ocr-core/readOcrLayerLayout';

// The PDF text layer is the document's only text; OCR writes into it. These
// pages follow desktop's catalog (electron/features/ocr/main/documentText.ts):
// an EVB OCR layer reads in recognition order with its layout, any other page
// as its text layer reads.

async function digest(parts: readonly string[]) {
    const bytes = new TextEncoder().encode(parts.map(part => `${part}\0`).join(''));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readPdfjsPageText(page: IPdfPage) {
    const content = await page.getTextContent();
    return normalizeExtractedPageText(content.items
        .map(item => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
        .join(''));
}

/** The EVB layer lines of the pages that have one, when the document can be read whole. */
async function readEvbLayerLines(ref: TDocumentRef, pageNumbers: number[], signal?: AbortSignal) {
    const layers = new Map<number, {
        text: string;
        layout: IDocumentTextPageLayout
    }>();
    if (pageNumbers.length === 0) return layers;
    const {size} = await browserDocumentStore.stat(ref);
    if (size > BROWSER_MAX_FULL_READ_BYTES) return layers;
    const report = await runBrowserPageOpsWorkerRequest('ocrTextVisibility', {
        data: await browserDocumentStore.read(ref),
        pages: pageNumbers,
        withEvbOcrText: true,
    }, signal === undefined ? {} : {signal}).catch(() => null);
    if (report === null || isBrowserPageOpsWasmFailure(report)) return layers;
    for (const page of report.pages) {
        if (page.paintedText || !page.evbOcrLayer || page.evbOcrLines === null) continue;
        layers.set(page.pageNumber, {
            text: normalizeExtractedPageText(page.evbOcrLines.map(line => line.text).join('\n')),
            layout: readOcrLayerLayout(page.evbOcrLines),
        });
    }
    return layers;
}

async function readTextPages(
    ref: TDocumentRef,
    documentRevision: TDocumentRevisionToken,
    range: {
        firstPage: number;
        lastPage: number | undefined
    },
    maxTextLength: number,
    signal?: AbortSignal,
) {
    await browserDocumentStore.assertDocumentRevisionCurrent(ref, documentRevision);
    const pdf = await loadBrowserPdfjsDocument(ref);
    try {
        const lastPage = Math.min(range.lastPage ?? pdf.numPages, pdf.numPages);
        const texts = new Map<number, string>();
        for (let pageNumber = range.firstPage; pageNumber <= lastPage; pageNumber += 1) {
            signal?.throwIfAborted();
            const page = await pdf.getPage(pageNumber);
            try {
                texts.set(pageNumber, await readPdfjsPageText(page));
            } finally {
                page.cleanup();
            }
        }
        const layers = await readEvbLayerLines(
            ref,
            [...texts].filter(([
                , text,
            ]) => text.length > 0).map(([pageNumber]) => pageNumber),
            signal,
        );
        let textLength = 0;
        const pages: IDocumentTextCatalogPage[] = [];
        for (const [
            pageNumber,
            pdfText,
        ] of texts) {
            const layer = layers.get(pageNumber);
            const text = layer?.text ?? pdfText;
            if (!text.trim()) continue;
            textLength += text.length
                + (layer?.layout.regions.flatMap(region => region.columns.flat()).reduce((length, paragraph) => length + paragraph.length, 0) ?? 0);
            if (textLength > maxTextLength) {
                throw new RangeError(`Document text exceeds ${maxTextLength} characters; export it in page windows`);
            }
            pages.push({
                pageNumber: requirePageNumber(pageNumber),
                text,
                source: 'pdf-native',
                ...(layer === undefined ? {} : {layout: layer.layout}),
                contentDigest: await digest([
                    String(pageNumber),
                    text,
                ]),
            });
        }
        await browserDocumentStore.assertDocumentRevisionCurrent(ref, documentRevision);
        return {
            pageCount: pdf.numPages,
            pages,
        };
    } finally {
        await pdf.loadingTask.destroy().catch(() => {});
    }
}

export async function readBrowserDocumentTextSnapshot(
    ref: TDocumentRef,
    documentRevision: TDocumentRevisionToken,
    pageCount: number | undefined,
): Promise<IDocumentTextSnapshot> {
    const read = await readTextPages(ref, documentRevision, {
        firstPage: 1,
        lastPage: pageCount,
    }, MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH);
    return {
        documentRevision,
        pageCount: pageCount ?? read.pageCount,
        pages: read.pages,
        contentDigest: await digest(read.pages.map(page => page.contentDigest)),
    };
}

export async function readBrowserDocumentTextWindow(
    ref: TDocumentRef,
    documentRevision: TDocumentRevisionToken,
    window: {
        firstPage: number;
        lastPage: number;
        pageCount: number
    },
): Promise<IDocumentTextCatalogWindow> {
    const lastPage = Math.min(window.lastPage, window.pageCount);
    if (window.firstPage < 1 || lastPage - window.firstPage + 1 > MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES) {
        throw new RangeError(`Document text windows hold 1-${MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES} pages`);
    }
    const read = await readTextPages(ref, documentRevision, {
        firstPage: window.firstPage,
        lastPage,
    }, MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH);
    return {
        documentRevision,
        pageCount: window.pageCount,
        firstPage: window.firstPage,
        lastPage,
        pages: read.pages,
        contentDigest: await digest(read.pages.map(page => page.contentDigest)),
    };
}
