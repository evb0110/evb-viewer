import { BROWSER_DOCUMENT_CHUNK_SIZE } from '@app/platform/browser/browserDocumentConstants';
import { groupBy } from 'es-toolkit/array';
import { isRecord } from '@contracts/runtimeGuards';
import {
    cloneBytes,
    normalizePersistedBytes,
} from '@app/platform/browser/browserDocumentBytes';
import { defaultRetentionForKind } from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IBrowserDocumentEntryInput,
    IBrowserPersistedDocumentRecord,
    IChunkKeyRecord,
    TBrowserDocumentStorageMode,
} from '@app/platform/browser/browserDocumentTypes';
import { getBrowserDocumentEntryContentRevision } from '@app/platform/browser/browserDocumentRevision';
import { parseDocumentRef } from '@contracts/documentRef';

export function createPersistedBrowserDocumentRecord(
    entry: IBrowserDocumentEntry,
    data = entry.data,
    cloneData = true,
): IBrowserPersistedDocumentRecord {
    return {
        ref: entry.ref,
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        kind: entry.kind,
        retention: entry.retention,
        ...(entry.sourceRef ? { sourceRef: entry.sourceRef } : {}),
        data: cloneData ? cloneBytes(data) : data,
        fileSize: entry.fileSize,
        ...(entry.fileLastModified !== undefined ? {fileLastModified: entry.fileLastModified} : {}),
        updatedAt: entry.updatedAt,
        ...(entry.contentToken ? { contentToken: entry.contentToken } : {}),
        contentRevision: getBrowserDocumentEntryContentRevision(entry),
        ...(entry.saveName ? { saveName: entry.saveName } : {}),
        saveKind: entry.saveKind,
        saveHandle: entry.saveHandle ?? null,
        ...(entry.sourceWitness ? {sourceWitness: true} : {}),
        ...(entry.sourceBaseWitness ? {sourceBaseWitness: entry.sourceBaseWitness} : {}),
        storageMode: entry.storageMode,
        chunkCount: entry.chunkCount,
        chunkSize: entry.chunkSize,
        ...(entry.chunkGeneration ? { chunkGeneration: entry.chunkGeneration } : {}),
        ...(entry.pendingChunkGeneration ? { pendingChunkGeneration: entry.pendingChunkGeneration } : {}),
        ...(entry.pendingChunkCount !== undefined ? { pendingChunkCount: entry.pendingChunkCount } : {}),
        ...(entry.pendingChunkSize !== undefined ? { pendingChunkSize: entry.pendingChunkSize } : {}),
        ...(entry.pendingFileSize !== undefined ? { pendingFileSize: entry.pendingFileSize } : {}),
        ...(entry.pendingChunkUpdatedAt !== undefined ? { pendingChunkUpdatedAt: entry.pendingChunkUpdatedAt } : {}),
    };
}

type TPersistedDocumentKind = IBrowserPersistedDocumentRecord['kind'];

interface IPersistedDocumentRequiredFields {
    ref: string;
    fileName: string;
    mimeType: string;
    kind: TPersistedDocumentKind;
    data: Uint8Array;
    fileSize: number;
    updatedAt: number;
}

interface IPersistedSaveTarget {
    saveName?: string;
    saveKind?: IBrowserDocumentEntry['saveKind'];
    saveHandle?: FileSystemFileHandle | null;
    sourceWitness?: boolean;
    sourceBaseWitness?: string;
}

interface IPersistedChunkLayout {
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
    pendingChunkGeneration?: string;
    pendingChunkCount?: number;
    pendingChunkSize?: number;
    pendingFileSize?: number;
    pendingChunkUpdatedAt?: number;
}

function normalizeStorageMode(value: unknown): TBrowserDocumentStorageMode {
    if (
        value === 'handle'
        || value === 'chunked'
        || value === 'source-proxy'
    ) {
        return value;
    }

    return 'inline';
}

function normalizePersistedKind(value: unknown): TPersistedDocumentKind | null {
    if (value === 'source' || value === 'working' || value === 'output') {
        return value;
    }

    return null;
}

function readRequiredString(value: unknown) {
    return typeof value === 'string' ? value : null;
}

function readRequiredNumber(value: unknown) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        ? value
        : null;
}

function readPersistedDocumentRequiredFields(
    value: Record<string, unknown>,
): IPersistedDocumentRequiredFields | null {
    const ref = readRequiredString(value.ref);
    const fileName = readRequiredString(value.fileName);
    const mimeType = readRequiredString(value.mimeType);
    const kind = normalizePersistedKind(value.kind);
    const data = normalizePersistedBytes(value.data);
    const fileSize = readRequiredNumber(value.fileSize);
    const fileLastModified = value.fileLastModified === undefined
        ? undefined
        : readRequiredNumber(value.fileLastModified) ?? undefined;
    const updatedAt = readRequiredNumber(value.updatedAt);

    if (!ref || !fileName || !mimeType || !kind || !data || fileSize === null || updatedAt === null) {
        return null;
    }

    return {
        ref,
        fileName,
        mimeType,
        kind,
        data,
        fileSize,
        ...(fileLastModified === undefined ? {} : {fileLastModified}),
        updatedAt,
    };
}

function normalizePersistedSaveKind(
    value: unknown,
): IBrowserDocumentEntry['saveKind'] | undefined {
    if (value === 'pdf' || value === 'docx' || value === 'generic') {
        return value;
    }

    return undefined;
}

function isFileSystemFileHandleLike(value: unknown): value is FileSystemFileHandle {
    return isRecord(value)
        && value.kind === 'file'
        && typeof value.name === 'string'
        && typeof value.getFile === 'function';
}

function normalizePersistedSaveHandle(value: unknown): FileSystemFileHandle | null | undefined {
    if (value === null || value === undefined) {
        return value;
    }
    return isFileSystemFileHandleLike(value) ? value : undefined;
}

function normalizePersistedSaveTarget(
    value: Record<string, unknown>,
): IPersistedSaveTarget {
    const saveName =
        typeof value.saveName === 'string' ? value.saveName : undefined;
    const saveKind = normalizePersistedSaveKind(value.saveKind);
    const saveHandle = 'saveHandle' in value
        ? normalizePersistedSaveHandle(value.saveHandle)
        : undefined;
    const sourceWitness = value.sourceWitness === true;
    const sourceBaseWitness = typeof value.sourceBaseWitness === 'string' && value.sourceBaseWitness.length > 0
        ? value.sourceBaseWitness
        : undefined;

    return {
        ...(saveName ? { saveName } : {}),
        ...(saveKind ? { saveKind } : {}),
        ...(saveHandle !== undefined ? { saveHandle } : {}),
        ...(sourceWitness ? { sourceWitness: true } : {}),
        ...(sourceBaseWitness ? { sourceBaseWitness } : {}),
    };
}

function normalizePersistedChunkLayout(
    value: Record<string, unknown>,
): IPersistedChunkLayout {
    const chunkCount =
        typeof value.chunkCount === 'number'
        && Number.isSafeInteger(value.chunkCount)
        && value.chunkCount >= 0
            ? value.chunkCount
            : undefined;
    const chunkSize =
        typeof value.chunkSize === 'number'
        && Number.isSafeInteger(value.chunkSize)
        && value.chunkSize > 0
            ? value.chunkSize
            : undefined;
    const chunkGeneration =
        typeof value.chunkGeneration === 'string' && value.chunkGeneration.length > 0
            ? value.chunkGeneration
            : undefined;
    const pendingChunkGeneration =
        typeof value.pendingChunkGeneration === 'string' && value.pendingChunkGeneration.length > 0
            ? value.pendingChunkGeneration
            : undefined;
    const pendingChunkCount =
        typeof value.pendingChunkCount === 'number'
        && Number.isSafeInteger(value.pendingChunkCount)
        && value.pendingChunkCount >= 0
            ? value.pendingChunkCount
            : undefined;
    const pendingChunkSize =
        typeof value.pendingChunkSize === 'number'
        && Number.isSafeInteger(value.pendingChunkSize)
        && value.pendingChunkSize > 0
            ? value.pendingChunkSize
            : undefined;
    const pendingFileSize =
        typeof value.pendingFileSize === 'number'
        && Number.isSafeInteger(value.pendingFileSize)
        && value.pendingFileSize >= 0
            ? value.pendingFileSize
            : undefined;
    const pendingChunkUpdatedAt =
        typeof value.pendingChunkUpdatedAt === 'number'
        && Number.isFinite(value.pendingChunkUpdatedAt)
        && value.pendingChunkUpdatedAt >= 0
            ? value.pendingChunkUpdatedAt
            : undefined;

    return {
        ...(chunkCount !== undefined ? { chunkCount } : {}),
        ...(chunkSize !== undefined ? { chunkSize } : {}),
        ...(chunkGeneration ? { chunkGeneration } : {}),
        ...(pendingChunkGeneration ? { pendingChunkGeneration } : {}),
        ...(pendingChunkCount !== undefined ? { pendingChunkCount } : {}),
        ...(pendingChunkSize !== undefined ? { pendingChunkSize } : {}),
        ...(pendingFileSize !== undefined ? { pendingFileSize } : {}),
        ...(pendingChunkUpdatedAt !== undefined ? { pendingChunkUpdatedAt } : {}),
    };
}

export function toPersistedDocumentRecord(
    value: unknown,
): IBrowserPersistedDocumentRecord | null {
    if (!isRecord(value)) {
        return null;
    }

    const requiredFields = readPersistedDocumentRequiredFields(value);
    if (!requiredFields) {
        return null;
    }

    const retention = value.retention;
    const sourceRef =
        typeof value.sourceRef === 'string' ? value.sourceRef : undefined;
    const contentToken =
        typeof value.contentToken === 'string' && value.contentToken.length > 0
            ? value.contentToken
            : undefined;
    const contentRevision =
        typeof value.contentRevision === 'number'
        && Number.isSafeInteger(value.contentRevision)
        && value.contentRevision >= 1
            ? value.contentRevision
            : undefined;
    const saveTarget = normalizePersistedSaveTarget(value);
    const storageMode = normalizeStorageMode(value.storageMode);
    const chunkLayout = normalizePersistedChunkLayout(value);

    return {
        ...requiredFields,
        retention: retention === 'transient' ? 'transient' : 'durable',
        ...(sourceRef ? { sourceRef } : {}),
        ...(contentToken ? { contentToken } : {}),
        ...(contentRevision !== undefined ? { contentRevision } : {}),
        ...saveTarget,
        storageMode,
        ...chunkLayout,
    };
}

function defaultSaveKindForFileName(fileName: string): IBrowserDocumentEntry['saveKind'] {
    if (/\.pdf$/i.test(fileName)) {
        return 'pdf';
    }

    if (/\.docx$/i.test(fileName)) {
        return 'docx';
    }

    return 'generic';
}

export function createEntryFromPersistedRecord(
    record: IBrowserPersistedDocumentRecord,
): IBrowserDocumentEntry {
    const ref = parseDocumentRef(record.ref);
    if (ref === null) {
        throw new TypeError('Persisted browser document reference is invalid');
    }
    return {
        ...record,
        ref,
        data: cloneBytes(record.data),
        pendingLoad: null,
        retention: record.retention ?? defaultRetentionForKind(record.kind),
        contentRevision: record.contentRevision ?? 1,
        saveName: record.saveName ?? record.fileName,
        saveKind: record.saveKind ?? defaultSaveKindForFileName(record.fileName),
        saveHandle: record.saveHandle ?? null,
        ...(record.sourceWitness ? { sourceWitness: true } : {}),
        ...(record.sourceBaseWitness ? { sourceBaseWitness: record.sourceBaseWitness } : {}),
        storageMode: record.storageMode ?? 'inline',
        chunkCount: record.chunkCount ?? 0,
        chunkSize: record.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        ...(record.chunkGeneration ? { chunkGeneration: record.chunkGeneration } : {}),
    };
}

export function collectChunkIndicesByRef(chunkKeys: IChunkKeyRecord[]) {
    return new Map(
        Object.entries(groupBy(chunkKeys, chunkKey => `${chunkKey.ref}\0${chunkKey.generation ?? ''}`))
            .map(([
                key,
                chunks,
            ]) => ([
                key,
                new Set(chunks.map(chunk => chunk.index)),
            ])),
    );
}

export function isChunkedRecordMissingChunks(
    record: IBrowserPersistedDocumentRecord,
    chunkIndicesByRef: Map<string, Set<number>>,
) {
    const chunkCount = record.chunkCount ?? 0;
    if (record.storageMode !== 'chunked' || chunkCount <= 0) {
        return false;
    }

    const chunkIndices = chunkIndicesByRef.get(`${record.ref}\0${record.chunkGeneration ?? ''}`);
    if (!chunkIndices) {
        return true;
    }

    for (let index = 0; index < chunkCount; index += 1) {
        if (!chunkIndices.has(index)) {
            return true;
        }
    }

    return false;
}

export function countNonWorkingDependents(records: IBrowserPersistedDocumentRecord[]) {
    const dependentCounts = new Map<string, number>();
    for (const record of records) {
        if (!record.sourceRef || record.kind === 'working') {
            continue;
        }

        dependentCounts.set(
            record.sourceRef,
            (dependentCounts.get(record.sourceRef) ?? 0) + 1,
        );
    }
    return dependentCounts;
}

export function shouldRemovePersistedRecord(
    record: IBrowserPersistedDocumentRecord,
    recentRefs: Set<string>,
    nonWorkingDependentCounts: Map<string, number>,
) {
    const durableWorkingRecoveryGraceMs = 10 * 60 * 1_000;
    return (
        (
            record.kind === 'working'
            && (
                record.retention !== 'durable'
                || record.updatedAt < Date.now() - durableWorkingRecoveryGraceMs
            )
        )
        || (
            !recentRefs.has(record.ref)
            && (nonWorkingDependentCounts.get(record.ref) ?? 0) === 0
        )
    );
}

export function createBrowserDocumentEntry(
    input: IBrowserDocumentEntryInput,
): IBrowserDocumentEntry {
    return {
        ref: input.ref,
        fileName: input.fileName,
        mimeType: input.mimeType,
        kind: input.kind,
        retention: input.retention,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        data: input.data,
        fileSize: input.fileSize,
        ...(input.fileLastModified === undefined ? {} : {fileLastModified: input.fileLastModified}),
        updatedAt: Date.now(),
        ...(input.contentToken ? { contentToken: input.contentToken } : {}),
        contentRevision: input.contentRevision ?? 1,
        pendingLoad: null,
        saveName: input.fileName,
        saveKind: input.saveKind,
        saveHandle: input.saveHandle,
        ...(input.sourceWitness ? { sourceWitness: true } : {}),
        ...(input.sourceBaseWitness ? { sourceBaseWitness: input.sourceBaseWitness } : {}),
        storageMode: input.storageMode,
        chunkCount: input.chunkCount ?? 0,
        chunkSize: input.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        ...(input.chunkGeneration ? { chunkGeneration: input.chunkGeneration } : {}),
    };
}
