import {
    open,
    stat,
} from 'fs/promises';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
    ISearchMatch,
    ISearchResponse,
} from '@electron/search/protocol';
import type { IResolvedSearchMatchOptions } from '@pdf-core/pdfSearchCore';
import { SEARCH_WIRE_CODEC } from '@contracts/search';
import {
    COMPACT_SEARCH_INDEX_MAX_BYTES,
    COMPACT_SEARCH_INDEX_MAX_PAGE_RECORDS,
    COMPACT_SEARCH_INDEX_MAX_TOTAL_TEXT_BYTES,
    COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION,
} from '@contracts/searchIndexSidecar';
import {
    EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@electron/config/constants';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { isRecord } from '@contracts/runtimeGuards';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    NATIVE_SEARCH_INDEX_MAGIC,
    NATIVE_SEARCH_INDEX_SCHEMA_VERSION,
    getNativeSearchIndexPath,
} from '@electron/search/nativeSearchIndex';
import {
    SEARCH_INDEX_SCHEMA_VERSION,
    loadSearchIndex,
    type IPdfSearchIndex,
} from '@electron/search/indexBuilder';
import { collectSearchMatchWords } from '@pdf-core/collectSearchMatchWords';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { createLogger } from '@electron/utils/createLogger';
import { tryRunPersistentNativeSearch } from '@electron/search/tryRunPersistentNativeSearch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const log = createLogger('native-search');
const HEADER_SIZE = 64;
const PAGE_RECORD_SIZE = 24;
const DEFAULT_NATIVE_SEARCH_SERVICE_IDLE_TIMEOUT_MS = 5 * 60_000;
const NATIVE_SEARCH_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_SEARCH_TIMEOUT_MS ?? '30000', 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 30_000;
    }
    return parsed;
})();
const NATIVE_SEARCH_MAX_STDOUT_BYTES = parseIntegerEnv(
    'EVB_PDF_SEARCH_MAX_STDOUT_BYTES',
    4 * 1024 * 1024,
    64 * 1024,
);

interface INativeSearchIndexMetadata {
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    pageRecordCount: number;
    streaming: boolean;
    pagesScanned?: number;
    partialCoverage?: boolean;
    truncatedCoverage?: boolean;
}

interface INativeSearchOptions extends IResolvedSearchMatchOptions {
    pdfPath: string;
    documentRevision: TDocumentRevisionToken;
    query: string;
    nativeServiceIdleTimeoutMs?: number;
    pageCount?: number;
    signal?: AbortSignal;
    /** Make native availability mandatory for the path-backed xlarge route. */
    strictXlarge?: boolean;
    /** Never hydrate the legacy JSON index for xlarge results. */
    skipLegacyGeometry?: boolean;
}

export interface INativeSearchResult {
    response: ISearchResponse;
    totalPages: number;
}

export type TXlargeNativeSearchFailureKind =
    | 'unsupported-options'
    | 'native-unavailable'
    | 'index-missing-or-stale'
    | 'native-failure'
    | 'invalid-response';

/** A typed failure for the xlarge path. It is intentionally never JS-fallbackable. */
export class XlargeNativeSearchCapabilityError extends Error {
    constructor(
        readonly kind: TXlargeNativeSearchFailureKind,
        message: string,
        options: {cause?: unknown} = {},
    ) {
        super(message);
        this.name = 'XlargeNativeSearchCapabilityError';
        if (options.cause !== undefined) {
            Object.defineProperty(this, 'cause', {
                configurable: true,
                enumerable: false,
                value: options.cause,
                writable: false,
            });
        }
    }
}

export function isXlargeNativeSearchCapabilityError(
    error: unknown,
): error is XlargeNativeSearchCapabilityError {
    return error instanceof XlargeNativeSearchCapabilityError;
}

function throwXlargeNativeSearchError(
    kind: TXlargeNativeSearchFailureKind,
    message: string,
    cause?: unknown,
): never {
    throw new XlargeNativeSearchCapabilityError(
        kind,
        message,
        cause === undefined ? {} : {cause},
    );
}

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-search.exe'
        : 'evb-pdf-search';
}

function isNativeSearchDisabled() {
    return process.env.EVB_PDF_SEARCH_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_SEARCH_ENABLE !== '1');
}

function resolveNativeSearchPath() {
    return resolveNativeToolPath({
        binaryName: getBinaryName(),
        crateName: 'pdf-search',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_SEARCH_PATH,
        isPackaged,
    });
}

export function isNativeSearchSupportedOptions(options: {
    query: string;
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}) {
    if (options.useRegex || options.wholeWord || options.query.length === 0) {
        return false;
    }

    return true;
}

async function statMtimeMs(filePath: string) {
    try {
        return (await stat(filePath)).mtimeMs;
    } catch {
        return null;
    }
}

async function getSearchSourceMtimeMs(pdfPath: string) {
    const [
        pdfMtimeMs,
        ocrManifestMtimeMs,
    ] = await Promise.all([
        statMtimeMs(pdfPath),
        statMtimeMs(`${pdfPath}.ocr/manifest.json`),
    ]);

    return Math.max(pdfMtimeMs ?? 0, ocrManifestMtimeMs ?? 0);
}

function bigintToSafeNumber(value: bigint) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : null;
}

async function loadNativeSearchIndexMetadata(
    indexPath: string,
    expectedRevision: TDocumentRevisionToken,
): Promise<INativeSearchIndexMetadata | null> {
    const file = await open(indexPath, 'r');
    try {
        const header = Buffer.alloc(HEADER_SIZE);
        const { bytesRead } = await file.read(header, 0, HEADER_SIZE, 0);
        if (bytesRead !== HEADER_SIZE) {
            return null;
        }

        const magic = header.toString('ascii', 0, 8);
        const fileStat = await file.stat();

        if (magic === COMPACT_SEARCH_INDEX_STREAMING_MAGIC) {
            const schemaVersion = header.readUInt32LE(8);
            const headerSize = header.readUInt32LE(12);
            const pageCount = header.readUInt32LE(16);
            const pageRecordCount = header.readUInt32LE(20);
            const flags = header.readUInt32LE(24);
            const revisionTokenByteLength = header.readUInt32LE(28);
            const revisionTokenByteOffset = bigintToSafeNumber(header.readBigUInt64LE(32));
            const directoryOffset = bigintToSafeNumber(header.readBigUInt64LE(40));
            const textDataOffset = bigintToSafeNumber(header.readBigUInt64LE(48));
            const footerOffset = bigintToSafeNumber(header.readBigUInt64LE(56));
            const directoryLength = BigInt(pageCount)
                * BigInt(COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE);
            const directoryEnd = bigintToSafeNumber(
                BigInt(directoryOffset ?? 0) + directoryLength,
            );
            const footerEnd = footerOffset === null
                ? null
                : footerOffset + COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE;
            const revisionTokenEnd = revisionTokenByteOffset === null
                ? null
                : revisionTokenByteOffset + revisionTokenByteLength;
            const totalTextBytes = footerOffset === null || textDataOffset === null
                ? null
                : footerOffset - textDataOffset;
            const knownFlags = COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE
                | COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE
                | COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE;
            if (
                schemaVersion !== COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION
                || headerSize !== COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE
                || pageCount <= 0
                || pageRecordCount > pageCount
                || (flags & COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE) === 0
                || (flags & ~knownFlags) !== 0
                || revisionTokenByteLength <= 0
                || revisionTokenByteLength > 8_192
                || revisionTokenByteOffset === null
                || directoryOffset === null
                || textDataOffset === null
                || footerOffset === null
                || directoryEnd === null
                || footerEnd === null
                || revisionTokenEnd === null
                || totalTextBytes === null
                || !Number.isSafeInteger(revisionTokenEnd)
                || !Number.isSafeInteger(footerEnd)
                || !Number.isSafeInteger(totalTextBytes)
                || totalTextBytes < 0
                || revisionTokenByteOffset < COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE
                || revisionTokenEnd > directoryOffset
                || textDataOffset !== directoryEnd
                || footerOffset < textDataOffset
                || footerEnd !== fileStat.size
                || !Number.isSafeInteger(fileStat.size)
                || fileStat.size < 0
            ) {
                return null;
            }

            const footer = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE);
            const {bytesRead: footerBytesRead} = await file.read(
                footer,
                0,
                COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE,
                footerOffset,
            );
            if (
                footerBytesRead !== COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE
                || footer.toString('ascii', 0, 8) !== COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC
                || footer.readUInt32LE(8) !== COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION
                || footer.readUInt32LE(12) !== COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE
                || footer.readUInt32LE(16) !== flags
                || footer.readUInt32LE(24) !== pageRecordCount
                || footer.readBigUInt64LE(32) !== BigInt(totalTextBytes)
                || footer.readBigUInt64LE(40) !== BigInt(fileStat.size)
                || footer.readBigUInt64LE(48) !== directoryLength
            ) {
                return null;
            }
            const pagesScannedBigInt = footer.readBigUInt64LE(56);
            const pagesScanned = bigintToSafeNumber(pagesScannedBigInt);
            if (
                pagesScanned === null
                || pagesScanned > pageCount
                || (pagesScanned < pageCount
                    && (flags & COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE) === 0)
            ) {
                return null;
            }

            const revisionBuffer = Buffer.alloc(revisionTokenByteLength);
            const {bytesRead: revisionBytesRead} = await file.read(
                revisionBuffer,
                0,
                revisionTokenByteLength,
                revisionTokenByteOffset,
            );
            if (revisionBytesRead !== revisionTokenByteLength) {
                return null;
            }
            const documentRevision = parseDocumentRevisionToken(revisionBuffer.toString('utf8'));
            if (documentRevision === null || documentRevision !== expectedRevision) {
                return null;
            }
            const partialCoverage = (flags & COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE) !== 0;
            const truncatedCoverage = (flags & COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE) !== 0;
            return {
                documentRevision,
                pageCount,
                pageRecordCount,
                streaming: true,
                pagesScanned,
                partialCoverage,
                truncatedCoverage,
            };
        }

        if (magic !== NATIVE_SEARCH_INDEX_MAGIC) {
            return null;
        }

        const schemaVersion = header.readUInt32LE(8);
        if (schemaVersion !== NATIVE_SEARCH_INDEX_SCHEMA_VERSION) {
            return null;
        }

        const headerSize = header.readUInt32LE(12);
        if (headerSize !== HEADER_SIZE) {
            return null;
        }
        const pageCount = header.readUInt32LE(16);
        const pageRecordCount = header.readUInt32LE(20);
        const revisionTokenByteLength = header.readUInt32LE(28);
        const revisionTokenByteOffset = bigintToSafeNumber(header.readBigUInt64LE(32));
        const pageTableOffset = bigintToSafeNumber(header.readBigUInt64LE(40));
        const textDataOffset = bigintToSafeNumber(header.readBigUInt64LE(48));
        if (
            revisionTokenByteOffset === null
            || pageTableOffset === null
            || textDataOffset === null
            || revisionTokenByteLength <= 0
        ) {
            return null;
        }
        const revisionTokenEnd = revisionTokenByteOffset + revisionTokenByteLength;
        const minimumSize = pageTableOffset + pageRecordCount * PAGE_RECORD_SIZE;
        const totalTextBytes = fileStat.size - textDataOffset;
        if (
            revisionTokenByteOffset < HEADER_SIZE
            || revisionTokenEnd > pageTableOffset
            || pageRecordCount > COMPACT_SEARCH_INDEX_MAX_PAGE_RECORDS
            || textDataOffset < minimumSize
            || fileStat.size < textDataOffset
            || fileStat.size > COMPACT_SEARCH_INDEX_MAX_BYTES
            || totalTextBytes > COMPACT_SEARCH_INDEX_MAX_TOTAL_TEXT_BYTES
        ) {
            return null;
        }
        const revisionBuffer = Buffer.alloc(revisionTokenByteLength);
        const { bytesRead: revisionBytesRead } = await file.read(
            revisionBuffer,
            0,
            revisionTokenByteLength,
            revisionTokenByteOffset,
        );
        if (revisionBytesRead !== revisionTokenByteLength) {
            return null;
        }
        const documentRevision = parseDocumentRevisionToken(revisionBuffer.toString('utf8'));
        if (documentRevision === null || documentRevision !== expectedRevision) {
            return null;
        }

        return {
            documentRevision,
            pageCount,
            pageRecordCount,
            streaming: false,
        };
    } finally {
        await file.close();
    }
}

async function isNativeSearchIndexFresh(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
    expectedPageCount?: number,
    requireStreaming = false,
) {
    const indexPath = getNativeSearchIndexPath(pdfPath);
    const [
        nativeMtimeMs,
        sourceMtimeMs,
    ] = await Promise.all([
        statMtimeMs(indexPath),
        getSearchSourceMtimeMs(pdfPath),
    ]);
    if (nativeMtimeMs === null || sourceMtimeMs > nativeMtimeMs) {
        return null;
    }

    const metadata = await loadNativeSearchIndexMetadata(indexPath, documentRevision);
    if (!metadata) {
        return null;
    }

    if (requireStreaming && !metadata.streaming) {
        return null;
    }

    if (metadata.partialCoverage || metadata.truncatedCoverage) {
        log.debug(`Native search skipped: sidecar covers only part of ${pdfPath}`);
        return null;
    }

    if (
        typeof expectedPageCount === 'number'
        && expectedPageCount > 0
        && metadata.pageCount < expectedPageCount
    ) {
        return null;
    }

    return {
        indexPath,
        metadata,
    };
}

function parseFiniteInteger(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function parseNativeSearchResponse(value: unknown): INativeSearchResult | null {
    if (!isRecord(value) || !Array.isArray(value.results) || typeof value.truncated !== 'boolean') {
        return null;
    }

    const pageCount = parseFiniteInteger(value.pageCount);
    if (pageCount === null) {
        return null;
    }

    const results: ISearchMatch[] = [];
    for (const result of value.results) {
        const parsedResult = SEARCH_WIRE_CODEC.decodeResult(result, pageCount);
        if (!parsedResult) {
            return null;
        }
        results.push(parsedResult);
    }

    return {
        response: {
            results,
            truncated: value.truncated,
        },
        totalPages: pageCount,
    };
}

function createNativeSearchArgs(indexPath: string, options: INativeSearchOptions) {
    const args = [
        'search',
        '--index',
        indexPath,
        '--query',
        options.query,
        '--document-revision',
        options.documentRevision,
        '--limit',
        String(SEARCH_RESULT_LIMIT),
        '--context',
        String(EXCERPT_CONTEXT_CHARS),
    ];
    if (options.matchCase) {
        args.push('--match-case');
    }
    if (options.pageCount !== undefined) {
        args.push('--page-count', String(options.pageCount));
    }
    return args;
}

function hasSearchIndexGeometry(index: IPdfSearchIndex | null): index is IPdfSearchIndex {
    if (!index || index.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
        return false;
    }

    return index.pages.some(page => (
        Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && Number.isFinite(page.pageWidth)
        && page.pageWidth > 0
        && typeof page.pageHeight === 'number'
        && Number.isFinite(page.pageHeight)
        && page.pageHeight > 0
    ));
}

function attachGeometryToNativeResponse(
    nativeResult: INativeSearchResult,
    searchIndex: IPdfSearchIndex,
) {
    const pagesByNumber = new Map(searchIndex.pages.map(page => [
        page.pageNumber,
        page,
    ]));

    return {
        ...nativeResult,
        response: {
            ...nativeResult.response,
            results: nativeResult.response.results.map((result) => {
                const page = pagesByNumber.get(Number(result.pageNumber));
                if (!page) {
                    return result;
                }

                const words = collectSearchMatchWords(page, result.startOffset, result.endOffset);
                if (!words) {
                    return result;
                }

                return {
                    ...result,
                    words,
                    ...(page.pageWidth !== undefined ? { pageWidth: page.pageWidth } : {}),
                    ...(page.pageHeight !== undefined ? { pageHeight: page.pageHeight } : {}),
                    ...(page.rotation !== undefined ? { rotation: page.rotation } : {}),
                };
            }),
        },
    };
}

export async function tryRunNativeSearch(options: INativeSearchOptions): Promise<INativeSearchResult | null> {
    const strictXlarge = options.strictXlarge === true;
    if (isNativeSearchDisabled()) {
        if (strictXlarge) {
            throwXlargeNativeSearchError(
                'native-unavailable',
                'Native search is disabled for an xlarge document',
            );
        }
        log.debug('Native search skipped: disabled or unsupported options');
        return null;
    }

    if (!isNativeSearchSupportedOptions(options)) {
        if (strictXlarge) {
            throwXlargeNativeSearchError(
                'unsupported-options',
                'Native search does not support the requested xlarge search options',
            );
        }
        log.debug('Native search skipped: disabled or unsupported options');
        return null;
    }

    const binaryPath = resolveNativeSearchPath();
    if (!binaryPath) {
        if (strictXlarge) {
            throwXlargeNativeSearchError(
                'native-unavailable',
                'The native search binary is unavailable for an xlarge document',
            );
        }
        log.debug('Native search skipped: evb-pdf-search binary unavailable');
        return null;
    }

    let freshIndex: Awaited<ReturnType<typeof isNativeSearchIndexFresh>>;
    try {
        freshIndex = await isNativeSearchIndexFresh(
            options.pdfPath,
            options.documentRevision,
            options.pageCount,
            strictXlarge,
        );
    } catch (error) {
        if (strictXlarge) {
            throwXlargeNativeSearchError(
                'native-failure',
                `Could not inspect the xlarge search sidecar: ${error instanceof Error ? error.message : String(error)}`,
                error,
            );
        }
        throw error;
    }
    if (!freshIndex) {
        if (strictXlarge) {
            throwXlargeNativeSearchError(
                'index-missing-or-stale',
                'The xlarge search sidecar is missing, stale, or not streaming',
            );
        }
        log.debug(`Native search skipped: missing or stale sidecar for ${options.pdfPath}`);
        return null;
    }

    const startedAt = Date.now();
    const commandOptions: Parameters<typeof runNativeToolCommand>[2] = {
        timeoutMs: NATIVE_SEARCH_TIMEOUT_MS,
        maxStdoutBytes: NATIVE_SEARCH_MAX_STDOUT_BYTES,
        rejectOnStdoutTruncation: true,
        commandLabel: 'evb-pdf-search(search)',
    };
    if (options.signal !== undefined) {
        commandOptions.signal = options.signal;
    }

    let parsed: unknown = null;
    try {
        parsed = await tryRunPersistentNativeSearch(binaryPath, {
            contextChars: EXCERPT_CONTEXT_CHARS,
            documentRevision: options.documentRevision,
            indexPath: freshIndex.indexPath,
            limit: SEARCH_RESULT_LIMIT,
            matchCase: options.matchCase,
            ...(options.pageCount === undefined ? {} : {pageCount: options.pageCount}),
            query: options.query,
        }, {
            ...(options.signal === undefined ? {} : {signal: options.signal}),
            idleTimeoutMs: options.nativeServiceIdleTimeoutMs
                ?? DEFAULT_NATIVE_SEARCH_SERVICE_IDLE_TIMEOUT_MS,
            timeoutMs: NATIVE_SEARCH_TIMEOUT_MS,
        });
    } catch (error) {
        log.warn(`Persistent native search failed; using one-shot fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null) {
        try {
            const result = await runNativeToolCommand(
                binaryPath,
                createNativeSearchArgs(freshIndex.indexPath, options),
                commandOptions,
            );
            parsed = JSON.parse(result.stdout ?? '');
        } catch (error) {
            if (strictXlarge) {
                throwXlargeNativeSearchError(
                    'native-failure',
                    `Native xlarge search failed: ${error instanceof Error ? error.message : String(error)}`,
                    error,
                );
            }
            throw error;
        }
    }
    const nativeResult = parseNativeSearchResponse(parsed);
    if (!nativeResult) {
        if (strictXlarge) {
            throwXlargeNativeSearchError(
                'invalid-response',
                'Native xlarge search returned an invalid response',
            );
        }
        return null;
    }
    log.debug(
        `Native search completed for ${options.pdfPath} in ${Math.max(0, Date.now() - startedAt)}ms `
        + `(results=${nativeResult.response.results.length}, totalPages=${nativeResult.totalPages})`,
    );
    if (nativeResult.response.results.length === 0) {
        return nativeResult;
    }

    if (options.skipLegacyGeometry || strictXlarge) {
        return nativeResult;
    }

    const searchIndex = await loadSearchIndex(options.pdfPath, options.documentRevision);
    return hasSearchIndexGeometry(searchIndex)
        ? attachGeometryToNativeResponse(nativeResult, searchIndex)
        : nativeResult;
}
