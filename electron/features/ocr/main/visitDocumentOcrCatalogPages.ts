import {createHash} from 'node:crypto';
import {join} from 'node:path';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IDocumentTextCatalogPage} from '@contracts/documentTextCatalog';
import {
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH,
    MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS,
} from '@contracts/documentTextCatalog';
import {assembleSearchablePageText} from '@contracts/search';
import {requirePageNumber} from '@contracts/pageNumbers';
import {buildOcrTextLayerIndexText} from '@contracts/ocrText';
import type {TOcrPageArtifact} from '@contracts/ocrIndex';
import {assertWorkingCopyRevisionSidecarCurrent} from '@electron/file-access/documentRevisionSidecar';
import {
    openCatalog,
    OcrCatalogCorruptError,
    type IOcrCatalogHandle,
} from '@electron/features/ocr/main/ocrCatalogV4';
import {readOcrIndexV3ManifestMetadata} from '@electron/features/ocr/main/ocrIndexV3Stream';
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

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError');
    }
}

async function loadCurrentOcrManifest(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
) {
    const catalogDir = `${workingCopyPath}.ocr`;
    const manifest = await readOcrIndexV3ManifestMetadata(join(catalogDir, 'manifest.json'))
        .catch(() => null);
    return manifest?.documentRevision.token === documentRevision ? manifest : null;
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
        log.warn(`Quarantined corrupt OCR catalog for ${workingCopyPath}: ${JSON.stringify(receipt)}`);
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
        log.warn(`Quarantined corrupt OCR catalog for ${workingCopyPath}: ${JSON.stringify(receipt)}`);
        return true;
    } catch (quarantineError) {
        const detail = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
        log.warn(`Failed to quarantine corrupt OCR catalog for ${workingCopyPath}: ${detail}`);
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

export async function loadLegacyOcrLanguages(
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    catalog: IOcrCatalogHandle | null,
) {
    if (catalog?.header.version !== 3) {
        return undefined;
    }
    const manifest = await loadCurrentOcrManifest(workingCopyPath, documentRevision);
    return manifest ? [...manifest.ocr.languages] : undefined;
}

export function digestCanonicalPage(page: Omit<IDocumentTextCatalogPage, 'contentDigest'>) {
    return createHash('sha256').update(JSON.stringify(page)).digest('hex');
}

export function createOcrCatalogPage(
    pageNumber: number,
    ocrPage: TOcrPageArtifact,
    languages?: readonly string[],
): IDocumentTextCatalogPage | null {
    if (
        ocrPage.words.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS
        || ocrPage.text.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH
    ) {
        return null;
    }
    const pageWithoutDigest: Omit<IDocumentTextCatalogPage, 'contentDigest'> = {
        pageNumber: requirePageNumber(pageNumber),
        text: ocrPage.words.length > 0
            ? buildOcrTextLayerIndexText(ocrPage.words)
            : assembleSearchablePageText([{text: ocrPage.text}]).text,
        words: ocrPage.words,
        source: 'evb-ocr',
        ...(ocrPage.canonicalText?.generation ? {generation: ocrPage.canonicalText.generation} : {}),
        render: ocrPage.render,
        ...(languages === undefined ? {} : {languages: [...languages]}),
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
        const languages = await loadLegacyOcrLanguages(workingCopyPath, documentRevision, catalog);
        let visitedPages = 0;
        for await (const {
            pageNumber,
            artifact,
        } of catalog.iterateMappedPages()) {
            throwIfAborted(options.signal);
            const page = createOcrCatalogPage(pageNumber, artifact, languages);
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
