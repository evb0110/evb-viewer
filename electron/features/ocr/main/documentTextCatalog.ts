import {
    open,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    randomUUID,
    createHash,
} from 'node:crypto';
import {
    dirname,
    join,
} from 'node:path';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IOcrIndexV3Manifest,
    TOcrPageArtifact,
} from '@contracts/ocrIndex';
import type {
    IDocumentOcrAvailability,
    IDocumentOcrPageRange,
    IDocumentOcrPageSnapshot,
    IDocumentTextCatalogPage,
    IDocumentTextCatalogWindow,
    IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';
import {
    MAX_DOCUMENT_OCR_AVAILABILITY_RANGES,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
    MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH,
} from '@contracts/documentTextCatalog';
import {
    OCR_MAX_WINDOW_PAGES,
    OCR_SCALAR_PAGE_LIMIT,
} from '@contracts/ocrIndex';
import { requirePageNumber } from '@contracts/pageNumbers';
import {buildOcrTextLayerIndexText} from '@pdf-core';
import {requireEpochMs} from '@contracts/timestamps';
import {
    extractTextFromPdf,
    loadPdfjsTextExtractor,
} from '@electron/features/search/public/textExtraction';
import type {IPageTextWithWordBoxes} from '@electron/features/search/public/textExtraction';
import {assertWorkingCopyRevisionSidecarCurrent} from '@electron/file-access/documentRevisionSidecar';
import {
    OcrCatalogTooLargeError,
    OcrCatalogCorruptError,
    openCatalog,
    type IOcrCatalogHandle,
} from '@electron/features/ocr/main/ocrCatalogV4';
import {
    migrateOcrIndexV3ToV4,
    remapOcrCatalogV4,
} from '@electron/features/ocr/pipeline/indexWriterV4';
import {
    readOcrIndexV3ManifestMetadata,
    streamOcrIndexV3ManifestMappings,
} from '@electron/features/ocr/main/ocrIndexV3Stream';
import {
    closeOcrCatalog,
    createOcrCatalogPage,
    digestCanonicalPage,
    loadLegacyOcrLanguages,
    hasOcrCatalogRecovery,
    openCurrentOcrCatalog,
    recoverOcrCatalogCorruption,
    resolveDocumentTextCatalogWindow as resolveDocumentTextCatalogWindowWithEmbeddedText,
    type IResolveDocumentTextCatalogOptions,
    visitDocumentOcrCatalogPages,
} from '@electron/features/ocr/main/visitDocumentOcrCatalogPages';

export {visitDocumentOcrCatalogPages};
export type {IResolveDocumentTextCatalogOptions};

export async function resolveDocumentTextCatalogWindow(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    firstPage: number,
    lastPage: number,
    pageCount?: number,
    options: IResolveDocumentTextCatalogOptions = {},
): Promise<IDocumentTextCatalogWindow> {
    return resolveDocumentTextCatalogWindowWithEmbeddedText(
        workingCopyPath,
        documentRevision,
        firstPage,
        lastPage,
        pageCount,
        {
            ...options,
            extractEmbeddedText: extractTextFromPdf,
        },
    );
}

const DOCUMENT_TEXT_EXPORT_PAGE_WINDOW = MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES;
const DOCUMENT_TEXT_EXPORT_PDFJS_MAX_PAGES = 200;
const DOCUMENT_TEXT_EXPORT_PDFJS_MAX_BYTES = 16 * 1024 * 1024;
const OCR_V3_COMPATIBILITY_PAGE_LIMIT = 1_024;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError');
    }
}

function temporaryPath(path: string) {
    return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

async function syncDirectory(path: string) {
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

async function writeJsonAtomic(path: string, value: unknown) {
    const tempPath = temporaryPath(path);
    try {
        await writeFile(tempPath, JSON.stringify(value), 'utf8');
        const file = await open(tempPath, 'r');
        try {
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(tempPath, path);
        await syncDirectory(dirname(path));
    } catch (error) {
        const errors: unknown[] = [error];
        try {
            await rm(tempPath, {force: true});
            await syncDirectory(dirname(path));
        } catch (cleanupError) {
            errors.push(cleanupError);
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, 'OCR document text catalog cleanup failed');
        }
        throw error;
    }
}

async function rebindV4CatalogRevision(
    catalogRoot: string,
    workingCopyPath: string,
    expectedRevision: TDocumentRevisionToken,
    nextRevision: TDocumentRevisionToken,
    pageCount: number,
) {
    const ranges = pageCount === 0
        ? []
        : [{
            kind: 'retain' as const,
            fromPageNumber: 1,
            toPageNumber: 1,
            count: pageCount,
        }];
    const result = await remapOcrCatalogV4({
        catalogRoot,
        delta: {
            previousPageCount: pageCount,
            nextPageCount: pageCount,
            ranges,
        },
        nextRevision,
        sourcePdfPath: workingCopyPath,
    });
    if (result === null) {
        throw new Error('OCR DocumentTextCatalog is missing or stale');
    }
}

/** Re-keys the canonical text catalog during the OCR PDF revision transition. */
export async function rebindDocumentTextCatalogRevision(
    workingCopyPath: string,
    expectedRevision: TDocumentRevisionToken,
    nextRevision: TDocumentRevisionToken,
) {
    const catalogRoot = `${workingCopyPath}.ocr`;
    let catalog: IOcrCatalogHandle | null;
    try {
        catalog = await openCatalog(catalogRoot, {expectedDocumentRevision: expectedRevision});
    } catch {
        throw new Error('OCR DocumentTextCatalog is missing or stale');
    }
    if (!catalog) {
        throw new Error('OCR DocumentTextCatalog is missing or stale');
    }
    try {
        if (catalog.header.version === 4) {
            await rebindV4CatalogRevision(
                catalogRoot,
                workingCopyPath,
                expectedRevision,
                nextRevision,
                catalog.header.pageCount,
            );
            return;
        }
        const manifestPath = join(catalogRoot, 'manifest.json');
        const metadata = await readOcrIndexV3ManifestMetadata(manifestPath);
        if (!metadata || metadata.documentRevision.token !== expectedRevision) {
            throw new Error('OCR DocumentTextCatalog is missing or stale');
        }
        if (metadata.pageCount > OCR_V3_COMPATIBILITY_PAGE_LIMIT) {
            const migrated = await migrateOcrIndexV3ToV4({
                catalogRoot,
                sourcePdfPath: workingCopyPath,
                documentRevision: expectedRevision,
            });
            if (migrated === null) {
                throw new Error('OCR DocumentTextCatalog is missing or stale');
            }
            const rebound = await remapOcrCatalogV4({
                catalogRoot,
                delta: {
                    previousPageCount: metadata.pageCount,
                    nextPageCount: metadata.pageCount,
                    ranges: [{
                        kind: 'retain',
                        fromPageNumber: 1,
                        toPageNumber: 1,
                        count: metadata.pageCount,
                    }],
                },
                nextRevision,
                sourcePdfPath: workingCopyPath,
            });
            if (rebound === null) {
                throw new Error('OCR DocumentTextCatalog is missing or stale');
            }
            return;
        }
        const pages: Record<number, IOcrIndexV3Manifest['pages'][number]> = {};
        const streamedMetadata = await streamOcrIndexV3ManifestMappings(manifestPath, mapping => {
            pages[mapping.pageNumber] = {
                path: mapping.path,
                ...(mapping.generation === undefined ? {} : {generation: mapping.generation}),
            };
        });
        if (
            streamedMetadata === null
            || streamedMetadata.documentRevision.token !== expectedRevision
            || streamedMetadata.pageCount !== metadata.pageCount
        ) {
            throw new Error('OCR DocumentTextCatalog is missing or stale');
        }
        const manifest: IOcrIndexV3Manifest = {
            version: 3,
            documentRevision: {token: nextRevision},
            createdAt: requireEpochMs(metadata.createdAt),
            source: {pdfPath: workingCopyPath},
            pageCount: metadata.pageCount,
            pageBox: metadata.pageBox,
            ocr: metadata.ocr,
            pages,
        };
        await writeJsonAtomic(manifestPath, manifest);
    } finally {
        await closeOcrCatalog(catalog);
    }
}

type TEmbeddedTextPage = Awaited<ReturnType<typeof extractTextFromPdf>>[number] | IPageTextWithWordBoxes;

function createEmbeddedCatalogPage(embedded: TEmbeddedTextPage): IDocumentTextCatalogPage | null {
    if (!embedded.text.trim()) {
        return null;
    }
    const pageWithoutDigest: Omit<IDocumentTextCatalogPage, 'contentDigest'> = {
        pageNumber: requirePageNumber(embedded.pageNumber),
        text: 'words' in embedded
            ? buildOcrTextLayerIndexText(embedded.words)
            : embedded.text,
        ...('words' in embedded ? {words: embedded.words} : {}),
        source: 'hasInvisibleText' in embedded && embedded.hasInvisibleText
            ? 'foreign-ocr'
            : 'pdf-native',
    };
    return {
        ...pageWithoutDigest,
        contentDigest: digestCanonicalPage(pageWithoutDigest),
    };
}

interface ITextBudget {
    limit: number;
    used: number;
    message: string;
}

/**
 * Replaces the canonical page and charges only the net text growth, so a
 * caller can stop pulling pages the moment the running total passes the limit.
 */
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
    languages: readonly string[] | undefined,
    budget: ITextBudget,
) {
    const page = createOcrCatalogPage(pageNumber, artifact, languages);
    if (page) {
        setCanonicalPage(canonicalByPage, asTextOnlyCatalogPage(page), budget);
    }
}

function asTextOnlyCatalogPage(page: IDocumentTextCatalogPage): IDocumentTextCatalogPage {
    const {
        words: _words,
        ...textOnlyPage
    } = page;
    return textOnlyPage;
}

function appendPageToRanges(
    ranges: Array<{
        firstPage: number;
        lastPage: number
    }>,
    pageNumber: number,
): boolean {
    const lastRange = ranges.at(-1);
    if (lastRange?.lastPage === pageNumber - 1) {
        lastRange.lastPage = pageNumber;
        return true;
    }
    if (ranges.length >= MAX_DOCUMENT_OCR_AVAILABILITY_RANGES) {
        return false;
    }
    ranges.push({
        firstPage: pageNumber,
        lastPage: pageNumber,
    });
    return true;
}

async function resolveCatalogAvailability(catalog: IOcrCatalogHandle, signal?: AbortSignal): Promise<{
    mappedPageCount: number;
    pageRanges: IDocumentOcrPageRange[];
    rangesComplete: boolean;
}> {
    const {
        pageCount,
        mappedPageCount,
    } = catalog.header;
    if (pageCount === 0 || mappedPageCount === 0) {
        return {
            mappedPageCount,
            pageRanges: [],
            rangesComplete: true,
        };
    }

    // Header counts and the v4 `complete` flag describe what the writer
    // published, not what still decodes on disk, so every page is checked.
    const pageRanges: IDocumentOcrPageRange[] = [];
    let rangesComplete = true;
    let readablePageCount = 0;
    for (let firstPage = 1; firstPage <= pageCount; firstPage += OCR_MAX_WINDOW_PAGES) {
        throwIfAborted(signal);
        const count = Math.min(OCR_MAX_WINDOW_PAGES, pageCount - firstPage + 1);
        const availability = await catalog.windowAvailability(firstPage, count);
        for (let index = 0; index < availability.length; index += 1) {
            if (availability[index] === 0) {
                continue;
            }
            readablePageCount += 1;
            if (!appendPageToRanges(pageRanges, firstPage + index)) {
                rangesComplete = false;
                break;
            }
        }
        if (!rangesComplete) {
            break;
        }
    }
    return {
        mappedPageCount: rangesComplete ? readablePageCount : mappedPageCount,
        pageRanges,
        rangesComplete,
    };
}

export interface IDocumentOcrReadOptions {signal?: AbortSignal;}

export async function resolveDocumentOcrAvailability(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    options: IDocumentOcrReadOptions = {},
): Promise<IDocumentOcrAvailability> {
    throwIfAborted(options.signal);
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    if (!catalog) {
        return {
            documentRevision,
            pageCount: 0,
            mappedPageCount: 0,
            pageRanges: [],
            rangesComplete: true,
            ...(await hasOcrCatalogRecovery(workingCopyPath, documentRevision) ? {needsReOcr: true} : {}),
        };
    }
    let corruption: unknown = null;
    try {
        const availability = await resolveCatalogAvailability(catalog, options.signal);
        return {
            documentRevision,
            pageCount: catalog.header.pageCount,
            ...availability,
        };
    } catch (error) {
        if (!(error instanceof OcrCatalogCorruptError)) {
            throw error;
        }
        corruption = error;
        return {
            documentRevision,
            pageCount: catalog.header.pageCount,
            mappedPageCount: 0,
            pageRanges: [],
            rangesComplete: true,
            needsReOcr: true,
        };
    } finally {
        await closeOcrCatalog(catalog);
        await recoverOcrCatalogCorruption(workingCopyPath, documentRevision, corruption);
    }
}

export async function resolveDocumentOcrPage(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageNumber: number,
    options: IDocumentOcrReadOptions = {},
): Promise<IDocumentOcrPageSnapshot> {
    throwIfAborted(options.signal);
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    if (!catalog) {
        return {
            documentRevision,
            pageCount: 0,
            page: null,
        };
    }
    let corruption: unknown = null;
    try {
        const languages = await loadLegacyOcrLanguages(workingCopyPath, documentRevision, catalog);
        throwIfAborted(options.signal);
        const page = Number.isSafeInteger(pageNumber)
            && pageNumber >= 1
            && pageNumber <= catalog.header.pageCount
            ? await catalog.readPage(pageNumber)
            : null;
        return {
            documentRevision,
            pageCount: catalog.header.pageCount,
            page: page === null
                ? null
                : createOcrCatalogPage(pageNumber, page, languages),
        };
    } catch (error) {
        throwIfAborted(options.signal);
        corruption = error;
        return {
            documentRevision,
            pageCount: catalog.header.pageCount,
            page: null,
        };
    } finally {
        await closeOcrCatalog(catalog);
        await recoverOcrCatalogCorruption(workingCopyPath, documentRevision, corruption);
    }
}

/** Main-process canonical per-page text authority for viewer/search/export projections. */
export async function resolveDocumentTextCatalogSnapshot(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount?: number,
    options: IResolveDocumentTextCatalogOptions = {},
): Promise<IDocumentTextSnapshot> {
    throwIfAborted(options.signal);
    if (pageCount !== undefined && pageCount > OCR_SCALAR_PAGE_LIMIT) {
        throw new OcrCatalogTooLargeError(pageCount);
    }
    await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
    throwIfAborted(options.signal);
    const catalog = await openCurrentOcrCatalog(workingCopyPath, documentRevision);
    const sourcePdfPath = options.sourcePdfPath ?? workingCopyPath;
    let corruption: unknown = null;
    try {
        const catalogPageCount = catalog?.header.pageCount;
        if (catalogPageCount !== undefined && catalogPageCount > OCR_SCALAR_PAGE_LIMIT) {
            throw new OcrCatalogTooLargeError(catalogPageCount);
        }
        if (catalogPageCount === undefined && pageCount === undefined) {
            throw new RangeError('Document text catalog snapshot requires a bounded page count');
        }
        const shouldUseBoundedTextOnlyExtraction = Boolean(
            pageCount && pageCount > DOCUMENT_TEXT_EXPORT_PDFJS_MAX_PAGES,
        ) || await stat(sourcePdfPath).then(
            fileStat => fileStat.size > DOCUMENT_TEXT_EXPORT_PDFJS_MAX_BYTES,
            () => false,
        );
        throwIfAborted(options.signal);
        const embeddedPages: Array<
            Awaited<ReturnType<typeof extractTextFromPdf>>[number]
            | IPageTextWithWordBoxes
        > = [];
        if (!shouldUseBoundedTextOnlyExtraction) {
            const {extractTextWithPdfjsWordBoxes} = await loadPdfjsTextExtractor();
            throwIfAborted(options.signal);
            const extractedPages = options.signal === undefined
                ? await extractTextWithPdfjsWordBoxes(sourcePdfPath)
                : await extractTextWithPdfjsWordBoxes(sourcePdfPath, {signal: options.signal});
            embeddedPages.push(...extractedPages);
        } else if (pageCount) {
            for (let firstPage = 1; firstPage <= pageCount; firstPage += DOCUMENT_TEXT_EXPORT_PAGE_WINDOW) {
                throwIfAborted(options.signal);
                const lastPage = Math.min(pageCount, firstPage + DOCUMENT_TEXT_EXPORT_PAGE_WINDOW - 1);
                const extractionOptions = {
                    pageCount,
                    pages: Array.from({length: lastPage - firstPage + 1}, (_, index) => firstPage + index),
                    ...(options.signal === undefined ? {} : {signal: options.signal}),
                };
                embeddedPages.push(...await extractTextFromPdf(sourcePdfPath, extractionOptions));
            }
        } else {
            const extractedPages = options.signal === undefined
                ? await extractTextFromPdf(sourcePdfPath)
                : await extractTextFromPdf(sourcePdfPath, {signal: options.signal});
            embeddedPages.push(...extractedPages);
        }
        const languages = await loadLegacyOcrLanguages(workingCopyPath, documentRevision, catalog);
        throwIfAborted(options.signal);
        const resolvedPageCount = pageCount ?? Math.max(embeddedPages.length, catalogPageCount ?? 0);
        const canonicalByPage = new Map<number, IDocumentTextCatalogPage>();
        const budget: ITextBudget = {
            limit: MAX_DOCUMENT_TEXT_SNAPSHOT_TOTAL_TEXT_LENGTH,
            used: 0,
            message: 'Document text export exceeds the 8 MiB aggregate text budget',
        };

        for (const embedded of embeddedPages) {
            throwIfAborted(options.signal);
            if (embedded.pageNumber > resolvedPageCount || !embedded.text.trim()) {
                continue;
            }
            const page = createEmbeddedCatalogPage(embedded);
            if (page) {
                setCanonicalPage(canonicalByPage, page, budget);
            }
        }

        if (catalog) {
            for await (const {
                pageNumber,
                artifact,
            } of catalog.iterateMappedPages()) {
                throwIfAborted(options.signal);
                setCanonicalOcrCatalogPage(canonicalByPage, pageNumber, artifact, languages, budget);
            }
        }
        await assertWorkingCopyRevisionSidecarCurrent(workingCopyPath, documentRevision);
        throwIfAborted(options.signal);

        const pages = Array.from(canonicalByPage.values()).sort((left, right) => left.pageNumber - right.pageNumber);
        return {
            documentRevision,
            pageCount: resolvedPageCount,
            pages,
            contentDigest: createHash('sha256').update(JSON.stringify(
                pages.map(page => [
                    page.pageNumber,
                    page.contentDigest,
                ]),
            )).digest('hex'),
        };
    } catch (error) {
        corruption = error;
        throw error;
    } finally {
        await closeOcrCatalog(catalog);
        await recoverOcrCatalogCorruption(workingCopyPath, documentRevision, corruption);
    }
}
