import {
    createHash,
    randomUUID,
} from 'crypto';
import {
    lstat,
    mkdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'path';
import type {
    IOcrPageWithWords,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import type {
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
} from '@contracts/ocrIndex';
import {decodeOcrPage} from '@contracts/ocrIndex';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrTextLayerIndexText,
} from '@contracts/ocrText';
import {
    NATIVE_COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER as COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    getNativeCompactSearchIndexPath as getCompactSearchIndexPath,
    loadNativeCompactSearchIndex as loadCompactSearchIndex,
    persistNativeCompactSearchIndex as persistCompactSearchIndex,
    classifyXlargeSearchPathFromFile,
} from '@electron/features/search/publicNative';
import { getErrorMessage } from '@electron/utils/error';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { assertWorkingCopyRevisionSidecarCurrent as assertWorkingCopyRevisionCurrent } from '@electron/file-access/documentRevisionSidecar';
import {
    readOcrIndexV3ManifestMetadata,
    resolveCatalogPath,
    streamOcrIndexV3ManifestMappings,
} from '@electron/features/ocr/workerPublic';
import type {IOcrIndexV3ManifestStreamMetadata} from '@electron/features/ocr/workerPublic';
import {writeOcrIndexV4} from '@electron/features/ocr/worker/indexWriterV4';
import {
    createEpochMs,
    requireEpochMs,
} from '@contracts/timestamps';
import { requirePageNumber } from '@contracts/pageNumbers';

const OCR_V3_COMPATIBILITY_PAGE_LIMIT = 1_024;

type TExistingOcrIndexV3Manifest =
    | {
        kind: 'manifest';
        manifest: IOcrIndexV3Manifest;
    }
    | {
        kind: 'streaming-required';
        metadata: IOcrIndexV3ManifestStreamMetadata;
    };

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function isPathInsideBaseDir(baseDir: string, candidatePath: string) {
    const relativePath = relative(baseDir, candidatePath);
    return (
        relativePath !== ''
        && relativePath !== '.'
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
}

function isPathInsideAnyBaseDir(baseDirs: string[], candidatePath: string) {
    return baseDirs.some(baseDir => isPathInsideBaseDir(baseDir, candidatePath));
}

async function readExistingOcrIndexV3Manifest(
    ocrDir: string,
): Promise<TExistingOcrIndexV3Manifest | null> {
    let metadata: IOcrIndexV3ManifestStreamMetadata | null;
    const pages: Record<number, IOcrIndexV3Manifest['pages'][number]> = {};
    try {
        metadata = await readOcrIndexV3ManifestMetadata(join(ocrDir, 'manifest.json'));
        if (metadata === null) {
            return null;
        }
        if (metadata.pageCount > OCR_V3_COMPATIBILITY_PAGE_LIMIT) {
            return {
                kind: 'streaming-required',
                metadata,
            };
        }
        const streamedMetadata = await streamOcrIndexV3ManifestMappings(
            join(ocrDir, 'manifest.json'),
            mapping => {
                pages[mapping.pageNumber] = {
                    path: mapping.path,
                    ...(mapping.generation === undefined ? {} : {generation: mapping.generation}),
                };
            },
        );
        if (
            streamedMetadata === null
            || streamedMetadata.documentRevision.token !== metadata.documentRevision.token
            || streamedMetadata.pageCount !== metadata.pageCount
        ) {
            return null;
        }
        return {
            kind: 'manifest',
            manifest: {
                version: 3,
                documentRevision: metadata.documentRevision,
                createdAt: requireEpochMs(metadata.createdAt),
                source: metadata.source,
                pageCount: metadata.pageCount,
                pageBox: metadata.pageBox,
                ocr: metadata.ocr,
                pages,
            },
        };
    } catch {
        return null;
    }
}

function parseManifestPageNumber(value: string) {
    const pageNumber = Number.parseInt(value, 10);
    return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function shouldPreserveExistingOcrManifest(
    manifest: IOcrIndexV3Manifest | null,
    workingCopyPath: string,
    pageCount: number,
    documentRevision: IDocumentRevisionInfo,
) {
    return !!manifest
        && manifest.pageCount === pageCount
        && manifest.documentRevision.token === documentRevision.token
        && resolve(manifest.source.pdfPath) === resolve(workingCopyPath);
}

function copyPreservedPageMappings(
    manifest: IOcrIndexV3Manifest | null,
    workingCopyPath: string,
    pageCount: number,
    ocrDir: string,
    documentRevision: IDocumentRevisionInfo,
) {
    if (!manifest || !shouldPreserveExistingOcrManifest(manifest, workingCopyPath, pageCount, documentRevision)) {
        return {};
    }

    const pages: Record<number, IOcrIndexV3Manifest['pages'][number]> = {};
    for (const [
        rawPageNumber,
        pageMapping,
    ] of Object.entries(manifest.pages)) {
        const pageNumber = parseManifestPageNumber(rawPageNumber);
        if (
            pageNumber !== null
            && pageNumber <= pageCount
            && typeof pageMapping.path === 'string'
            && pageMapping.path.length > 0
            && resolveManifestPagePath(ocrDir, pageMapping.path) !== null
        ) {
            pages[pageNumber] = {...pageMapping};
        }
    }

    return pages;
}

function createUniqueTempPath(targetPath: string) {
    return `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
}

async function statMtimeMs(filePath: string) {
    try {
        const fileStat = await stat(filePath);
        return typeof fileStat.mtimeMs === 'number' && Number.isFinite(fileStat.mtimeMs)
            ? fileStat.mtimeMs
            : undefined;
    } catch {
        return undefined;
    }
}

async function unlinkIfPresent(filePath: string) {
    try {
        await unlink(filePath);
    } catch {
        // Keep cleanup best-effort.
    }
}

async function renameIfPresent(sourcePath: string, targetPath: string) {
    try {
        await rename(sourcePath, targetPath);
    } catch {
        // Keep rollback best-effort.
    }
}

function assertValidOcrPageData(
    ocrPageData: readonly IOcrPageWithWords[],
    pageCount: number,
) {
    const seenPageNumbers = new Set<number>();
    for (const pageData of ocrPageData) {
        if (
            !Number.isSafeInteger(pageData.pageNumber)
            || pageData.pageNumber < 1
            || pageData.pageNumber > pageCount
        ) {
            throw new Error(`Invalid OCR page number ${pageData.pageNumber}`);
        }
        if (seenPageNumbers.has(pageData.pageNumber)) {
            throw new Error(`Duplicate OCR page number ${pageData.pageNumber}`);
        }
        seenPageNumbers.add(pageData.pageNumber);
    }
}

async function moveExistingFileAside(filePath: string) {
    const backupPath = createUniqueTempPath(`${filePath}.bak`);
    try {
        await rename(filePath, backupPath);
        return backupPath;
    } catch (error) {
        if (
            error
            && typeof error === 'object'
            && 'code' in error
            && error.code === 'ENOENT'
        ) {
            return null;
        }
        throw error;
    }
}

function buildOcrSearchText(page: Pick<IOcrPageWithWords, 'text' | 'words'>) {
    if (page.text.length > 0) {
        return page.text;
    }
    return page.words.length > 0
        ? buildOcrTextLayerIndexText(page.words)
        : page.text;
}

function resolveManifestPagePath(
    ocrDir: string,
    relativePath: unknown,
) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        return null;
    }

    try {
        return resolveCatalogPath(ocrDir, relativePath, {kind: 'legacy'});
    } catch {
        return null;
    }
}

function parseOcrPageTextPayload(payload: unknown) {
    const page = decodeOcrPage(payload, 'repair-legacy');
    if (!page) {
        return null;
    }
    return page.text || (page.words.length > 0 ? buildOcrTextLayerIndexText(page.words) : '');
}

async function readOcrPageSearchText(
    ocrDir: string,
    pageMapping: { path: string },
) {
    const pagePath = resolveManifestPagePath(ocrDir, pageMapping.path);
    if (!pagePath) {
        return null;
    }
    try {
        return parseOcrPageTextPayload(JSON.parse(await readFile(pagePath, 'utf-8')));
    } catch {
        return null;
    }
}

async function seedSearchSidecarTextsFromExistingCompactIndex(
    workingCopyPath: string,
    documentRevisionToken: TDocumentRevisionToken,
    pageCount: number,
    existingManifestMtimeMs: number | undefined,
) {
    const textsByPage = new Map<number, string>();
    const requiredTextSource = {
        kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
        version: OCR_TEXT_LAYER_INDEX_VERSION,
    };
    const loadOptions: NonNullable<Parameters<typeof loadCompactSearchIndex>[1]> = {
        documentRevision: documentRevisionToken,
        requiredTextSource,
    };
    if (existingManifestMtimeMs !== undefined) {
        loadOptions.minSourceMtimeMs = existingManifestMtimeMs;
    }
    const existingCompactIndex = await loadCompactSearchIndex(workingCopyPath, loadOptions);
    if (!existingCompactIndex || existingCompactIndex.pageCount !== pageCount) {
        return textsByPage;
    }

    for (const page of existingCompactIndex.pages) {
        if (page.pageNumber > 0 && page.pageNumber <= pageCount) {
            textsByPage.set(page.pageNumber, page.text);
        }
    }
    return textsByPage;
}

async function collectCompactSearchIndexPages(
    workingCopyPath: string,
    ocrDir: string,
    manifest: IOcrIndexV3Manifest,
    ocrPageData: IOcrPageWithWords[],
    existingManifestMtimeMs: number | undefined,
) {
    const manifestPageNumbers: number[] = [];
    for (const pageKey of Object.keys(manifest.pages)) {
        const pageNumber = parseManifestPageNumber(pageKey);
        if (pageNumber !== null && pageNumber <= manifest.pageCount) {
            manifestPageNumbers.push(pageNumber);
        }
    }
    manifestPageNumbers.sort((a, b) => a - b);

    const textsByPage = await seedSearchSidecarTextsFromExistingCompactIndex(
        workingCopyPath,
        manifest.documentRevision.token,
        manifest.pageCount,
        existingManifestMtimeMs,
    );
    for (const page of ocrPageData) {
        textsByPage.set(page.pageNumber, buildOcrSearchText(page));
    }

    for (const pageNumber of manifestPageNumbers) {
        if (textsByPage.has(pageNumber)) {
            continue;
        }
        const pageMapping = manifest.pages[pageNumber];
        if (!pageMapping) {
            continue;
        }
        const text = await readOcrPageSearchText(ocrDir, pageMapping);
        if (text !== null) {
            textsByPage.set(pageNumber, text);
        }
    }

    const pages: Array<{
        pageNumber: number;
        text: string;
    }> = [];
    for (const pageNumber of manifestPageNumbers) {
        const text = textsByPage.get(pageNumber);
        if (text !== undefined) {
            pages.push({
                pageNumber,
                text,
            });
        }
    }

    return pages.length === manifestPageNumbers.length
        ? pages
        : null;
}

async function writeCompactSearchIndexForOcr(
    workingCopyPath: string,
    ocrDir: string,
    manifest: IOcrIndexV3Manifest,
    ocrPageData: IOcrPageWithWords[],
    existingManifestMtimeMs: number | undefined,
    log: TWorkerLog,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    await assertWorkingCopyRevisionCurrent(workingCopyPath, manifest.documentRevision.token);
    const classification = await classifyXlargeSearchPathFromFile(
        workingCopyPath,
        manifest.pageCount,
    );
    if (classification.isXlarge) {
        const indexPath = getCompactSearchIndexPath(workingCopyPath);
        try {
            await rm(indexPath, {force: true});
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            log('warn', `Failed to invalidate xlarge OCR search sidecar: ${getErrorMessage(error)}`);
        }
        throwIfAborted(signal);
        log('debug', `Skipped eager compact OCR search sidecar for xlarge document ${workingCopyPath}`);
        return;
    }
    const pages = await collectCompactSearchIndexPages(
        workingCopyPath,
        ocrDir,
        manifest,
        ocrPageData,
        existingManifestMtimeMs,
    );
    if (!pages) {
        log('debug', `Skipped compact OCR search sidecar for ${workingCopyPath}: preserved OCR page text is incomplete`);
        return;
    }

    try {
        throwIfAborted(signal);
        await persistCompactSearchIndex(workingCopyPath, {
            documentRevision: manifest.documentRevision.token,
            pageCount: manifest.pageCount,
            pages: pages.map(page => ({
                ...page,
                pageNumber: requirePageNumber(page.pageNumber, manifest.pageCount),
            })),
            textSource: {
                kind: COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
                version: OCR_TEXT_LAYER_INDEX_VERSION,
            },
        }, signal);
        log('debug', `Wrote compact OCR search sidecar for ${workingCopyPath} with ${pages.length} pages`);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log('warn', `Failed to write compact OCR search sidecar: ${getErrorMessage(error)}`);
        throw error;
    }
}

export async function resolveSafeOcrIndexBasePath(
    indexPath: string,
    tempDirPath: string,
) {
    const normalizedPath = indexPath.trim();
    if (!normalizedPath) {
        throw new Error('OCR index path must not be empty');
    }

    const absoluteIndexPath = resolve(normalizedPath);
    const absoluteTempDir = resolve(tempDirPath);
    const tempBaseDirs = [absoluteTempDir];
    try {
        const canonicalTempDir = await realpath(absoluteTempDir);
        if (canonicalTempDir !== absoluteTempDir) {
            tempBaseDirs.push(canonicalTempDir);
        }
    } catch {
        // Keep the non-canonical temp directory as the fallback base.
    }

    if (!isPathInsideAnyBaseDir(tempBaseDirs, absoluteIndexPath)) {
        throw new Error('OCR index path is outside the allowed temp directory');
    }

    const indexStat = await lstat(absoluteIndexPath).catch(() => null);
    if (!indexStat) {
        throw new Error('OCR index path does not exist');
    }
    if (indexStat.isSymbolicLink()) {
        throw new Error('OCR index path cannot be a symbolic link');
    }

    const resolvedIndexPath = await realpath(absoluteIndexPath);
    if (!isPathInsideAnyBaseDir(tempBaseDirs, resolvedIndexPath)) {
        throw new Error('OCR index path resolves outside the allowed temp directory');
    }

    const resolvedParentDir = await realpath(dirname(resolvedIndexPath));
    const isInsideTempDir = isPathInsideAnyBaseDir(tempBaseDirs, resolvedParentDir) || tempBaseDirs.includes(resolvedParentDir);
    if (!isInsideTempDir) {
        throw new Error('OCR index path parent directory is outside the allowed temp directory');
    }

    return resolvedIndexPath;
}

export async function writeOcrIndexV3(
    workingCopyPath: string,
    documentRevision: IDocumentRevisionInfo,
    ocrPageData: IOcrPageWithWords[],
    pageCount: number,
    languages: string[],
    extractionDpi: number,
    log: TWorkerLog,
    signal?: AbortSignal,
    stagedResultPdfPath?: string,
) {
    throwIfAborted(signal);
    assertValidOcrPageData(ocrPageData, pageCount);
    const ocrDir = `${stagedResultPdfPath ?? workingCopyPath}.ocr`;
    if (stagedResultPdfPath) {
        await rm(ocrDir, {
            recursive: true,
            force: true,
        });
    }
    await mkdir(ocrDir, { recursive: true });
    const manifestPath = join(ocrDir, 'manifest.json');
    const existingResult = await readExistingOcrIndexV3Manifest(ocrDir);
    if (existingResult?.kind === 'streaming-required' && !stagedResultPdfPath) {
        await writeOcrIndexV4({
            catalogRoot: ocrDir,
            sourcePdfPath: workingCopyPath,
            documentRevision,
            pageCount,
            pageBatches: [ocrPageData],
            workingCopyPath,
            ...(signal === undefined ? {} : {signal}),
            log,
            extractionDpi,
        });
        log('debug', `Migrated large OCR v3 catalog to v4 before writing compatibility output for ${workingCopyPath}`);
        return;
    }
    const existingManifest = existingResult?.kind === 'manifest'
        ? existingResult.manifest
        : null;
    const existingManifestMtimeMs = existingManifest
        ? await statMtimeMs(manifestPath)
        : undefined;

    const pages = copyPreservedPageMappings(
        existingManifest,
        workingCopyPath,
        pageCount,
        ocrDir,
        documentRevision,
    );
    const manifest: IOcrIndexV3Manifest = {
        version: 3,
        documentRevision: {token: documentRevision.token},
        createdAt: createEpochMs(),
        source: { pdfPath: workingCopyPath },
        pageCount,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages,
            renderDpi: extractionDpi,
        },
        pages,
    };
    const generation = randomUUID();

    const tempPaths = new Set<string>();
    const backups: Array<{
        pagePath: string;
        backupPath: string;
    }> = [];
    const writtenPagePaths = new Set<string>();
    let manifestCommitted = false;
    let publishCommitted = false;
    let manifestBackupPath: string | null = null;

    try {
        await assertWorkingCopyRevisionCurrent(workingCopyPath, documentRevision.token);
        for (const pd of ocrPageData) {
            throwIfAborted(signal);
            const pageFile = `page-${String(pd.pageNumber).padStart(4, '0')}.json`;

            const pageData: IOcrIndexV3Page = {
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
                canonicalText: {
                    source: 'evb-ocr',
                    generation,
                    contentDigest: createHash('sha256').update(JSON.stringify({
                        pageNumber: pd.pageNumber,
                        text: pd.text,
                        words: pd.words,
                    })).digest('hex'),
                },
            };

            const pagePath = join(ocrDir, pageFile);
            const tempPath = createUniqueTempPath(pagePath);
            tempPaths.add(tempPath);
            await writeFile(tempPath, JSON.stringify(pageData), 'utf-8');
            throwIfAborted(signal);

            const backupPath = await moveExistingFileAside(pagePath);
            if (backupPath) {
                backups.push({
                    pagePath,
                    backupPath,
                });
            }
            await rename(tempPath, pagePath);
            tempPaths.delete(tempPath);
            writtenPagePaths.add(pagePath);

            pages[pd.pageNumber] = {
                path: pageFile,
                generation,
            };
        }

        throwIfAborted(signal);
        const tempManifestPath = createUniqueTempPath(manifestPath);
        tempPaths.add(tempManifestPath);
        await writeFile(tempManifestPath, JSON.stringify(manifest), 'utf-8');
        throwIfAborted(signal);
        await assertWorkingCopyRevisionCurrent(workingCopyPath, documentRevision.token);
        manifestBackupPath = await moveExistingFileAside(manifestPath);
        await rename(tempManifestPath, manifestPath);
        tempPaths.delete(tempManifestPath);
        manifestCommitted = true;
        if (!stagedResultPdfPath) {
            await writeCompactSearchIndexForOcr(
                workingCopyPath,
                ocrDir,
                manifest,
                ocrPageData,
                existingManifestMtimeMs,
                log,
                signal,
            );
        }
        publishCommitted = true;
    } catch (error) {
        await Promise.all(Array.from(tempPaths, path => unlinkIfPresent(path)));
        if (!publishCommitted) {
            if (manifestCommitted) {
                await unlinkIfPresent(manifestPath);
            }
            if (manifestBackupPath) {
                await renameIfPresent(manifestBackupPath, manifestPath);
            }
            await Promise.all(Array.from(writtenPagePaths, path => unlinkIfPresent(path)));
            await Promise.all(backups.map(backup => renameIfPresent(backup.backupPath, backup.pagePath)));
        }
        throw error;
    } finally {
        if (publishCommitted) {
            if (manifestBackupPath) {
                await unlinkIfPresent(manifestBackupPath);
            }
            await Promise.all(backups.map(backup => unlinkIfPresent(backup.backupPath)));
        }
    }

    log('debug', `Wrote OCR index v3 to ${ocrDir} with ${ocrPageData.length} pages`);
}
