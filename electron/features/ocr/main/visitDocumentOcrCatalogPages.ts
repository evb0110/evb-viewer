import {createHash} from 'node:crypto';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {
    IDocumentTextCatalogPage,
    IDocumentTextCatalogWindow,
} from '@contracts/documentTextCatalog';
import {
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH,
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH,
} from '@contracts/documentTextCatalog';
import {
    assembleSearchablePageText,buildOcrTextLayerIndexText,
} from '@pdf-core';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {TOcrPageArtifact} from '@contracts/ocrIndex';
import {assertWorkingCopyRevisionSidecarCurrent} from '@electron/file-access/documentRevisionSidecar';
import {
    openCatalog,
    OcrCatalogCorruptError,
    type IOcrCatalogHandle,
} from '@electron/features/ocr/main/ocrCatalogV4';
import {createLogger} from '@electron/utils/createLogger';
import {
    hasOcrCatalogRecoveryReceipt,
    quarantineOcrCatalog,
} from '@electron/features/ocr/main/ocrCatalogRecovery';

const log = createLogger('ocr-catalog-recovery');

export interface IVisitDocumentOcrCatalogOptions {
    signal?: AbortSignal;
    onPage: (page: IDocumentTextCatalogPage) => void;
}

export interface IResolveDocumentTextCatalogOptions {
    pageWindow?: number;
    signal?: AbortSignal;
    sourcePdfPath?: string;
}

export interface IEmbeddedTextPage {
    pageNumber: number;
    text: string;
}

export interface IExtractEmbeddedTextOptions {
    pageCount: number;
    pages: readonly number[];
    signal?: AbortSignal;
}

export interface IResolveDocumentTextCatalogReaderOptions extends IResolveDocumentTextCatalogOptions { extractEmbeddedText: (pdfPath: string, options: IExtractEmbeddedTextOptions) => Promise<readonly IEmbeddedTextPage[]>; }

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError');
    }
}

export async function openCurrentOcrCatalog(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
): Promise<IOcrCatalogHandle | null> {
    const catalogRoot = `${workingCopyPath}.ocr`;
    try {
        return await openCatalog(
            catalogRoot,
            {expectedDocumentRevision: documentRevision},
        );
    } catch (error) {
        if (!(error instanceof OcrCatalogCorruptError)) {
            throw error;
        }
        const receipt = await quarantineOcrCatalog(catalogRoot, documentRevision, error);
        log.warn('Quarantined corrupt OCR catalog', {
            workingCopyPath,
            receipt,
        });
        return null;
    }
}

/**
 * Call this only once the catalog handle is closed: quarantine renames the
 * catalog root, and Windows refuses to rename a directory that still has open
 * handles inside it.
 *
 * A failed quarantine must not replace the corruption error the caller is
 * already propagating, so it is logged rather than thrown.
 */
export async function recoverOcrCatalogCorruption(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    error: unknown,
): Promise<boolean> {
    if (!(error instanceof OcrCatalogCorruptError)) {
        return false;
    }
    try {
        const receipt = await quarantineOcrCatalog(
            `${workingCopyPath}.ocr`,
            documentRevision,
            error,
        );
        log.warn('Quarantined corrupt OCR catalog', {
            workingCopyPath,
            receipt,
        });
        return true;
    } catch (quarantineError) {
        const detail = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
        log.warn('Failed to quarantine corrupt OCR catalog', {
            workingCopyPath,
            error: detail,
        });
        return false;
    }
}

export async function hasOcrCatalogRecovery(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
): Promise<boolean> {
    return hasOcrCatalogRecoveryReceipt(`${workingCopyPath}.ocr`, documentRevision);
}

export async function closeOcrCatalog(catalog: IOcrCatalogHandle | null) {
    await catalog?.close();
}

export function digestCanonicalPage(page: Omit<IDocumentTextCatalogPage, 'contentDigest'>) {
    return createHash('sha256').update(JSON.stringify(page)).digest('hex');
}

export function createOcrCatalogPage(
    pageNumber: number,
    ocrPage: TOcrPageArtifact,
): IDocumentTextCatalogPage | null {
    if (
        ocrPage.words.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS
        || ocrPage.text.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH
    ) {
        return null;
    }
    const pageWithoutDigest: Omit<IDocumentTextCatalogPage, 'contentDigest'> = {
        pageNumber: requirePageNumber(pageNumber),
        // The recognizer text is already in logical Unicode order. The word
        // boxes remain the geometry source for the viewer, but rebuilding text
        // from their visual order corrupts RTL search text.
        text: ocrPage.text.length > 0
            ? ocrPage.text
            : ocrPage.words.length > 0
                ? buildOcrTextLayerIndexText(ocrPage.words)
                : assembleSearchablePageText([{text: ocrPage.text}]).text,
        words: ocrPage.words,
        source: 'evb-ocr',
        ...(ocrPage.canonicalText?.generation ? {generation: ocrPage.canonicalText.generation} : {}),
        render: ocrPage.render,
    };
    const contentDigest = ocrPage.canonicalText?.contentDigest ?? '';
    return {
        ...pageWithoutDigest,
        contentDigest: contentDigest === ''
            ? digestCanonicalPage(pageWithoutDigest)
            : contentDigest,
    };
}

/**
 * Visits OCR sidecar pages without repeatedly parsing the manifest or creating
 * one all-document payload. This is the bounded internal projection used by
 * search indexing; renderer IPC remains page-scoped through resolveDocumentOcrPage.
 */
export async function visitDocumentOcrCatalogPages(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    options: IVisitDocumentOcrCatalogOptions,
) {
    throwIfAborted(options.signal);
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    if (!catalog) {
        return {
            pageCount: 0,
            visitedPages: 0,
        };
    }

    let corruption: unknown = null;
    try {
        let visitedPages = 0;
        for await (const {
            pageNumber,
            artifact,
        } of catalog.iterateMappedPages()) {
            throwIfAborted(options.signal);
            const page = createOcrCatalogPage(pageNumber, artifact);
            if (!page) {
                continue;
            }
            options.onPage(page);
            visitedPages += 1;
        }
        return {
            pageCount: catalog.header.pageCount,
            visitedPages,
        };
    } catch (error) {
        corruption = error;
        throw error;
    } finally {
        await closeOcrCatalog(catalog);
        await recoverOcrCatalogCorruption(workingCopyPath, documentRevision, corruption);
    }
}

interface IVisitDocumentTextCatalogPagesOptions {
    pageCount?: number;
    firstPage?: number;
    lastPage?: number;
    pageWindow?: number;
    sourcePdfPath?: string;
    signal?: AbortSignal;
    extractEmbeddedText: IResolveDocumentTextCatalogReaderOptions['extractEmbeddedText'];
    onPage: (page: IDocumentTextCatalogPage) => void | Promise<void>;
}

interface ITextBudget {
    limit: number;
    used: number;
    message: string;
}

function createEmbeddedCatalogPage(embedded: IEmbeddedTextPage): IDocumentTextCatalogPage | null {
    if (!embedded.text.trim()) {
        return null;
    }
    const pageWithoutDigest: Omit<IDocumentTextCatalogPage, 'contentDigest'> = {
        pageNumber: requirePageNumber(embedded.pageNumber),
        text: embedded.text,
        source: 'pdf-native',
    };
    return {
        ...pageWithoutDigest,
        contentDigest: digestCanonicalPage(pageWithoutDigest),
    };
}

function setCanonicalPage(
    canonicalByPage: Map<number, IDocumentTextCatalogPage>,
    page: IDocumentTextCatalogPage,
    budget: ITextBudget,
) {
    budget.used += page.text.length - (canonicalByPage.get(page.pageNumber)?.text.length ?? 0);
    if (budget.used > budget.limit) {
        throw new RangeError(budget.message);
    }
    canonicalByPage.set(page.pageNumber, page);
}

function setCanonicalOcrCatalogPage(
    canonicalByPage: Map<number, IDocumentTextCatalogPage>,
    pageNumber: number,
    artifact: TOcrPageArtifact,
    budget: ITextBudget,
) {
    const page = createOcrCatalogPage(pageNumber, artifact);
    if (page) {
        const {
            words: _words,
            ...textOnlyPage
        } = page;
        setCanonicalPage(canonicalByPage, textOnlyPage, budget);
    }
}

/**
 * Visits native text and OCR catalog pages in bounded windows. The catalog
 * page replaces native text only when it belongs to the requested revision.
 */
async function visitDocumentTextCatalogPages(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    options: IVisitDocumentTextCatalogPagesOptions,
) {
    throwIfAborted(options.signal);
    if (
        options.pageCount !== undefined
        && (!Number.isSafeInteger(options.pageCount) || options.pageCount < 1)
    ) {
        throw new Error('Document text catalog window traversal requires a positive page count');
    }
    const firstPage = options.firstPage ?? 1;
    const pageWindow = options.pageWindow ?? MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES;
    const requestedLastPage = options.lastPage ?? options.pageCount;
    if (
        !Number.isSafeInteger(firstPage)
        || firstPage < 1
        || (requestedLastPage !== undefined && !isValidWindowEnd(firstPage, requestedLastPage))
        || !Number.isSafeInteger(pageWindow)
        || pageWindow < 1
        || pageWindow > MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES
    ) {
        throw new RangeError('Invalid document text catalog window');
    }
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    let corruption: unknown = null;
    try {
        const catalogPageCount = catalog?.header.pageCount;
        const resolvedPageCount = options.pageCount ?? catalogPageCount;
        if (!resolvedPageCount || !Number.isSafeInteger(resolvedPageCount) || resolvedPageCount < 1) {
            throw new Error('Document text catalog window traversal requires a positive page count');
        }
        if (catalogPageCount !== undefined && resolvedPageCount > catalogPageCount) {
            throw new RangeError('Document text catalog page count exceeds the OCR catalog page count');
        }
        const lastPage = requestedLastPage ?? resolvedPageCount;
        if (!isValidWindowEnd(firstPage, lastPage) || lastPage > resolvedPageCount) {
            throw new RangeError('Invalid document text catalog window');
        }
        let visitedPages = 0;
        for (let windowFirst = firstPage; windowFirst <= lastPage; windowFirst += pageWindow) {
            throwIfAborted(options.signal);
            const windowLast = Math.min(lastPage, windowFirst + pageWindow - 1);
            const embeddedPages = await options.extractEmbeddedText(options.sourcePdfPath ?? workingCopyPath, {
                pageCount: resolvedPageCount,
                pages: Array.from(
                    {length: windowLast - windowFirst + 1},
                    (_value, index) => windowFirst + index,
                ),
                ...(options.signal === undefined ? {} : {signal: options.signal}),
            });
            const canonicalByPage = new Map<number, IDocumentTextCatalogPage>();
            const budget: ITextBudget = {
                limit: MAX_DOCUMENT_TEXT_CATALOG_WINDOW_TOTAL_TEXT_LENGTH,
                used: 0,
                message: 'Document text catalog window exceeds its bounded text budget',
            };
            for (const embedded of embeddedPages) {
                const page = createEmbeddedCatalogPage(embedded);
                if (
                    page
                    && page.pageNumber >= windowFirst
                    && page.pageNumber <= windowLast
                ) {
                    setCanonicalPage(canonicalByPage, page, budget);
                }
            }
            if (catalog) {
                for await (const {
                    pageNumber, artifact,
                } of catalog.readWindow(windowFirst, windowLast - windowFirst + 1)) {
                    throwIfAborted(options.signal);
                    if (artifact) {
                        setCanonicalOcrCatalogPage(canonicalByPage, pageNumber, artifact, budget);
                    }
                }
            }
            await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
            throwIfAborted(options.signal);
            for (const page of Array.from(canonicalByPage.values()).sort((left, right) => left.pageNumber - right.pageNumber)) {
                throwIfAborted(options.signal);
                await options.onPage(page);
                visitedPages += 1;
            }
        }
        return {
            documentRevision,
            pageCount: resolvedPageCount,
            firstPage,
            lastPage,
            visitedPages,
        };
    } catch (error) {
        corruption = error;
        throw error;
    } finally {
        await closeOcrCatalog(catalog);
        await recoverOcrCatalogCorruption(workingCopyPath, documentRevision, corruption);
    }
}

function isValidWindowEnd(firstPage: number, lastPage: number) {
    return Number.isSafeInteger(lastPage)
        && lastPage >= firstPage
        && lastPage - firstPage + 1 <= MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES;
}

export function resolveDocumentTextCatalogWindow(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    firstPage: number,
    lastPage: number,
    options: IResolveDocumentTextCatalogReaderOptions,
): Promise<IDocumentTextCatalogWindow>;

export function resolveDocumentTextCatalogWindow(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    firstPage: number,
    lastPage: number,
    pageCount: number | undefined,
    options: IResolveDocumentTextCatalogReaderOptions,
): Promise<IDocumentTextCatalogWindow>;

export async function resolveDocumentTextCatalogWindow(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    firstPage: number,
    lastPage: number,
    pageCountOrOptions: number | IResolveDocumentTextCatalogReaderOptions | undefined,
    readerOptions?: IResolveDocumentTextCatalogReaderOptions,
): Promise<IDocumentTextCatalogWindow> {
    const pageCount = typeof pageCountOrOptions === 'number' ? pageCountOrOptions : undefined;
    const options = typeof pageCountOrOptions === 'number'
        ? readerOptions
        : pageCountOrOptions;
    if (!options) {
        throw new TypeError('Document text catalog window extraction requires an embedded text reader');
    }
    const pages: IDocumentTextCatalogPage[] = [];
    const result = await visitDocumentTextCatalogPages(
        workingCopyPath,
        documentRevision,
        {
            firstPage,
            lastPage,
            ...(pageCount === undefined ? {} : {pageCount}),
            ...(options.pageWindow === undefined ? {} : {pageWindow: options.pageWindow}),
            ...(options.sourcePdfPath === undefined ? {} : {sourcePdfPath: options.sourcePdfPath}),
            ...(options.signal === undefined ? {} : {signal: options.signal}),
            extractEmbeddedText: options.extractEmbeddedText,
            onPage: page => {
                pages.push(page);
            },
        },
    );
    throwIfAborted(options.signal);
    return {
        documentRevision,
        pageCount: result.pageCount,
        firstPage: result.firstPage,
        lastPage: result.lastPage,
        pages,
        contentDigest: createHash('sha256').update(JSON.stringify(
            pages.map(page => [
                page.pageNumber,
                page.contentDigest,
            ]),
        )).digest('hex'),
    };
}
