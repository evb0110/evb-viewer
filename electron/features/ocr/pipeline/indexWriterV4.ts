import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import type {Dirent} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {isOcrWord} from '@contracts/shared';
import {createIsoTimestamp} from '@contracts/timestamps';
import type {
    IPageIdentityDelta,
    IPageIdentityRangeInsert,
    IPageIdentityRangeMapping,
    IPageIdentityRangeTouch,
    TPageIdentityRangeOperation,
} from '@contracts/electronApiPageOps';
import {getPageIdentityDeltaNextPageCount} from '@contracts/electronApiPageOps';
import {getPageIdentityRangeOperations} from '@electron/file-access/pageIdentityDelta';
import type {
    IOcrCatalogV4PreparedDescriptor,
    IOcrCatalogRootV4,
    IOcrGenerationV4,
    IOcrPageMappingV4,
    IOcrShardIndexRecord,
    IOcrShardV4,
    TOcrPageArtifact,
} from '@contracts/ocrIndex';
import {
    fsyncDirectory as syncDirectory, fsyncFile as syncFile, 
} from '@electron/utils/fsyncPath';
import {
    OCR_CATALOG_PREPARED_DESCRIPTOR_VERSION,
    OCR_CATALOG_ROOT_MAX_BYTES,
    OCR_CATALOG_VERSION,
    OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH,
    OCR_MAX_GENERATION,
    OCR_MAX_PAGE_NUMBER,
    OCR_MAX_SHARD_NUMBER,
    OCR_SHARD_INDEX_HEADER_BYTES,
    OCR_SHARD_INDEX_MAGIC,
    OCR_SHARD_INDEX_RECORD_BYTES,
    OCR_SHARD_SIZE,
    parseOcrCatalogRootV4,
    parseOcrCatalogV4PreparedDescriptor,
    parseOcrGenerationV4,
    parseOcrShardIndexHeader,
    parseOcrShardV4,
} from '@contracts/ocrIndex';
import type {
    IOcrPageWithWords,
    TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import {
    OcrCatalogCorruptError,
    OcrCatalogFencedError,
    OcrCatalogPathError,
    OcrCatalogAbortedError,
    assertCatalogRegularFile as assertRegularFile,
    assertIndexByteLength,
    assertOpenFileByteLength,
    readBoundedFileContents,
    canonicalPathParts as parseCanonicalPagePath,
    hasOcrCatalogV4ReaderLease,
    readCatalogRoot,
    readExactly,
    readJsonFile,
    resolveCatalogPath,
} from '@electron/features/ocr/main/ocrCatalogV4';
import {clearOcrCatalogRecoveryReceipt} from '@electron/features/ocr/main/ocrCatalogRecovery';
import {assertWorkingCopyRevisionSidecarCurrent as assertWorkingCopyRevisionCurrent} from '@electron/file-access/documentRevisionSidecar';
export interface IOcrIndexV4WriteOptions {
    catalogRoot: string;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo | TDocumentRevisionToken;
    pageCount: number;
    pageBatches: AsyncIterable<readonly IOcrPageWithWords[]> | Iterable<readonly IOcrPageWithWords[]>;
    /** Keep the generated immutable files private until an apply caller rebinds the root. */
    publishRoot?: boolean;
    workingCopyPath?: string;
    catalogId?: string;
    signal?: AbortSignal;
    log?: TWorkerLog;
    extractionDpi?: number;
    assertRevisionCurrent?: () => Promise<void>;
    durabilityBoundary?: IOcrCatalogV4DurabilityBoundary;
}
export interface IOcrIndexV4WriteResult {
    catalogRoot: string;
    catalogId: string;
    generation: number;
    parent: number | null;
    pageCount: number;
    mappedPageCount: number;
    dirtyShards: number[];
    published: boolean;
}
export interface IOcrIndexV4PrepareOptions {
    catalogRoot: string;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo | TDocumentRevisionToken;
    pageCount: number;
    pageBatches: AsyncIterable<readonly IOcrPageWithWords[]> | Iterable<readonly IOcrPageWithWords[]>;
    resultPath: string;
    resultIdentity?: string;
    descriptorPath?: string;
    workingCopyPath?: string;
    catalogId?: string;
    signal?: AbortSignal;
    log?: TWorkerLog;
    extractionDpi?: number;
    assertRevisionCurrent?: () => Promise<void>;
}

export interface IPublishOcrCatalogV4PreparedOptions {
    catalogRoot: string;
    descriptor: IOcrCatalogV4PreparedDescriptor | string;
    resultPath: string;
    resultIdentity?: string;
    sourcePdfPath: string;
    nextRevision: IDocumentRevisionInfo | TDocumentRevisionToken;
    descriptorPath?: string;
    signal?: AbortSignal;
    assertRevisionCurrent?: () => Promise<void>;
    durabilityBoundary?: IOcrCatalogV4DurabilityBoundary;
}

export interface IRollbackOcrCatalogV4PreparedOptions {
    descriptorPath?: string;
    catalogRoot?: string;
}

/** Allows callers to exercise and report the post-rename durability boundary. */
export interface IOcrCatalogV4DurabilityBoundary {
    syncDirectory?: (directoryPath: string, sync: () => Promise<void>) => Promise<void>;
    afterRootRename?: (catalogRoot: string, generation: number) => Promise<void>;
}

export class OcrCatalogCommittedDurabilityError extends Error {
    readonly code = 'OCR_CATALOG_COMMITTED_DURABILITY_UNCONFIRMED';
    readonly catalogRoot: string;
    readonly generation: number;
    readonly committed = true;

    constructor(catalogRoot: string, generation: number, cause: unknown) {
        super(
            `OCR catalog generation ${generation} was committed, but directory durability was not confirmed`,
            {cause},
        );
        this.name = 'OcrCatalogCommittedDurabilityError';
        this.catalogRoot = catalogRoot;
        this.generation = generation;
    }
}

function isCommittedDurabilityError(error: unknown): error is OcrCatalogCommittedDurabilityError {
    return error instanceof OcrCatalogCommittedDurabilityError;
}
const ROOT_MANIFEST_FILENAME = 'manifest.json';
const GENERATION_MANIFEST_FILENAME = 'generation.json';
const SHARD_INDEX_FILENAME = 'shards.idx';
const OCR_CATALOG_V4_PREPARED_DESCRIPTOR_SUFFIX = '.ocr-v4-prepared.json' as const;
const MAX_GENERATION_DIRECTORY_VALUE = OCR_MAX_GENERATION;
const MAX_SHARD_FILE_VALUE = OCR_MAX_SHARD_NUMBER;
const INDEX_COPY_CHUNK_RECORDS = 4096;
/** Keep abandoned generations until their publication window has elapsed. */
export const OCR_CATALOG_V4_ORPHAN_GRACE_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANONICAL_PAGE_PATH = /^gen-(\d{8,})\/pages\/(\d{6,})\/p(\d{8,})\.json$/u;
const GENERATION_DIRECTORY = /^gen-(\d{8,})$/u;
const catalogLocks = new Map<string, Promise<void>>();
// O_RDONLY is zero. These are the stable POSIX O_NOFOLLOW values used by the
// Electron hosts. Windows has no equivalent, so its validated lstat path is
// the fallback.
const READ_ONLY_NOFOLLOW_FLAGS = process.platform === 'darwin'
    ? 0x100
    : process.platform === 'linux'
        ? 0x20_000
        : 0;

async function withCatalogLock<T>(catalogRoot: string, operation: () => Promise<T>): Promise<T> {
    const key = resolve(catalogRoot);
    const previous = catalogLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolveRelease => {
        release = resolveRelease;
    });
    catalogLocks.set(key, current);
    try {
        if (previous) {
            await previous;
        }
        return await operation();
    } finally {
        release();
        if (catalogLocks.get(key) === current) {
            catalogLocks.delete(key);
        }
    }
}

export function getOcrCatalogV4PreparedDescriptorPath(resultPath: string): string {
    if (typeof resultPath !== 'string' || resultPath.length === 0) {
        throw new TypeError('OCR prepared result path must not be empty');
    }
    return `${resolve(resultPath)}${OCR_CATALOG_V4_PREPARED_DESCRIPTOR_SUFFIX}`;
}

export async function readOcrCatalogV4PreparedDescriptor(
    descriptorPath: string,
): Promise<IOcrCatalogV4PreparedDescriptor | null> {
    if (!await assertRegularFile(descriptorPath, descriptorPath)) {
        return null;
    }
    let value: unknown;
    try {
        const file = await openReadOnlyNoFollow(descriptorPath);
        try {
            value = JSON.parse(
                (await readBoundedFileContents(file, descriptorPath)).toString('utf8'),
            ) as unknown;
        } finally {
            await file.close();
        }
    } catch (error) {
        if (error instanceof OcrCatalogPathError) {
            throw error;
        }
        throw new OcrCatalogCorruptError('prepared OCR catalog descriptor is invalid JSON');
    }
    const descriptor = parseOcrCatalogV4PreparedDescriptor(value);
    if (descriptor === null) {
        throw new OcrCatalogCorruptError('prepared OCR catalog descriptor is invalid');
    }
    return descriptor;
}
interface ICurrentV4Catalog {
    kind: 'v4';
    root: IOcrCatalogRootV4;
    generation: IOcrGenerationV4;
    generationDirectory: string;
    indexPath: string;
    indexByteLength: number;
}
type TCurrentCatalog = ICurrentV4Catalog | null;
interface IRevisionContext {
    token: TDocumentRevisionToken;
    fence: () => Promise<void>;
}
interface IGenerationBuildState {
    readonly generation: number;
    readonly generationDirectory: string;
    readonly catalogRoot: string;
    readonly pageCount: number;
    readonly source: {pdfPath: string};
    readonly documentRevision: TDocumentRevisionToken;
    readonly catalogId: string;
    readonly extractionDpi: number;
    readonly parent: number | null;
    readonly sourceCatalog: ICurrentV4Catalog | null;
    readonly sourceIndexRecords: Map<number, IOcrShardIndexRecord>;
    readonly liveRefs: Map<number, number>;
    readonly dirtyShards: Set<number>;
    readonly dirtyRecords: Map<number, IOcrShardIndexRecord>;
    readonly touchedShards: Set<number>;
    readonly releasedLegacyPaths: Set<string>;
    readonly releasedGenerations: Set<number>;
    mappedPageCount: number;
}
function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new OcrCatalogAbortedError();
    }
}
function isErrnoCode(error: unknown, code: string) {
    return !!error
        && typeof error === 'object'
        && 'code' in error
        && error.code === code;
}
function asRevisionToken(value: IDocumentRevisionInfo | TDocumentRevisionToken | undefined): TDocumentRevisionToken | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === 'string') {
        return parseDocumentRevisionToken(value) ?? undefined;
    }
    return parseDocumentRevisionToken(value.token) ?? undefined;
}
function requireRevisionToken(value: IDocumentRevisionInfo | TDocumentRevisionToken | undefined) {
    const token = asRevisionToken(value);
    if (token === undefined) {
        throw new TypeError('OCR catalog document revision is invalid');
    }
    return token;
}
function generationDirectoryName(generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION_DIRECTORY_VALUE) {
        throw new OcrCatalogCorruptError(`generation ${generation} cannot be represented in a directory name`);
    }
    return `gen-${String(generation).padStart(8, '0')}`;
}
function shardFileName(shard: number) {
    if (!Number.isSafeInteger(shard) || shard < 0 || shard > MAX_SHARD_FILE_VALUE) {
        throw new OcrCatalogCorruptError(`shard ${shard} cannot be represented in a file name`);
    }
    return `shard-${String(shard).padStart(6, '0')}.json`;
}
function canonicalPagePath(generation: number, pageNumber: number) {
    const shard = Math.floor((pageNumber - 1) / OCR_SHARD_SIZE);
    const directory = generationDirectoryName(generation);
    const path = `${directory}/pages/${String(shard).padStart(6, '0')}/p${String(pageNumber).padStart(8, '0')}.json`;
    if (!CANONICAL_PAGE_PATH.test(path)) {
        throw new OcrCatalogCorruptError(`page ${pageNumber} has an invalid canonical path`);
    }
    return path;
}
function expectedShardCount(pageCount: number) {
    const shardCount = Math.ceil(pageCount / OCR_SHARD_SIZE);
    if (!Number.isSafeInteger(shardCount) || shardCount > 0xFFFF_FFFF) {
        throw new OcrCatalogCorruptError('page count produces an unrepresentable shard count');
    }
    return shardCount;
}
function expectedIndexByteLength(shardCount: number) {
    const recordBytes = shardCount * OCR_SHARD_INDEX_RECORD_BYTES;
    if (
        !Number.isSafeInteger(recordBytes)
        || recordBytes > Number.MAX_SAFE_INTEGER - OCR_SHARD_INDEX_HEADER_BYTES
    ) {
        throw new OcrCatalogCorruptError('shard index length is not safely representable');
    }
    return OCR_SHARD_INDEX_HEADER_BYTES + recordBytes;
}
function indexRecordBuffer(record: IOcrShardIndexRecord) {
    const buffer = Buffer.alloc(OCR_SHARD_INDEX_RECORD_BYTES);
    buffer.writeUInt32LE(record.generation, 0);
    buffer.writeUInt16LE(record.mappedCount, 4);
    buffer.writeUInt16LE(0, 6);
    return buffer;
}
function validateIndexRecord(record: IOcrShardIndexRecord, shard: number, pageCount: number, maxGeneration: number) {
    const shardPageCount = Math.min(
        OCR_SHARD_SIZE,
        Math.max(0, pageCount - shard * OCR_SHARD_SIZE),
    );
    if (
        !Number.isSafeInteger(record.generation)
        || record.generation < 0
        || record.generation > maxGeneration
        || !Number.isSafeInteger(record.mappedCount)
        || record.mappedCount < 0
        || record.mappedCount > shardPageCount
        || (record.generation === 0 && record.mappedCount !== 0)
    ) {
        throw new OcrCatalogCorruptError(`invalid shard-index record ${shard}`);
    }
    return record;
}
async function writeExactly(file: FileHandle, buffer: Buffer, position: number) {
    if (
        !Number.isSafeInteger(position)
        || position < 0
        || !Number.isSafeInteger(buffer.byteLength)
        || position > Number.MAX_SAFE_INTEGER - buffer.byteLength
    ) {
        throw new OcrCatalogCorruptError('shard-index write offset is unsafe');
    }
    let offset = 0;
    while (offset < buffer.byteLength) {
        const result = await file.write(buffer, offset, buffer.byteLength - offset, position + offset);
        if (result.bytesWritten <= 0) {
            throw new OcrCatalogCorruptError('unable to write shard index');
        }
        offset += result.bytesWritten;
    }
}

/**
 * Removes a staged entry and persists the containing directory entry. A
 * successful rename without the parent fsync is not durable after a power
 * loss, and a failed cleanup must not be hidden behind the original error.
 */
async function removePathAndSync(filePath: string, parentDirectory = dirname(filePath)) {
    await rm(filePath, {
        recursive: true,
        force: true,
    });
    await syncDirectory(parentDirectory);
}

async function throwAfterCleanup(
    originalError: unknown,
    cleanups: ReadonlyArray<() => Promise<void>>,
): Promise<never> {
    const errors: unknown[] = [originalError];
    for (const cleanup of cleanups) {
        try {
            await cleanup();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 1) {
        throw new AggregateError(errors, 'OCR catalog cleanup failed');
    }
    throw originalError;
}
function temporaryPath(filePath: string) {
    return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}
async function writeAtomic(filePath: string, contents: string) {
    const tempPath = temporaryPath(filePath);
    try {
        await writeFile(tempPath, contents, 'utf8');
        await syncFile(tempPath);
        await rename(tempPath, filePath);
        await syncDirectory(dirname(filePath));
    } catch (error) {
        return throwAfterCleanup(error, [() => removePathAndSync(tempPath)]);
    }
}
async function openReadOnlyNoFollow(filePath: string): Promise<FileHandle> {
    try {
        return await open(filePath, READ_ONLY_NOFOLLOW_FLAGS);
    } catch (error) {
        if (isErrnoCode(error, 'ELOOP')) {
            throw new OcrCatalogPathError(`symbolic links are not allowed: ${filePath}`, filePath);
        }
        throw error;
    }
}
async function readCurrentCatalog(catalogRoot: string): Promise<TCurrentCatalog> {
    const rootValue = (await readCatalogRoot(catalogRoot))?.value ?? null;
    if (rootValue === null) {
        return null;
    }
    if (
        rootValue
        && typeof rootValue === 'object'
        && !Array.isArray(rootValue)
        && 'version' in rootValue
    ) {
        if (rootValue.version !== OCR_CATALOG_VERSION) {
            if (rootValue.version === '4') {
                throw new OcrCatalogCorruptError('published v4 root manifest has an invalid version');
            }
            return null;
        }
        const root = parseOcrCatalogRootV4(rootValue);
        if (root === null) {
            throw new OcrCatalogCorruptError('published v4 root manifest is invalid');
        }
        const generationDirectory = generationDirectoryName(root.generation);
        const generationPath = join(catalogRoot, generationDirectory, GENERATION_MANIFEST_FILENAME);
        const generationValue = await readJsonFile(
            generationPath,
            `${generationDirectory}/${GENERATION_MANIFEST_FILENAME}`,
            catalogRoot,
        );
        if (generationValue === null) {
            throw new OcrCatalogCorruptError('published generation manifest is missing');
        }
        const generation = parseOcrGenerationV4(generationValue, root);
        if (generation === null) {
            throw new OcrCatalogCorruptError('published generation manifest is invalid');
        }
        const indexPath = join(catalogRoot, generationDirectory, SHARD_INDEX_FILENAME);
        const indexByteLength = await validateIndexFile(indexPath, generation, root.generation, catalogRoot);
        return {
            kind: 'v4',
            root,
            generation,
            generationDirectory,
            indexPath,
            indexByteLength,
        };
    }
    return null;
}
async function validateIndexFile(
    indexPath: string,
    generation: IOcrGenerationV4,
    maxGeneration: number,
    catalogRoot?: string,
) {
    if (!await assertRegularFile(indexPath, SHARD_INDEX_FILENAME, catalogRoot)) {
        throw new OcrCatalogCorruptError('published shard index is missing');
    }
    const expectedLength = expectedIndexByteLength(generation.shardCount);
    await assertIndexByteLength(indexPath, expectedLength);
    const file = await openReadOnlyNoFollow(indexPath);
    try {
        await assertOpenFileByteLength(file, expectedLength, SHARD_INDEX_FILENAME);
        const headerBuffer = Buffer.alloc(OCR_SHARD_INDEX_HEADER_BYTES);
        await readExactly(file, headerBuffer, 0);
        const header = parseOcrShardIndexHeader(headerBuffer);
        if (
            header === null
            || header.shardSize !== OCR_SHARD_SIZE
            || header.shardCount !== generation.shardCount
            || headerBuffer.toString('ascii', 0, OCR_SHARD_INDEX_MAGIC.length) !== OCR_SHARD_INDEX_MAGIC
        ) {
            throw new OcrCatalogCorruptError('invalid shard-index header');
        }
        if (maxGeneration < generation.generation) {
            throw new OcrCatalogCorruptError('generation ordering is invalid');
        }
        let mappedPageCount = 0;
        for (let firstShard = 0; firstShard < generation.shardCount; firstShard += INDEX_COPY_CHUNK_RECORDS) {
            const count = Math.min(INDEX_COPY_CHUNK_RECORDS, generation.shardCount - firstShard);
            const recordsBuffer = Buffer.alloc(count * OCR_SHARD_INDEX_RECORD_BYTES);
            const position = OCR_SHARD_INDEX_HEADER_BYTES + firstShard * OCR_SHARD_INDEX_RECORD_BYTES;
            if (
                !Number.isSafeInteger(position)
                || position + recordsBuffer.byteLength > expectedLength
            ) {
                throw new OcrCatalogCorruptError('shard-index scan offset is unsafe');
            }
            await readExactly(file, recordsBuffer, position);
            for (let index = 0; index < count; index += 1) {
                const record = validateIndexRecord({
                    generation: recordsBuffer.readUInt32LE(index * OCR_SHARD_INDEX_RECORD_BYTES),
                    mappedCount: recordsBuffer.readUInt16LE(index * OCR_SHARD_INDEX_RECORD_BYTES + 4),
                    reserved: recordsBuffer.readUInt16LE(index * OCR_SHARD_INDEX_RECORD_BYTES + 6) as 0,
                }, firstShard + index, generation.pageCount, maxGeneration);
                mappedPageCount += record.mappedCount;
                if (mappedPageCount > generation.mappedPageCount) {
                    throw new OcrCatalogCorruptError('shard-index mapped count exceeds generation manifest');
                }
            }
        }
        if (mappedPageCount !== generation.mappedPageCount) {
            throw new OcrCatalogCorruptError(
                `shard-index mapped count ${mappedPageCount} does not equal ${generation.mappedPageCount}`,
            );
        }
    } finally {
        await file.close();
    }
    return expectedLength;
}
async function readIndexRecordAt(catalog: ICurrentV4Catalog, shard: number) {
    if (!Number.isSafeInteger(shard) || shard < 0 || shard >= catalog.generation.shardCount) {
        throw new OcrCatalogCorruptError(`shard ${shard} is outside the index`);
    }
    const position = OCR_SHARD_INDEX_HEADER_BYTES + shard * OCR_SHARD_INDEX_RECORD_BYTES;
    if (
        !Number.isSafeInteger(position)
        || position < OCR_SHARD_INDEX_HEADER_BYTES
        || position > Number.MAX_SAFE_INTEGER - OCR_SHARD_INDEX_RECORD_BYTES
        || position + OCR_SHARD_INDEX_RECORD_BYTES > catalog.indexByteLength
    ) {
        throw new OcrCatalogCorruptError(`shard ${shard} has an unsafe index offset`);
    }
    await assertIndexByteLength(catalog.indexPath, catalog.indexByteLength);
    const file = await openReadOnlyNoFollow(catalog.indexPath);
    try {
        await assertOpenFileByteLength(file, catalog.indexByteLength, SHARD_INDEX_FILENAME);
        const buffer = Buffer.alloc(OCR_SHARD_INDEX_RECORD_BYTES);
        await readExactly(file, buffer, position);
        return validateIndexRecord({
            generation: buffer.readUInt32LE(0),
            mappedCount: buffer.readUInt16LE(4),
            reserved: buffer.readUInt16LE(6) as 0,
        }, shard, catalog.root.pageCount, catalog.root.generation);
    } finally {
        await file.close();
    }
}

/** Sums fixed-index records without materializing a page or shard map. */
async function sumIndexMappedCounts(
    catalog: ICurrentV4Catalog,
    firstShard: number,
    lastShard: number,
): Promise<number> {
    if (firstShard > lastShard) {
        return 0;
    }
    if (
        !Number.isSafeInteger(firstShard)
        || !Number.isSafeInteger(lastShard)
        || firstShard < 0
        || lastShard >= catalog.generation.shardCount
    ) {
        throw new OcrCatalogCorruptError('shard-index sum range is outside the index');
    }
    let mappedCount = 0;
    await scanIndexRecords(catalog, firstShard, lastShard, (_shard, record) => {
        mappedCount += record.mappedCount;
    });
    return mappedCount;
}

/** Scans a fixed-index range in bounded chunks without materializing records. */
async function scanIndexRecords(
    catalog: ICurrentV4Catalog,
    firstShard: number,
    lastShard: number,
    visit: (shard: number, record: IOcrShardIndexRecord) => void,
): Promise<void> {
    if (firstShard > lastShard) {
        return;
    }
    if (
        !Number.isSafeInteger(firstShard)
        || !Number.isSafeInteger(lastShard)
        || firstShard < 0
        || lastShard >= catalog.generation.shardCount
    ) {
        throw new OcrCatalogCorruptError('shard-index scan range is outside the index');
    }
    await assertIndexByteLength(catalog.indexPath, catalog.indexByteLength);
    const file = await openReadOnlyNoFollow(catalog.indexPath);
    try {
        await assertOpenFileByteLength(file, catalog.indexByteLength, SHARD_INDEX_FILENAME);
        for (let first = firstShard; first <= lastShard; first += INDEX_COPY_CHUNK_RECORDS) {
            const count = Math.min(INDEX_COPY_CHUNK_RECORDS, lastShard - first + 1);
            const buffer = Buffer.alloc(count * OCR_SHARD_INDEX_RECORD_BYTES);
            const position = OCR_SHARD_INDEX_HEADER_BYTES + first * OCR_SHARD_INDEX_RECORD_BYTES;
            if (
                !Number.isSafeInteger(position)
                || position < OCR_SHARD_INDEX_HEADER_BYTES
                || position + buffer.byteLength > catalog.indexByteLength
            ) {
                throw new OcrCatalogCorruptError('shard-index scan offset is unsafe');
            }
            await readExactly(file, buffer, position);
            for (let index = 0; index < count; index += 1) {
                const shard = first + index;
                const offset = index * OCR_SHARD_INDEX_RECORD_BYTES;
                const record = validateIndexRecord({
                    generation: buffer.readUInt32LE(offset),
                    mappedCount: buffer.readUInt16LE(offset + 4),
                    reserved: buffer.readUInt16LE(offset + 6) as 0,
                }, shard, catalog.root.pageCount, catalog.root.generation);
                visit(shard, record);
            }
        }
    } finally {
        await file.close();
    }
}
async function readSourceShard(
    catalog: ICurrentV4Catalog,
    shard: number,
    record: IOcrShardIndexRecord,
): Promise<Record<string, IOcrPageMappingV4>> {
    if (record.generation === 0 || record.mappedCount === 0) {
        return {};
    }
    const generationDirectory = generationDirectoryName(record.generation);
    const relativePath = `${generationDirectory}/shards/${shardFileName(shard)}`;
    const catalogRoot = catalogRootFor(catalog);
    const shardPath = join(catalogRoot, relativePath);
    const value = await readJsonFile(shardPath, relativePath, catalogRoot);
    if (value === null) {
        throw new OcrCatalogCorruptError(`missing shard ${shard}`);
    }
    const parsed = parseOcrShardV4(value, {
        expectedGeneration: record.generation,
        expectedShard: shard,
        expectedMappedCount: record.mappedCount,
        pageCount: catalog.root.pageCount,
        maxGeneration: catalog.root.generation,
    });
    if (parsed === null) {
        throw new OcrCatalogCorruptError(`invalid shard ${shard}`);
    }
    for (const [
        rawPageNumber,
        mapping,
    ] of Object.entries(parsed.pages)) {
        const pageNumber = Number(rawPageNumber);
        const canonical = parseCanonicalPagePath(mapping.path);
        if (mapping.generation === 0) {
            resolveCatalogPath(catalogRoot, mapping.path, {kind: 'legacy'});
            continue;
        }
        if (
            canonical === null
            || canonical.generation !== mapping.generation
            || mapping.generation > record.generation
        ) {
            throw new OcrCatalogCorruptError(`canonical path does not match generation for page ${pageNumber}`);
        }
        resolveCatalogPath(catalogRoot, mapping.path, {kind: 'canonical-v4'});
    }
    return {...parsed.pages};
}
function catalogRootFor(catalog: ICurrentV4Catalog) {
    return dirname(dirname(catalog.indexPath));
}
async function findNextGeneration(catalogRoot: string, currentGeneration = 0) {
    let highest = currentGeneration;
    let entries: Dirent[];
    try {
        entries = await readdir(catalogRoot, {withFileTypes: true});
    } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) {
            return 1;
        }
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const match = GENERATION_DIRECTORY.exec(entry.name);
        if (match) {
            highest = Math.max(highest, Number(match[1]));
        }
    }
    if (highest >= MAX_GENERATION_DIRECTORY_VALUE) {
        throw new OcrCatalogCorruptError('OCR catalog generation counter is exhausted');
    }
    return highest + 1;
}
function validateWritePage(page: IOcrPageWithWords, pageCount: number) {
    if (
        !Number.isSafeInteger(page.pageNumber)
        || page.pageNumber < 1
        || page.pageNumber > pageCount
    ) {
        throw new RangeError(`Invalid OCR page number ${page.pageNumber}`);
    }
    if (
        typeof page.text !== 'string'
        || !Array.isArray(page.words)
        || !page.words.every(isOcrWord)
        || !Number.isFinite(page.imageWidth)
        || !Number.isFinite(page.imageHeight)
        || page.imageWidth <= 0
        || page.imageHeight <= 0
    ) {
        throw new TypeError(`Invalid OCR page payload ${page.pageNumber}`);
    }
}
function createPageArtifact(
    page: IOcrPageWithWords,
    generationDirectory: string,
    extractionDpi: number,
): TOcrPageArtifact {
    const contentDigest = createHash('sha256').update(JSON.stringify({
        pageNumber: page.pageNumber,
        text: page.text,
        words: page.words,
    })).digest('hex');
    return {
        rotation: 0,
        render: {
            dpi: extractionDpi,
            imagePx: {
                w: page.imageWidth,
                h: page.imageHeight,
            },
        },
        text: page.text,
        words: page.words,
        canonicalText: {
            source: 'evb-ocr',
            generation: generationDirectory,
            contentDigest,
        },
    };
}
function asGenerationRecordMap(value: Record<string, number>) {
    const result = new Map<number, number>();
    for (const [
        rawGeneration,
        count,
    ] of Object.entries(value)) {
        const generation = Number(rawGeneration);
        if (Number.isSafeInteger(generation) && generation >= 0 && Number.isSafeInteger(count) && count >= 0) {
            result.set(generation, count);
        }
    }
    return result;
}
function asLiveRefs(value: Map<number, number>) {
    const result: Record<string, number> = {};
    for (const [
        generation,
        count,
    ] of [...value.entries()].sort(([left], [right]) => left - right)) {
        result[String(generation)] = count;
    }
    return result;
}
async function writePage(
    catalogRoot: string,
    generation: number,
    page: IOcrPageWithWords,
    extractionDpi: number,
): Promise<IOcrPageMappingV4> {
    const relativePath = canonicalPagePath(generation, page.pageNumber);
    const resolvedPath = resolveCatalogPath(catalogRoot, relativePath, {kind: 'canonical-v4'});
    await mkdir(dirname(resolvedPath), {recursive: true});
    const artifact = createPageArtifact(page, generationDirectoryName(generation), extractionDpi);
    await writeAtomic(resolvedPath, JSON.stringify(artifact));
    return {
        path: relativePath,
        generation,
        createdAt: createIsoTimestamp(),
    };
}
async function writeShard(
    catalogRoot: string,
    generation: number,
    shard: number,
    pages: Record<string, IOcrPageMappingV4>,
) {
    const generationDirectory = generationDirectoryName(generation);
    const relativePath = `${generationDirectory}/shards/${shardFileName(shard)}`;
    const shardPath = resolveCatalogPath(catalogRoot, relativePath, {kind: 'canonical-v4'});
    const pageNumbers = Object.keys(pages).sort((left, right) => Number(left) - Number(right));
    const shardPages: Record<string, IOcrPageMappingV4> = {};
    for (const pageNumber of pageNumbers) {
        const page = pages[pageNumber];
        if (page) {
            shardPages[pageNumber] = page;
        }
    }
    const shardValue: IOcrShardV4 = {
        version: OCR_CATALOG_VERSION,
        generation,
        shard,
        pages: shardPages,
    };
    await writeAtomic(shardPath, JSON.stringify(shardValue));
}
async function loadWorkingShard(
    state: IGenerationBuildState,
    shard: number,
): Promise<Record<string, IOcrPageMappingV4>> {
    if (state.touchedShards.has(shard)) {
        const relativePath = `${state.generationDirectory}/shards/${shardFileName(shard)}`;
        const value = await readJsonFile(join(state.catalogRoot, relativePath), relativePath, state.catalogRoot);
        if (value === null) {
            throw new OcrCatalogCorruptError(`missing staged shard ${shard}`);
        }
        const record = state.dirtyRecords.get(shard);
        const parseOptions = {
            expectedGeneration: state.generation,
            expectedShard: shard,
            pageCount: state.pageCount,
            maxGeneration: state.generation,
            ...(record === undefined ? {} : {expectedMappedCount: record.mappedCount}),
        };
        const parsed = parseOcrShardV4(value, parseOptions);
        if (parsed === null) {
            throw new OcrCatalogCorruptError(`invalid staged shard ${shard}`);
        }
        const pages: Record<string, IOcrPageMappingV4> = {};
        for (const [
            pageNumber,
            mapping,
        ] of Object.entries(parsed.pages)) {
            pages[pageNumber] = mapping;
        }
        return pages;
    }
    if (!state.sourceCatalog) {
        return {};
    }
    const record = await readIndexRecordAt(state.sourceCatalog, shard);
    state.sourceIndexRecords.set(shard, record);
    return readSourceShard(state.sourceCatalog, shard, record);
}
async function consumePageBatches(
    state: IGenerationBuildState,
    pageBatches: AsyncIterable<readonly IOcrPageWithWords[]> | Iterable<readonly IOcrPageWithWords[]>,
    signal?: AbortSignal,
) {
    for await (const batch of pageBatches) {
        throwIfAborted(signal);
        if (batch.length > OCR_SHARD_SIZE) {
            throw new RangeError(`OCR v4 page batches must contain at most ${OCR_SHARD_SIZE} pages`);
        }
        const byShard = new Map<number, IOcrPageWithWords[]>();
        for (const page of batch) {
            validateWritePage(page, state.pageCount);
            const shard = Math.floor((page.pageNumber - 1) / OCR_SHARD_SIZE);
            const pages = byShard.get(shard) ?? [];
            pages.push(page);
            byShard.set(shard, pages);
        }
        for (const [
            shard,
            pages,
        ] of byShard) {
            throwIfAborted(signal);
            const isFirstTouch = !state.touchedShards.has(shard);
            const pageMappings = await loadWorkingShard(state, shard);
            const sourceRecord = state.sourceIndexRecords.get(shard);
            if (isFirstTouch) {
                const ownerGeneration = sourceRecord?.generation ?? 0;
                if (ownerGeneration > 0) {
                    const ownerRefs = state.liveRefs.get(ownerGeneration) ?? 0;
                    const remainingRefs = Math.max(0, ownerRefs - 1);
                    state.liveRefs.set(ownerGeneration, remainingRefs);
                    if (remainingRefs === 0 && ownerGeneration !== state.generation) {
                        state.releasedGenerations.add(ownerGeneration);
                    }
                }
                state.touchedShards.add(shard);
                state.dirtyShards.add(shard);
            }
            for (const page of pages) {
                const rawPageNumber = String(page.pageNumber);
                const previousMapping = pageMappings[rawPageNumber];
                if (previousMapping?.generation === state.generation) {
                    throw new Error(`Duplicate OCR page number ${page.pageNumber}`);
                }
                if (previousMapping?.generation === 0) {
                    state.releasedLegacyPaths.add(previousMapping.path);
                }
                const pageMapping = await writePage(
                    state.catalogRoot,
                    state.generation,
                    page,
                    state.extractionDpi,
                );
                pageMappings[rawPageNumber] = pageMapping;
                if (!previousMapping) {
                    state.mappedPageCount += 1;
                }
            }
            await writeShard(state.catalogRoot, state.generation, shard, pageMappings);
            state.dirtyRecords.set(shard, {
                generation: state.generation,
                mappedCount: Object.keys(pageMappings).length,
                reserved: 0,
            });
            if (isFirstTouch) {
                state.liveRefs.set(state.generation, (state.liveRefs.get(state.generation) ?? 0) + 1);
            }
        }
    }
}
async function writeIndexFile(
    catalogRoot: string,
    generation: number,
    shardCount: number,
    sourceIndexPath: string | null,
    dirtyRecords: ReadonlyMap<number, IOcrShardIndexRecord>,
    sourceShardCount?: number,
) {
    const generationDirectory = generationDirectoryName(generation);
    const indexPath = resolveCatalogPath(
        catalogRoot,
        `${generationDirectory}/${SHARD_INDEX_FILENAME}`,
    );
    const tempPath = temporaryPath(indexPath);
    const expectedLength = expectedIndexByteLength(shardCount);
    const destination = await open(tempPath, 'w+');
    let source: FileHandle | null = null;
    try {
        const header = Buffer.alloc(OCR_SHARD_INDEX_HEADER_BYTES);
        header.write(OCR_SHARD_INDEX_MAGIC, 0, 'ascii');
        header.writeUInt32LE(OCR_SHARD_SIZE, 8);
        header.writeUInt32LE(shardCount, 12);
        await writeExactly(destination, header, 0);
        if (sourceIndexPath !== null) {
            const sourceCount = sourceShardCount ?? shardCount;
            if (
                !Number.isSafeInteger(sourceCount)
                || sourceCount < 0
                || sourceCount > 0xFFFF_FFFF
            ) {
                throw new OcrCatalogCorruptError('source shard index count is invalid');
            }
            await assertIndexByteLength(sourceIndexPath, expectedIndexByteLength(sourceCount));
            source = await openReadOnlyNoFollow(sourceIndexPath);
            await assertOpenFileByteLength(
                source,
                expectedIndexByteLength(sourceCount),
                SHARD_INDEX_FILENAME,
            );
        }
        for (let firstShard = 0; firstShard < shardCount; firstShard += INDEX_COPY_CHUNK_RECORDS) {
            const recordCount = Math.min(INDEX_COPY_CHUNK_RECORDS, shardCount - firstShard);
            const recordsBuffer = Buffer.alloc(recordCount * OCR_SHARD_INDEX_RECORD_BYTES);
            if (source) {
                const sourceCount = sourceShardCount ?? shardCount;
                const readableCount = Math.max(0, Math.min(recordCount, sourceCount - firstShard));
                if (readableCount === 0) {
                    await writeExactly(
                        destination,
                        recordsBuffer,
                        OCR_SHARD_INDEX_HEADER_BYTES + firstShard * OCR_SHARD_INDEX_RECORD_BYTES,
                    );
                    continue;
                }
                const sourceBuffer = recordsBuffer.subarray(0, readableCount * OCR_SHARD_INDEX_RECORD_BYTES);
                await readExactly(
                    source,
                    sourceBuffer,
                    OCR_SHARD_INDEX_HEADER_BYTES + firstShard * OCR_SHARD_INDEX_RECORD_BYTES,
                );
            }
            await writeExactly(
                destination,
                recordsBuffer,
                OCR_SHARD_INDEX_HEADER_BYTES + firstShard * OCR_SHARD_INDEX_RECORD_BYTES,
            );
        }
        for (const [
            shard,
            record,
        ] of dirtyRecords) {
            if (!Number.isSafeInteger(shard) || shard < 0 || shard >= shardCount) {
                throw new OcrCatalogCorruptError(`dirty shard ${shard} is outside the index`);
            }
            await writeExactly(
                destination,
                indexRecordBuffer(record),
                OCR_SHARD_INDEX_HEADER_BYTES + shard * OCR_SHARD_INDEX_RECORD_BYTES,
            );
        }
        await destination.truncate(expectedLength);
        await destination.sync();
    } finally {
        if (source) {
            await source.close();
        }
        await destination.close();
    }
    try {
        await rename(tempPath, indexPath);
    } catch (error) {
        return throwAfterCleanup(error, [() => removePathAndSync(tempPath, join(catalogRoot, generationDirectory))]);
    }
    await syncDirectory(join(catalogRoot, generationDirectory));
    return {
        indexPath,
        indexByteLength: expectedLength,
    };
}
interface IOcrCatalogV4PublishInput {
    catalogRoot: string;
    root: IOcrCatalogRootV4;
    generation: IOcrGenerationV4;
    sourceIndexPath: string | null;
    sourceShardCount?: number;
    dirtyRecords: ReadonlyMap<number, IOcrShardIndexRecord>;
    revisionFence: () => Promise<void>;
    signal?: AbortSignal;
    /** Stage immutable files under the catalog without replacing manifest.json. */
    publishRoot?: boolean;
    durabilityBoundary?: IOcrCatalogV4DurabilityBoundary;
}
interface IOcrCatalogV4PublishResult {
    rootPath: string;
    generationPath: string;
    published: boolean;
}
async function publishOcrCatalogV4GenerationUnlocked(
    input: IOcrCatalogV4PublishInput,
): Promise<IOcrCatalogV4PublishResult> {
    throwIfAborted(input.signal);
    const generationDirectory = generationDirectoryName(input.generation.generation);
    const generationPath = join(input.catalogRoot, generationDirectory);
    const rootPath = join(input.catalogRoot, ROOT_MANIFEST_FILENAME);
    let published = false;
    let rootTempPath: string | null = null;
    try {
        await mkdir(join(generationPath, 'shards'), {recursive: true});
        await mkdir(join(generationPath, 'pages'), {recursive: true});
        const generationManifestPath = join(generationPath, GENERATION_MANIFEST_FILENAME);
        await writeAtomic(generationManifestPath, JSON.stringify(input.generation));
        await writeIndexFile(
            input.catalogRoot,
            input.generation.generation,
            input.generation.shardCount,
            input.sourceIndexPath,
            input.dirtyRecords,
            input.sourceShardCount,
        );
        await syncDirectory(generationPath);
        if (input.publishRoot === false) {
            // The generation directory entry itself was created below the
            // catalog root. Persist that entry before exposing the staged
            // generation to the descriptor writer.
            await syncDirectory(input.catalogRoot);
            return {
                rootPath,
                generationPath,
                published: false,
            };
        }
        const rootText = JSON.stringify(input.root);
        if (Buffer.byteLength(rootText, 'utf8') >= OCR_CATALOG_ROOT_MAX_BYTES) {
            throw new OcrCatalogCorruptError(`v4 root manifest must be smaller than ${OCR_CATALOG_ROOT_MAX_BYTES} bytes`);
        }
        await assertRegularFile(rootPath, ROOT_MANIFEST_FILENAME);
        rootTempPath = temporaryPath(rootPath);
        await writeFile(rootTempPath, rootText, 'utf8');
        await syncFile(rootTempPath);
        throwIfAborted(input.signal);
        await input.revisionFence();
        throwIfAborted(input.signal);
        await rename(rootTempPath, rootPath);
        rootTempPath = null;
        published = true;
    } catch (error) {
        return throwAfterCleanup(error, [
            ...(rootTempPath === null
                ? []
                : [() => removePathAndSync(rootTempPath!, input.catalogRoot)]),
            ...(!published
                ? [() => removePathAndSync(generationPath, input.catalogRoot)]
                : []),
        ]);
    }
    try {
        const syncRootDirectory = input.durabilityBoundary?.syncDirectory;
        if (syncRootDirectory === undefined) {
            await syncDirectory(input.catalogRoot);
        } else {
            await syncRootDirectory(input.catalogRoot, () => syncDirectory(input.catalogRoot));
        }
        await input.durabilityBoundary?.afterRootRename?.(
            input.catalogRoot,
            input.generation.generation,
        );
    } catch (error) {
        throw new OcrCatalogCommittedDurabilityError(
            input.catalogRoot,
            input.generation.generation,
            error,
        );
    }
    if (published) {
        await clearOcrCatalogRecoveryReceipt(input.catalogRoot);
    }
    return {
        rootPath,
        generationPath,
        published,
    };
}
type TPageIdentityDestinationRange =
    | IPageIdentityRangeMapping
    | IPageIdentityRangeInsert
    | IPageIdentityRangeTouch;
type TPageIdentityStructuralRange = IPageIdentityRangeMapping | IPageIdentityRangeInsert;

export interface IOcrCatalogV4RemapOptions {
    catalogRoot: string;
    delta: IPageIdentityDelta;
    nextRevision: IDocumentRevisionInfo | TDocumentRevisionToken;
    sourcePdfPath?: string;
    catalogId?: string;
    signal?: AbortSignal;
    durabilityBoundary?: IOcrCatalogV4DurabilityBoundary;
    assertRevisionCurrent?: () => Promise<void>;
}

export interface IOcrCatalogV4RemapResult {
    catalogRoot: string;
    catalogId: string;
    generation: number;
    parent: number;
    pageCount: number;
    mappedPageCount: number;
    dirtyShards: number[];
    published: true;
}

function checkedRangeEnd(start: number, count: number, maximum: number, label: string) {
    if (
        !Number.isSafeInteger(start)
        || start < 1
        || !Number.isSafeInteger(count)
        || count < 1
        || start > maximum
        || count > maximum - start + 1
    ) {
        throw new OcrCatalogCorruptError(`invalid ${label} range`);
    }
    return start + count - 1;
}

function findDestinationRange<T extends TPageIdentityDestinationRange>(
    ranges: readonly T[],
    pageNumber: number,
): T | null {
    let lower = 0;
    let upper = ranges.length;
    while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (ranges[middle]!.toPageNumber <= pageNumber) {
            lower = middle + 1;
        } else {
            upper = middle;
        }
    }
    const candidate = ranges[lower - 1];
    if (
        candidate !== undefined
        && pageNumber <= checkedRangeEnd(candidate.toPageNumber, candidate.count, Number.MAX_SAFE_INTEGER, 'destination')
    ) {
        return candidate;
    }
    return null;
}

function markShardSpan(shards: Set<number>, firstPage: number, lastPage: number) {
    const firstShard = Math.floor((firstPage - 1) / OCR_SHARD_SIZE);
    const lastShard = Math.floor((lastPage - 1) / OCR_SHARD_SIZE);
    for (let shard = firstShard; shard <= lastShard; shard += 1) {
        shards.add(shard);
    }
}

function validatePageIdentityRanges(
    delta: IPageIdentityDelta,
    previousPageCount: number,
    nextPageCount: number,
) {
    if (delta.pages !== undefined) {
        throw new OcrCatalogCorruptError('v4 page remapping requires range operations');
    }
    const ranges = getPageIdentityRangeOperations(delta);
    if (ranges.length === 0) {
        if (previousPageCount !== nextPageCount) {
            throw new OcrCatalogCorruptError('empty page identity ranges changed the page count');
        }
        return {
            destinationRanges: [] as TPageIdentityDestinationRange[],
            structuralRanges: [] as TPageIdentityStructuralRange[],
            touchRanges: [] as IPageIdentityRangeTouch[],
        };
    }

    const sourceRanges = ranges
        .filter((range): range is IPageIdentityRangeMapping | Extract<TPageIdentityRangeOperation, {kind: 'delete'}> => range.kind !== 'insert' && range.kind !== 'touch')
        .sort((left, right) => left.fromPageNumber - right.fromPageNumber);
    for (const range of ranges) {
        if (range.kind === 'retain' || range.kind === 'move') {
            checkedRangeEnd(range.fromPageNumber, range.count, previousPageCount, 'source');
            checkedRangeEnd(range.toPageNumber, range.count, nextPageCount, 'destination');
        } else if (range.kind === 'delete') {
            checkedRangeEnd(range.fromPageNumber, range.count, previousPageCount, 'deleted source');
        } else {
            checkedRangeEnd(range.toPageNumber, range.count, nextPageCount, 'destination');
        }
    }

    let expectedSource = 1;
    for (const range of sourceRanges) {
        if (range.fromPageNumber !== expectedSource) {
            throw new OcrCatalogCorruptError('page identity source ranges are not contiguous');
        }
        expectedSource = range.fromPageNumber + range.count;
    }
    if (expectedSource !== previousPageCount + 1) {
        throw new OcrCatalogCorruptError('page identity source ranges do not cover the source document');
    }

    const destinationRanges = ranges
        .filter((range): range is TPageIdentityDestinationRange => range.kind !== 'delete')
        .sort((left, right) => left.toPageNumber - right.toPageNumber || (left.kind === 'touch' ? 1 : -1));
    const structuralRanges = destinationRanges
        .filter((range): range is TPageIdentityStructuralRange => range.kind !== 'touch')
        .sort((left, right) => left.toPageNumber - right.toPageNumber);
    let expectedDestination = 1;
    for (const range of structuralRanges) {
        if (range.toPageNumber !== expectedDestination) {
            throw new OcrCatalogCorruptError('page identity destination ranges are not contiguous');
        }
        expectedDestination = range.toPageNumber + range.count;
    }
    if (expectedDestination !== nextPageCount + 1) {
        throw new OcrCatalogCorruptError('page identity destination ranges do not cover the output document');
    }

    const touchRanges = destinationRanges
        .filter((range): range is IPageIdentityRangeTouch => range.kind === 'touch')
        .sort((left, right) => left.toPageNumber - right.toPageNumber);
    let previousTouchEnd = 0;
    let structuralIndex = 0;
    for (const range of touchRanges) {
        const touchEnd = checkedRangeEnd(range.toPageNumber, range.count, nextPageCount, 'touched destination');
        if (range.toPageNumber <= previousTouchEnd) {
            throw new OcrCatalogCorruptError('page identity touch ranges overlap');
        }
        previousTouchEnd = touchEnd;
        while (
            structuralIndex + 1 < structuralRanges.length
            && checkedRangeEnd(
                structuralRanges[structuralIndex]!.toPageNumber,
                structuralRanges[structuralIndex]!.count,
                nextPageCount,
                'destination',
            ) < range.toPageNumber
        ) {
            structuralIndex += 1;
        }
        const containing = structuralRanges[structuralIndex];
        if (
            containing === undefined
            || containing.toPageNumber > range.toPageNumber
            || checkedRangeEnd(containing.toPageNumber, containing.count, nextPageCount, 'destination') < touchEnd
        ) {
            throw new OcrCatalogCorruptError('page identity touch range is not mapped to a destination range');
        }
    }

    return {
        destinationRanges,
        structuralRanges,
        touchRanges,
    };
}

/**
 * Remaps a v4 catalog through sparse page-identity ranges. The current fixed
 * index is copied in bounded chunks, and only destination shards whose
 * mappings change receive a new shard JSON file.
 */
export async function remapOcrCatalogV4(
    input: IOcrCatalogV4RemapOptions,
): Promise<IOcrCatalogV4RemapResult | null> {
    return withCatalogLock(input.catalogRoot, () => remapOcrCatalogV4Unlocked(input));
}

async function remapOcrCatalogV4Unlocked(
    input: IOcrCatalogV4RemapOptions,
): Promise<IOcrCatalogV4RemapResult | null> {
    throwIfAborted(input.signal);
    const current = await readCurrentCatalog(input.catalogRoot);
    if (current === null || current.kind !== 'v4') {
        return null;
    }
    const nextRevision = requireRevisionToken(input.nextRevision);
    const previousPageCount = current.root.pageCount;
    if (input.delta.previousPageCount !== previousPageCount) {
        throw new OcrCatalogFencedError(
            'OCR page identity delta does not match the published catalog page count',
            current.root.documentRevision.token,
            current.root.documentRevision.token,
        );
    }
    const declaredNextPageCount = getPageIdentityDeltaNextPageCount(input.delta);
    if (
        typeof declaredNextPageCount !== 'number'
        || !Number.isSafeInteger(declaredNextPageCount)
        || declaredNextPageCount < 0
    ) {
        throw new OcrCatalogCorruptError('page identity delta does not declare a valid next page count');
    }
    const nextPageCount = declaredNextPageCount;
    const {
        structuralRanges,
        touchRanges,
    } = validatePageIdentityRanges(
        input.delta,
        previousPageCount,
        nextPageCount,
    );
    const dirtyShards = new Set<number>();
    for (const range of structuralRanges) {
        const changed = range.kind === 'insert'
            || range.fromPageNumber !== range.toPageNumber;
        if (changed) {
            markShardSpan(
                dirtyShards,
                range.toPageNumber,
                checkedRangeEnd(range.toPageNumber, range.count, nextPageCount, 'destination'),
            );
        }
    }
    for (const range of touchRanges) {
        markShardSpan(
            dirtyShards,
            range.toPageNumber,
            checkedRangeEnd(range.toPageNumber, range.count, nextPageCount, 'touched destination'),
        );
    }
    if (
        nextPageCount < previousPageCount
        && nextPageCount > 0
        && nextPageCount % OCR_SHARD_SIZE !== 0
    ) {
        markShardSpan(dirtyShards, nextPageCount, nextPageCount);
    }

    const generation = await findNextGeneration(input.catalogRoot, current.root.generation);
    const catalogId = input.catalogId ?? current.root.catalogId;
    if (input.catalogId !== undefined && input.catalogId !== current.root.catalogId) {
        throw new OcrCatalogFencedError('Cannot remap an OCR catalog with a different catalogId');
    }
    assertCatalogId(catalogId);
    const pageCount = nextPageCount;
    const shardCount = expectedShardCount(pageCount);
    const generationPath = join(input.catalogRoot, generationDirectoryName(generation));
    try {
        await createGenerationDirectory(input.catalogRoot, generation);
    } catch (error) {
        return throwAfterCleanup(error, [() => removePathAndSync(generationPath, input.catalogRoot)]);
    }
    const liveRefs = asGenerationRecordMap(current.generation.liveRefs);
    liveRefs.set(generation, 0);
    const releasedGenerations = new Set<number>(current.generation.releasedGenerations);
    const releasedLegacyPaths = new Set<string>(current.generation.releasedLegacyPaths);
    const dirtyRecords = new Map<number, IOcrShardIndexRecord>();
    let mappedPageCount = current.generation.mappedPageCount;
    const nextShardCount = shardCount;
    if (nextShardCount < current.generation.shardCount) {
        const removedMappedPageCount = await sumIndexMappedCounts(
            current,
            nextShardCount,
            current.generation.shardCount - 1,
        );
        mappedPageCount -= removedMappedPageCount;
        if (mappedPageCount < 0) {
            throw new OcrCatalogCorruptError('page identity remap produced a negative mapped page count');
        }
        // The dropped terminal shards no longer belong to the next index. Keep
        // liveRefs accurate while scanning the fixed records in bounded chunks,
        // so orphan sweep can release generations that were used only there.
        await scanIndexRecords(
            current,
            nextShardCount,
            current.generation.shardCount - 1,
            (_shard, record) => {
                if (record.generation === 0) {
                    return;
                }
                const remaining = Math.max(0, (liveRefs.get(record.generation) ?? 0) - 1);
                liveRefs.set(record.generation, remaining);
                if (remaining === 0 && record.generation !== generation) {
                    releasedGenerations.add(record.generation);
                }
            },
        );
    }
    const removedLegacyCandidates = new Set<string>();
    const retainedLegacyPaths = new Set<string>();

    try {
        for (const shard of [...dirtyShards].sort((left, right) => left - right)) {
            throwIfAborted(input.signal);
            // A destination insertion can create a new terminal shard. Such a
            // shard has no source record and starts empty.
            const oldRecord = shard < current.generation.shardCount
                ? await readIndexRecordAt(current, shard)
                : {
                    generation: 0,
                    mappedCount: 0,
                    reserved: 0 as const,
                };
            const oldPages = oldRecord.generation === 0 || oldRecord.mappedCount === 0
                ? {}
                : await readSourceShard(current, shard, oldRecord);
            for (const mapping of Object.values(oldPages)) {
                if (mapping.generation === 0) {
                    removedLegacyCandidates.add(mapping.path);
                }
            }

            const firstPage = shard * OCR_SHARD_SIZE + 1;
            const lastPage = Math.min(pageCount, (shard + 1) * OCR_SHARD_SIZE);
            const nextPages: Record<string, IOcrPageMappingV4> = {};
            const sourcePagesByShard = new Map<number, Record<string, IOcrPageMappingV4>>();
            sourcePagesByShard.set(shard, oldPages);
            if (firstPage <= lastPage) {
                for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
                    const range = findDestinationRange(structuralRanges, pageNumber);
                    const touched = findDestinationRange(touchRanges, pageNumber);
                    if (range === null || range.kind === 'insert' || touched !== null) {
                        continue;
                    }
                    const sourcePageNumber = range.fromPageNumber + pageNumber - range.toPageNumber;
                    const sourceShard = Math.floor((sourcePageNumber - 1) / OCR_SHARD_SIZE);
                    let sourcePages = sourcePagesByShard.get(sourceShard);
                    if (sourcePages === undefined) {
                        const sourceRecord = await readIndexRecordAt(current, sourceShard);
                        sourcePages = sourceRecord.generation === 0 || sourceRecord.mappedCount === 0
                            ? {}
                            : await readSourceShard(current, sourceShard, sourceRecord);
                        sourcePagesByShard.set(sourceShard, sourcePages);
                    }
                    const mapping = sourcePages[String(sourcePageNumber)];
                    if (mapping !== undefined) {
                        nextPages[String(pageNumber)] = mapping;
                        if (mapping.generation === 0) {
                            retainedLegacyPaths.add(mapping.path);
                        }
                    }
                }
            }

            const mappedCount = Object.keys(nextPages).length;
            dirtyRecords.set(shard, mappedCount === 0
                ? {
                    generation: 0,
                    mappedCount: 0,
                    reserved: 0,
                }
                : {
                    generation,
                    mappedCount,
                    reserved: 0,
                });
            mappedPageCount += mappedCount - oldRecord.mappedCount;
            if (oldRecord.generation > 0) {
                const remaining = Math.max(0, (liveRefs.get(oldRecord.generation) ?? 0) - 1);
                liveRefs.set(oldRecord.generation, remaining);
                if (remaining === 0 && oldRecord.generation !== generation) {
                    releasedGenerations.add(oldRecord.generation);
                }
            }
            if (mappedCount > 0) {
                liveRefs.set(generation, (liveRefs.get(generation) ?? 0) + 1);
                await writeShard(input.catalogRoot, generation, shard, nextPages);
            }
        }
        for (const path of removedLegacyCandidates) {
            if (!retainedLegacyPaths.has(path)) {
                releasedLegacyPaths.add(path);
            }
        }

        const root: IOcrCatalogRootV4 = {
            version: OCR_CATALOG_VERSION,
            catalogId,
            source: {pdfPath: input.sourcePdfPath ?? current.root.source.pdfPath},
            documentRevision: {token: nextRevision},
            pageCount,
            shardSize: OCR_SHARD_SIZE,
            generation,
            publishedAt: createIsoTimestamp(),
        };
        const generationManifest: IOcrGenerationV4 = {
            version: OCR_CATALOG_VERSION,
            catalogId,
            generation,
            parent: current.root.generation,
            source: root.source,
            documentRevision: {token: nextRevision},
            pageCount,
            shardSize: OCR_SHARD_SIZE,
            shardCount,
            mappedPageCount,
            createdAt: createIsoTimestamp(),
            dirtyShards: [...dirtyShards].sort((left, right) => left - right),
            liveRefs: asLiveRefs(liveRefs),
            releasedGenerations: [...releasedGenerations].sort((left, right) => left - right),
            releasedLegacyPaths: [...releasedLegacyPaths].sort(),
        };
        const sourceRootRevision = current.root.documentRevision.token;
        const revisionFence = async () => {
            const latest = await readCurrentCatalog(input.catalogRoot);
            if (
                latest?.kind !== 'v4'
                || latest.root.generation !== current.root.generation
                || latest.root.documentRevision.token !== sourceRootRevision
            ) {
                throw new OcrCatalogFencedError(
                    'OCR catalog changed while page identities were being remapped',
                    sourceRootRevision,
                    latest?.kind === 'v4' ? latest.root.documentRevision.token : undefined,
                );
            }
            await input.assertRevisionCurrent?.();
        };
        await publishOcrCatalogV4GenerationUnlocked({
            catalogRoot: input.catalogRoot,
            root,
            generation: generationManifest,
            sourceIndexPath: current.indexPath,
            sourceShardCount: current.generation.shardCount,
            dirtyRecords,
            revisionFence,
            ...(input.signal === undefined ? {} : {signal: input.signal}),
            ...(input.durabilityBoundary === undefined ? {} : {durabilityBoundary: input.durabilityBoundary}),
        });
        return {
            catalogRoot: input.catalogRoot,
            catalogId,
            generation,
            parent: current.root.generation,
            pageCount,
            mappedPageCount,
            dirtyShards: [...dirtyShards].sort((left, right) => left - right),
            published: true,
        };
    } catch (error) {
        return throwAfterCleanup(error, isCommittedDurabilityError(error)
            ? []
            : [() => removePathAndSync(generationPath, input.catalogRoot)]);
    }
}

/** PageIdentityStore's range-only caller. */
export async function remapOcrCatalogV4PageRanges(
    workingCopyPath: string,
    delta: Pick<IPageIdentityDelta, 'previousPageCount' | 'nextPageCount' | 'ranges'>,
    nextRevision: IDocumentRevisionInfo,
    signal?: AbortSignal,
    durabilityBoundary?: IOcrCatalogV4DurabilityBoundary,
): Promise<boolean> {
    const result = await remapOcrCatalogV4({
        catalogRoot: `${workingCopyPath}.ocr`,
        delta,
        nextRevision,
        ...(signal === undefined ? {} : {signal}),
        ...(durabilityBoundary === undefined ? {} : {durabilityBoundary}),
    });
    return result !== null;
}

function revisionContext(
    value: IDocumentRevisionInfo | TDocumentRevisionToken | undefined,
    workingCopyPath: string | undefined,
    customFence: (() => Promise<void>) | undefined,
): IRevisionContext {
    const token = requireRevisionToken(value);
    const fence = customFence ?? (workingCopyPath === undefined
        ? async () => {}
        : () => assertWorkingCopyRevisionCurrent(workingCopyPath, token));
    return {
        token,
        fence,
    };
}
function assertCatalogId(catalogId: string) {
    if (!UUID_PATTERN.test(catalogId)) {
        throw new TypeError('OCR catalogId must be a UUID');
    }
}
async function createGenerationDirectory(catalogRoot: string, generation: number) {
    const generationPath = join(catalogRoot, generationDirectoryName(generation));
    try {
        await mkdir(generationPath, {recursive: false});
    } catch (error) {
        if (isErrnoCode(error, 'EEXIST')) {
            throw new OcrCatalogCorruptError(`generation ${generation} already exists`);
        }
        throw error;
    }
    await mkdir(join(generationPath, 'pages'), {recursive: true});
    await mkdir(join(generationPath, 'shards'), {recursive: true});
    return generationPath;
}

/** Source identity is shared by preparation, carry-forward, and publication. */
async function isSameSourcePdf(left: string, right: string): Promise<boolean> {
    if (resolve(left) === resolve(right)) {
        return true;
    }
    // macOS /var and /private/var can name the same validated working copy.
    // Failure to resolve either path must never authorize a different source.
    try {
        const [
            canonicalLeft,
            canonicalRight,
        ] = await Promise.all([
            realpath(left),
            realpath(right),
        ]);
        return canonicalLeft === canonicalRight;
    } catch {
        return false;
    }
}

async function createBuildState(input: {
    catalogRoot: string;
    sourcePdfPath: string;
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    generation: number;
    catalog: ICurrentV4Catalog | null;
    signal?: AbortSignal;
    catalogId: string;
    extractionDpi: number;
}) {
    const generationDirectory = generationDirectoryName(input.generation);
    await createGenerationDirectory(input.catalogRoot, input.generation);
    const carry = input.catalog !== null
        && input.catalog.root.documentRevision.token === input.documentRevision
        && await isSameSourcePdf(input.catalog.root.source.pdfPath, input.sourcePdfPath)
        && input.catalog.root.pageCount === input.pageCount;
    const sourceCatalog = carry ? input.catalog : null;
    const parent = sourceCatalog?.root.generation ?? null;
    const liveRefs = sourceCatalog
        ? asGenerationRecordMap(sourceCatalog.generation.liveRefs)
        : new Map<number, number>();
    liveRefs.set(input.generation, 0);
    const releasedGenerations = new Set<number>(sourceCatalog?.generation.releasedGenerations ?? []);
    const releasedLegacyPaths = new Set<string>();
    for (const path of sourceCatalog?.generation.releasedLegacyPaths ?? []) {
        if (path.length > 0 && path.length <= OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH) {
            releasedLegacyPaths.add(path);
        }
    }
    for (const [
        ownerGeneration,
        count,
    ] of liveRefs) {
        if (ownerGeneration > 0 && ownerGeneration !== input.generation && count === 0) {
            releasedGenerations.add(ownerGeneration);
        }
    }
    const state = {
        generation: input.generation,
        generationDirectory,
        catalogRoot: input.catalogRoot,
        pageCount: input.pageCount,
        source: {pdfPath: input.sourcePdfPath},
        documentRevision: input.documentRevision,
        catalogId: input.catalogId,
        extractionDpi: input.extractionDpi,
        parent,
        sourceCatalog,
        sourceIndexRecords: new Map<number, IOcrShardIndexRecord>(),
        liveRefs,
        dirtyShards: new Set<number>(),
        dirtyRecords: new Map<number, IOcrShardIndexRecord>(),
        touchedShards: new Set<number>(),
        releasedLegacyPaths,
        releasedGenerations,
        mappedPageCount: sourceCatalog?.generation.mappedPageCount ?? 0,
    } satisfies IGenerationBuildState;
    return {state};
}
function generationManifestFromState(state: IGenerationBuildState): IOcrGenerationV4 {
    const releasedLegacyPaths = [...state.releasedLegacyPaths]
        .filter(path => path.length > 0 && path.length <= OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH)
        .sort();
    return {
        version: OCR_CATALOG_VERSION,
        catalogId: state.catalogId,
        generation: state.generation,
        parent: state.parent,
        source: state.source,
        documentRevision: {token: state.documentRevision},
        pageCount: state.pageCount,
        shardSize: OCR_SHARD_SIZE,
        shardCount: expectedShardCount(state.pageCount),
        mappedPageCount: state.mappedPageCount,
        createdAt: createIsoTimestamp(),
        dirtyShards: [...state.dirtyShards].sort((left, right) => left - right),
        liveRefs: asLiveRefs(state.liveRefs),
        releasedGenerations: [...state.releasedGenerations].sort((left, right) => left - right),
        releasedLegacyPaths,
    };
}
function rootManifestFromState(state: IGenerationBuildState, catalogId: string): IOcrCatalogRootV4 {
    return {
        version: OCR_CATALOG_VERSION,
        catalogId,
        source: state.source,
        documentRevision: {token: state.documentRevision},
        pageCount: state.pageCount,
        shardSize: OCR_SHARD_SIZE,
        generation: state.generation,
        publishedAt: createIsoTimestamp(),
    };
}
async function publishBuildState(
    state: IGenerationBuildState,
    catalogId: string,
    revisionFence: () => Promise<void>,
    signal?: AbortSignal,
    publishRoot = true,
    durabilityBoundary?: IOcrCatalogV4DurabilityBoundary,
) {
    const generationManifest = generationManifestFromState(state);
    const root = rootManifestFromState(state, catalogId);
    return publishOcrCatalogV4GenerationUnlocked({
        catalogRoot: state.catalogRoot,
        root,
        generation: generationManifest,
        sourceIndexPath: state.sourceCatalog?.indexPath ?? null,
        ...(state.sourceCatalog === null ? {} : {sourceShardCount: state.sourceCatalog.generation.shardCount}),
        dirtyRecords: state.dirtyRecords,
        revisionFence,
        publishRoot,
        ...(durabilityBoundary === undefined ? {} : {durabilityBoundary}),
        ...(signal === undefined ? {} : {signal}),
    });
}
export async function writeOcrIndexV4(
    options: IOcrIndexV4WriteOptions,
): Promise<IOcrIndexV4WriteResult> {
    return withCatalogLock(options.catalogRoot, () => writeOcrIndexV4Unlocked(options));
}

async function writeOcrIndexV4Unlocked(
    options: IOcrIndexV4WriteOptions,
): Promise<IOcrIndexV4WriteResult> {
    const log = options.log ?? (() => {});
    throwIfAborted(options.signal);
    if (
        !Number.isSafeInteger(options.pageCount)
        || options.pageCount < 0
        || options.pageCount > OCR_MAX_PAGE_NUMBER
    ) {
        throw new RangeError('OCR v4 page count must be a safe non-negative integer');
    }
    if (typeof options.sourcePdfPath !== 'string' || options.sourcePdfPath.length === 0) {
        throw new TypeError('OCR v4 source PDF path must not be empty');
    }
    await mkdir(options.catalogRoot, {recursive: true});
    const current = await readCurrentCatalog(options.catalogRoot);
    const revision = revisionContext(
        options.documentRevision,
        options.workingCopyPath,
        options.assertRevisionCurrent,
    );
    const currentV4 = current;
    if (
        currentV4 !== null
        && options.catalogId !== undefined
        && options.catalogId !== currentV4.root.catalogId
    ) {
        throw new OcrCatalogFencedError('Cannot write an OCR catalog with a different catalogId');
    }
    const currentGeneration = currentV4?.root.generation ?? 0;
    const generation = await findNextGeneration(options.catalogRoot, currentGeneration);
    const catalogId = options.catalogId ?? currentV4?.root.catalogId ?? randomUUID();
    assertCatalogId(catalogId);
    try {
        const build = await createBuildState({
            catalogRoot: options.catalogRoot,
            sourcePdfPath: options.sourcePdfPath,
            documentRevision: revision.token,
            pageCount: options.pageCount,
            generation,
            catalog: currentV4,
            catalogId,
            extractionDpi: options.extractionDpi ?? 300,
            ...(options.signal === undefined ? {} : {signal: options.signal}),
        });
        const state = build.state;
        await consumePageBatches(state, options.pageBatches, options.signal);
        throwIfAborted(options.signal);
        const published = await publishBuildState(
            state,
            catalogId,
            revision.fence,
            options.signal,
            options.publishRoot !== false,
            options.durabilityBoundary,
        );
        log('debug', `Wrote OCR index v4 generation ${generation} with ${state.mappedPageCount} mapped pages`);
        return {
            catalogRoot: options.catalogRoot,
            catalogId,
            generation,
            parent: state.parent,
            pageCount: state.pageCount,
            mappedPageCount: state.mappedPageCount,
            dirtyShards: [...state.dirtyShards].sort((left, right) => left - right),
            published: published.published,
        };
    } catch (error) {
        return throwAfterCleanup(error, isCommittedDurabilityError(error)
            ? []
            : [() => removePathAndSync(
                join(options.catalogRoot, generationDirectoryName(generation)),
                options.catalogRoot,
            )]);
    }
}
function sourceRootRevision(current: TCurrentCatalog): TDocumentRevisionToken | null {
    return current?.root.documentRevision.token ?? null;
}

function sourceRootGeneration(current: TCurrentCatalog): number | null {
    return current?.root.generation ?? null;
}

function assertPreparedDescriptorMatchesResult(
    descriptor: IOcrCatalogV4PreparedDescriptor,
    input: Pick<IPublishOcrCatalogV4PreparedOptions, 'catalogRoot' | 'resultPath' | 'resultIdentity'>,
) {
    if (resolve(descriptor.catalogRoot) !== resolve(input.catalogRoot)) {
        throw new OcrCatalogFencedError('Prepared OCR catalog belongs to a different catalog root');
    }
    if (resolve(descriptor.resultPath) !== resolve(input.resultPath)) {
        throw new OcrCatalogFencedError('Prepared OCR catalog belongs to a different result PDF');
    }
    const resultIdentity = input.resultIdentity ?? resolve(input.resultPath);
    if (descriptor.resultIdentity !== resultIdentity) {
        throw new OcrCatalogFencedError('Prepared OCR catalog result identity does not match');
    }
}

async function readPreparedGeneration(
    catalogRoot: string,
    descriptor: IOcrCatalogV4PreparedDescriptor,
) {
    const directory = generationDirectoryName(descriptor.stagedGeneration);
    const generationPath = join(catalogRoot, directory, GENERATION_MANIFEST_FILENAME);
    const value = await readJsonFile(
        generationPath,
        `${directory}/${GENERATION_MANIFEST_FILENAME}`,
        catalogRoot,
    );
    const generation = value === null ? null : parseOcrGenerationV4(value);
    if (
        generation === null
        || generation.catalogId !== descriptor.catalogId
        || generation.generation !== descriptor.stagedGeneration
        || generation.pageCount !== descriptor.pageCount
    ) {
        throw new OcrCatalogCorruptError('prepared OCR catalog generation is invalid');
    }
    const indexPath = join(catalogRoot, directory, SHARD_INDEX_FILENAME);
    await validateIndexFile(indexPath, generation, generation.generation, catalogRoot);
    return {
        generation,
        indexPath,
    };
}

/**
 * Builds an immutable generation in the shared catalog directory and writes a
 * descriptor beside the staged PDF. The live manifest is left untouched.
 */
export async function prepareOcrCatalogV4Generation(
    options: IOcrIndexV4PrepareOptions,
): Promise<IOcrCatalogV4PreparedDescriptor> {
    throwIfAborted(options.signal);
    const current = await readCurrentCatalog(options.catalogRoot);
    const revision = requireRevisionToken(options.documentRevision);
    const currentRevision = sourceRootRevision(current);
    if (currentRevision !== null && currentRevision !== revision) {
        throw new OcrCatalogFencedError(
            'Cannot prepare OCR catalog from a different document revision',
            revision,
            currentRevision,
        );
    }
    const currentSourcePath = current?.root.source.pdfPath ?? null;
    if (currentSourcePath !== null && !await isSameSourcePdf(currentSourcePath, options.sourcePdfPath)) {
        throw new OcrCatalogFencedError('Cannot prepare OCR catalog from a different source PDF');
    }
    if (
        current !== null
        && options.catalogId !== undefined
        && options.catalogId !== current.root.catalogId
    ) {
        throw new OcrCatalogFencedError('Cannot prepare an OCR catalog with a different catalogId');
    }
    await options.assertRevisionCurrent?.();
    const writeResult = await writeOcrIndexV4({
        catalogRoot: options.catalogRoot,
        sourcePdfPath: options.sourcePdfPath,
        documentRevision: revision,
        pageCount: options.pageCount,
        pageBatches: options.pageBatches,
        publishRoot: false,
        ...(options.workingCopyPath === undefined ? {} : {workingCopyPath: options.workingCopyPath}),
        ...(options.catalogId === undefined ? {} : {catalogId: options.catalogId}),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
        ...(options.log === undefined ? {} : {log: options.log}),
        ...(options.extractionDpi === undefined ? {} : {extractionDpi: options.extractionDpi}),
        ...(options.assertRevisionCurrent === undefined ? {} : {assertRevisionCurrent: options.assertRevisionCurrent}),
    });
    const descriptorPath = resolve(
        options.descriptorPath ?? getOcrCatalogV4PreparedDescriptorPath(options.resultPath),
    );
    const descriptor: IOcrCatalogV4PreparedDescriptor = {
        version: OCR_CATALOG_PREPARED_DESCRIPTOR_VERSION,
        catalogId: writeResult.catalogId,
        catalogRoot: resolve(options.catalogRoot),
        sourceRootGeneration: sourceRootGeneration(current),
        sourceRootRevisionToken: currentRevision,
        stagedGeneration: writeResult.generation,
        pageCount: writeResult.pageCount,
        resultPath: resolve(options.resultPath),
        resultIdentity: options.resultIdentity ?? resolve(options.resultPath),
        createdAt: createIsoTimestamp(),
    };
    try {
        await writeAtomic(descriptorPath, JSON.stringify(descriptor));
    } catch (error) {
        return throwAfterCleanup(error, [() => removePathAndSync(
            join(options.catalogRoot, generationDirectoryName(writeResult.generation)),
            options.catalogRoot,
        )]);
    }
    return descriptor;
}

/** Validates a staged descriptor and publishes a tiny rebind generation. */
export async function publishPreparedOcrCatalogV4(
    input: IPublishOcrCatalogV4PreparedOptions,
): Promise<IOcrIndexV4WriteResult> {
    return withCatalogLock(input.catalogRoot, () => publishPreparedOcrCatalogV4Unlocked(input));
}

async function publishPreparedOcrCatalogV4Unlocked(
    input: IPublishOcrCatalogV4PreparedOptions,
): Promise<IOcrIndexV4WriteResult> {
    throwIfAborted(input.signal);
    const descriptorPath = resolve(
        input.descriptorPath
            ?? (typeof input.descriptor === 'string'
                ? input.descriptor
                : getOcrCatalogV4PreparedDescriptorPath(input.resultPath)),
    );
    const descriptor = typeof input.descriptor === 'string'
        ? await readOcrCatalogV4PreparedDescriptor(input.descriptor)
        : parseOcrCatalogV4PreparedDescriptor(input.descriptor);
    if (descriptor === null) {
        throw new OcrCatalogCorruptError('prepared OCR catalog descriptor is missing');
    }
    assertPreparedDescriptorMatchesResult(descriptor, input);
    const nextRevision = requireRevisionToken(input.nextRevision);
    const current = await readCurrentCatalog(input.catalogRoot);
    const actualSourceGeneration = sourceRootGeneration(current);
    const actualSourceRevision = sourceRootRevision(current);
    if (
        actualSourceGeneration !== descriptor.sourceRootGeneration
        || actualSourceRevision !== descriptor.sourceRootRevisionToken
    ) {
        throw new OcrCatalogFencedError(
            'OCR catalog changed before its prepared generation was applied',
            descriptor.sourceRootRevisionToken ?? undefined,
            actualSourceRevision ?? undefined,
        );
    }
    if (current !== null) {
        const currentPageCount = current.root.pageCount;
        if (currentPageCount !== descriptor.pageCount) {
            throw new OcrCatalogFencedError('OCR catalog page count changed before prepared generation apply');
        }
        const currentSourcePath = current.root.source.pdfPath;
        if (!await isSameSourcePdf(currentSourcePath, input.sourcePdfPath)) {
            throw new OcrCatalogFencedError('Prepared OCR catalog source PDF does not match the live catalog');
        }
        if (current.root.catalogId !== descriptor.catalogId) {
            throw new OcrCatalogFencedError('Prepared OCR catalog belongs to a different catalogId');
        }
    }
    const staged = await readPreparedGeneration(input.catalogRoot, descriptor);
    if (!await isSameSourcePdf(staged.generation.source.pdfPath, input.sourcePdfPath)) {
        throw new OcrCatalogFencedError('Prepared OCR generation source PDF does not match the apply request');
    }
    const currentGeneration = actualSourceGeneration ?? 0;
    const generation = await findNextGeneration(input.catalogRoot, currentGeneration);
    if (generation <= descriptor.stagedGeneration) {
        throw new OcrCatalogCorruptError('prepared OCR catalog generation is not older than the next generation');
    }
    const source = {pdfPath: input.sourcePdfPath};
    const root: IOcrCatalogRootV4 = {
        version: OCR_CATALOG_VERSION,
        catalogId: descriptor.catalogId,
        source,
        documentRevision: {token: nextRevision},
        pageCount: descriptor.pageCount,
        shardSize: OCR_SHARD_SIZE,
        generation,
        publishedAt: createIsoTimestamp(),
    };
    const generationManifest: IOcrGenerationV4 = {
        ...staged.generation,
        generation,
        parent: actualSourceGeneration,
        source,
        documentRevision: {token: nextRevision},
        createdAt: createIsoTimestamp(),
        dirtyShards: [],
        liveRefs: {
            ...staged.generation.liveRefs,
            [String(generation)]: 0,
        },
    };
    const sourceRevision = descriptor.sourceRootRevisionToken;
    const revisionFence = async () => {
        const latest = await readCurrentCatalog(input.catalogRoot);
        if (
            sourceRootGeneration(latest) !== descriptor.sourceRootGeneration
            || sourceRootRevision(latest) !== descriptor.sourceRootRevisionToken
        ) {
            throw new OcrCatalogFencedError(
                'OCR catalog changed while its prepared generation was being published',
                sourceRevision ?? undefined,
                sourceRootRevision(latest) ?? undefined,
            );
        }
        await input.assertRevisionCurrent?.();
    };
    await publishOcrCatalogV4GenerationUnlocked({
        catalogRoot: input.catalogRoot,
        root,
        generation: generationManifest,
        sourceIndexPath: join(input.catalogRoot, generationDirectoryName(descriptor.stagedGeneration), SHARD_INDEX_FILENAME),
        sourceShardCount: staged.generation.shardCount,
        dirtyRecords: new Map<number, IOcrShardIndexRecord>(),
        revisionFence,
        ...(input.signal === undefined ? {} : {signal: input.signal}),
        ...(input.durabilityBoundary === undefined ? {} : {durabilityBoundary: input.durabilityBoundary}),
    });
    await removePathAndSync(descriptorPath);
    return {
        catalogRoot: input.catalogRoot,
        catalogId: descriptor.catalogId,
        generation,
        parent: actualSourceGeneration,
        pageCount: descriptor.pageCount,
        mappedPageCount: staged.generation.mappedPageCount,
        dirtyShards: [],
        published: true,
    };
}

/** Drops a prepared descriptor and lets reachability cleanup remove its stage. */
export async function rollbackPreparedOcrCatalogV4(
    prepared: IOcrCatalogV4PreparedDescriptor | string,
    options: IRollbackOcrCatalogV4PreparedOptions = {},
): Promise<boolean> {
    const descriptorPath = resolve(
        options.descriptorPath
            ?? (typeof prepared === 'string'
                ? prepared
                : getOcrCatalogV4PreparedDescriptorPath(prepared.resultPath)),
    );
    const descriptor = typeof prepared === 'string'
        ? await readOcrCatalogV4PreparedDescriptor(prepared)
        : parseOcrCatalogV4PreparedDescriptor(prepared);
    if (descriptor === null) {
        return false;
    }
    await removePathAndSync(descriptorPath);
    if (options.catalogRoot !== undefined) {
        await sweepOcrCatalogV4Orphans(options.catalogRoot);
    }
    return true;
}

export async function sweepOcrCatalogV4Orphans(catalogRoot: string): Promise<number> {
    return withCatalogLock(catalogRoot, () => sweepOcrCatalogV4OrphansUnlocked(catalogRoot));
}

async function sweepOcrCatalogV4OrphansUnlocked(catalogRoot: string): Promise<number> {
    const current = await readCurrentCatalog(catalogRoot);
    if (current?.kind !== 'v4') {
        return 0;
    }
    const referenced = new Set<number>([current.root.generation]);
    const indexByteLength = expectedIndexByteLength(current.generation.shardCount);
    await assertIndexByteLength(current.indexPath, indexByteLength);
    const file = await openReadOnlyNoFollow(current.indexPath);
    try {
        await assertOpenFileByteLength(file, indexByteLength, SHARD_INDEX_FILENAME);
        for (let firstShard = 0; firstShard < current.generation.shardCount; firstShard += INDEX_COPY_CHUNK_RECORDS) {
            const count = Math.min(INDEX_COPY_CHUNK_RECORDS, current.generation.shardCount - firstShard);
            const buffer = Buffer.alloc(count * OCR_SHARD_INDEX_RECORD_BYTES);
            await readExactly(file, buffer, OCR_SHARD_INDEX_HEADER_BYTES + firstShard * OCR_SHARD_INDEX_RECORD_BYTES);
            for (let index = 0; index < count; index += 1) {
                const record = validateIndexRecord({
                    generation: buffer.readUInt32LE(index * OCR_SHARD_INDEX_RECORD_BYTES),
                    mappedCount: buffer.readUInt16LE(index * OCR_SHARD_INDEX_RECORD_BYTES + 4),
                    reserved: buffer.readUInt16LE(index * OCR_SHARD_INDEX_RECORD_BYTES + 6) as 0,
                }, firstShard + index, current.root.pageCount, current.root.generation);
                if (record.generation > 0) {
                    referenced.add(record.generation);
                    // A newly published shard may carry mappings whose page
                    // artifacts still live in an older generation. Keep those
                    // artifact generations alive as well. The fixed index
                    // records only identify shard owners, so ignoring the
                    // mapping generation would let an otherwise live page
                    // disappear during orphan cleanup.
                    const shard = firstShard + index;
                    const pages = await readSourceShard(current, shard, record);
                    for (const mapping of Object.values(pages)) {
                        if (mapping.generation > 0) {
                            referenced.add(mapping.generation);
                        }
                    }
                }
            }
        }
    } finally {
        await file.close();
    }
    const entries = await readdir(catalogRoot, {withFileTypes: true});
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory() || !GENERATION_DIRECTORY.test(entry.name)) {
            continue;
        }
        const generation = Number(entry.name.slice(4));
        if (referenced.has(generation)) {
            continue;
        }
        const generationPath = join(catalogRoot, entry.name);
        let generationStat;
        try {
            generationStat = await stat(generationPath);
        } catch (error) {
            if (isErrnoCode(error, 'ENOENT')) {
                continue;
            }
            throw error;
        }
        if (Date.now() - generationStat.mtimeMs < OCR_CATALOG_V4_ORPHAN_GRACE_MS) {
            continue;
        }
        if (hasOcrCatalogV4ReaderLease(catalogRoot)) {
            continue;
        }
        const latest = await readCurrentCatalog(catalogRoot);
        if (
            latest?.kind !== 'v4'
            || latest.root.catalogId !== current.root.catalogId
            || latest.root.generation !== current.root.generation
            || latest.root.documentRevision.token !== current.root.documentRevision.token
        ) {
            throw new OcrCatalogFencedError(
                'OCR catalog changed while orphan generations were being swept',
                current.root.documentRevision.token,
                latest?.kind === 'v4' ? latest.root.documentRevision.token : undefined,
            );
        }
        // Keep the CAS check adjacent to removal. The lock serializes local
        // writers, while this read catches a root replacement by another
        // process before deleting any generation.
        if (hasOcrCatalogV4ReaderLease(catalogRoot)) {
            continue;
        }
        await removePathAndSync(generationPath, catalogRoot);
        removed += 1;
    }
    if (removed > 0) {
        await syncDirectory(catalogRoot);
    }
    return removed;
}
