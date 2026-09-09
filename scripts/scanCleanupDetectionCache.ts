import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    extname,
    join,
    resolve,
} from 'node:path';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {createFileBackedScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/fileBackedResultStore';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    DETECTION_DPI,
    PREVIEW_DPI,
} from '@evb/scan-cleanup/core/detection';

export const SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION = 2 as const;
export const DEFAULT_SCAN_CLEANUP_DETECTION_CACHE_PATH = '.devkit/tmp/detection-cache';

/**
 * Document-scale detection caches use a tiny descriptor and an adjacent
 * JSONL sidecar. Version 2 remains the explicit small-document compatibility
 * format because its `results` array is part of the existing script API.
 */
const SCAN_CLEANUP_DETECTION_CACHE_STREAMING_FORMAT_VERSION = 3 as const;
const STREAMING_CACHE_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const STREAMING_CACHE_DESCRIPTOR_MAX_BYTES = 1024 * 1024;
const LEGACY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const STREAMING_CACHE_RECORDS_SUFFIX = '.jsonl';

const DETECTION_ALGORITHM_VERSION = 1 as const;
// Detection intentionally enumerates every source page; --pages is consumed
// only by the subsequent conversion pipeline and therefore is not a key input.
const DETECTION_SCOPE = 'all-source-pages' as const;

export interface IScanCleanupDetectionCacheKey {
    key: string;
    sourceSha256: string;
}

export interface IScanCleanupDetectionCacheDetectorPaths {
    pdftoppmBinaryPath: string;
    scanCleanupBinaryPath: string;
}

export interface IScanCleanupDetectionRunResult {
    /** Small-document compatibility snapshot. Large runs leave this empty. */
    results: IScanCleanupDetectionResult[];
    /** Authoritative bounded result sidecar for document-scale runs. */
    resultStore?: IScanCleanupDetectionResultStore;
}

export interface IScanCleanupDetectionCacheRunRequest {
    cachePath?: string | undefined;
    detect: () => Promise<IScanCleanupDetectionRunResult>;
    key?: IScanCleanupDetectionCacheKey | undefined;
    log?: (message: string) => void;
    refresh: boolean;
}

interface IScanCleanupDetectionCacheFile {
    cacheFormatVersion: typeof SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION;
    detectionScope: typeof DETECTION_SCOPE;
    key: string;
    results: IScanCleanupDetectionResult[];
    sourceSha256: string;
}

interface IScanCleanupDetectionCacheStreamingFile {
    cacheFormatVersion: typeof SCAN_CLEANUP_DETECTION_CACHE_STREAMING_FORMAT_VERSION;
    detectionScope: typeof DETECTION_SCOPE;
    key: string;
    pageCount: number;
    resultCount: number;
    sourceSha256: string;
}

interface IScanCleanupDetectionCacheNativeBinaryHash {
    fingerprint: string;
    sha256: Promise<string>;
}

const nativeBinaryHashes = new Map<string, IScanCleanupDetectionCacheNativeBinaryHash>();
const pdftoppmVersions = new Map<string, Promise<string>>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(item => isJsonValue(item));
    }
    return isRecord(value) && Object.values(value).every(item => isJsonValue(item));
}

function isLayoutClassification(value: unknown): value is IScanCleanupDetectionResult['classification'] {
    return value === 'single-uncut-page'
        || value === 'two-page-spread'
        || value === 'page-with-offcut';
}

function isDetectionResult(value: unknown): value is IScanCleanupDetectionResult {
    if (!isRecord(value) || !isJsonValue(value)) {
        return false;
    }
    const pageNumber = value.pageNumber;
    return typeof pageNumber === 'number'
        && Number.isSafeInteger(pageNumber)
        && pageNumber >= 1
        && isLayoutClassification(value.classification)
        && typeof value.confidence === 'number'
        && Number.isFinite(value.confidence)
        && (value.cutterXPx === null || (
            typeof value.cutterXPx === 'number' && Number.isFinite(value.cutterXPx)
        ))
        && isLayoutClassification(value.tier1Verdict)
        && typeof value.reconciled === 'boolean'
        && typeof value.clusterAgreement === 'number'
        && Number.isFinite(value.clusterAgreement)
        && (value.documentPrior === null || isRecord(value.documentPrior))
        && (value.revision === undefined || Number.isSafeInteger(value.revision));
}

function isCacheFile(value: unknown, expectedKey: IScanCleanupDetectionCacheKey): value is IScanCleanupDetectionCacheFile {
    if (!isRecord(value) || !isJsonValue(value)) {
        return false;
    }
    const results = value.results;
    if (
        value.cacheFormatVersion !== SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION
        || value.detectionScope !== DETECTION_SCOPE
        || value.key !== expectedKey.key
        || value.sourceSha256 !== expectedKey.sourceSha256
        || !Array.isArray(results)
        || results.length === 0
        || !results.every(result => isDetectionResult(result))
    ) {
        return false;
    }
    return results.every((result, index) => result.pageNumber === index + 1);
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(item => canonicalize(item));
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [
                    key,
                    canonicalize(value[key]),
                ]),
        );
    }
    return value;
}

async function hashFile(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
            hash.update(chunk);
            continue;
        }
        throw new Error(`File stream produced an unsupported chunk: ${path}`);
    }
    return hash.digest('hex');
}

async function resolveAbsoluteToolPath(path: string) {
    return realpath(resolve(path));
}

async function hashNativeBinary(path: string) {
    const binaryStats = await stat(path, {bigint: true});
    if (!binaryStats.isFile()) {
        throw new Error(`Scan-cleanup detector is not a file: ${path}`);
    }
    const fingerprint = [
        binaryStats.dev,
        binaryStats.ino,
        binaryStats.size,
        binaryStats.mtimeNs,
        binaryStats.ctimeNs,
    ].join(':');
    const cached = nativeBinaryHashes.get(path);
    if (cached?.fingerprint === fingerprint) {
        return cached.sha256;
    }
    const sha256 = hashFile(path);
    nativeBinaryHashes.set(path, {
        fingerprint,
        sha256,
    });
    try {
        return await sha256;
    } catch (error: unknown) {
        if (nativeBinaryHashes.get(path)?.sha256 === sha256) {
            nativeBinaryHashes.delete(path);
        }
        throw error;
    }
}

function readPdftoppmVersion(path: string) {
    return new Promise<string>((resolvePromise, reject) => {
        execFile(path, ['-v'], {encoding: 'utf8'}, (error, stdout, stderr) => {
            if (error !== null) {
                reject(new Error(
                    `Could not read pdftoppm identity from ${path}: ${error.message}`,
                    {cause: error},
                ));
                return;
            }
            const version = `${stdout}${stderr}`.trim();
            if (version === '') {
                reject(new Error(`pdftoppm returned an empty version string: ${path}`));
                return;
            }
            resolvePromise(version);
        });
    });
}

function getPdftoppmVersion(path: string) {
    const cached = pdftoppmVersions.get(path);
    if (cached !== undefined) {
        return cached;
    }
    const version = readPdftoppmVersion(path);
    pdftoppmVersions.set(path, version);
    void version.catch(() => {
        if (pdftoppmVersions.get(path) === version) {
            pdftoppmVersions.delete(path);
        }
    });
    return version;
}

function resolveCacheEntryPath(cachePath: string, key: IScanCleanupDetectionCacheKey) {
    return extname(cachePath).toLowerCase() === '.json'
        ? cachePath
        : join(cachePath, `${key.key}.json`);
}

function resolveStreamingCacheRecordsPath(entryPath: string) {
    return `${entryPath}${STREAMING_CACHE_RECORDS_SUFFIX}`;
}

function isStreamingCacheFile(
    value: unknown,
    expectedKey: IScanCleanupDetectionCacheKey,
): value is IScanCleanupDetectionCacheStreamingFile {
    if (!isRecord(value) || !isJsonValue(value)) {
        return false;
    }
    const pageCount = value.pageCount;
    const resultCount = value.resultCount;
    return value.cacheFormatVersion === SCAN_CLEANUP_DETECTION_CACHE_STREAMING_FORMAT_VERSION
        && value.detectionScope === DETECTION_SCOPE
        && value.key === expectedKey.key
        && value.sourceSha256 === expectedKey.sourceSha256
        && typeof pageCount === 'number'
        && Number.isSafeInteger(pageCount)
        && pageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        && typeof resultCount === 'number'
        && Number.isSafeInteger(resultCount)
        && resultCount === pageCount;
}

async function readStreamingCacheDescriptor(
    entryPath: string,
    key: IScanCleanupDetectionCacheKey,
): Promise<IScanCleanupDetectionCacheStreamingFile | null> {
    let entryStats: Awaited<ReturnType<typeof stat>>;
    try {
        entryStats = await stat(entryPath);
    } catch (error: unknown) {
        if (isRecord(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    if (!entryStats.isFile() || entryStats.size > STREAMING_CACHE_DESCRIPTOR_MAX_BYTES) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(entryPath, 'utf8')) as unknown;
    } catch {
        return null;
    }
    return isStreamingCacheFile(parsed, key) ? parsed : null;
}

async function *readStreamingCacheRecords(path: string): AsyncGenerator<IScanCleanupDetectionResult> {
    const stream = createReadStream(path, {
        encoding: 'utf8',
        highWaterMark: 64 * 1024,
    });
    let pending = '';
    let pendingBytes = 0;
    const parseLine = (line: string) => {
        const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (normalized === '') {
            return undefined;
        }
        if (Buffer.byteLength(normalized, 'utf8') > STREAMING_CACHE_RECORD_MAX_BYTES) {
            throw new Error('Scan cleanup detection cache contains an oversized result record');
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(normalized) as unknown;
        } catch (error) {
            throw new Error(`Scan cleanup detection cache contains invalid JSON: ${String(error)}`);
        }
        if (!isDetectionResult(parsed)) {
            throw new Error('Scan cleanup detection cache contains an invalid result record');
        }
        return parsed;
    };
    try {
        for await (const chunk of stream) {
            if (typeof chunk !== 'string') {
                throw new Error('Scan cleanup detection cache stream produced a non-text chunk');
            }
            pending += chunk;
            pendingBytes += Buffer.byteLength(chunk, 'utf8');
            if (pendingBytes > STREAMING_CACHE_RECORD_MAX_BYTES) {
                throw new Error('Scan cleanup detection cache contains an unterminated or oversized result record');
            }
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
                const parsed = parseLine(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
                pendingBytes = Buffer.byteLength(pending, 'utf8');
                if (parsed !== undefined) yield parsed;
                newline = pending.indexOf('\n');
            }
        }
        const parsed = parseLine(pending);
        if (parsed !== undefined) yield parsed;
    } finally {
        stream.destroy();
    }
}

/**
 * Open a document-scale cache without parsing its records into one array.
 * The temporary fixed-width index is removed by the returned store's close
 * method, while the cache's JSONL file remains reusable by later runs.
 */
export async function openScanCleanupDetectionCacheStore(
    cachePath: string,
    key: IScanCleanupDetectionCacheKey,
): Promise<IScanCleanupDetectionResultStore | null> {
    const entryPath = resolveCacheEntryPath(cachePath, key);
    const descriptor = await readStreamingCacheDescriptor(entryPath, key);
    if (descriptor === null) {
        return null;
    }
    const recordsPath = resolveStreamingCacheRecordsPath(entryPath);
    let store: IScanCleanupDetectionResultStore | null = null;
    try {
        store = await createFileBackedScanCleanupDetectionResultStore({
            pageCount: descriptor.pageCount,
            rootDir: dirname(entryPath),
        });
        let expectedPageNumber = 1;
        for await (const result of readStreamingCacheRecords(recordsPath)) {
            if (result.pageNumber !== expectedPageNumber) {
                throw new Error(
                    `Scan cleanup detection cache record ${String(result.pageNumber)} is out of order`,
                );
            }
            await store.append(result);
            expectedPageNumber += 1;
        }
        if (expectedPageNumber !== descriptor.pageCount + 1 || store.resultCount !== descriptor.resultCount) {
            throw new Error('Scan cleanup detection cache sidecar is incomplete');
        }
        return store;
    } catch {
        await store?.close();
        return null;
    }
}

export async function createScanCleanupDetectionCacheKey(
    sourcePdfPath: string,
    options: IScanCleanupOptions,
    detectorPaths: IScanCleanupDetectionCacheDetectorPaths,
): Promise<IScanCleanupDetectionCacheKey> {
    const [
        sourceSha256,
        pdftoppmBinaryPath,
        scanCleanupBinaryPath,
    ] = await Promise.all([
        hashFile(sourcePdfPath),
        resolveAbsoluteToolPath(detectorPaths.pdftoppmBinaryPath),
        resolveAbsoluteToolPath(detectorPaths.scanCleanupBinaryPath),
    ]);
    const [
        pdftoppmVersion,
        scanCleanupBinarySha256,
    ] = await Promise.all([
        getPdftoppmVersion(pdftoppmBinaryPath),
        hashNativeBinary(scanCleanupBinaryPath),
    ]);
    const keyMaterial = canonicalize({
        architecture: process.arch,
        cacheFormatVersion: SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION,
        detectorIdentity: {
            pdftoppm: {
                absolutePath: pdftoppmBinaryPath,
                version: pdftoppmVersion,
            },
            scanCleanup: {sha256: scanCleanupBinarySha256},
        },
        detectionAlgorithmVersion: DETECTION_ALGORITHM_VERSION,
        detectionScope: DETECTION_SCOPE,
        analysisDpi: DETECTION_DPI,
        nativeProtocolVersion: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        options,
        previewDpi: PREVIEW_DPI,
        sourceSha256,
        platform: process.platform,
    });
    const keyJson = JSON.stringify(keyMaterial);
    return {
        key: createHash('sha256').update(keyJson).digest('hex'),
        sourceSha256,
    };
}

export async function readScanCleanupDetectionCache(
    cachePath: string,
    key: IScanCleanupDetectionCacheKey,
): Promise<IScanCleanupDetectionResult[] | null> {
    const entryPath = resolveCacheEntryPath(cachePath, key);
    // A streaming descriptor is intentionally not adapted back into one array.
    // Callers that need document-scale results must use the store API below.
    if (await readStreamingCacheDescriptor(entryPath, key) !== null) {
        return null;
    }
    let entryStats: Awaited<ReturnType<typeof stat>>;
    try {
        entryStats = await stat(entryPath);
    } catch (error: unknown) {
        if (isRecord(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    // The JSON-array format is a compatibility adapter. Do not let an old
    // large cache force a whole-document read into the production path.
    if (!entryStats.isFile() || entryStats.size > LEGACY_CACHE_MAX_BYTES) {
        return null;
    }
    let serialized: string;
    try {
        serialized = await readFile(entryPath, 'utf8');
    } catch (error: unknown) {
        if (isRecord(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized) as unknown;
    } catch {
        return null;
    }
    return isCacheFile(parsed, key) ? parsed.results : null;
}

export async function writeScanCleanupDetectionCache(
    cachePath: string,
    key: IScanCleanupDetectionCacheKey,
    results: readonly IScanCleanupDetectionResult[],
) {
    const entryPath = resolveCacheEntryPath(cachePath, key);
    await mkdir(dirname(entryPath), {recursive: true});
    const cacheFile: IScanCleanupDetectionCacheFile = {
        cacheFormatVersion: SCAN_CLEANUP_DETECTION_CACHE_FORMAT_VERSION,
        detectionScope: DETECTION_SCOPE,
        key: key.key,
        results: [...results],
        sourceSha256: key.sourceSha256,
    };
    const temporaryPath = `${entryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, JSON.stringify(cacheFile, null, 2) + '\n', 'utf8');
        await rename(temporaryPath, entryPath);
    } finally {
        await rm(temporaryPath, {force: true});
    }
}

/**
 * Persist the authoritative document-scale result store as a JSONL sidecar.
 * Every callback receives at most the store's configured read window, and the
 * descriptor is published last so an interrupted write cannot look complete.
 */
export async function writeScanCleanupDetectionCacheStore(
    cachePath: string,
    key: IScanCleanupDetectionCacheKey,
    store: IScanCleanupDetectionResultStore,
) {
    if (store.pageCount <= SCAN_CLEANUP_STREAMING_BATCH_PAGES) {
        throw new RangeError('Streaming detection cache requires an xlarge result store');
    }
    const entryPath = resolveCacheEntryPath(cachePath, key);
    const recordsPath = resolveStreamingCacheRecordsPath(entryPath);
    await mkdir(dirname(entryPath), {recursive: true});
    const temporaryRecordsPath = `${recordsPath}.${process.pid}.${randomUUID()}.tmp`;
    const temporaryEntryPath = `${entryPath}.${process.pid}.${randomUUID()}.tmp`;
    let recordsHandle: Awaited<ReturnType<typeof open>> | null = null;
    let recordsPublished = false;
    try {
        recordsHandle = await open(temporaryRecordsPath, 'w');
        let expectedPageNumber = 1;
        let resultCount = 0;
        await store.forEachChunk(async records => {
            for (const result of records) {
                if (result.pageNumber !== expectedPageNumber) {
                    throw new Error(
                        `Scan cleanup detection result store returned page ${String(result.pageNumber)} where page ${String(expectedPageNumber)} was expected`,
                    );
                }
                const line = `${JSON.stringify(result)}\n`;
                if (Buffer.byteLength(line, 'utf8') > STREAMING_CACHE_RECORD_MAX_BYTES) {
                    throw new RangeError('Scan cleanup detection cache result exceeds the sidecar record limit');
                }
                await recordsHandle!.write(line);
                expectedPageNumber += 1;
                resultCount += 1;
            }
        });
        if (expectedPageNumber !== store.pageCount + 1 || resultCount !== store.resultCount) {
            throw new Error('Scan cleanup detection result store is incomplete');
        }
        await recordsHandle.close();
        recordsHandle = null;
        const descriptor: IScanCleanupDetectionCacheStreamingFile = {
            cacheFormatVersion: SCAN_CLEANUP_DETECTION_CACHE_STREAMING_FORMAT_VERSION,
            detectionScope: DETECTION_SCOPE,
            key: key.key,
            pageCount: store.pageCount,
            resultCount: store.resultCount,
            sourceSha256: key.sourceSha256,
        };
        await writeFile(temporaryEntryPath, `${JSON.stringify(descriptor)}\n`, 'utf8');
        await rename(temporaryRecordsPath, recordsPath);
        recordsPublished = true;
        await rename(temporaryEntryPath, entryPath);
    } finally {
        await recordsHandle?.close();
        if (!recordsPublished) await rm(temporaryRecordsPath, {force: true});
        await rm(temporaryEntryPath, {force: true});
    }
}

export async function runScanCleanupDetectionWithCache({
    cachePath,
    detect,
    key,
    log = () => undefined,
    refresh,
}: IScanCleanupDetectionCacheRunRequest) {
    if (cachePath !== undefined && key !== undefined && !refresh) {
        const cachedStore = await openScanCleanupDetectionCacheStore(cachePath, key);
        if (cachedStore !== null) {
            log(`detection cache hit ${key.key} (streaming sidecar)`);
            return {
                resultStore: cachedStore,
                results: [],
            };
        }
        const cachedResults = await readScanCleanupDetectionCache(cachePath, key);
        if (cachedResults !== null) {
            log(`detection cache hit ${key.key}`);
            return {results: cachedResults};
        }
        log(`detection cache miss ${key.key}`);
    }
    const result = await detect();
    if (cachePath !== undefined && key !== undefined) {
        if (
            result.resultStore !== undefined
            && result.resultStore.pageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES
        ) {
            await writeScanCleanupDetectionCacheStore(cachePath, key, result.resultStore);
        } else {
            await writeScanCleanupDetectionCache(cachePath, key, result.results);
        }
        log(`detection cache wrote ${key.key}`);
    }
    return result;
}
