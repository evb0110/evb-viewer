import {
    lstat,
    mkdtemp,
    open,
    realpath,
    rm,
    stat,
} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {
    dirname,
    join,
    posix,
    relative,
    resolve,
    sep,
    win32,
} from 'node:path';
import {tmpdir} from 'node:os';
import type {
    IDocumentRevisionStamp,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import type {
    IOcrCatalogRootV4,
    IOcrCatalogSourceV4,
    IOcrGenerationV4,
    IOcrPageMappingV4,
    IOcrShardIndexRecord,
    IOcrShardV4,
    TOcrPageArtifact,
} from '@contracts/ocrIndex';
import {
    OCR_CATALOG_ROOT_MAX_BYTES,
    OCR_MAX_GENERATION,
    OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH,
    OCR_MAX_WINDOW_PAGES,
    OCR_MAX_PAGE_NUMBER,
    OCR_MAX_SHARD_NUMBER,
    OCR_SCALAR_PAGE_LIMIT,
    OCR_SHARD_INDEX_HEADER_BYTES,
    OCR_SHARD_INDEX_MAGIC,
    OCR_SHARD_INDEX_RECORD_BYTES,
    OCR_SHARD_SIZE,
    decodeOcrPage,
    parseOcrCatalogRootV4,
    parseOcrGenerationV4,
    parseOcrShardIndexHeader,
    parseOcrShardV4,
} from '@contracts/ocrIndex';
import type {IOcrIndexV3ManifestStreamMetadata} from '@electron/features/ocr/main/ocrIndexV3Stream';
import {
    OcrIndexV3ManifestStreamError,
    iterateOcrIndexV3ManifestMappings,
    readOcrIndexV3ManifestMetadata,
    streamOcrIndexV3ManifestMappings,
} from '@electron/features/ocr/main/ocrIndexV3Stream';

const OCR_CATALOG_MANIFEST_FILENAME = 'manifest.json' as const;
const OCR_CATALOG_GENERATION_MANIFEST_FILENAME = 'generation.json' as const;
const OCR_CATALOG_SHARD_INDEX_FILENAME = 'shards.idx' as const;

const CANONICAL_PAGE_PATH = /^gen-(\d{8,})\/pages\/(\d{6,})\/p(\d{8,})\.json$/u;
const CANONICAL_GENERATION_PATH = /^gen-\d{8,}\/(?:generation\.json|shards\.idx|shards\/shard-\d{6,}\.json|pages\/\d{6,}\/p\d{8,}\.json)$/u;
const INDEX_SCAN_CHUNK_RECORDS = 4_096;
/** JSON records are parsed only after a finite same-fd size check. */
const OCR_CATALOG_JSON_MAX_BYTES = 64 * 1024 * 1024;
// O_RDONLY is zero. These are the stable POSIX O_NOFOLLOW values used by the
// Electron hosts. Windows has no equivalent, so its validated lstat path is
// the fallback.
const READ_ONLY_NOFOLLOW_FLAGS = process.platform === 'darwin'
    ? 0x100
    : process.platform === 'linux'
        ? 0x20_000
        : 0;

/**
 * Reader leases are process-local. A forgotten handle stops protecting its
 * immutable generation after this interval, while an explicitly closed handle
 * releases its lease immediately.
 */
const OCR_CATALOG_READER_LEASE_TTL_MS = 30_000;

interface IOcrCatalogReaderLease {
    readonly catalogRoot: string;
    expiresAt: number;
    released: boolean;
}

const readerLeases = new Map<string, Set<IOcrCatalogReaderLease>>();
const readerLeaseFinalizer = typeof FinalizationRegistry === 'undefined'
    ? null
    : new FinalizationRegistry<IOcrCatalogReaderLease>(lease => {
        releaseReaderLease(lease);
    });

export type TOcrCatalogVersion = 3 | 4;

export interface IOcrCatalogHeader {
    version: TOcrCatalogVersion;
    catalogId?: string;
    source: IOcrCatalogSourceV4;
    documentRevision: IDocumentRevisionStamp;
    pageCount: number;
    generation: number;
    mappedPageCount: number;
    complete: boolean;
}

export interface IOcrCatalogWindowPage {
    pageNumber: number;
    artifact: TOcrPageArtifact | null;
}

export interface IOcrCatalogWindowMapping {
    pageNumber: number;
    mapping: IOcrPageMappingV4 | null;
}

export interface IOcrCatalogOpenOptions {
    mode?: 'readonly' | 'readwrite';
    expectedDocumentRevision?: TDocumentRevisionToken | IDocumentRevisionStamp;
    /** Alias used by callers that already call the value `documentRevision`. */
    documentRevision?: TDocumentRevisionToken | IDocumentRevisionStamp;
}

export interface IOcrCatalogHandle {
    readonly header: IOcrCatalogHeader;
    readPage(pageNumber: number): Promise<TOcrPageArtifact | null>;
    /** Yields one page at a time so callers can stop pulling once a budget is spent. */
    readWindow(start: number, count: number): AsyncIterable<IOcrCatalogWindowPage>;
    readWindowMappings(start: number, count: number): Promise<IOcrCatalogWindowMapping[]>;
    windowAvailability(start: number, count: number): Promise<Uint8Array>;
    iterateMappedPages(fromPage?: number): AsyncIterable<{
        pageNumber: number;
        artifact: TOcrPageArtifact
    }>;
    findFirstUnmapped(fromPage?: number): Promise<number | null>;
    close(): Promise<void>;
}

export interface IResolveCatalogPathOptions {kind?: 'legacy' | 'canonical-v4' | 'v4';}

class OcrCatalogError extends Error {
    readonly code: string;
    readonly subsystem = 'ocr';

    constructor(message: string, code = 'OCR_CATALOG_ERROR') {
        super(message);
        this.name = 'OcrCatalogError';
        this.code = code;
    }
}

export class OcrCatalogCorruptError extends OcrCatalogError {
    constructor(message: string) {
        super(`OCR catalog is corrupt: ${message}`, 'OCR_CATALOG_CORRUPT');
        this.name = 'OcrCatalogCorruptError';
    }
}

export class OcrCatalogPathError extends OcrCatalogError {
    readonly relativePath: string;

    constructor(message: string, relativePath = '') {
        super(`OCR catalog path is invalid: ${message}`, 'OCR_CATALOG_PATH');
        this.name = 'OcrCatalogPathError';
        this.relativePath = relativePath;
    }
}

export class OcrCatalogFencedError extends OcrCatalogError {
    readonly expectedRevision: TDocumentRevisionToken | undefined;
    readonly actualRevision: TDocumentRevisionToken | undefined;

    constructor(
        message = 'OCR catalog document revision changed while it was being read',
        expectedRevision?: TDocumentRevisionToken,
        actualRevision?: TDocumentRevisionToken,
    ) {
        super(message, 'OCR_CATALOG_FENCED');
        this.name = 'OcrCatalogFencedError';
        this.expectedRevision = expectedRevision;
        this.actualRevision = actualRevision;
    }
}

export class OcrCatalogTooLargeError extends OcrCatalogError {
    readonly pageCount: number;
    readonly limit: number;

    constructor(pageCount: number, limit = OCR_SCALAR_PAGE_LIMIT) {
        super(`OCR catalog snapshot is limited to ${limit} pages (catalog has ${pageCount})`, 'OCR_CATALOG_TOO_LARGE');
        this.name = 'OcrCatalogTooLargeError';
        this.pageCount = pageCount;
        this.limit = limit;
    }
}

export class OcrCatalogAbortedError extends OcrCatalogError {
    constructor(message = 'OCR catalog operation was aborted') {
        super(message, 'OCR_CATALOG_ABORTED');
        this.name = 'OcrCatalogAbortedError';
    }
}

function isErrnoCode(error: unknown, code: string): boolean {
    return !!error
        && typeof error === 'object'
        && 'code' in error
        && error.code === code;
}

function releaseReaderLease(lease: IOcrCatalogReaderLease): void {
    if (lease.released) {
        return;
    }
    lease.released = true;
    const leases = readerLeases.get(lease.catalogRoot);
    leases?.delete(lease);
    if (leases?.size === 0) {
        readerLeases.delete(lease.catalogRoot);
    }
}

function purgeExpiredReaderLeases(catalogRoot: string): Set<IOcrCatalogReaderLease> | undefined {
    const leases = readerLeases.get(catalogRoot);
    if (!leases) {
        return undefined;
    }
    const now = Date.now();
    for (const lease of leases) {
        if (lease.released || lease.expiresAt <= now) {
            releaseReaderLease(lease);
        }
    }
    return readerLeases.get(catalogRoot);
}

/** Returns true while a non-expired handle has the catalog root open. */
export function hasOcrCatalogV4ReaderLease(catalogRoot: string): boolean {
    const key = resolve(catalogRoot);
    return (purgeExpiredReaderLeases(key)?.size ?? 0) > 0;
}

function attachReaderLease<T extends IOcrCatalogHandle>(handle: T, catalogRoot: string): T {
    const key = resolve(catalogRoot);
    const lease: IOcrCatalogReaderLease = {
        catalogRoot: key,
        expiresAt: Date.now() + OCR_CATALOG_READER_LEASE_TTL_MS,
        released: false,
    };
    let leases = readerLeases.get(key);
    if (!leases) {
        leases = new Set<IOcrCatalogReaderLease>();
        readerLeases.set(key, leases);
    }
    leases.add(lease);
    const unregisterToken = {};
    readerLeaseFinalizer?.register(handle, lease, unregisterToken);
    const close = handle.close.bind(handle);
    let closed = false;
    handle.close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        releaseReaderLease(lease);
        readerLeaseFinalizer?.unregister(unregisterToken);
        await close();
    };
    return handle;
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

async function assertNoSymlinkAncestors(path: string, displayPath: string): Promise<void> {
    let cursor = resolve(path);
    for (;;) {
        try {
            const ancestorStat = await lstat(cursor);
            if (ancestorStat.isSymbolicLink()) {
                throw new OcrCatalogPathError(`symbolic links are not allowed: ${displayPath}`, displayPath);
            }
        } catch (error) {
            if (!isErrnoCode(error, 'ENOENT')) {
                throw error;
            }
        }
        const parent = dirname(cursor);
        if (parent === cursor) {
            return;
        }
        cursor = parent;
    }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
    return isSafeNonNegativeInteger(value) && value > 0;
}

function parseExpectedRevision(
    value: TDocumentRevisionToken | IDocumentRevisionStamp | undefined,
): TDocumentRevisionToken | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === 'string') {
        return parseDocumentRevisionToken(value) ?? undefined;
    }
    return parseDocumentRevisionToken(value.token) ?? undefined;
}

function assertExpectedRevision(
    expectedRevision: TDocumentRevisionToken | undefined,
    actualRevision: TDocumentRevisionToken,
) {
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
        throw new OcrCatalogFencedError(
            'OCR catalog document revision does not match the requested revision',
            expectedRevision,
            actualRevision,
        );
    }
}

function assertCatalogRootDirectory(root: string) {
    if (typeof root !== 'string' || root.length === 0) {
        throw new OcrCatalogPathError('catalog root must be a non-empty path');
    }
}

/**
 * Resolves a mapping path without allowing path APIs to reinterpret it. This
 * function is deliberately synchronous and side-effect free. Callers must
 * use readCatalogFile or assertCatalogRegularFile before opening the result.
 */
export function resolveCatalogPath(
    catalogRoot: string,
    relativePath: string,
    options: IResolveCatalogPathOptions = {},
): string {
    assertCatalogRootDirectory(catalogRoot);
    if (typeof relativePath !== 'string') {
        throw new OcrCatalogPathError('mapping path must be a string');
    }
    if (relativePath.length === 0) {
        throw new OcrCatalogPathError('mapping path must not be empty', relativePath);
    }
    if (relativePath.length > OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH) {
        throw new OcrCatalogPathError(
            `mapping path exceeds ${OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH} characters`,
            relativePath,
        );
    }
    if (
        relativePath.includes('\u0000')
        || relativePath.includes('\\')
        || relativePath.startsWith('/')
        || posix.isAbsolute(relativePath)
        || win32.isAbsolute(relativePath)
        || win32.parse(relativePath).root.length > 0
        || relativePath.split('/').some(segment => segment.length === 0)
    ) {
        throw new OcrCatalogPathError('mapping path must be a confined relative POSIX path', relativePath);
    }
    if (posix.normalize(relativePath) !== relativePath) {
        throw new OcrCatalogPathError('mapping path must already be normalized', relativePath);
    }
    if (relativePath.split('/').some(segment => segment === '.' || segment === '..')) {
        throw new OcrCatalogPathError('mapping path must not contain dot segments', relativePath);
    }

    const canonical = options.kind === 'canonical-v4'
        || options.kind === 'v4'
        || (options.kind !== 'legacy' && relativePath.startsWith('gen-'));
    if (canonical && !CANONICAL_GENERATION_PATH.test(relativePath)) {
        throw new OcrCatalogPathError('canonical v4 page path has an invalid shape', relativePath);
    }
    if (!canonical && relativePath.startsWith('gen-')) {
        throw new OcrCatalogPathError('legacy mapping paths must not start with gen-', relativePath);
    }
    return join(catalogRoot, relativePath);
}

export async function assertCatalogRegularFile(
    filePath: string,
    displayPath = filePath,
    catalogRoot?: string,
) {
    if (catalogRoot !== undefined) {
        const lexicalRootPath = resolve(catalogRoot);
        const lexicalTargetPath = resolve(filePath);
        const relativePath = relative(lexicalRootPath, lexicalTargetPath);
        if (
            relativePath === ''
            || relativePath === '..'
            || relativePath.startsWith(`..${sep}`)
            || posix.isAbsolute(relativePath)
            || win32.isAbsolute(relativePath)
        ) {
            throw new OcrCatalogPathError(`path escapes catalog root: ${displayPath}`, displayPath);
        }
        let lexicalRootStat;
        try {
            lexicalRootStat = await lstat(lexicalRootPath);
        } catch (error) {
            if (isErrnoCode(error, 'ENOENT')) {
                return false;
            }
            throw error;
        }
        if (lexicalRootStat.isSymbolicLink()) {
            throw new OcrCatalogPathError(`symbolic links are not allowed: ${displayPath}`, displayPath);
        }
        if (!lexicalRootStat.isDirectory()) {
            throw new OcrCatalogPathError(`catalog root is not a directory: ${displayPath}`, displayPath);
        }
        const rootPath = await realpath(lexicalRootPath);
        await assertNoSymlinkAncestors(rootPath, displayPath);
        let rootStat;
        try {
            rootStat = await lstat(rootPath);
        } catch (error) {
            if (isErrnoCode(error, 'ENOENT')) {
                return false;
            }
            throw error;
        }
        if (rootStat.isSymbolicLink()) {
            throw new OcrCatalogPathError(`symbolic links are not allowed: ${displayPath}`, displayPath);
        }
        if (!rootStat.isDirectory()) {
            throw new OcrCatalogPathError(`catalog root is not a directory: ${displayPath}`, displayPath);
        }
        const segments = relativePath.split(sep);
        let cursor = rootPath;
        for (const [
            index,
            segment,
        ] of segments.entries()) {
            cursor = join(cursor, segment);
            let ancestorStat;
            try {
                ancestorStat = await lstat(cursor);
            } catch (error) {
                if (isErrnoCode(error, 'ENOENT')) {
                    return false;
                }
                throw error;
            }
            if (ancestorStat.isSymbolicLink()) {
                throw new OcrCatalogPathError(`symbolic links are not allowed: ${displayPath}`, displayPath);
            }
            if (index < segments.length - 1 && !ancestorStat.isDirectory()) {
                throw new OcrCatalogPathError(`catalog ancestor is not a directory: ${displayPath}`, displayPath);
            }
            if (index === segments.length - 1 && !ancestorStat.isFile()) {
                throw new OcrCatalogPathError(`catalog entry is not a regular file: ${displayPath}`, displayPath);
            }
        }
        let canonicalTargetPath: string;
        try {
            canonicalTargetPath = await realpath(join(rootPath, relativePath));
        } catch (error) {
            if (isErrnoCode(error, 'ENOENT')) {
                return false;
            }
            throw error;
        }
        const canonicalRelativePath = relative(rootPath, canonicalTargetPath);
        if (
            canonicalRelativePath === ''
            || canonicalRelativePath === '..'
            || canonicalRelativePath.startsWith(`..${sep}`)
            || posix.isAbsolute(canonicalRelativePath)
            || win32.isAbsolute(canonicalRelativePath)
        ) {
            throw new OcrCatalogPathError(`path escapes catalog root: ${displayPath}`, displayPath);
        }
        return true;
    }
    let fileStat;
    try {
        fileStat = await lstat(filePath);
    } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }
    if (fileStat.isSymbolicLink()) {
        throw new OcrCatalogPathError(`symbolic links are not allowed: ${displayPath}`, displayPath);
    }
    if (!fileStat.isFile()) {
        throw new OcrCatalogPathError(`catalog entry is not a regular file: ${displayPath}`, displayPath);
    }
    return true;
}

export async function readBoundedFileContents(
    file: FileHandle,
    displayPath: string,
    maxBytes = OCR_CATALOG_JSON_MAX_BYTES,
): Promise<Buffer> {
    const before = await file.stat();
    if (
        !Number.isSafeInteger(before.size)
        || before.size < 0
        || before.size > maxBytes
    ) {
        throw new OcrCatalogCorruptError(
            `${displayPath} exceeds the ${maxBytes}-byte read limit`,
        );
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
        const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
        if (
            result.bytesRead <= 0
            || result.bytesRead > bytes.byteLength - offset
        ) {
            throw new OcrCatalogCorruptError(`truncated ${displayPath}`);
        }
        offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
        !Number.isSafeInteger(after.size)
        || after.size !== before.size
        || after.size > maxBytes
    ) {
        throw new OcrCatalogCorruptError(`${displayPath} changed while it was being read`);
    }
    return bytes;
}

export async function readCatalogFile(
    catalogRoot: string,
    relativePath: string,
    options: IResolveCatalogPathOptions = {},
): Promise<Buffer | null> {
    const filePath = resolveCatalogPath(catalogRoot, relativePath, options);
    if (!await assertCatalogRegularFile(filePath, relativePath, catalogRoot)) {
        return null;
    }
    const file = await openReadOnlyNoFollow(filePath);
    try {
        return await readBoundedFileContents(file, relativePath);
    } finally {
        await file.close();
    }
}

export async function readJsonFile(filePath: string, displayPath: string, catalogRoot?: string): Promise<unknown | null> {
    if (!await assertCatalogRegularFile(filePath, displayPath, catalogRoot)) {
        return null;
    }
    try {
        const file = await openReadOnlyNoFollow(filePath);
        try {
            return JSON.parse(
                (await readBoundedFileContents(file, displayPath)).toString('utf8'),
            ) as unknown;
        } finally {
            await file.close();
        }
    } catch (error) {
        if (error instanceof OcrCatalogPathError) {
            throw error;
        }
        throw new OcrCatalogCorruptError(`invalid JSON in ${displayPath}`);
    }
}

/** Reads only the bounded root prefix and rechecks its size on the same fd. */
async function readRootPrefix(
    filePath: string,
): Promise<{
    raw: Buffer;
    size: number
} | null> {
    let file: FileHandle;
    try {
        file = await openReadOnlyNoFollow(filePath);
    } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }
    try {
        const before = await file.stat();
        if (!Number.isSafeInteger(before.size) || before.size < 0) {
            return null;
        }
        // Always read the same small prefix. A root that grows after the
        // initial stat still cannot make this read allocate the whole file.
        const buffer = Buffer.alloc(OCR_CATALOG_ROOT_MAX_BYTES);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
            const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
            if (result.bytesRead <= 0) {
                break;
            }
            bytesRead += result.bytesRead;
        }
        const after = await file.stat();
        if (!Number.isSafeInteger(after.size) || after.size < 0) {
            return null;
        }
        if (after.size !== before.size) {
            throw new OcrCatalogCorruptError('root manifest changed while it was being read');
        }
        return {
            raw: buffer.subarray(0, bytesRead),
            size: after.size,
        };
    } finally {
        await file.close();
    }
}

function hasV4VersionMarker(rawText: string): boolean {
    return /"version"\s*:\s*(?:4(?:\D|$)|"4"(?:\s*[,}]))/u.test(rawText);
}

function generationDirectoryName(generation: number): string {
    if (!Number.isSafeInteger(generation) || generation < 0 || generation > OCR_MAX_GENERATION) {
        throw new OcrCatalogCorruptError(`generation ${generation} cannot be represented in a directory name`);
    }
    return `gen-${String(generation).padStart(8, '0')}`;
}

function shardFileName(shard: number): string {
    if (!Number.isSafeInteger(shard) || shard < 0 || shard > OCR_MAX_SHARD_NUMBER) {
        throw new OcrCatalogCorruptError(`shard ${shard} cannot be represented in a file name`);
    }
    return `shard-${String(shard).padStart(6, '0')}.json`;
}

function expectedIndexByteLength(shardCount: number): number {
    const recordBytes = shardCount * OCR_SHARD_INDEX_RECORD_BYTES;
    if (!Number.isSafeInteger(recordBytes) || recordBytes > Number.MAX_SAFE_INTEGER - OCR_SHARD_INDEX_HEADER_BYTES) {
        throw new OcrCatalogCorruptError('shard index length is not safely representable');
    }
    return OCR_SHARD_INDEX_HEADER_BYTES + recordBytes;
}

function validateIndexRecord(
    record: IOcrShardIndexRecord,
    shard: number,
    pageCount: number,
    rootGeneration: number,
): IOcrShardIndexRecord {
    const shardPageCount = Math.min(OCR_SHARD_SIZE, Math.max(0, pageCount - shard * OCR_SHARD_SIZE));
    if (
        !isSafeNonNegativeInteger(record.generation)
        || record.generation > rootGeneration
        || !isSafeNonNegativeInteger(record.mappedCount)
        || record.mappedCount > shardPageCount
        || (record.generation === 0 && record.mappedCount !== 0)
    ) {
        throw new OcrCatalogCorruptError(`invalid shard-index record ${shard}`);
    }
    return record;
}

export async function readExactly(
    file: FileHandle,
    buffer: Buffer,
    position: number,
): Promise<void> {
    if (
        !Number.isSafeInteger(position)
        || position < 0
        || !Number.isSafeInteger(buffer.byteLength)
        || position > Number.MAX_SAFE_INTEGER - buffer.byteLength
    ) {
        throw new OcrCatalogCorruptError('shard-index read offset is unsafe');
    }
    let offset = 0;
    while (offset < buffer.byteLength) {
        const result = await file.read(buffer, offset, buffer.byteLength - offset, position + offset);
        if (result.bytesRead <= 0) {
            throw new OcrCatalogCorruptError('truncated shard index');
        }
        offset += result.bytesRead;
    }
}

export async function assertIndexByteLength(indexPath: string, expectedLength: number): Promise<void> {
    let fileStat;
    try {
        fileStat = await stat(indexPath);
    } catch {
        throw new OcrCatalogCorruptError(`cannot stat ${OCR_CATALOG_SHARD_INDEX_FILENAME}`);
    }
    if (!Number.isSafeInteger(fileStat.size) || fileStat.size !== expectedLength) {
        throw new OcrCatalogCorruptError(
            `shard index length ${fileStat.size} does not equal ${expectedLength}`,
        );
    }
}

export async function assertOpenFileByteLength(
    file: FileHandle,
    expectedLength: number,
    displayPath: string,
): Promise<void> {
    const fileStat = await file.stat();
    if (!Number.isSafeInteger(fileStat.size) || fileStat.size !== expectedLength) {
        throw new OcrCatalogCorruptError(
            `${displayPath} length ${fileStat.size} does not equal ${expectedLength}`,
        );
    }
}

function decodeIndexRecord(buffer: Buffer, offset = 0): IOcrShardIndexRecord {
    if (offset < 0 || offset + OCR_SHARD_INDEX_RECORD_BYTES > buffer.byteLength) {
        throw new OcrCatalogCorruptError('shard-index record is truncated');
    }
    return {
        generation: buffer.readUInt32LE(offset),
        mappedCount: buffer.readUInt16LE(offset + 4),
        reserved: buffer.readUInt16LE(offset + 6) as 0,
    };
}

interface IOcrOpenV4State {
    readonly catalogRoot: string;
    readonly root: IOcrCatalogRootV4;
    readonly generation: IOcrGenerationV4;
    readonly indexPath: string;
    readonly indexByteLength: number;
}

async function readAndValidateIndexHeader(state: Pick<IOcrOpenV4State, 'indexPath' | 'root' | 'generation'>) {
    const expectedLength = expectedIndexByteLength(state.generation.shardCount);
    await assertIndexByteLength(state.indexPath, expectedLength);
    const file = await openReadOnlyNoFollow(state.indexPath);
    try {
        await assertOpenFileByteLength(file, expectedLength, OCR_CATALOG_SHARD_INDEX_FILENAME);
        const headerBuffer = Buffer.alloc(OCR_SHARD_INDEX_HEADER_BYTES);
        await readExactly(file, headerBuffer, 0);
        const parsedHeader = parseOcrShardIndexHeader(headerBuffer);
        if (
            parsedHeader === null
            || parsedHeader.shardSize !== OCR_SHARD_SIZE
            || parsedHeader.shardCount !== state.generation.shardCount
            || headerBuffer.toString('ascii', 0, OCR_SHARD_INDEX_MAGIC.length) !== OCR_SHARD_INDEX_MAGIC
        ) {
            throw new OcrCatalogCorruptError('invalid shard-index header');
        }
        let mappedPageCount = 0;
        for (let firstShard = 0; firstShard < state.generation.shardCount; firstShard += INDEX_SCAN_CHUNK_RECORDS) {
            const count = Math.min(
                INDEX_SCAN_CHUNK_RECORDS,
                state.generation.shardCount - firstShard,
            );
            const recordsBuffer = Buffer.alloc(count * OCR_SHARD_INDEX_RECORD_BYTES);
            const position = OCR_SHARD_INDEX_HEADER_BYTES + firstShard * OCR_SHARD_INDEX_RECORD_BYTES;
            if (
                !Number.isSafeInteger(position)
                || position < OCR_SHARD_INDEX_HEADER_BYTES
                || position + recordsBuffer.byteLength > expectedLength
            ) {
                throw new OcrCatalogCorruptError('shard-index scan offset is unsafe');
            }
            await readExactly(file, recordsBuffer, position);
            for (let index = 0; index < count; index += 1) {
                const record = validateIndexRecord(
                    decodeIndexRecord(recordsBuffer, index * OCR_SHARD_INDEX_RECORD_BYTES),
                    firstShard + index,
                    state.root.pageCount,
                    state.root.generation,
                );
                mappedPageCount += record.mappedCount;
                if (mappedPageCount > state.generation.mappedPageCount) {
                    throw new OcrCatalogCorruptError('shard-index mapped count exceeds generation manifest');
                }
            }
        }
        if (mappedPageCount !== state.generation.mappedPageCount) {
            throw new OcrCatalogCorruptError(
                `shard-index mapped count ${mappedPageCount} does not equal ${state.generation.mappedPageCount}`,
            );
        }
    } finally {
        await file.close();
    }
    return expectedLength;
}

async function readIndexRecord(state: IOcrOpenV4State, shard: number): Promise<IOcrShardIndexRecord> {
    if (!Number.isSafeInteger(shard) || shard < 0 || shard >= state.generation.shardCount) {
        throw new OcrCatalogCorruptError(`shard ${shard} is outside the index`);
    }
    const position = OCR_SHARD_INDEX_HEADER_BYTES + shard * OCR_SHARD_INDEX_RECORD_BYTES;
    if (
        !Number.isSafeInteger(position)
        || position < OCR_SHARD_INDEX_HEADER_BYTES
        || position + OCR_SHARD_INDEX_RECORD_BYTES > state.indexByteLength
    ) {
        throw new OcrCatalogCorruptError(`shard ${shard} has an unsafe index offset`);
    }
    await assertIndexByteLength(state.indexPath, state.indexByteLength);
    const file = await openReadOnlyNoFollow(state.indexPath);
    try {
        await assertOpenFileByteLength(file, state.indexByteLength, OCR_CATALOG_SHARD_INDEX_FILENAME);
        const recordBuffer = Buffer.alloc(OCR_SHARD_INDEX_RECORD_BYTES);
        await readExactly(file, recordBuffer, position);
        return validateIndexRecord(
            decodeIndexRecord(recordBuffer),
            shard,
            state.root.pageCount,
            state.root.generation,
        );
    } finally {
        await file.close();
    }
}

async function readIndexRecords(
    state: IOcrOpenV4State,
    firstShard: number,
    lastShard: number,
): Promise<IOcrShardIndexRecord[]> {
    if (
        !Number.isSafeInteger(firstShard)
        || !Number.isSafeInteger(lastShard)
        || firstShard < 0
        || lastShard < firstShard
        || lastShard >= state.generation.shardCount
    ) {
        throw new OcrCatalogCorruptError('requested shard range is outside the index');
    }
    const count = lastShard - firstShard + 1;
    const byteLength = count * OCR_SHARD_INDEX_RECORD_BYTES;
    const position = OCR_SHARD_INDEX_HEADER_BYTES + firstShard * OCR_SHARD_INDEX_RECORD_BYTES;
    if (
        !Number.isSafeInteger(byteLength)
        || !Number.isSafeInteger(position)
        || position + byteLength > state.indexByteLength
    ) {
        throw new OcrCatalogCorruptError('requested shard range has an unsafe index offset');
    }
    await assertIndexByteLength(state.indexPath, state.indexByteLength);
    const file = await openReadOnlyNoFollow(state.indexPath);
    try {
        await assertOpenFileByteLength(file, state.indexByteLength, OCR_CATALOG_SHARD_INDEX_FILENAME);
        const recordsBuffer = Buffer.alloc(byteLength);
        await readExactly(file, recordsBuffer, position);
        return Array.from({length: count}, (_value, index) => validateIndexRecord(
            decodeIndexRecord(recordsBuffer, index * OCR_SHARD_INDEX_RECORD_BYTES),
            firstShard + index,
            state.root.pageCount,
            state.root.generation,
        ));
    } finally {
        await file.close();
    }
}

export function canonicalPathParts(path: string) {
    const match = CANONICAL_PAGE_PATH.exec(path);
    if (!match) {
        return null;
    }
    const generation = Number(match[1]);
    const shard = Number(match[2]);
    const pageNumber = Number(match[3]);
    if (
        !Number.isSafeInteger(generation)
        || generation < 1
        || generation > OCR_MAX_GENERATION
        || !Number.isSafeInteger(shard)
        || shard < 0
        || shard > OCR_MAX_SHARD_NUMBER
        || !Number.isSafeInteger(pageNumber)
        || pageNumber < 1
        || pageNumber > OCR_MAX_PAGE_NUMBER
        || Math.floor((pageNumber - 1) / OCR_SHARD_SIZE) !== shard
    ) {
        return null;
    }
    return {
        generation,
        shard,
        pageNumber,
    };
}

function validateMappingPath(
    catalogRoot: string,
    mapping: IOcrPageMappingV4,
    pageNumber: number,
    shard: number,
    rootGeneration: number,
    ownerGeneration?: number,
) {
    if (ownerGeneration !== undefined && mapping.generation > ownerGeneration) {
        throw new OcrCatalogCorruptError(`mapping generation exceeds owning shard generation for page ${pageNumber}`);
    }
    const resolvedPath = resolveCatalogPath(
        catalogRoot,
        mapping.path,
        {kind: mapping.generation === 0 ? 'legacy' : 'canonical-v4'},
    );
    const canonical = canonicalPathParts(mapping.path);
    if (mapping.generation > 0 && canonical === null) {
        throw new OcrCatalogCorruptError(`canonical path is not safely representable for page ${pageNumber}`);
    }
    if (canonical !== null) {
        if (
            canonical.generation !== mapping.generation
            || canonical.generation < 1
            || canonical.generation > rootGeneration
        ) {
            throw new OcrCatalogCorruptError(`canonical path does not match generation for page ${pageNumber}`);
        }
    }
    return resolvedPath;
}

async function loadPageArtifact(
    catalogRoot: string,
    mapping: IOcrPageMappingV4,
    pageNumber: number,
    shard: number,
    rootGeneration: number,
    strictPath: boolean,
): Promise<TOcrPageArtifact | null> {
    let pagePath: string;
    try {
        pagePath = validateMappingPath(catalogRoot, mapping, pageNumber, shard, rootGeneration);
    } catch (error) {
        if (!strictPath && error instanceof OcrCatalogPathError) {
            return null;
        }
        throw error;
    }
    if (!await assertCatalogRegularFile(pagePath, mapping.path, catalogRoot)) {
        if (strictPath) {
            throw new OcrCatalogCorruptError(`missing page artifact ${mapping.path}`);
        }
        return null;
    }
    let value: unknown;
    try {
        const file = await openReadOnlyNoFollow(pagePath);
        try {
            value = JSON.parse(
                (await readBoundedFileContents(file, mapping.path)).toString('utf8'),
            ) as unknown;
        } finally {
            await file.close();
        }
    } catch (error) {
        if (!strictPath && (isErrnoCode(error, 'ENOENT') || error instanceof SyntaxError)) {
            return null;
        }
        if (error instanceof OcrCatalogPathError) {
            throw error;
        }
        if (strictPath) {
            throw new OcrCatalogCorruptError(`unable to read page artifact ${mapping.path}`);
        }
        return null;
    }
    const artifact = decodeOcrPage(value, 'strict');
    if (artifact === null && strictPath) {
        throw new OcrCatalogCorruptError(`invalid page artifact ${mapping.path}`);
    }
    return artifact;
}

function createHeaderFromV4(root: IOcrCatalogRootV4, generation: IOcrGenerationV4): IOcrCatalogHeader {
    return {
        version: 4,
        catalogId: root.catalogId,
        source: {pdfPath: root.source.pdfPath},
        documentRevision: {token: root.documentRevision.token},
        pageCount: root.pageCount,
        generation: root.generation,
        mappedPageCount: generation.mappedPageCount,
        complete: generation.mappedPageCount === root.pageCount,
    };
}

function createHeaderFromV3(manifest: IOcrIndexV3ManifestStreamMetadata): IOcrCatalogHeader {
    const mappedPageCount = manifest.mappedPageCount;
    return {
        version: 3,
        source: {pdfPath: manifest.source.pdfPath},
        documentRevision: {token: manifest.documentRevision.token},
        pageCount: manifest.pageCount,
        generation: 0,
        mappedPageCount,
        complete: mappedPageCount === manifest.pageCount,
    };
}

interface IOcrCatalogV3Mapping {
    path: string;
    generation?: string;
}

async function readV3WindowMappings(
    catalogRoot: string,
    manifestPath: string,
    metadata: IOcrIndexV3ManifestStreamMetadata,
    start: number,
    count: number,
): Promise<Map<number, IOcrCatalogV3Mapping>> {
    const end = start + count - 1;
    const mappings = new Map<number, IOcrCatalogV3Mapping>();
    if (!await assertCatalogRegularFile(manifestPath, OCR_CATALOG_MANIFEST_FILENAME, catalogRoot)) {
        throw new OcrCatalogCorruptError('v3 manifest disappeared while a window was being read');
    }
    try {
        const streamedMetadata = await streamOcrIndexV3ManifestMappings(manifestPath, mapping => {
            if (mapping.pageNumber >= start && mapping.pageNumber <= end) {
                resolveCatalogPath(catalogRoot, mapping.path, {kind: 'legacy'});
                mappings.set(mapping.pageNumber, {
                    path: mapping.path,
                    ...(mapping.generation === undefined ? {} : {generation: mapping.generation}),
                });
            }
        });
        if (
            streamedMetadata === null
            || streamedMetadata.documentRevision.token !== metadata.documentRevision.token
            || streamedMetadata.pageCount !== metadata.pageCount
        ) {
            throw new OcrCatalogCorruptError('v3 manifest changed while a window was being read');
        }
    } catch (error) {
        if (error instanceof OcrCatalogCorruptError) {
            throw error;
        }
        if (error instanceof OcrIndexV3ManifestStreamError) {
            throw new OcrCatalogCorruptError(`invalid v3 manifest: ${error.message}`);
        }
        throw error;
    }
    return mappings;
}

/**
 * Finds the first absent or unreadable v3 page in one manifest pass. The
 * legacy object is allowed to arrive in arbitrary property order, so a sparse
 * on-disk bitset records only page presence. The scan that follows reads at
 * most one 256-page window into memory.
 */
async function findFirstUnmappedV3Page(
    catalogRoot: string,
    manifestPath: string,
    metadata: IOcrIndexV3ManifestStreamMetadata,
    fromPage: number,
): Promise<number | null> {
    const bitmapBytes = Math.ceil(metadata.pageCount / 8);
    if (!Number.isSafeInteger(bitmapBytes) || bitmapBytes < 1) {
        throw new OcrCatalogCorruptError('v3 mapped-page bitset size is unsafe');
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-ocr-v3-page-bits-'));
    const bitmapPath = join(temporaryDirectory, 'mapped.bits');
    let bitmap: FileHandle | null = null;
    let firstUnreadablePage = null as number | null;
    const markUnreadable = (pageNumber: number) => {
        if (firstUnreadablePage === null || pageNumber < firstUnreadablePage) {
            firstUnreadablePage = pageNumber;
        }
    };
    try {
        bitmap = await open(bitmapPath, 'w+');
        await bitmap.truncate(bitmapBytes);
        let streamedMetadata: IOcrIndexV3ManifestStreamMetadata | null;
        try {
            streamedMetadata = await streamOcrIndexV3ManifestMappings(manifestPath, async mapping => {
                if (mapping.pageNumber < fromPage) {
                    return;
                }
                const byteOffset = Math.floor((mapping.pageNumber - 1) / 8);
                if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset >= bitmapBytes) {
                    throw new OcrCatalogCorruptError('v3 mapped-page bitset offset is unsafe');
                }
                const byte = Buffer.alloc(1);
                await readExactly(bitmap!, byte, byteOffset);
                byte[0] = byte[0]! | (1 << ((mapping.pageNumber - 1) % 8));
                let written = 0;
                while (written < byte.byteLength) {
                    const result = await bitmap!.write(byte, written, byte.byteLength - written, byteOffset + written);
                    if (result.bytesWritten <= 0) {
                        throw new OcrCatalogCorruptError('unable to update v3 mapped-page bitset');
                    }
                    written += result.bytesWritten;
                }
                try {
                    const path = resolveCatalogPath(catalogRoot, mapping.path, {kind: 'legacy'});
                    if (!await assertCatalogRegularFile(path, mapping.path, catalogRoot)) {
                        markUnreadable(mapping.pageNumber);
                    }
                } catch (error) {
                    if (error instanceof OcrCatalogPathError) {
                        markUnreadable(mapping.pageNumber);
                        return;
                    }
                    throw error;
                }
            });
        } catch (error) {
            if (error instanceof OcrCatalogCorruptError) {
                throw error;
            }
            if (error instanceof OcrIndexV3ManifestStreamError) {
                throw new OcrCatalogCorruptError(`invalid v3 manifest: ${error.message}`);
            }
            throw error;
        }
        if (
            streamedMetadata === null
            || streamedMetadata.documentRevision.token !== metadata.documentRevision.token
            || streamedMetadata.pageCount !== metadata.pageCount
        ) {
            throw new OcrCatalogCorruptError('v3 manifest changed while finding an unmapped page');
        }
        for (let firstPage = fromPage; firstPage <= metadata.pageCount; firstPage += OCR_MAX_WINDOW_PAGES) {
            if (firstUnreadablePage !== null && firstUnreadablePage <= firstPage) {
                return firstUnreadablePage;
            }
            const lastPage = Math.min(metadata.pageCount, firstPage + OCR_MAX_WINDOW_PAGES - 1);
            const firstByte = Math.floor((firstPage - 1) / 8);
            const lastByte = Math.floor((lastPage - 1) / 8);
            const bytes = Buffer.alloc(lastByte - firstByte + 1);
            await readExactly(bitmap, bytes, firstByte);
            for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
                if (firstUnreadablePage === pageNumber) {
                    return pageNumber;
                }
                const byte = bytes[Math.floor((pageNumber - 1) / 8) - firstByte]!;
                if ((byte & (1 << ((pageNumber - 1) % 8))) === 0) {
                    return pageNumber;
                }
            }
        }
        return firstUnreadablePage;
    } finally {
        if (bitmap !== null) {
            await bitmap.close();
        }
        await rm(temporaryDirectory, {
            recursive: true,
            force: true,
        });
    }
}

function assertPageNumberInRange(pageNumber: number, pageCount: number) {
    if (!isSafePositiveInteger(pageNumber) || pageNumber > pageCount) {
        throw new RangeError(`OCR catalog page number must be between 1 and ${pageCount}`);
    }
}

function assertWindowInRange(start: number, count: number, pageCount: number) {
    if (
        !isSafePositiveInteger(start)
        || !isSafePositiveInteger(count)
        || count > OCR_MAX_WINDOW_PAGES
        || start > pageCount
        || count > pageCount - start + 1
    ) {
        throw new RangeError(
            `OCR catalog windows require 1 <= count <= ${OCR_MAX_WINDOW_PAGES} within the page count`,
        );
    }
}

function shardForPage(pageNumber: number): number {
    return Math.floor((pageNumber - 1) / OCR_SHARD_SIZE);
}

class OcrCatalogV4Handle implements IOcrCatalogHandle {
    readonly header: IOcrCatalogHeader;
    private readonly state: IOcrOpenV4State;

    constructor(state: IOcrOpenV4State) {
        this.state = state;
        this.header = createHeaderFromV4(state.root, state.generation);
    }

    async close(): Promise<void> {
        // The v4 handle does not retain file descriptors. The public close
        // method releases the process-local reader lease installed by
        // openCatalog.
    }

    async readPage(pageNumber: number): Promise<TOcrPageArtifact | null> {
        assertPageNumberInRange(pageNumber, this.state.root.pageCount);
        const shard = shardForPage(pageNumber);
        const indexRecord = await readIndexRecord(this.state, shard);
        if (indexRecord.generation === 0 || indexRecord.mappedCount === 0) {
            return null;
        }
        const shardData = await this.readShard(shard, indexRecord);
        const mapping = shardData.pages[String(pageNumber)];
        if (!mapping) {
            return null;
        }
        return loadPageArtifact(
            this.state.catalogRoot,
            mapping,
            pageNumber,
            shard,
            this.state.root.generation,
            true,
        );
    }

    async *readWindow(start: number, count: number): AsyncIterable<IOcrCatalogWindowPage> {
        assertWindowInRange(start, count, this.state.root.pageCount);
        const firstShard = shardForPage(start);
        const lastShard = shardForPage(start + count - 1);
        const records = await readIndexRecords(this.state, firstShard, lastShard);
        const shardData = new Map<number, IOcrShardV4>();
        for (let index = 0; index < count; index += 1) {
            const pageNumber = start + index;
            const shard = shardForPage(pageNumber);
            const record = records[shard - firstShard];
            if (!record || record.generation === 0 || record.mappedCount === 0) {
                yield {
                    pageNumber,
                    artifact: null,
                };
                continue;
            }
            let shardDataForPage = shardData.get(shard);
            if (!shardDataForPage) {
                shardDataForPage = await this.readShard(shard, record);
                shardData.set(shard, shardDataForPage);
            }
            const mapping = shardDataForPage.pages[String(pageNumber)];
            yield {
                pageNumber,
                artifact: mapping
                    ? await loadPageArtifact(
                        this.state.catalogRoot,
                        mapping,
                        pageNumber,
                        shard,
                        this.state.root.generation,
                        false,
                    )
                    : null,
            };
        }
    }

    async readWindowMappings(start: number, count: number): Promise<IOcrCatalogWindowMapping[]> {
        assertWindowInRange(start, count, this.state.root.pageCount);
        const firstShard = shardForPage(start);
        const lastShard = shardForPage(start + count - 1);
        const records = await readIndexRecords(this.state, firstShard, lastShard);
        const shardData = new Map<number, IOcrShardV4>();
        const result: IOcrCatalogWindowMapping[] = [];
        for (let index = 0; index < count; index += 1) {
            const pageNumber = start + index;
            const shard = shardForPage(pageNumber);
            const record = records[shard - firstShard];
            if (!record || record.generation === 0 || record.mappedCount === 0) {
                result.push({
                    pageNumber,
                    mapping: null,
                });
                continue;
            }
            let shardDataForPage = shardData.get(shard);
            if (!shardDataForPage) {
                shardDataForPage = await this.readShard(shard, record);
                shardData.set(shard, shardDataForPage);
            }
            result.push({
                pageNumber,
                mapping: shardDataForPage.pages[String(pageNumber)] ?? null,
            });
        }
        return result;
    }

    async windowAvailability(start: number, count: number): Promise<Uint8Array> {
        assertWindowInRange(start, count, this.state.root.pageCount);
        const firstShard = shardForPage(start);
        const lastShard = shardForPage(start + count - 1);
        const records = await readIndexRecords(this.state, firstShard, lastShard);
        const shardData = new Map<number, IOcrShardV4>();
        const result = new Uint8Array(count);
        for (let index = 0; index < count; index += 1) {
            const pageNumber = start + index;
            const shard = shardForPage(pageNumber);
            const record = records[shard - firstShard];
            if (!record || record.generation === 0 || record.mappedCount === 0) {
                continue;
            }
            let shardDataForPage = shardData.get(shard);
            if (!shardDataForPage) {
                shardDataForPage = await this.readShard(shard, record);
                shardData.set(shard, shardDataForPage);
            }
            const mapping = shardDataForPage.pages[String(pageNumber)];
            if (!mapping) {
                continue;
            }
            const artifact = await loadPageArtifact(
                this.state.catalogRoot,
                mapping,
                pageNumber,
                shard,
                this.state.root.generation,
                false,
            );
            result[index] = artifact === null ? 0 : 1;
        }
        return result;
    }

    async *iterateMappedPages(fromPage = 1): AsyncIterable<{
        pageNumber: number;
        artifact: TOcrPageArtifact
    }> {
        if (!isSafePositiveInteger(fromPage) || fromPage > this.state.root.pageCount + 1) {
            throw new RangeError('OCR catalog iteration start is outside the page count');
        }
        if (fromPage === this.state.root.pageCount + 1) {
            return;
        }
        const firstShard = shardForPage(fromPage);
        for (let shard = firstShard; shard < this.state.generation.shardCount; shard += 1) {
            const record = await readIndexRecord(this.state, shard);
            if (record.generation === 0 || record.mappedCount === 0) {
                continue;
            }
            const shardData = await this.readShard(shard, record);
            const firstPage = Math.max(fromPage, shard * OCR_SHARD_SIZE + 1);
            const lastPage = Math.min(this.state.root.pageCount, (shard + 1) * OCR_SHARD_SIZE);
            for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
                const mapping = shardData.pages[String(pageNumber)];
                if (!mapping) {
                    continue;
                }
                const artifact = await loadPageArtifact(
                    this.state.catalogRoot,
                    mapping,
                    pageNumber,
                    shard,
                    this.state.root.generation,
                    true,
                );
                if (artifact) {
                    yield {
                        pageNumber,
                        artifact,
                    };
                }
            }
        }
    }

    async findFirstUnmapped(fromPage = 1): Promise<number | null> {
        if (!isSafePositiveInteger(fromPage) || fromPage > this.state.root.pageCount + 1) {
            throw new RangeError('OCR catalog search start is outside the page count');
        }
        if (fromPage === this.state.root.pageCount + 1) {
            return null;
        }
        const firstShard = shardForPage(fromPage);
        for (let shard = firstShard; shard < this.state.generation.shardCount; shard += 1) {
            const shardFirstPage = Math.max(fromPage, shard * OCR_SHARD_SIZE + 1);
            const shardLastPage = Math.min(this.state.root.pageCount, (shard + 1) * OCR_SHARD_SIZE);
            const expectedCount = shardLastPage - shard * OCR_SHARD_SIZE;
            const record = await readIndexRecord(this.state, shard);
            if (record.generation === 0) {
                return shardFirstPage;
            }
            const shardData = await this.readShard(shard, record);
            if (record.mappedCount < expectedCount) {
                for (let pageNumber = shardFirstPage; pageNumber <= shardLastPage; pageNumber += 1) {
                    if (!shardData.pages[String(pageNumber)]) {
                        return pageNumber;
                    }
                }
            }
        }
        return null;
    }

    private async readShard(shard: number, record: IOcrShardIndexRecord): Promise<IOcrShardV4> {
        const relativePath = `${generationDirectoryName(record.generation)}/shards/${shardFileName(shard)}`;
        const shardPath = join(this.state.catalogRoot, relativePath);
        const value = await readJsonFile(shardPath, relativePath, this.state.catalogRoot);
        if (value === null) {
            throw new OcrCatalogCorruptError(`missing shard ${shard}`);
        }
        const parsed = parseOcrShardV4(value, {
            expectedGeneration: record.generation,
            expectedShard: shard,
            expectedMappedCount: record.mappedCount,
            pageCount: this.state.root.pageCount,
            maxGeneration: this.state.root.generation,
        });
        if (parsed === null) {
            throw new OcrCatalogCorruptError(`invalid shard ${shard}`);
        }
        for (const [
            rawPageNumber,
            mapping,
        ] of Object.entries(parsed.pages)) {
            const pageNumber = Number(rawPageNumber);
            validateMappingPath(
                this.state.catalogRoot,
                mapping,
                pageNumber,
                shard,
                this.state.root.generation,
                record.generation,
            );
        }
        return parsed;
    }
}

class OcrCatalogV3Handle implements IOcrCatalogHandle {
    readonly header: IOcrCatalogHeader;
    private readonly catalogRoot: string;
    private readonly manifestPath: string;
    private readonly metadata: IOcrIndexV3ManifestStreamMetadata;

    constructor(
        catalogRoot: string,
        manifestPath: string,
        metadata: IOcrIndexV3ManifestStreamMetadata,
    ) {
        this.catalogRoot = catalogRoot;
        this.manifestPath = manifestPath;
        this.metadata = metadata;
        this.header = createHeaderFromV3(metadata);
    }

    async close(): Promise<void> {
        // The compatibility adapter also has no retained file descriptors.
    }

    async readPage(pageNumber: number): Promise<TOcrPageArtifact | null> {
        assertPageNumberInRange(pageNumber, this.metadata.pageCount);
        const mappings = await readV3WindowMappings(this.catalogRoot, this.manifestPath, this.metadata, pageNumber, 1);
        const mapping = mappings.get(pageNumber);
        if (!mapping) {
            return null;
        }
        const v4Mapping: IOcrPageMappingV4 = {
            path: mapping.path,
            generation: 0,
        };
        return loadPageArtifact(
            this.catalogRoot,
            v4Mapping,
            pageNumber,
            shardForPage(pageNumber),
            0,
            false,
        );
    }

    async *readWindow(start: number, count: number): AsyncIterable<IOcrCatalogWindowPage> {
        assertWindowInRange(start, count, this.metadata.pageCount);
        const mappings = await readV3WindowMappings(this.catalogRoot, this.manifestPath, this.metadata, start, count);
        for (let index = 0; index < count; index += 1) {
            const pageNumber = start + index;
            const mapping = mappings.get(pageNumber);
            yield {
                pageNumber,
                artifact: mapping === undefined
                    ? null
                    : await loadPageArtifact(
                        this.catalogRoot,
                        {
                            path: mapping.path,
                            generation: 0,
                        },
                        pageNumber,
                        shardForPage(pageNumber),
                        0,
                        false,
                    ),
            };
        }
    }

    async readWindowMappings(start: number, count: number): Promise<IOcrCatalogWindowMapping[]> {
        assertWindowInRange(start, count, this.metadata.pageCount);
        const mappings = await readV3WindowMappings(this.catalogRoot, this.manifestPath, this.metadata, start, count);
        const result: IOcrCatalogWindowMapping[] = [];
        for (let index = 0; index < count; index += 1) {
            const pageNumber = start + index;
            const mapping = mappings.get(pageNumber);
            result.push({
                pageNumber,
                mapping: mapping === undefined
                    ? null
                    : {
                        path: mapping.path,
                        generation: 0,
                    },
            });
        }
        return result;
    }

    async windowAvailability(start: number, count: number): Promise<Uint8Array> {
        assertWindowInRange(start, count, this.metadata.pageCount);
        const mappings = await readV3WindowMappings(this.catalogRoot, this.manifestPath, this.metadata, start, count);
        const result = new Uint8Array(count);
        for (let index = 0; index < count; index += 1) {
            const pageNumber = start + index;
            const mapping = mappings.get(pageNumber);
            if (!mapping) {
                continue;
            }
            const artifact = await loadPageArtifact(
                this.catalogRoot,
                {
                    path: mapping.path,
                    generation: 0,
                },
                pageNumber,
                shardForPage(pageNumber),
                0,
                false,
            );
            result[index] = artifact === null ? 0 : 1;
        }
        return result;
    }

    async *iterateMappedPages(fromPage = 1): AsyncIterable<{
        pageNumber: number;
        artifact: TOcrPageArtifact
    }> {
        if (!isSafePositiveInteger(fromPage) || fromPage > this.metadata.pageCount + 1) {
            throw new RangeError('OCR catalog iteration start is outside the page count');
        }
        if (!await assertCatalogRegularFile(this.manifestPath, OCR_CATALOG_MANIFEST_FILENAME, this.catalogRoot)) {
            throw new OcrCatalogCorruptError('v3 manifest disappeared while pages were being iterated');
        }
        try {
            for await (const mapping of iterateOcrIndexV3ManifestMappings(this.manifestPath)) {
                if (mapping.pageNumber < fromPage) {
                    continue;
                }
                const artifact = await loadPageArtifact(
                    this.catalogRoot,
                    {
                        path: mapping.path,
                        generation: 0,
                    },
                    mapping.pageNumber,
                    shardForPage(mapping.pageNumber),
                    0,
                    false,
                );
                if (artifact) {
                    yield {
                        pageNumber: mapping.pageNumber,
                        artifact,
                    };
                }
            }
        } catch (error) {
            if (error instanceof OcrIndexV3ManifestStreamError) {
                throw new OcrCatalogCorruptError(`invalid v3 manifest: ${error.message}`);
            }
            throw error;
        }
    }

    async findFirstUnmapped(fromPage = 1): Promise<number | null> {
        if (!isSafePositiveInteger(fromPage) || fromPage > this.metadata.pageCount + 1) {
            throw new RangeError('OCR catalog search start is outside the page count');
        }
        if (fromPage === this.metadata.pageCount + 1) {
            return null;
        }
        return findFirstUnmappedV3Page(
            this.catalogRoot,
            this.manifestPath,
            this.metadata,
            fromPage,
        );
    }
}

export type TOcrCatalogRootProbe =
    | {
        kind: 'v4';
        value: unknown
    }
    | {
        kind: 'v3';
        metadata: IOcrIndexV3ManifestStreamMetadata
    };

async function openV4Catalog(
    catalogRoot: string,
    rootValue: unknown,
    options: IOcrCatalogOpenOptions,
): Promise<IOcrCatalogHandle | null> {
    const root = parseOcrCatalogRootV4(rootValue);
    if (root === null) {
        throw new OcrCatalogCorruptError('published v4 root manifest is invalid');
    }
    assertExpectedRevision(
        parseExpectedRevision(options.expectedDocumentRevision ?? options.documentRevision),
        root.documentRevision.token,
    );
    const generationDirectory = generationDirectoryName(root.generation);
    const generationPath = join(catalogRoot, generationDirectory, OCR_CATALOG_GENERATION_MANIFEST_FILENAME);
    const generationValue = await readJsonFile(
        generationPath,
        `${generationDirectory}/${OCR_CATALOG_GENERATION_MANIFEST_FILENAME}`,
        catalogRoot,
    );
    if (generationValue === null) {
        throw new OcrCatalogCorruptError('published generation manifest is missing');
    }
    const generation = parseOcrGenerationV4(generationValue, root);
    if (generation === null) {
        throw new OcrCatalogCorruptError('published generation manifest is invalid');
    }
    const indexPath = join(catalogRoot, generationDirectory, OCR_CATALOG_SHARD_INDEX_FILENAME);
    if (!await assertCatalogRegularFile(
        indexPath,
        `${generationDirectory}/${OCR_CATALOG_SHARD_INDEX_FILENAME}`,
        catalogRoot,
    )) {
        throw new OcrCatalogCorruptError('published shard index is missing');
    }
    const stateWithoutLength = {
        catalogRoot,
        root,
        generation,
        indexPath,
    };
    const indexByteLength = await readAndValidateIndexHeader(stateWithoutLength);
    return new OcrCatalogV4Handle({
        ...stateWithoutLength,
        indexByteLength,
    });
}

export async function readCatalogRoot(catalogRoot: string): Promise<TOcrCatalogRootProbe | null> {
    const rootPath = join(catalogRoot, OCR_CATALOG_MANIFEST_FILENAME);
    if (!await assertCatalogRegularFile(rootPath, OCR_CATALOG_MANIFEST_FILENAME, catalogRoot)) {
        return null;
    }
    const prefix = await readRootPrefix(rootPath);
    if (prefix === null) {
        return null;
    }
    const {raw} = prefix;
    const fileSize = prefix.size;
    const rawText = raw.toString('utf8');
    const hasV4Marker = hasV4VersionMarker(rawText);
    if (fileSize >= OCR_CATALOG_ROOT_MAX_BYTES) {
        if (hasV4Marker) {
            throw new OcrCatalogCorruptError(
                `v4 root manifest must be smaller than ${OCR_CATALOG_ROOT_MAX_BYTES} bytes`,
            );
        }
        // v3 stores the complete page map in the root manifest. Parse only
        // the stream metadata here. Page mappings are consumed by the adapter
        // or explicit migration in bounded callbacks.
        const metadata = await readOcrIndexV3ManifestMetadata(rootPath);
        if (metadata !== null) {
            return {
                kind: 'v3',
                metadata,
            };
        }
        return null;
    }
    if (!hasV4Marker) {
        const metadata = await readOcrIndexV3ManifestMetadata(rootPath);
        return metadata === null
            ? null
            : {
                kind: 'v3',
                metadata,
            };
    }
    try {
        const parsed = JSON.parse(rawText) as unknown;
        return {
            kind: 'v4',
            value: parsed,
        };
    } catch (error) {
        if (error instanceof OcrCatalogCorruptError) {
            throw error;
        }
        throw new OcrCatalogCorruptError('published v4 root manifest is invalid JSON');
    }
}

/**
 * Opens either the current v4 catalog or the compatibility-only v3 catalog.
 * A malformed or unknown root is treated as an absent catalog. Once a v4 root
 * has been accepted, malformed generation/index data is a hard corruption
 * error because the root is already published state.
 */
export async function openCatalog(
    catalogRoot: string,
    options: IOcrCatalogOpenOptions = {},
): Promise<IOcrCatalogHandle | null> {
    assertCatalogRootDirectory(catalogRoot);
    const rootProbe = await readCatalogRoot(catalogRoot);
    if (rootProbe === null) {
        return null;
    }
    if (rootProbe.kind === 'v4') {
        const handle = await openV4Catalog(catalogRoot, rootProbe.value, options);
        return handle === null ? null : attachReaderLease(handle, catalogRoot);
    }
    assertExpectedRevision(
        parseExpectedRevision(options.expectedDocumentRevision ?? options.documentRevision),
        rootProbe.metadata.documentRevision.token,
    );
    return attachReaderLease(new OcrCatalogV3Handle(
        catalogRoot,
        join(catalogRoot, OCR_CATALOG_MANIFEST_FILENAME),
        rootProbe.metadata,
    ), catalogRoot);
}
