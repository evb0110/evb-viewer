import { BROWSER_DOCUMENT_CHUNK_SIZE } from '@app/platform/browser/browserDocumentConstants';
import { groupBy } from 'es-toolkit/array';
import {cloneBytes} from '@app/platform/browser/browserDocumentBytes';
import { defaultRetentionForKind } from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IBrowserDocumentEntryInput,
    IBrowserPersistedDocumentRecord,
    IChunkKeyRecord,
} from '@app/platform/browser/browserDocumentTypes';
import {
    createBrowserDocumentContentToken,
    getBrowserDocumentEntryContentRevision,
} from '@app/platform/browser/browserDocumentRevision';
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
        data: entry.storageMode === 'chunked' ? new Uint8Array() : cloneData ? cloneBytes(data) : data,
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
        ...(entry.storageMode === 'inline' && data.byteLength > 0
            ? {chunkGeneration: createBrowserDocumentContentToken()}
            : entry.chunkGeneration ? {chunkGeneration: entry.chunkGeneration} : {}),
        ...(entry.pendingChunkGeneration ? { pendingChunkGeneration: entry.pendingChunkGeneration } : {}),
        ...(entry.pendingChunkCount !== undefined ? { pendingChunkCount: entry.pendingChunkCount } : {}),
        ...(entry.pendingChunkSize !== undefined ? { pendingChunkSize: entry.pendingChunkSize } : {}),
        ...(entry.pendingFileSize !== undefined ? { pendingFileSize: entry.pendingFileSize } : {}),
        ...(entry.pendingChunkUpdatedAt !== undefined ? { pendingChunkUpdatedAt: entry.pendingChunkUpdatedAt } : {}),
    };
}

export {toPersistedDocumentRecord} from '@app/platform/browser/browserDocumentTypes';

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
