import {
    rm,
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { sortBy } from 'es-toolkit/array';
import { isOcrWord } from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';
import type { IOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    OCR_TEXT_LAYER_INDEX_SOURCE,
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrTextLayerIndexText,
} from '@contracts/ocrText';
import { assembleSearchablePageText } from '@contracts/search';
import { requirePageNumber } from '@contracts/pageNumbers';
import { extractTextFromPdf } from '@electron/features/search/extractTextFromPdf';
import type { IExtractPdfjsTextOptions } from '@electron/features/search/extractTextWithPdfjs';
import {loadPdfjsTextExtractor} from '@electron/features/search/loadPdfjsTextExtractor';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    persistCompactSearchIndexBestEffort,
} from '@electron/features/search/searchIndexSidecar';
import { ensureNativeSearchIndexBestEffort } from '@electron/features/search/nativeSearchIndex';
import { stringifyLegacyJsonSearchIndex } from '@electron/features/search/stringifyLegacyJsonSearchIndex';
import type {
    IPageIndex,
    IPdfSearchIndex,
} from '@electron/features/search/searchIndexTypes';
import {SEARCH_INDEX_SCHEMA_VERSION} from '@electron/features/search/searchIndexSchemaVersion';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { assertWorkingCopyRevisionSidecarCurrent } from '@electron/file-access/documentRevisionSidecar';
import {visitDocumentOcrCatalogPages} from '@electron/features/ocr/public/catalog';

export type {
    IPageIndex,
    IPdfSearchIndex,
} from '@electron/features/search/searchIndexTypes';

const log = createLogger('indexBuilder');

const SEARCH_PDFTOTEXT_PAGE_WINDOW = 64;
const SEARCH_RESIDENT_GEOMETRY_MAX_WORDS = 250_000;
const SEARCH_LEGACY_JSON_INDEX_MAX_BYTES = 128 * 1024 * 1024;
interface IBuildSearchIndexOptions {
    documentRevision: TDocumentRevisionToken;
    pageCount?: number;
    signal?: AbortSignal;
    onPageIndexed?: (page: IPageIndex) => void;
    validateBeforePersist?: (index: IPdfSearchIndex) => void;
}

interface IExtractedPageText {
    pageNumber: number;
    text: string;
}

interface IPageDataInput {
    pageNumber: number;
    words: IOcrWord[];
    text?: string;
    pageWidth?: number;
    pageHeight?: number;
    rotation?: TOcrIndexRotation;
}

interface ISearchGeometryBudget {remainingWords: number;}

interface ISeededPageText {
    pagesByNumber: Map<number, IPageIndex>;
    hasText: boolean;
    completed: boolean;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function finiteNumberOrUndefined(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function ocrRotationOrUndefined(value: unknown): TOcrIndexRotation | undefined {
    return value === 0 || value === 90 || value === 180 || value === 270
        ? value
        : undefined;
}

function ocrWordsOrUndefined(value: unknown) {
    return Array.isArray(value) && value.every(isOcrWord)
        ? value
        : undefined;
}

function parseDocumentRevisionStamp(value: unknown): { token: TDocumentRevisionToken } | null {
    if (!isRecord(value)) {
        return null;
    }
    const token = parseDocumentRevisionToken(value.token);
    return token === null ? null : {token};
}

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
}

function parseSearchIndexPage(page: unknown): IPageIndex | null {
    if (!isRecord(page)) {
        return null;
    }
    if (!isPositiveInteger(page.pageNumber)) {
        return null;
    }
    if (typeof page.text !== 'string') {
        return null;
    }

    const normalizedPage: IPageIndex = {
        pageNumber: page.pageNumber,
        text: page.text,
    };
    const words = ocrWordsOrUndefined(page.words);
    if (words) {
        normalizedPage.words = words;
    }
    const pageWidth = finiteNumberOrUndefined(page.pageWidth);
    if (pageWidth !== undefined) {
        normalizedPage.pageWidth = pageWidth;
    }
    const pageHeight = finiteNumberOrUndefined(page.pageHeight);
    if (pageHeight !== undefined) {
        normalizedPage.pageHeight = pageHeight;
    }
    const rotation = ocrRotationOrUndefined(page.rotation);
    if (rotation !== undefined) {
        normalizedPage.rotation = rotation;
    }
    return normalizedPage;
}

function parseSearchIndexPages(pages: unknown[]): IPageIndex[] | null {
    const normalizedPages: IPageIndex[] = [];
    for (const page of pages) {
        const normalizedPage = parseSearchIndexPage(page);
        if (!normalizedPage) {
            return null;
        }
        normalizedPages.push(normalizedPage);
    }
    return sortBy(normalizedPages, ['pageNumber']);
}

function applySearchGeometryBudget(
    page: IPageIndex,
    budget: ISearchGeometryBudget,
): IPageIndex {
    const wordCount = page.words?.length ?? 0;
    if (wordCount === 0) {
        return page;
    }
    if (wordCount > budget.remainingWords) {
        return {
            pageNumber: page.pageNumber,
            text: page.text,
        };
    }
    budget.remainingWords -= wordCount;
    return page;
}

function parseSearchIndexPayload(
    payload: unknown,
    expectedPdfPath: string,
    expectedRevision?: TDocumentRevisionToken,
): IPdfSearchIndex | null {
    if (!isRecord(payload) || !Array.isArray(payload.pages)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionStamp(payload.documentRevision);
    if (
        payload.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION
        || documentRevision === null
        || (
            expectedRevision !== undefined
            && documentRevision.token !== expectedRevision
        )
    ) {
        return null;
    }
    if (typeof payload.pdfPath !== 'string' || payload.pdfPath.length === 0) {
        return null;
    }
    if (normalizePathForLookup(payload.pdfPath) !== normalizePathForLookup(expectedPdfPath)) {
        return null;
    }

    const normalizedPages = parseSearchIndexPages(payload.pages);
    if (!normalizedPages) {
        return null;
    }

    const createdAt = finiteNumberOrUndefined(payload.createdAt);

    const normalizedIndex: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        documentRevision,
        pdfPath: payload.pdfPath,
        createdAt: createdAt ?? Date.now(),
        pages: normalizedPages,
    };
    if (isPositiveInteger(payload.pageCount)) {
        normalizedIndex.pageCount = payload.pageCount;
    }
    if (
        isRecord(payload.textSource)
        && typeof payload.textSource.kind === 'string'
        && typeof payload.textSource.version === 'number'
    ) {
        normalizedIndex.textSource = {
            kind: payload.textSource.kind,
            version: payload.textSource.version,
        };
    }
    return normalizedIndex;
}

function pagesFromOcrIndexPages(
    ocrPages: Map<number, IPageIndex>,
    signal?: AbortSignal,
): IPageIndex[] {
    const pages: IPageIndex[] = [];
    for (const page of ocrPages.values()) {
        throwIfAborted(signal);
        pages.push(page);
    }
    return sortBy(pages, ['pageNumber']);
}

function hasCompleteExpectedCoverage(
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
) {
    if (!isPositiveInteger(expectedCount)) {
        return false;
    }
    for (let pageNumber = 1; pageNumber <= expectedCount; pageNumber += 1) {
        throwIfAborted(signal);
        if (!pagesByNumber.has(pageNumber)) {
            return false;
        }
    }
    return true;
}

async function persistIndex(
    pdfPath: string,
    index: IPdfSearchIndex,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const indexPath = getIndexPath(pdfPath);
    const tempPath = makeSiblingTempPath(indexPath);
    try {
        await writeFile(tempPath, stringifyLegacyJsonSearchIndex(index, signal), 'utf-8');
        throwIfAborted(signal);
        await assertWorkingCopyRevisionSidecarCurrent(pdfPath, index.documentRevision.token);
        await atomicReplace(tempPath, indexPath);
        try {
            await assertWorkingCopyRevisionSidecarCurrent(pdfPath, index.documentRevision.token);
        } catch (error) {
            await rm(indexPath, { force: true }).catch(() => undefined);
            throw error;
        }
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
    log.debug(`Index saved successfully: ${indexPath}`);
}

async function persistIndexBestEffort(
    pdfPath: string,
    index: IPdfSearchIndex,
    signal?: AbortSignal,
) {
    try {
        await persistIndex(pdfPath, index, signal);
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }
        if (err instanceof Error && getErrorMessage(err) === 'Document revision is stale') {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Warning: Failed to save OCR-based index: ${errMsg}`);
    }
}

async function buildIndexFromOcrPages(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    ocrPages: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    validateBeforePersist?: (index: IPdfSearchIndex) => void,
): Promise<IPdfSearchIndex> {
    log.debug(`Using OCR v3 index with ${ocrPages.size} pages`);
    const pages = pagesFromOcrIndexPages(ocrPages, signal);

    const index: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        documentRevision: {token: documentRevision},
        pdfPath,
        createdAt: Date.now(),
        pages,
        pageCount: isPositiveInteger(expectedCount) ? expectedCount : pages.length,
        textSource: {
            kind: OCR_TEXT_LAYER_INDEX_SOURCE,
            version: OCR_TEXT_LAYER_INDEX_VERSION,
        },
    };

    validateBeforePersist?.(index);
    await persistIndexBestEffort(pdfPath, index, signal);
    await persistCompactSearchIndexBestEffort(pdfPath, {
        documentRevision,
        pageCount: index.pageCount ?? pages.length,
        pages: pages.map(page => ({
            pageNumber: requirePageNumber(page.pageNumber),
            text: page.text,
        })),
        textSource: {
            kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
            version: OCR_TEXT_LAYER_INDEX_VERSION,
        },
    }, signal);
    return index;
}

function seedFromExistingIndex(
    existing: IPdfSearchIndex | null,
): Map<number, IPageIndex> {
    if (!existing || existing.pages.length === 0) {
        return new Map();
    }
    return new Map(existing.pages.map((page) => [
        page.pageNumber,
        {
            pageNumber: page.pageNumber,
            text: page.text,
            ...(page.pageWidth !== undefined ? { pageWidth: page.pageWidth } : {}),
            ...(page.pageHeight !== undefined ? { pageHeight: page.pageHeight } : {}),
            ...(page.rotation !== undefined ? { rotation: page.rotation } : {}),
            ...(page.words !== undefined ? { words: page.words } : {}),
        },
    ]));
}

function shouldExtractPdfText(
    pagesByNumber: Map<number, IPageIndex>,
    existing: IPdfSearchIndex | null,
    expectedCount: number | undefined,
) {
    if (!existing) {
        return true;
    }
    if (existing.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
        return true;
    }
    const hasAnyText = Array.from(pagesByNumber.values()).some(p => p.text.length > 0);
    if (!hasAnyText) {
        return true;
    }
    if (isPositiveInteger(expectedCount) && pagesByNumber.size < expectedCount) {
        return true;
    }
    return false;
}

function applyExtractedTexts(
    pagesByNumber: Map<number, IPageIndex>,
    pageTexts: IExtractedPageText[],
    signal?: AbortSignal,
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Map<number, IPageIndex> {
    for (const pt of pageTexts) {
        throwIfAborted(signal);
        const entry = pagesByNumber.get(pt.pageNumber);
        if (entry && preservePageNumbers.has(pt.pageNumber)) {
            continue;
        }
        if (!entry) {
            pagesByNumber.set(pt.pageNumber, {
                pageNumber: pt.pageNumber,
                text: pt.text,
            });
            continue;
        }

        if (!entry.text && pt.text) {
            pagesByNumber.set(pt.pageNumber, {
                ...entry,
                text: pt.text,
            });
        }
    }
    return pagesByNumber;
}

async function seedFromPdfjs(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Promise<ISeededPageText> {
    let hasText = false;
    let nextPagesByNumber = new Map(pagesByNumber);
    const pendingPages: IPageIndex[] = [];
    try {
        log.debug(`Seeding index with pdfjs-dist (pageCount=${expectedCount ?? 'unknown'})`);
        const extractOptions: IExtractPdfjsTextOptions = {
            collectPages: false,
            onPageText: (pageText) => {
                hasText ||= pageText.text.length > 0;
                nextPagesByNumber = applyExtractedTexts(nextPagesByNumber, [pageText], signal, preservePageNumbers);
                const page = nextPagesByNumber.get(pageText.pageNumber);
                if (page && !preservePageNumbers.has(pageText.pageNumber)) {
                    pendingPages.push(page);
                }
            },
        };
        if (isPositiveInteger(expectedCount)) {
            extractOptions.pageCount = expectedCount;
        }
        if (signal !== undefined) {
            extractOptions.signal = signal;
        }
        const {extractTextWithPdfjs} = await loadPdfjsTextExtractor();
        await extractTextWithPdfjs(pdfPath, extractOptions);
        pendingPages.forEach((page) => onPageIndexed?.(page));
        return {
            pagesByNumber: nextPagesByNumber,
            hasText,
            completed: true,
        };
    } catch (pdfjsErr) {
        if (isAbortError(pdfjsErr)) {
            throw pdfjsErr;
        }
        const errMsg = getErrorMessage(pdfjsErr);
        log.warn(`Failed to extract text with pdfjs-dist: ${errMsg}`);
        return {
            pagesByNumber: nextPagesByNumber,
            hasText,
            completed: false,
        };
    }
}

async function seedFromPdftotext(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Promise<ISeededPageText> {
    let hasText = false;
    let nextPagesByNumber = new Map(pagesByNumber);
    const pendingPages: IPageIndex[] = [];
    try {
        log.debug(`Falling back to pdftotext (pageCount=${expectedCount ?? 'unknown'})`);
        const runWindow = async (pages?: number[]) => {
            const extractOptions: Parameters<typeof extractTextFromPdf>[1] = {};
            if (expectedCount !== undefined) {
                extractOptions.pageCount = expectedCount;
            }
            if (signal !== undefined) {
                extractOptions.signal = signal;
            }
            if (pages !== undefined) {
                extractOptions.pages = pages;
            }
            const pageTexts = await extractTextFromPdf(pdfPath, extractOptions);
            hasText ||= pageTexts.some(pageText => pageText.text.length > 0);
            nextPagesByNumber = applyExtractedTexts(
                nextPagesByNumber,
                pageTexts,
                signal,
                preservePageNumbers,
            );
            pageTexts.forEach((pageText) => {
                const page = nextPagesByNumber.get(pageText.pageNumber);
                if (page && !preservePageNumbers.has(pageText.pageNumber)) {
                    pendingPages.push(page);
                }
            });
        };

        if (isPositiveInteger(expectedCount)) {
            for (let firstPage = 1; firstPage <= expectedCount; firstPage += SEARCH_PDFTOTEXT_PAGE_WINDOW) {
                throwIfAborted(signal);
                const lastPage = Math.min(expectedCount, firstPage + SEARCH_PDFTOTEXT_PAGE_WINDOW - 1);
                const pages: number[] = [];
                for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
                    if (!preservePageNumbers.has(pageNumber)) {
                        pages.push(pageNumber);
                    }
                }
                if (pages.length > 0) {
                    await runWindow(pages);
                }
            }
        } else {
            await runWindow();
        }
        pendingPages.forEach((page) => onPageIndexed?.(page));
        return {
            pagesByNumber: nextPagesByNumber,
            hasText,
            completed: true,
        };
    } catch (pdfTextErr) {
        if (isAbortError(pdfTextErr)) {
            throw pdfTextErr;
        }
        const errMsg = getErrorMessage(pdfTextErr);
        log.warn(`Failed to extract text with pdftotext: ${errMsg}`);
        throw pdfTextErr;
    }
}

async function seedPagesFromPdfText(
    pdfPath: string,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
    preservePageNumbers: ReadonlySet<number> = new Set(),
): Promise<Map<number, IPageIndex>> {
    const seeded = await seedFromPdfjs(pdfPath, pagesByNumber, expectedCount, signal, onPageIndexed, preservePageNumbers);
    if (seeded.completed && seeded.hasText) {
        return seeded.pagesByNumber;
    }

    return (await seedFromPdftotext(
        pdfPath,
        seeded.pagesByNumber,
        expectedCount,
        signal,
        onPageIndexed,
        preservePageNumbers,
    )).pagesByNumber;
}

function padMissingPages(
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    signal?: AbortSignal,
): Map<number, IPageIndex> {
    if (!isPositiveInteger(expectedCount)) {
        return pagesByNumber;
    }
    const nextPages = new Map(pagesByNumber);
    for (let pageNumber = 1; pageNumber <= expectedCount; pageNumber += 1) {
        throwIfAborted(signal);
        if (nextPages.has(pageNumber)) {
            continue;
        }
        nextPages.set(pageNumber, {
            pageNumber,
            text: '',
        });
    }
    return nextPages;
}

function mergePageData(
    pagesByNumber: Map<number, IPageIndex>,
    pageData: IPageDataInput[] | undefined,
    signal?: AbortSignal,
    onPageIndexed?: (page: IPageIndex) => void,
): Map<number, IPageIndex> {
    if (!pageData?.length) {
        return pagesByNumber;
    }
    const nextPages = new Map(pagesByNumber);
    for (const page of pageData) {
        throwIfAborted(signal);
        const textFromWords = page.words.length > 0
            ? buildOcrTextLayerIndexText(page.words)
            : '';
        const textFromOcr = page.text
            ? assembleSearchablePageText([{text: page.text.trim()}]).text
            : '';
        const text = textFromWords || textFromOcr;
        const previous = nextPages.get(page.pageNumber);
        const indexedPage: IPageIndex = {
            pageNumber: page.pageNumber,
            text: text.length > 0
                ? text
                : previous?.text ?? '',
        };
        if (page.pageWidth !== undefined) {
            indexedPage.pageWidth = page.pageWidth;
        }
        if (page.pageHeight !== undefined) {
            indexedPage.pageHeight = page.pageHeight;
        }
        if (page.rotation !== undefined) {
            indexedPage.rotation = page.rotation;
        }
        if (page.words.length > 0) {
            indexedPage.words = page.words;
        }
        onPageIndexed?.(indexedPage);
        nextPages.set(page.pageNumber, indexedPage);
    }
    return nextPages;
}

function assembleIndex(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    pagesByNumber: Map<number, IPageIndex>,
    expectedCount: number | undefined,
    existing: IPdfSearchIndex | null,
): IPdfSearchIndex {
    const pages = sortBy(Array.from(pagesByNumber.values()), ['pageNumber']);
    const index: IPdfSearchIndex = {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        documentRevision: {token: documentRevision},
        pdfPath,
        createdAt: Date.now(),
        pages,
    };
    if (isPositiveInteger(expectedCount)) {
        index.pageCount = expectedCount;
    } else if (existing?.pageCount !== undefined) {
        index.pageCount = existing.pageCount;
    }
    return index;
}

/**
 * Build and save a search index from OCR page data
 * Index is saved as {pdfPath}.index.json for quick access on future searches
 */
export async function buildSearchIndex(
    pdfPath: string,
    pageData: IPageDataInput[],
    options: IBuildSearchIndexOptions,
): Promise<IPdfSearchIndex> {
    log.debug(`Building search index for ${pdfPath}`);

    const {
        documentRevision,
        pageCount: expectedCount,
        signal,
        onPageIndexed,
        validateBeforePersist,
    } = options;
    if (!documentRevision) {
        throw new Error('documentRevision is required to build a search index');
    }
    throwIfAborted(signal);

    const geometryBudget: ISearchGeometryBudget = {remainingWords: SEARCH_RESIDENT_GEOMETRY_MAX_WORDS};
    const ocrPages = new Map<number, IPageIndex>();
    const ocrCatalog = await visitDocumentOcrCatalogPages(pdfPath, documentRevision, {
        ...(signal ? {signal} : {}),
        onPage: (page) => {
            const indexedPage = applySearchGeometryBudget({
                pageNumber: page.pageNumber,
                text: page.text,
                ...(page.words && page.words.length > 0 ? {words: [...page.words]} : {}),
                ...(page.render ? {
                    pageWidth: page.render.imagePx.w,
                    pageHeight: page.render.imagePx.h,
                } : {}),
            }, geometryBudget);
            onPageIndexed?.(indexedPage);
            ocrPages.set(page.pageNumber, indexedPage);
        },
    }).catch((error) => {
        if (isAbortError(error)) {
            throw error;
        }
        log.debug(`OCR page catalog is unavailable for this revision: ${getErrorMessage(error)}`);
        return null;
    });
    const effectiveExpectedCount = isPositiveInteger(expectedCount)
        ? expectedCount
        : ocrCatalog?.pageCount;
    if (ocrPages.size > 0 && hasCompleteExpectedCoverage(ocrPages, effectiveExpectedCount, signal)) {
        return buildIndexFromOcrPages(
            pdfPath,
            documentRevision,
            ocrPages,
            effectiveExpectedCount,
            signal,
            validateBeforePersist,
        );
    }

    throwIfAborted(signal);
    const existing = await loadSearchIndex(pdfPath, documentRevision);
    throwIfAborted(signal);

    let pagesByNumber = ocrPages.size > 0
        ? new Map(ocrPages)
        : seedFromExistingIndex(existing);
    const preservedOcrPages = new Set(ocrPages.keys());

    if (shouldExtractPdfText(pagesByNumber, existing, effectiveExpectedCount)) {
        pagesByNumber = await seedPagesFromPdfText(
            pdfPath,
            pagesByNumber,
            effectiveExpectedCount,
            signal,
            onPageIndexed,
            preservedOcrPages,
        );
    }

    pagesByNumber = padMissingPages(pagesByNumber, effectiveExpectedCount, signal);
    pagesByNumber = mergePageData(pagesByNumber, pageData, signal, onPageIndexed);

    if (pagesByNumber.size === 0) {
        throw new Error('No pages available to build search index');
    }

    const index = assembleIndex(pdfPath, documentRevision, pagesByNumber, effectiveExpectedCount, existing);

    log.debug(`Saving index to ${getIndexPath(pdfPath)}`);
    try {
        validateBeforePersist?.(index);
        await persistIndex(pdfPath, index, signal);
        await ensureNativeSearchIndexBestEffort(pdfPath, index, documentRevision, signal);
        return index;
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }
        const errMsg = getErrorMessage(err);
        log.debug(`Failed to save index: ${errMsg}`);
        throw err;
    }
}

/**
 * Load a cached search index from disk
 */
export async function loadSearchIndex(
    pdfPath: string,
    expectedRevision?: TDocumentRevisionToken,
): Promise<IPdfSearchIndex | null> {
    const indexPath = getIndexPath(pdfPath);

    try {
        const indexStat = await stat(indexPath);
        if (indexStat.size > SEARCH_LEGACY_JSON_INDEX_MAX_BYTES) {
            log.warn(`Search index exceeds ${SEARCH_LEGACY_JSON_INDEX_MAX_BYTES} bytes; ignoring ${indexPath}`);
            return null;
        }
        const content = await readFile(indexPath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        const index = parseSearchIndexPayload(parsed, pdfPath, expectedRevision);
        if (!index) {
            log.warn(`Invalid search index schema at ${indexPath}; ignoring cached index`);
            return null;
        }
        log.debug(`Loaded index from ${indexPath}`);
        return index;
    } catch {
        log.debug(`Index not found or invalid: ${indexPath}`);
        return null;
    }
}
