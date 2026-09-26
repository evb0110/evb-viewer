import { BROWSER_DOCUMENT_CHUNK_SIZE } from '@app/platform/browser/browserDocumentConstants';
import { groupBy } from 'es-toolkit/array';
import { isRecord } from '@contracts/runtimeGuards';
import {cloneBytes} from '@app/platform/browser/browserDocumentBytes';
import { defaultRetentionForKind } from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IBrowserDocumentEntryInput,
    IBrowserPersistedDocumentRecord,
    IChunkKeyRecord,
} from '@app/platform/browser/browserDocumentTypes';
import {BROWSER_PERSISTED_DOCUMENT_RECORD_SCHEMA} from '@app/platform/browser/browserDocumentTypes';
import { getBrowserDocumentEntryContentRevision } from '@app/platform/browser/browserDocumentRevision';
import { parseDocumentRef } from '@contracts/documentRef';
import * as v from 'valibot';

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

function isFileSystemFileHandleLike(value: unknown): value is FileSystemFileHandle {
    return isRecord(value)
        && value.kind === 'file'
        && typeof value.name === 'string'
        && typeof value.getFile === 'function';
}

const persistedDocumentRecordSchema = v.pipe(
    v.object({
        ref: v.pipe(v.string(), v.minLength(1)),
        fileName: v.pipe(v.string(), v.minLength(1)),
        mimeType: v.pipe(v.string(), v.minLength(1)),
        kind: v.picklist([
            'source',
            'working',
            'output',
        ]),
        data: v.custom<Uint8Array | ArrayBuffer>(value => value instanceof Uint8Array || value instanceof ArrayBuffer),
        fileSize: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        updatedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        retention: v.optional(v.unknown()),
        sourceRef: v.optional(v.unknown()),
        fileLastModified: v.optional(v.unknown()),
        contentToken: v.optional(v.unknown()),
        contentRevision: v.optional(v.unknown()),
        saveName: v.optional(v.unknown()),
        saveKind: v.optional(v.unknown()),
        saveHandle: v.optional(v.unknown()),
        sourceWitness: v.optional(v.unknown()),
        sourceBaseWitness: v.optional(v.unknown()),
        storageMode: v.optional(v.unknown()),
        chunkCount: v.optional(v.unknown()),
        chunkSize: v.optional(v.unknown()),
        chunkGeneration: v.optional(v.unknown()),
        pendingChunkGeneration: v.optional(v.unknown()),
        pendingChunkCount: v.optional(v.unknown()),
        pendingChunkSize: v.optional(v.unknown()),
        pendingFileSize: v.optional(v.unknown()),
        pendingChunkUpdatedAt: v.optional(v.unknown()),
    }),
    // Legacy optional metadata is dropped when invalid; retention and storage mode keep their defaults.
    v.transform(value => ({
        ref: value.ref,
        fileName: value.fileName,
        mimeType: value.mimeType,
        kind: value.kind,
        data: value.data instanceof Uint8Array ? value.data : new Uint8Array(value.data),
        fileSize: value.fileSize,
        updatedAt: value.updatedAt,
        retention: value.retention === 'transient' ? 'transient' : 'durable',
        ...(typeof value.sourceRef === 'string' && value.sourceRef ? {sourceRef: value.sourceRef} : {}),
        ...(typeof value.fileLastModified === 'number'
            && Number.isSafeInteger(value.fileLastModified)
            && value.fileLastModified >= 0
            ? {fileLastModified: value.fileLastModified}
            : {}),
        ...(typeof value.contentToken === 'string' && value.contentToken ? {contentToken: value.contentToken} : {}),
        ...(typeof value.contentRevision === 'number'
            && Number.isSafeInteger(value.contentRevision)
            && value.contentRevision >= 1
            ? {contentRevision: value.contentRevision}
            : {}),
        ...(typeof value.saveName === 'string' && value.saveName ? {saveName: value.saveName} : {}),
        ...(value.saveKind === 'pdf' || value.saveKind === 'docx' || value.saveKind === 'generic'
            ? {saveKind: value.saveKind}
            : {}),
        ...(value.saveHandle === null || isFileSystemFileHandleLike(value.saveHandle)
            ? {saveHandle: value.saveHandle}
            : {}),
        ...(value.sourceWitness === true ? {sourceWitness: true} : {}),
        ...(typeof value.sourceBaseWitness === 'string' && value.sourceBaseWitness
            ? {sourceBaseWitness: value.sourceBaseWitness}
            : {}),
        storageMode: value.storageMode === 'handle'
            || value.storageMode === 'chunked'
            || value.storageMode === 'source-proxy'
            ? value.storageMode
            : 'inline',
        ...(typeof value.chunkCount === 'number'
            && Number.isSafeInteger(value.chunkCount)
            && value.chunkCount >= 0
            ? {chunkCount: value.chunkCount}
            : {}),
        ...(typeof value.chunkSize === 'number'
            && Number.isSafeInteger(value.chunkSize)
            && value.chunkSize > 0
            ? {chunkSize: value.chunkSize}
            : {}),
        ...(typeof value.chunkGeneration === 'string' && value.chunkGeneration
            ? {chunkGeneration: value.chunkGeneration}
            : {}),
        ...(typeof value.pendingChunkGeneration === 'string' && value.pendingChunkGeneration
            ? {pendingChunkGeneration: value.pendingChunkGeneration}
            : {}),
        ...(typeof value.pendingChunkCount === 'number'
            && Number.isSafeInteger(value.pendingChunkCount)
            && value.pendingChunkCount >= 0
            ? {pendingChunkCount: value.pendingChunkCount}
            : {}),
        ...(typeof value.pendingChunkSize === 'number'
            && Number.isSafeInteger(value.pendingChunkSize)
            && value.pendingChunkSize > 0
            ? {pendingChunkSize: value.pendingChunkSize}
            : {}),
        ...(typeof value.pendingFileSize === 'number'
            && Number.isSafeInteger(value.pendingFileSize)
            && value.pendingFileSize >= 0
            ? {pendingFileSize: value.pendingFileSize}
            : {}),
        ...(typeof value.pendingChunkUpdatedAt === 'number'
            && Number.isFinite(value.pendingChunkUpdatedAt)
            && value.pendingChunkUpdatedAt >= 0
            ? {pendingChunkUpdatedAt: value.pendingChunkUpdatedAt}
            : {}),
    })),
    BROWSER_PERSISTED_DOCUMENT_RECORD_SCHEMA,
);

export function toPersistedDocumentRecord(
    value: unknown,
): IBrowserPersistedDocumentRecord | null {
    const result = v.safeParse(persistedDocumentRecordSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
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
