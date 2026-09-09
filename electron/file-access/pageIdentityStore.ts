import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {constants} from 'node:fs';
import {
    copyFile,
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import {
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {IOcrIndexV3Manifest} from '@contracts/ocrIndex';
import {parseOcrIndexV3Manifest} from '@contracts/ocrIndex';
import {isRecord} from '@contracts/runtimeGuards';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {readOcrIndexV3ManifestMetadata} from '@electron/features/ocr/public/index';
import {
    loadNativeCompactSearchIndex as loadCompactSearchIndex,
    persistNativeCompactSearchIndex as persistCompactSearchIndex,
    loadSearchIndex,
    SEARCH_INDEX_SCHEMA_VERSION,
    stringifyLegacyJsonSearchIndex,
    classifySearchIndexOperation,
    invalidateSearchIndexSidecars,
} from '@electron/features/search/publicNative';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {isAbortError} from '@electron/utils/abort';
import {
    assertIdentitySeed,
    assertPageCount,
    assertPositivePageNumber,
    assertRangeCount,
    createPageIdentityDeltaPlan,
    PAGE_IDENTITY_INLINE_PAGE_COUNT,
    PAGE_IDENTITY_MAX_RANGE_OPERATIONS,
} from '@electron/file-access/pageIdentityDelta';
import {
    PageIdentitySidecarCorruptError,
    readIdentityAtFromSidecar,
    readPageIdentitySidecarHeader,
    streamPageIdentityIds,
    writeIdentityStateFromSidecarSource,
    type IPageIdentitySidecarSource,
} from '@electron/file-access/pageIdentitySidecarStreaming';
import {
    createOcrRangeDelta,
    OCR_V3_DIRECT_REMAP_PAGE_LIMIT,
    type IOcrRangeIdentityDelta,
} from '@electron/file-access/pageIdentityOcrRemap';
import {
    migrateOcrIndexV3ToV4,
    remapOcrCatalogV4PageRanges,
} from '@electron/features/ocr/worker/indexWriterV4';

/**
 * The v1 sidecar kept one UUID in a JSON array for every page. A range
 * sidecar keeps a small ordered list of identity runs instead. The default
 * seed and offset derive the UUID for a page, so an untouched million-page
 * document needs no million-element JavaScript collection.
 */
const PAGE_IDENTITY_SIDECAR_VERSION = 2;

export {
    createCropIdentityDelta,
    createCropRangesIdentityDelta,
    createDeleteIdentityDelta,
    createDeleteRangeIdentityDelta,
    createDeleteRangesIdentityDelta,
    createIdentityDelta,
    createInsertIdentityDelta,
    createMoveIdentityDelta,
    createPageMoveRangesIdentityDelta,
    createRemoveCropIdentityDelta,
    createRemoveCropRangesIdentityDelta,
    createReorderIdentityDelta,
    createRotateIdentityDelta,
    createRotateRangesIdentityDelta,
} from '@electron/file-access/pageIdentityDelta';

const PAGE_IDENTITY_STREAMING_SIDECAR_BYTES = 4 * 1024 * 1024;

interface IPageIdentitySegment {
    count: number;
    identitySeed: string;
    identityStart: number;
    pageIds?: string[];
}

interface IPageIdentityState {
    documentRevisionToken?: string;
    pageCount: number;
    segments: IPageIdentitySegment[];
    /** A legacy or explicit range sidecar kept on disk for bounded reads. */
    sidecarSource?: IPageIdentitySidecarSource;
}

interface IPageIdentitySidecarRange {
    startPage: number;
    count: number;
    identitySeed: string;
    identityStart: number;
    pageIds?: string[];
}

interface IPageIdentitySidecarV2 {
    version: 2;
    storage: 'ranges';
    documentRevisionToken: string;
    pageCount: number;
    identitySeed: string;
    pageIds?: string[];
    ranges?: IPageIdentitySidecarRange[];
}

const logger = createLogger('page-identity');

interface IPageIdentityInitializationTask {
    abortController?: AbortController;
    promise?: Promise<IPageIdentityState>;
    revision: IDocumentRevisionInfo;
    sourcePath?: string;
}

const initializationTasks = new Map<string, IPageIdentityInitializationTask>();

function getPageIdentitySidecarPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-pages.json`;
}

function makeDerivedSegment(
    count: number,
    identitySeed: string,
    identityStart = 0,
): IPageIdentitySegment {
    assertRangeCount(count, 'identity range count');
    assertIdentitySeed(identitySeed);
    if (!Number.isSafeInteger(identityStart) || identityStart < 0) {
        throw new Error('identity range offset must be a non-negative safe integer');
    }
    return {
        count,
        identitySeed,
        identityStart,
    };
}

function makeExplicitSegment(pageIds: readonly string[]): IPageIdentitySegment {
    if (pageIds.length === 0) {
        throw new Error('identity range must contain at least one page');
    }
    if (!pageIds.every(id => typeof id === 'string' && id.length > 0)) {
        throw new Error('page identities must be non-empty strings');
    }
    return {
        count: pageIds.length,
        identitySeed: `explicit:${randomUUID()}`,
        identityStart: 0,
        pageIds: [...pageIds],
    };
}

function normalizeSegments(segments: readonly IPageIdentitySegment[]) {
    const normalized: IPageIdentitySegment[] = [];
    for (const segment of segments) {
        if (segment.count <= 0) continue;
        const previous = normalized.at(-1);
        if (
            previous
            && previous.identitySeed === segment.identitySeed
            && previous.identityStart + previous.count === segment.identityStart
            && previous.pageIds === undefined
            && segment.pageIds === undefined
        ) {
            previous.count += segment.count;
            continue;
        }
        if (
            previous
            && previous.pageIds !== undefined
            && segment.pageIds !== undefined
            && previous.pageIds.length + segment.pageIds.length <= PAGE_IDENTITY_INLINE_PAGE_COUNT
        ) {
            previous.pageIds.push(...segment.pageIds);
            previous.count += segment.count;
            continue;
        }
        normalized.push({
            count: segment.count,
            identitySeed: segment.identitySeed,
            identityStart: segment.identityStart,
            ...(segment.pageIds === undefined ? {} : {pageIds: [...segment.pageIds]}),
        });
    }
    return normalized;
}

function createIdentityState(
    pageCount: number,
    identitySeed = randomUUID(),
    documentRevisionToken?: string,
): IPageIdentityState {
    assertPageCount(pageCount, 'pageCount');
    const segments = pageCount === 0
        ? []
        : [makeDerivedSegment(pageCount, identitySeed)];
    return {
        pageCount,
        segments,
        ...(documentRevisionToken === undefined ? {} : {documentRevisionToken}),
    };
}

/** Derives a stable RFC 4122 UUID from an identity seed and logical offset. */
export function derivePageIdentity(identitySeed: string, identityOffset: number) {
    assertIdentitySeed(identitySeed);
    if (!Number.isSafeInteger(identityOffset) || identityOffset < 0) {
        throw new Error('identityOffset must be a non-negative safe integer');
    }
    const digest = createHash('sha256')
        .update(`evb-page-identity-v2\0${identitySeed}\0${identityOffset}`)
        .digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6]! & 0x0F) | 0x50;
    bytes[8] = (bytes[8]! & 0x3F) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function identityAt(state: IPageIdentityState, zeroBasedPageNumber: number) {
    if (!Number.isSafeInteger(zeroBasedPageNumber) || zeroBasedPageNumber < 0 || zeroBasedPageNumber >= state.pageCount) {
        return undefined;
    }
    let offset = zeroBasedPageNumber;
    for (const segment of state.segments) {
        if (offset >= segment.count) {
            offset -= segment.count;
            continue;
        }
        return segment.pageIds?.[offset]
            ?? derivePageIdentity(segment.identitySeed, segment.identityStart + offset);
    }
    return undefined;
}

async function identityAtFromState(state: IPageIdentityState, zeroBasedPageNumber: number) {
    if (state.sidecarSource === undefined) {
        return identityAt(state, zeroBasedPageNumber);
    }
    if (
        !Number.isSafeInteger(zeroBasedPageNumber)
        || zeroBasedPageNumber < 0
        || zeroBasedPageNumber >= state.pageCount
    ) {
        return undefined;
    }
    return readIdentityAtFromSidecar(state.sidecarSource, zeroBasedPageNumber);
}

function sliceSegments(
    segments: readonly IPageIdentitySegment[],
    start: number,
    count: number,
) {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('identity slice must use non-negative safe integers');
    }
    if (count === 0) {
        return [];
    }
    const sliced: IPageIdentitySegment[] = [];
    let remainingStart = start;
    let remainingCount = count;
    for (const segment of segments) {
        if (remainingStart >= segment.count) {
            remainingStart -= segment.count;
            continue;
        }
        const localStart = remainingStart;
        const take = Math.min(segment.count - localStart, remainingCount);
        sliced.push({
            count: take,
            identitySeed: segment.identitySeed,
            identityStart: segment.identityStart + localStart,
            ...(segment.pageIds === undefined
                ? {}
                : {pageIds: segment.pageIds.slice(localStart, localStart + take)}),
        });
        remainingCount -= take;
        remainingStart = 0;
        if (remainingCount === 0) break;
    }
    if (remainingCount !== 0) {
        throw new Error('identity range exceeds the previous page count');
    }
    return sliced;
}

function materializePageIds(state: IPageIdentityState) {
    if (state.pageCount > PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        throw new Error('Refusing to materialize a large page identity state');
    }
    return Array.from({length: state.pageCount}, (_value, index) => identityAt(state, index)!);
}

async function writeJsonAtomic(path: string, value: unknown) {
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(tempPath, JSON.stringify(value), 'utf8');
        await atomicReplace(tempPath, path);
    } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw error;
    }
}


function parsePageIds(value: unknown, expectedPageCount: number) {
    if (
        !Array.isArray(value)
        || value.length !== expectedPageCount
        || !value.every((id): id is string => typeof id === 'string' && id.length > 0)
    ) {
        return null;
    }
    return [...value];
}

function parseRangeSegment(value: unknown): IPageIdentitySegment | null {
    if (!isRecord(value)) {
        return null;
    }
    const count = value.count;
    const identityStart = value.identityStart;
    const identitySeed = value.identitySeed;
    if (
        typeof count !== 'number'
        || !Number.isSafeInteger(count)
        || count < 1
        || typeof identityStart !== 'number'
        || !Number.isSafeInteger(identityStart)
        || identityStart < 0
        || typeof identitySeed !== 'string'
        || identitySeed.length === 0
        || identitySeed.length > 512
    ) {
        return null;
    }
    const pageIds = value.pageIds === undefined
        ? undefined
        : parsePageIds(value.pageIds, count);
    if (pageIds === null) {
        return null;
    }
    return {
        count,
        identitySeed,
        identityStart,
        ...(pageIds === undefined ? {} : {pageIds}),
    };
}

function parsePageIdentitySidecar(
    value: unknown,
    expectedPageCount: number,
): IPageIdentityState | null {
    if (!isRecord(value)) {
        return null;
    }
    if (value.version === 1) {
        const pageIds = parsePageIds(value.pageIds, expectedPageCount);
        if (
            pageIds === null
            || typeof value.documentRevisionToken !== 'string'
            || value.documentRevisionToken.length === 0
        ) {
            return null;
        }
        return {
            pageCount: expectedPageCount,
            segments: pageIds.length === 0 ? [] : [makeExplicitSegment(pageIds)],
            documentRevisionToken: value.documentRevisionToken,
        };
    }
    if (value.version !== PAGE_IDENTITY_SIDECAR_VERSION || value.storage !== 'ranges') {
        return null;
    }
    const pageCount = value.pageCount;
    if (
        typeof pageCount !== 'number'
        || !Number.isSafeInteger(pageCount)
        || pageCount < 0
        || pageCount !== expectedPageCount
        || typeof value.documentRevisionToken !== 'string'
        || value.documentRevisionToken.length === 0
        || typeof value.identitySeed !== 'string'
        || value.identitySeed.length === 0
        || value.identitySeed.length > 512
    ) {
        return null;
    }
    const topLevelPageIds = value.pageIds === undefined
        ? undefined
        : parsePageIds(value.pageIds, pageCount);
    if (topLevelPageIds === null) {
        return null;
    }
    if (topLevelPageIds !== undefined) {
        return {
            pageCount,
            segments: pageCount === 0 ? [] : [makeExplicitSegment(topLevelPageIds)],
            documentRevisionToken: value.documentRevisionToken,
        };
    }
    if (!Array.isArray(value.ranges) || value.ranges.length > PAGE_IDENTITY_MAX_RANGE_OPERATIONS) {
        return null;
    }
    const segments: IPageIdentitySegment[] = [];
    let startPage = 1;
    for (const rawRange of value.ranges) {
        if (!isRecord(rawRange) || rawRange.startPage !== startPage) {
            return null;
        }
        const segment = parseRangeSegment(rawRange);
        if (!segment) {
            return null;
        }
        segments.push(segment);
        startPage += segment.count;
    }
    if (startPage !== pageCount + 1) {
        return null;
    }
    return {
        pageCount,
        segments: normalizeSegments(segments),
        documentRevisionToken: value.documentRevisionToken,
    };
}

async function readPageIdentityState(
    workingCopyPath: string,
    expectedPageCount: number,
): Promise<IPageIdentityState | null> {
    const path = getPageIdentitySidecarPath(workingCopyPath);
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat) {
        return null;
    }
    // Keep legacy v1 arrays lazy regardless of their byte size. The streaming
    // reader below never builds an in-memory page-sized array, and mutation
    // commits convert the source to the v2 range format.
    const header = await readPageIdentitySidecarHeader(path);
    if (
        header?.version === 1
        && typeof header.documentRevisionToken === 'string'
        && header.documentRevisionToken.length > 0
    ) {
        return {
            pageCount: expectedPageCount,
            segments: [],
            documentRevisionToken: header.documentRevisionToken,
            sidecarSource: {
                format: 'v1',
                path,
            },
        };
    }
    if (fileStat.size > PAGE_IDENTITY_STREAMING_SIDECAR_BYTES || (header?.pageCount ?? 0) > PAGE_IDENTITY_INLINE_PAGE_COUNT) {
        if (
            header?.version === PAGE_IDENTITY_SIDECAR_VERSION
            && header.storage === 'ranges'
            && header.pageCount === expectedPageCount
            && typeof header.documentRevisionToken === 'string'
            && header.documentRevisionToken.length > 0
        ) {
            const scan = await streamPageIdentityIds(path);
            if (scan.foundPageIds) {
                return {
                    pageCount: expectedPageCount,
                    segments: [],
                    documentRevisionToken: header.documentRevisionToken,
                    sidecarSource: {
                        format: 'v2',
                        path,
                    },
                };
            }
        }
    }
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch (error) {
        throw new PageIdentitySidecarCorruptError('contains invalid JSON', {cause: error});
    }
    return parsePageIdentitySidecar(value, expectedPageCount);
}

function serializeIdentityState(
    state: IPageIdentityState,
    documentRevisionToken: string,
): IPageIdentitySidecarV2 {
    const baseSeed = state.segments[0]?.identitySeed ?? randomUUID();
    const pageIds = state.pageCount <= PAGE_IDENTITY_INLINE_PAGE_COUNT
        ? materializePageIds(state)
        : undefined;
    if (pageIds !== undefined) {
        return {
            version: PAGE_IDENTITY_SIDECAR_VERSION,
            storage: 'ranges',
            documentRevisionToken,
            pageCount: state.pageCount,
            identitySeed: baseSeed,
            pageIds,
        };
    }
    const ranges: IPageIdentitySidecarRange[] = [];
    let startPage = 1;
    for (const segment of state.segments) {
        if (segment.pageIds === undefined) {
            ranges.push({
                startPage,
                count: segment.count,
                identitySeed: segment.identitySeed,
                identityStart: segment.identityStart,
            });
            startPage += segment.count;
            continue;
        }
        for (let offset = 0; offset < segment.count; offset += PAGE_IDENTITY_INLINE_PAGE_COUNT) {
            const count = Math.min(PAGE_IDENTITY_INLINE_PAGE_COUNT, segment.count - offset);
            const range: IPageIdentitySidecarRange = {
                startPage,
                count,
                identitySeed: segment.identitySeed,
                identityStart: segment.identityStart + offset,
                pageIds: segment.pageIds.slice(offset, offset + count),
            };
            ranges.push(range);
            startPage += count;
        }
    }
    return {
        version: PAGE_IDENTITY_SIDECAR_VERSION,
        storage: 'ranges',
        documentRevisionToken,
        pageCount: state.pageCount,
        identitySeed: baseSeed,
        ranges,
    };
}

async function writeIdentityState(
    workingCopyPath: string,
    state: IPageIdentityState,
    documentRevisionToken: string,
) {
    await writeJsonAtomic(
        getPageIdentitySidecarPath(workingCopyPath),
        serializeIdentityState(state, documentRevisionToken),
    );
}

async function assertRevisionFence(
    workingCopyPath: string,
    state: IPageIdentityState,
    nextRevision: IDocumentRevisionInfo,
) {
    const currentRevision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (!currentRevision) {
        return;
    }
    if (
        state.documentRevisionToken !== undefined
        && state.documentRevisionToken !== currentRevision.token
    ) {
        throw new Error('Page identity state belongs to a stale document revision');
    }
    if (
        nextRevision.token !== currentRevision.token
        && nextRevision.contentRevision !== currentRevision.contentRevision + 1
    ) {
        throw new Error('Page identity publication has a stale document revision');
    }
}

/** Reads one identity without materializing its document or its sidecar. */
export async function readPageIdentity(
    workingCopyPath: string,
    pageNumber: number,
    expectedPageCount?: number,
) {
    assertPositivePageNumber(pageNumber, 'pageNumber');
    const pageCount = expectedPageCount ?? await getPdfPageCount(workingCopyPath);
    assertPageCount(pageCount, 'pageCount');
    const state = await readPageIdentityState(workingCopyPath, pageCount)
        ?? createIdentityState(pageCount);
    return await identityAtFromState(state, pageNumber - 1) ?? null;
}

async function initializePageIdentityStore(
    workingCopyPath: string,
    revision: IDocumentRevisionInfo,
    sourcePath?: string,
    shouldPublish: () => boolean = () => true,
    signal?: AbortSignal,
) {
    signal?.throwIfAborted();
    const capturedRevision = await readWorkingCopyRevisionSidecar(workingCopyPath) ?? revision;
    const pageCount = await getPdfPageCount(workingCopyPath, signal ? {signal} : {});
    signal?.throwIfAborted();
    const sourceState = sourcePath
        ? await readPageIdentityState(sourcePath, pageCount)
        : null;
    const state = sourceState ?? createIdentityState(pageCount);
    signal?.throwIfAborted();
    if (shouldPublish()) {
        await assertRevisionFence(
            workingCopyPath,
            {
                ...state,
                documentRevisionToken: capturedRevision.token,
            },
            capturedRevision,
        );
        if (!shouldPublish()) {
            return state;
        }
        const sidecarSource = state.sidecarSource;
        if (sidecarSource !== undefined) {
            await writeIdentityStateFromSidecarSource(
                getPageIdentitySidecarPath(workingCopyPath),
                {
                    pageCount: state.pageCount,
                    sidecarSource,
                },
                {
                    previousPageCount: pageCount,
                    nextPageCount: pageCount,
                    ranges: pageCount === 0
                        ? []
                        : [{
                            kind: 'retain',
                            fromPageNumber: 1,
                            toPageNumber: 1,
                            count: pageCount,
                        }],
                },
                capturedRevision.token,
                PAGE_IDENTITY_SIDECAR_VERSION,
                derivePageIdentity,
            );
        } else {
            await writeIdentityState(workingCopyPath, state, capturedRevision.token);
        }
    }
    return state;
}

/** Registers the inputs needed for page-ledger discovery without starting qpdf. */
export function schedulePageIdentityStoreInitialization(
    workingCopyPath: string,
    revision: IDocumentRevisionInfo,
    sourcePath?: string,
) {
    const existing = initializationTasks.get(workingCopyPath);
    if (existing) {
        return;
    }
    initializationTasks.set(workingCopyPath, {
        revision,
        ...(sourcePath ? {sourcePath} : {}),
    });
}

/** Starts and joins the ledger task before any revision-changing mutation. */
export async function awaitPageIdentityStoreInitialization(workingCopyPath: string) {
    const entry = initializationTasks.get(workingCopyPath);
    if (!entry) {
        return;
    }
    if (!entry.promise) {
        const startedAt = performance.now();
        const abortController = new AbortController();
        entry.abortController = abortController;
        entry.promise = initializePageIdentityStore(
            workingCopyPath,
            entry.revision,
            entry.sourcePath,
            () => !abortController.signal.aborted && initializationTasks.get(workingCopyPath) === entry,
            abortController.signal,
        );
        void entry.promise.then(
            state => logger.debug(`Page identity initialization complete: ${JSON.stringify({
                durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
                pageCount: state.pageCount,
                workingCopyPath,
            })}`),
            error => {
                if (!isAbortError(error)) {
                    logger.warn(`Page identity initialization failed for "${workingCopyPath}": ${getErrorMessage(error)}`);
                }
            },
        );
    }
    await entry.promise;
}

export function forgetPageIdentityStoreInitialization(workingCopyPath: string) {
    const entry = initializationTasks.get(workingCopyPath);
    entry?.abortController?.abort();
    initializationTasks.delete(workingCopyPath);
}

export function clearPageIdentityStoreInitializations() {
    for (const entry of initializationTasks.values()) {
        entry.abortController?.abort();
    }
    initializationTasks.clear();
}


function applyPageIdentityDelta(state: IPageIdentityState, delta: IPageIdentityDelta) {
    const {
        nextPageCount,
        parts,
    } = createPageIdentityDeltaPlan(state.pageCount, delta);
    const nextSegments = parts.map(part => part.kind === 'source'
        ? sliceSegments(state.segments, part.fromPageNumber - 1, part.count)
        : part.insertedIds === undefined
            ? makeDerivedSegment(part.count, part.identitySeed)
            : makeExplicitSegment(part.insertedIds));
    return {
        pageCount: nextPageCount,
        segments: normalizeSegments(nextSegments.flat()),
        ...(state.documentRevisionToken === undefined
            ? {}
            : {documentRevisionToken: state.documentRevisionToken}),
    } satisfies IPageIdentityState;
}

/** Publishes durable page identities and leaves OCR remapping at its existing seam. */
export async function commitPageIdentityDelta(
    workingCopyPath: string,
    delta: IPageIdentityDelta,
    nextRevision: IDocumentRevisionInfo,
) {
    assertPageCount(delta.previousPageCount, 'previousPageCount');
    const priorState = await readPageIdentityState(workingCopyPath, delta.previousPageCount) ?? createIdentityState(delta.previousPageCount);
    const nextState = priorState.sidecarSource === undefined
        ? applyPageIdentityDelta(priorState, delta)
        : undefined;
    await assertRevisionFence(workingCopyPath, priorState, nextRevision);
    await remapOcrCatalog(workingCopyPath, delta, nextRevision);
    await remapSearchIndexes(workingCopyPath, delta, nextRevision);
    await assertRevisionFence(workingCopyPath, priorState, nextRevision);
    if (nextState === undefined) {
        const sidecarSource = priorState.sidecarSource;
        if (sidecarSource === undefined) {
            throw new Error('Page identity source is not available for streaming migration');
        }
        await writeIdentityStateFromSidecarSource(
            getPageIdentitySidecarPath(workingCopyPath),
            {
                pageCount: priorState.pageCount,
                sidecarSource,
            },
            delta,
            nextRevision.token,
            PAGE_IDENTITY_SIDECAR_VERSION,
            derivePageIdentity,
        );
    } else {
        await writeIdentityState(workingCopyPath, nextState, nextRevision.token);
    }
}

async function remapSearchIndexes(workingCopyPath: string, delta: IPageIdentityDelta, nextRevision: IDocumentRevisionInfo) {
    const classification = await classifySearchIndexOperation(workingCopyPath, delta.previousPageCount);
    if (classification.isXlarge) {
        await invalidateSearchIndexSidecars(workingCopyPath);
        return;
    }
    const previousRevision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (!previousRevision) {
        return;
    }
    const [
        legacy,
        compact,
    ] = await Promise.all([
        loadSearchIndex(workingCopyPath, previousRevision.token),
        loadCompactSearchIndex(workingCopyPath, {documentRevision: previousRevision.token}),
    ]);
    const remapPages = <T extends {pageNumber: number}>(pages: readonly T[]) => pages.flatMap(page => {
        const pageNumber = mapPageNumberThroughPageIdentityDelta(
            delta,
            requirePageNumber(page.pageNumber),
        );
        return pageNumber === null ? [] : [{
            ...page,
            pageNumber,
        }];
    });
    await Promise.all([
        legacy
            ? (async () => {
                const indexPath = `${workingCopyPath}.index.json`;
                const tempPath = makeSiblingTempPath(indexPath);
                try {
                    await writeFile(tempPath, stringifyLegacyJsonSearchIndex({
                        ...legacy,
                        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
                        documentRevision: {token: nextRevision.token},
                        createdAt: Date.now(),
                        pageCount: delta.nextPageCount ?? delta.pages?.length ?? 0,
                        pages: remapPages(legacy.pages),
                    }), 'utf8');
                    await atomicReplace(tempPath, indexPath);
                } finally {
                    await rm(tempPath, {force: true});
                }
            })()
            : Promise.resolve(),
        compact
            ? persistCompactSearchIndex(workingCopyPath, {
                documentRevision: nextRevision.token,
                pageCount: delta.nextPageCount ?? delta.pages?.length ?? 0,
                pages: remapPages(compact.pages),
                textSource: compact.textSource,
            })
            : Promise.resolve(),
    ]);
}

function isIdentityPageDelta(delta: IPageIdentityDelta) {
    return delta.pages !== undefined
        && delta.pages.length === delta.previousPageCount
        && delta.pages.every((page, index) => 'fromPageNumber' in page && page.fromPageNumber === index + 1);
}

async function remapOcrCatalogAfterV3Migration(
    workingCopyPath: string,
    delta: IOcrRangeIdentityDelta,
    nextRevision: IDocumentRevisionInfo,
) {
    await migrateOcrIndexV3ToV4({
        catalogRoot: `${workingCopyPath}.ocr`,
        sourcePdfPath: workingCopyPath,
        workingCopyPath,
    });
    return remapOcrCatalogV4PageRanges(workingCopyPath, delta, nextRevision);
}

async function remapOcrCatalog(workingCopyPath: string, delta: IPageIdentityDelta, nextRevision: IDocumentRevisionInfo) {
    const rangeDelta = createOcrRangeDelta(delta);
    // OCR v4 stores page mappings in bounded shards. Give it range operations
    // first so a large document never falls back to a full page permutation.
    if (rangeDelta !== null) {
        const remappedV4 = await remapOcrCatalogV4PageRanges(workingCopyPath, rangeDelta, nextRevision);
        if (remappedV4) {
            return;
        }
    }

    if (delta.pages === undefined || delta.previousPageCount > OCR_V3_DIRECT_REMAP_PAGE_LIMIT) {
        if (rangeDelta === null) {
            throw new Error('Large OCR page remaps require sparse range operations');
        }
        await remapOcrCatalogAfterV3Migration(workingCopyPath, rangeDelta, nextRevision);
        return;
    }

    // OCR v3 stores one manifest entry per page. Keep this seam for the
    // existing small-document remapper when no v4 catalog exists. Read only
    // bounded metadata before deciding whether the legacy object is safe to
    // parse. Larger catalogs are migrated to v4 and remapped through shards.
    const ocrDir = `${workingCopyPath}.ocr`;
    const manifestPath = join(ocrDir, 'manifest.json');
    const metadata = await readOcrIndexV3ManifestMetadata(manifestPath).catch(() => null);
    if (metadata === null) {
        return;
    }

    if (
        metadata.pageCount > OCR_V3_DIRECT_REMAP_PAGE_LIMIT
        || rangeDelta === null
    ) {
        if (rangeDelta === null) {
            throw new Error('Large OCR page remaps require sparse range operations');
        }
        await remapOcrCatalogAfterV3Migration(workingCopyPath, rangeDelta, nextRevision);
        return;
    }

    const manifest = await readFile(manifestPath, 'utf8')
        .then(raw => parseOcrIndexV3Manifest(JSON.parse(raw), 'strict'))
        .catch(() => null);
    if (!manifest) {
        return;
    }
    if (isIdentityPageDelta(delta) && manifest.pageCount === delta.pages.length) {
        await writeJsonAtomic(manifestPath, {
            ...manifest,
            documentRevision: {token: nextRevision.token},
        });
        return;
    }
    const replacement = `${ocrDir}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(replacement, {recursive: true});
    const mappings: Record<number, IOcrIndexV3Manifest['pages'][number]> = {};
    for (const [
        index,
        identity,
    ] of delta.pages.entries()) {
        if (!('fromPageNumber' in identity)) continue;
        const source = manifest.pages[identity.fromPageNumber];
        if (!source) continue;
        const pageNumber = index + 1;
        const path = `page-${String(pageNumber).padStart(4, '0')}.json`;
        const copied = await copyFile(join(ocrDir, source.path), join(replacement, path), constants.COPYFILE_FICLONE)
            .then(() => true, () => false);
        if (copied) {
            mappings[pageNumber] = {
                path,
                ...(source.generation === undefined ? {} : {generation: source.generation}),
            };
        }
    }
    await writeFile(join(replacement, 'manifest.json'), JSON.stringify({
        ...manifest,
        documentRevision: {token: nextRevision.token},
        pageCount: delta.pages.length,
        pages: mappings,
    }), 'utf8');
    const backup = `${ocrDir}.${process.pid}.${randomUUID()}.bak`;
    await rename(ocrDir, backup);
    await rename(replacement, ocrDir);
    await rm(backup, {
        recursive: true,
        force: true,
    });
}
