import type { TPageNumber } from '@contracts/pageNumbers';
import { parsePageNumber } from '@contracts/pageNumbers';

import type { IOcrWord } from '@contracts/shared';
import { isOcrWord } from '@contracts/shared';
import type {
    IDocumentRevisionStamp,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import { isRecord } from '@contracts/runtimeGuards';
import {
    isIsoTimestamp,
    type TIsoTimestamp,
} from '@contracts/timestamps';

/** The current sharded OCR catalog format. */
export const OCR_CATALOG_VERSION = 4 as const;
/** Page mappings are grouped in fixed-size, zero-based shards. */
export const OCR_SHARD_SIZE = 256 as const;
/** Reader windows may cross at most two adjacent shards. */
export const OCR_MAX_WINDOW_PAGES = OCR_SHARD_SIZE;
/** Whole-catalog compatibility snapshots are intentionally scalar-only. */
export const OCR_SCALAR_PAGE_LIMIT = 2_048 as const;
export const OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH = 1_024 as const;
export const OCR_CATALOG_ROOT_MAX_BYTES = 1_024 as const;
export const OCR_SHARD_INDEX_HEADER_BYTES = 16 as const;
export const OCR_SHARD_INDEX_RECORD_BYTES = 8 as const;
export const OCR_SHARD_INDEX_MAGIC = 'EVBOIDX4' as const;
/**
 * Generation owners are stored as u32 values. Canonical names use at least
 * eight decimal digits and widen when the counter grows.
 */
export const OCR_MAX_GENERATION = 0xFFFF_FFFF as const;
/** A u32 shard count with 256 pages per shard fits in this safe integer. */
export const OCR_MAX_PAGE_NUMBER = OCR_SHARD_SIZE * OCR_MAX_GENERATION;
export const OCR_MAX_SHARD_NUMBER = OCR_MAX_GENERATION - 1;
export const OCR_CATALOG_PREPARED_DESCRIPTOR_VERSION = 1 as const;

export type TOcrIndexRotation = 0 | 90 | 180 | 270;

/** One recognized page as stored in the catalog. */
export interface IOcrPageArtifact {
    readonly rotation: TOcrIndexRotation;
    readonly render: {
        readonly dpi: number;
        readonly imagePx: {
            readonly w: number;
            readonly h: number;
        };
    };
    readonly text: string;
    readonly words: readonly IOcrWord[];
    readonly canonicalText?: {
        readonly source: 'evb-ocr';
        readonly generation: string;
        readonly contentDigest: string;
    };
}

export type TOcrPageArtifact = IOcrPageArtifact;

export interface IOcrCatalogSourceV4 {readonly pdfPath: string;}

/** Small root manifest published at the existing `manifest.json` path. */
export interface IOcrCatalogRootV4 {
    readonly version: typeof OCR_CATALOG_VERSION;
    readonly catalogId: string;
    readonly source: IOcrCatalogSourceV4;
    readonly documentRevision: IDocumentRevisionStamp;
    readonly pageCount: number;
    readonly shardSize: typeof OCR_SHARD_SIZE;
    readonly generation: number;
    // The v4 root manifest is persisted on disk and keeps its established ISO wire format.
    readonly publishedAt: TIsoTimestamp;
}

export interface IOcrPageMappingV4 {
    /** Path relative to the catalog directory. */
    readonly path: string;
    /** Generation that first recorded the referenced page artifact. */
    readonly generation: number;
    /** Carried by mappings that older migrated catalogs still contain. */
    // Those mappings persist their established ISO wire format.
    readonly createdAt?: TIsoTimestamp;
}

/** Alias retained for callers that group this with the index types. */
export type IOcrIndexV4PageMapping = IOcrPageMappingV4;

export interface IOcrShardV4 {
    readonly version: typeof OCR_CATALOG_VERSION;
    readonly generation: number;
    readonly shard: number;
    readonly pages: Readonly<Record<string, IOcrPageMappingV4>>;
}

export interface IOcrShardIndexRecord {
    readonly generation: number;
    readonly mappedCount: number;
    readonly reserved: 0;
}

export interface IOcrShardIndex {
    readonly shardSize: typeof OCR_SHARD_SIZE;
    readonly shardCount: number;
    readonly records: readonly IOcrShardIndexRecord[];
}

export interface IOcrGenerationV4 {
    readonly version: typeof OCR_CATALOG_VERSION;
    readonly catalogId: string;
    readonly generation: number;
    readonly parent: number | null;
    readonly source: IOcrCatalogSourceV4;
    readonly documentRevision: IDocumentRevisionStamp;
    readonly pageCount: number;
    readonly shardSize: typeof OCR_SHARD_SIZE;
    readonly shardCount: number;
    readonly mappedPageCount: number;
    // Generation manifests are persisted on disk and keep their established ISO wire format.
    readonly createdAt: TIsoTimestamp;
    readonly dirtyShards: readonly number[];
    readonly liveRefs: Readonly<Record<string, number>>;
    readonly releasedGenerations: readonly number[];
    readonly releasedLegacyPaths: readonly string[];
}

/**
 * Descriptor for a generation prepared in the live catalog directory but not
 * yet rebound to the small root manifest. The result path and identity bind
 * that generation to the staged PDF that will trigger the eventual rebind.
 */
export interface IOcrCatalogV4PreparedDescriptor {
    readonly version: typeof OCR_CATALOG_PREPARED_DESCRIPTOR_VERSION;
    readonly catalogId: string;
    readonly catalogRoot: string;
    readonly sourceRootGeneration: number | null;
    readonly sourceRootRevisionToken: TDocumentRevisionToken | null;
    readonly stagedGeneration: number;
    readonly pageCount: number;
    readonly resultPath: string;
    readonly resultIdentity: string;
    // Prepared descriptors are persisted on disk and keep their established ISO wire format.
    readonly createdAt: TIsoTimestamp;
}

export type TOcrIndexDecodeMode = 'strict' | 'repair-legacy';

function isFinitePositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseOcrRotation(value: unknown): TOcrIndexRotation | null {
    return value === 0 || value === 90 || value === 180 || value === 270 ? value : null;
}

/**
 * Decodes a page artifact. Identity and freshness belong to the manifest that
 * points at the artifact, so `pageNumber` and `documentRevision` written by
 * older catalogs are ignored rather than validated.
 */
export function decodeOcrPage(
    value: unknown,
    mode: TOcrIndexDecodeMode = 'strict',
): IOcrPageArtifact | null {
    if (!isRecord(value)) {
        return null;
    }
    const strict = mode === 'strict';
    const rotation = parseOcrRotation(value.rotation);
    const render = isRecord(value.render) ? value.render : null;
    const imagePx = isRecord(render?.imagePx) ? render.imagePx : null;
    const dpi = isFinitePositiveNumber(render?.dpi) ? render.dpi : null;
    const width = isFinitePositiveNumber(imagePx?.w) ? imagePx.w : null;
    const height = isFinitePositiveNumber(imagePx?.h) ? imagePx.h : null;
    const text = typeof value.text === 'string' ? value.text : null;
    const words = Array.isArray(value.words) && value.words.every(isOcrWord) ? value.words : null;
    const canonicalText = isRecord(value.canonicalText)
        && value.canonicalText.source === 'evb-ocr'
        && typeof value.canonicalText.generation === 'string'
        && value.canonicalText.generation.length > 0
        && typeof value.canonicalText.contentDigest === 'string'
        && /^[a-f0-9]{64}$/u.test(value.canonicalText.contentDigest)
        ? {
            source: 'evb-ocr' as const,
            generation: value.canonicalText.generation,
            contentDigest: value.canonicalText.contentDigest,
        }
        : undefined;
    if (strict && (rotation === null || dpi === null || width === null || height === null || text === null || words === null)) {
        return null;
    }
    return {
        rotation: rotation ?? 0,
        render: {
            dpi: dpi ?? 0,
            imagePx: {
                w: width ?? 0,
                h: height ?? 0,
            },
        },
        text: text ?? '',
        words: words ?? [],
        ...(canonicalText ? {canonicalText} : {}),
    };
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

const isIsoDateString = isIsoTimestamp;

function isSafeCatalogRelativePath(value: string): boolean {
    if (
        value.length === 0
        || value.length > OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH
        || value.includes('\u0000')
        || value.includes('\\')
        || value.startsWith('/')
        || /^[a-z]:\//iu.test(value)
    ) {
        return false;
    }
    const segments = value.split('/');
    return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

const CANONICAL_PAGE_PATH_PARTS = /^gen-(\d{8,})\/pages\/(\d{6,})\/p(\d{8,})\.json$/u;

function parseCanonicalPagePath(value: string): {
    generation: number;
    shard: number;
    pageNumber: TPageNumber;
} | null {
    const match = CANONICAL_PAGE_PATH_PARTS.exec(value);
    if (match === null) {
        return null;
    }
    const generation = Number(match[1]);
    const shard = Number(match[2]);
    const pageNumber = Number(match[3]);
    const parsedPageNumber = parsePageNumber(pageNumber, OCR_MAX_PAGE_NUMBER);
    return isSafeNonNegativeInteger(generation)
        && generation > 0
        && generation <= OCR_MAX_GENERATION
        && isSafeNonNegativeInteger(shard)
        && shard <= OCR_MAX_SHARD_NUMBER
        && parsedPageNumber !== null
        && Math.floor((pageNumber - 1) / OCR_SHARD_SIZE) === shard
        ? {
            generation,
            shard,
            pageNumber: parsedPageNumber,
        }
        : null;
}

function isUuid(value: unknown): value is string {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parseCatalogSource(value: unknown): IOcrCatalogSourceV4 | null {
    if (!isRecord(value) || typeof value.pdfPath !== 'string' || value.pdfPath.length === 0) {
        return null;
    }
    return {pdfPath: value.pdfPath};
}

function parseDocumentRevisionStampStrict(value: unknown): IDocumentRevisionStamp | null {
    if (!isRecord(value)) {
        return null;
    }
    const token = parseDocumentRevisionToken(value.token);
    return token === null ? null : {token};
}

function parseSafeIntegerArray(value: unknown, maxExclusive: number): number[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const values: number[] = [];
    const seen = new Set<number>();
    for (const item of value) {
        if (!isSafeNonNegativeInteger(item) || item >= maxExclusive || seen.has(item)) {
            return null;
        }
        seen.add(item);
        values.push(item);
    }
    return values;
}

function parsePositiveGenerationArray(value: unknown): number[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const values: number[] = [];
    const seen = new Set<number>();
    for (const item of value) {
        if (!isSafeNonNegativeInteger(item) || item < 1 || seen.has(item)) {
            return null;
        }
        seen.add(item);
        values.push(item);
    }
    return values;
}

function parseReleasedLegacyPaths(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const paths: string[] = [];
    for (const item of value) {
        if (
            typeof item !== 'string'
            || !isSafeCatalogRelativePath(item)
            || item.startsWith('gen-')
        ) {
            return null;
        }
        paths.push(item);
    }
    return paths;
}

/** Strictly decodes the v4 root manifest. */
export function parseOcrCatalogRootV4(value: unknown): IOcrCatalogRootV4 | null {
    if (!isRecord(value) || value.version !== OCR_CATALOG_VERSION) {
        return null;
    }
    const source = parseCatalogSource(value.source);
    const documentRevision = parseDocumentRevisionStampStrict(value.documentRevision);
    if (
        !isUuid(value.catalogId)
        || source === null
        || documentRevision === null
        || !isSafeNonNegativeInteger(value.pageCount)
        || value.pageCount > OCR_MAX_PAGE_NUMBER
        || value.shardSize !== OCR_SHARD_SIZE
        || !isSafeNonNegativeInteger(value.generation)
        || value.generation < 1
        || value.generation > OCR_MAX_GENERATION
        || !isIsoDateString(value.publishedAt)
    ) {
        return null;
    }
    return {
        version: OCR_CATALOG_VERSION,
        catalogId: value.catalogId,
        source,
        documentRevision,
        pageCount: value.pageCount,
        shardSize: OCR_SHARD_SIZE,
        generation: value.generation,
        publishedAt: value.publishedAt,
    };
}

/** Strictly decodes a completed immutable generation manifest. */
export function parseOcrGenerationV4(
    value: unknown,
    expectedRoot?: Pick<IOcrCatalogRootV4, 'catalogId' | 'generation' | 'source' | 'documentRevision' | 'pageCount'>,
): IOcrGenerationV4 | null {
    if (!isRecord(value) || value.version !== OCR_CATALOG_VERSION) {
        return null;
    }
    const source = parseCatalogSource(value.source);
    const documentRevision = parseDocumentRevisionStampStrict(value.documentRevision);
    const generation = isSafeNonNegativeInteger(value.generation) ? value.generation : null;
    const shardCount = isSafeNonNegativeInteger(value.shardCount) ? value.shardCount : null;
    const expectedShardCount = isSafeNonNegativeInteger(value.pageCount)
        ? Math.ceil(value.pageCount / OCR_SHARD_SIZE)
        : null;
    const dirtyShards = parseSafeIntegerArray(value.dirtyShards, shardCount ?? 0);
    const releasedGenerations = parsePositiveGenerationArray(value.releasedGenerations);
    const releasedLegacyPaths = parseReleasedLegacyPaths(value.releasedLegacyPaths);
    const liveRefs: Record<string, number> = {};
    if (isRecord(value.liveRefs)) {
        for (const [
            rawGeneration,
            rawCount,
        ] of Object.entries(value.liveRefs)) {
            const generation = Number(rawGeneration);
            if (
                (rawGeneration !== '0' && String(generation) !== rawGeneration)
                || !isSafeNonNegativeInteger(generation)
                || generation > OCR_MAX_GENERATION
                || !isSafeNonNegativeInteger(rawCount)
            ) {
                return null;
            }
            liveRefs[rawGeneration] = rawCount;
        }
    } else {
        return null;
    }
    if (
        !isUuid(value.catalogId)
        || generation === null
        || generation < 1
        || generation > OCR_MAX_GENERATION
        || (value.parent !== null && !isSafeNonNegativeInteger(value.parent))
        || (value.parent !== null && (value.parent < 1 || value.parent >= generation))
        || source === null
        || documentRevision === null
        || !isSafeNonNegativeInteger(value.pageCount)
        || value.pageCount > OCR_MAX_PAGE_NUMBER
        || value.shardSize !== OCR_SHARD_SIZE
        || shardCount === null
        || shardCount > 0xFFFF_FFFF
        || shardCount !== expectedShardCount
        || !isSafeNonNegativeInteger(value.mappedPageCount)
        || value.mappedPageCount > value.pageCount
        || !isIsoDateString(value.createdAt)
        || dirtyShards === null
        || releasedGenerations === null
        || releasedLegacyPaths === null
        || releasedGenerations.some(releasedGeneration => releasedGeneration >= generation)
        || (expectedRoot !== undefined && (
            value.catalogId !== expectedRoot.catalogId
            || value.generation !== expectedRoot.generation
            || value.pageCount !== expectedRoot.pageCount
            || source.pdfPath !== expectedRoot.source.pdfPath
            || documentRevision.token !== expectedRoot.documentRevision.token
        ))
    ) {
        return null;
    }
    return {
        version: OCR_CATALOG_VERSION,
        catalogId: value.catalogId,
        generation,
        parent: value.parent,
        source,
        documentRevision,
        pageCount: value.pageCount,
        shardSize: OCR_SHARD_SIZE,
        shardCount,
        mappedPageCount: value.mappedPageCount,
        createdAt: value.createdAt,
        dirtyShards,
        liveRefs,
        releasedGenerations,
        releasedLegacyPaths,
    };
}

/** Strictly decodes a prepared-generation descriptor. */
export function parseOcrCatalogV4PreparedDescriptor(
    value: unknown,
): IOcrCatalogV4PreparedDescriptor | null {
    if (!isRecord(value) || value.version !== OCR_CATALOG_PREPARED_DESCRIPTOR_VERSION) {
        return null;
    }
    const sourceRootGeneration = value.sourceRootGeneration === null
        ? null
        : (isSafeNonNegativeInteger(value.sourceRootGeneration)
            && value.sourceRootGeneration >= 1
            && value.sourceRootGeneration <= OCR_MAX_GENERATION
            ? value.sourceRootGeneration
            : undefined);
    const sourceRootRevisionToken = value.sourceRootRevisionToken === null
        ? null
        : (parseDocumentRevisionToken(value.sourceRootRevisionToken) ?? undefined);
    if (
        !isUuid(value.catalogId)
        || typeof value.catalogRoot !== 'string'
        || value.catalogRoot.length === 0
        || typeof value.resultPath !== 'string'
        || value.resultPath.length === 0
        || typeof value.resultIdentity !== 'string'
        || value.resultIdentity.length === 0
        || sourceRootGeneration === undefined
        || sourceRootRevisionToken === undefined
        || !isSafeNonNegativeInteger(value.stagedGeneration)
        || value.stagedGeneration < 1
        || value.stagedGeneration > OCR_MAX_GENERATION
        || !isSafeNonNegativeInteger(value.pageCount)
        || value.pageCount > OCR_MAX_PAGE_NUMBER
        || !isIsoDateString(value.createdAt)
    ) {
        return null;
    }
    return {
        version: OCR_CATALOG_PREPARED_DESCRIPTOR_VERSION,
        catalogId: value.catalogId,
        catalogRoot: value.catalogRoot,
        sourceRootGeneration,
        sourceRootRevisionToken,
        stagedGeneration: value.stagedGeneration,
        pageCount: value.pageCount,
        resultPath: value.resultPath,
        resultIdentity: value.resultIdentity,
        createdAt: value.createdAt,
    };
}

function parsePageMappingV4(value: unknown): IOcrPageMappingV4 | null {
    if (!isRecord(value)) {
        return null;
    }
    const createdAt = value.createdAt === undefined
        ? undefined
        : (isIsoDateString(value.createdAt) ? value.createdAt : null);
    const canonical = typeof value.path === 'string'
        && value.generation !== undefined
        && value.generation !== 0
        ? parseCanonicalPagePath(value.path)
        : null;
    if (
        typeof value.path !== 'string'
        || !isSafeCatalogRelativePath(value.path)
        || !isSafeNonNegativeInteger(value.generation)
        || value.generation > OCR_MAX_GENERATION
        || createdAt === null
        || (value.generation === 0 && value.path.startsWith('gen-'))
        || (value.generation > 0 && canonical === null)
        || (value.generation > 0 && canonical?.generation !== value.generation)
    ) {
        return null;
    }
    return {
        path: value.path,
        generation: value.generation,
        ...(createdAt === undefined ? {} : {createdAt}),
    };
}

/** Strictly decodes one fixed-range mapping shard. */
export function parseOcrShardV4(
    value: unknown,
    options: {
        expectedGeneration?: number;
        expectedShard?: number;
        expectedMappedCount?: number;
        pageCount?: number;
        maxGeneration?: number;
    } = {},
): IOcrShardV4 | null {
    if (!isRecord(value) || value.version !== OCR_CATALOG_VERSION || !isRecord(value.pages)) {
        return null;
    }
    const generation = isSafeNonNegativeInteger(value.generation) ? value.generation : null;
    const shard = isSafeNonNegativeInteger(value.shard) ? value.shard : null;
    if (
        generation === null
        || shard === null
        || generation < 1
        || generation > OCR_MAX_GENERATION
        || shard > OCR_MAX_SHARD_NUMBER
        || (options.expectedGeneration !== undefined && generation !== options.expectedGeneration)
        || (options.expectedShard !== undefined && shard !== options.expectedShard)
        || (options.maxGeneration !== undefined && generation > options.maxGeneration)
        || (options.pageCount !== undefined
            && (!isSafeNonNegativeInteger(options.pageCount) || options.pageCount > OCR_MAX_PAGE_NUMBER))
    ) {
        return null;
    }
    const pages: Record<string, IOcrPageMappingV4> = {};
    const firstPage = shard * OCR_SHARD_SIZE + 1;
    const lastPage = options.pageCount === undefined
        ? firstPage + OCR_SHARD_SIZE - 1
        : Math.min(options.pageCount, firstPage + OCR_SHARD_SIZE - 1);
    if (options.pageCount !== undefined && shard >= Math.ceil(options.pageCount / OCR_SHARD_SIZE)) {
        return null;
    }
    if (firstPage > lastPage && Object.keys(value.pages).length > 0) {
        return null;
    }
    for (const [
        rawPageNumber,
        rawMapping,
    ] of Object.entries(value.pages)) {
        const pageNumber = Number(rawPageNumber);
        const mapping = parsePageMappingV4(rawMapping);
        if (
            !isSafeNonNegativeInteger(pageNumber)
            || pageNumber < firstPage
            || pageNumber > lastPage
            || String(pageNumber) !== rawPageNumber
            || mapping === null
            || (options.expectedGeneration !== undefined
                && mapping.generation > options.expectedGeneration)
            || (options.maxGeneration !== undefined && mapping.generation > options.maxGeneration)
            || (mapping.generation === 0 && mapping.path.startsWith('gen-'))
        ) {
            return null;
        }
        pages[rawPageNumber] = mapping;
    }
    if (options.expectedMappedCount !== undefined && Object.keys(pages).length !== options.expectedMappedCount) {
        return null;
    }
    return {
        version: OCR_CATALOG_VERSION,
        generation,
        shard,
        pages,
    };
}

/** Decodes only the fixed 16-byte shard-index header. */
export interface IOcrShardIndexHeader {
    readonly shardSize: number;
    readonly shardCount: number;
}

export function parseOcrShardIndexHeader(value: Uint8Array): IOcrShardIndexHeader | null {
    if (value.byteLength < OCR_SHARD_INDEX_HEADER_BYTES) {
        return null;
    }
    const decoder = new TextDecoder('ascii', {fatal: true});
    let magic: string;
    try {
        magic = decoder.decode(value.subarray(0, OCR_SHARD_INDEX_MAGIC.length));
    } catch {
        return null;
    }
    if (magic !== OCR_SHARD_INDEX_MAGIC) {
        return null;
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return {
        shardSize: view.getUint32(8, true),
        shardCount: view.getUint32(12, true),
    };
}

function expectedShardIndexLength(shardCount: number): number | null {
    if (!Number.isSafeInteger(shardCount) || shardCount < 0) {
        return null;
    }
    const recordBytes = shardCount * OCR_SHARD_INDEX_RECORD_BYTES;
    return Number.isSafeInteger(recordBytes)
        && recordBytes <= Number.MAX_SAFE_INTEGER - OCR_SHARD_INDEX_HEADER_BYTES
        ? OCR_SHARD_INDEX_HEADER_BYTES + recordBytes
        : null;
}

/** Strictly decodes a complete fixed-width shard index. */
export function decodeOcrShardIndex(
    value: Uint8Array,
    options: {
        expectedPageCount?: number;
        maxGeneration?: number
    } = {},
): IOcrShardIndex | null {
    if (
        (options.expectedPageCount !== undefined
            && !isSafeNonNegativeInteger(options.expectedPageCount))
        || (options.expectedPageCount !== undefined
            && options.expectedPageCount > OCR_MAX_PAGE_NUMBER)
        || (options.maxGeneration !== undefined
            && !isSafeNonNegativeInteger(options.maxGeneration))
    ) {
        return null;
    }
    if (value.byteLength < OCR_SHARD_INDEX_HEADER_BYTES) {
        return null;
    }
    const header = parseOcrShardIndexHeader(value);
    if (header === null || header.shardSize !== OCR_SHARD_SIZE) {
        return null;
    }
    const expectedLength = expectedShardIndexLength(header.shardCount);
    if (expectedLength === null || value.byteLength !== expectedLength) {
        return null;
    }
    const expectedShardCount = options.expectedPageCount === undefined
        ? null
        : Math.ceil(options.expectedPageCount / OCR_SHARD_SIZE);
    if (expectedShardCount !== null && header.shardCount !== expectedShardCount) {
        return null;
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const records: IOcrShardIndexRecord[] = [];
    for (let index = 0; index < header.shardCount; index += 1) {
        const offset = OCR_SHARD_INDEX_HEADER_BYTES + index * OCR_SHARD_INDEX_RECORD_BYTES;
        const generation = view.getUint32(offset, true);
        const mappedCount = view.getUint16(offset + 4, true);
        const reserved = view.getUint16(offset + 6, true);
        const lastShardPageCount = options.expectedPageCount === undefined
            ? OCR_SHARD_SIZE
            : Math.min(
                OCR_SHARD_SIZE,
                Math.max(0, options.expectedPageCount - index * OCR_SHARD_SIZE),
            );
        if (
            reserved !== 0
            || mappedCount > lastShardPageCount
            || (generation === 0 && mappedCount !== 0)
            || generation > OCR_MAX_GENERATION
            || (options.maxGeneration !== undefined && generation > options.maxGeneration)
        ) {
            return null;
        }
        records.push({
            generation,
            mappedCount,
            reserved: 0,
        });
    }
    return {
        shardSize: OCR_SHARD_SIZE,
        shardCount: header.shardCount,
        records,
    };
}

/** Encodes the fixed 16-byte header and one 8-byte record per shard. */
export function encodeOcrShardIndex(
    value: IOcrShardIndex | readonly IOcrShardIndexRecord[],
): Uint8Array {
    let shardSize: number;
    let records: readonly IOcrShardIndexRecord[];
    if (Array.isArray(value)) {
        if (!value.every(isOcrShardIndexRecord)) {
            throw new TypeError('Invalid OCR shard index');
        }
        shardSize = OCR_SHARD_SIZE;
        records = value;
    } else if (isRecord(value)) {
        const rawRecords = value.records;
        if (
            typeof value.shardSize !== 'number'
            || !Array.isArray(rawRecords)
            || !rawRecords.every(isOcrShardIndexRecord)
        ) {
            throw new TypeError('Invalid OCR shard index');
        }
        shardSize = value.shardSize;
        records = rawRecords;
    } else {
        throw new TypeError('Invalid OCR shard index');
    }
    if (shardSize !== OCR_SHARD_SIZE || !Array.isArray(records) || records.length > 0xFFFF_FFFF) {
        throw new TypeError('Invalid OCR shard index');
    }
    const byteLength = expectedShardIndexLength(records.length);
    if (byteLength === null) {
        throw new RangeError('OCR shard index is too large');
    }
    const result = new Uint8Array(byteLength);
    const encoder = new TextEncoder();
    result.set(encoder.encode(OCR_SHARD_INDEX_MAGIC), 0);
    const view = new DataView(result.buffer);
    view.setUint32(8, OCR_SHARD_SIZE, true);
    view.setUint32(12, records.length, true);
    records.forEach((record: IOcrShardIndexRecord, index: number) => {
        if (
            !isSafeNonNegativeInteger(record.generation)
            || record.generation > 0xFFFF_FFFF
            || record.generation > OCR_MAX_GENERATION
            || !isSafeNonNegativeInteger(record.mappedCount)
            || record.mappedCount > OCR_SHARD_SIZE
        ) {
            throw new TypeError(`Invalid OCR shard index record ${index}`);
        }
        const offset = OCR_SHARD_INDEX_HEADER_BYTES + index * OCR_SHARD_INDEX_RECORD_BYTES;
        view.setUint32(offset, record.generation, true);
        view.setUint16(offset + 4, record.mappedCount, true);
        view.setUint16(offset + 6, 0, true);
    });
    return result;
}

function isOcrShardIndexRecord(value: unknown): value is IOcrShardIndexRecord {
    return isRecord(value)
        && isSafeNonNegativeInteger(value.generation)
        && isSafeNonNegativeInteger(value.mappedCount)
        && value.reserved === 0;
}
