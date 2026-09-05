import type {IBrowserDocumentEntry} from '@app/platform/browser/browserDocumentTypes';

export function captureBrowserDocumentEntryStorageState(entry: IBrowserDocumentEntry) {
    return {
        storageMode: entry.storageMode,
        chunkCount: entry.chunkCount,
        chunkSize: entry.chunkSize,
        chunkGeneration: entry.chunkGeneration,
        fileSize: entry.fileSize,
        fileLastModified: entry.fileLastModified,
        updatedAt: entry.updatedAt,
        contentToken: entry.contentToken,
        contentRevision: entry.contentRevision,
        data: entry.data,
        fileSnapshot: entry.fileSnapshot,
        sourceWitness: entry.sourceWitness,
        pendingChunkGeneration: entry.pendingChunkGeneration,
        pendingChunkCount: entry.pendingChunkCount,
        pendingChunkSize: entry.pendingChunkSize,
        pendingFileSize: entry.pendingFileSize,
        pendingChunkUpdatedAt: entry.pendingChunkUpdatedAt,
    };
}

export type TBrowserDocumentEntryStorageState = ReturnType<typeof captureBrowserDocumentEntryStorageState>;

export function restoreBrowserDocumentEntryStorageState(
    entry: IBrowserDocumentEntry,
    state: TBrowserDocumentEntryStorageState,
) {
    entry.storageMode = state.storageMode;
    entry.chunkCount = state.chunkCount;
    entry.chunkSize = state.chunkSize;
    entry.fileSize = state.fileSize;
    if (state.fileLastModified !== undefined) {
        entry.fileLastModified = state.fileLastModified;
    } else {
        delete entry.fileLastModified;
    }
    entry.updatedAt = state.updatedAt;
    entry.data = state.data;
    if (state.fileSnapshot) {
        entry.fileSnapshot = state.fileSnapshot;
    } else {
        delete entry.fileSnapshot;
    }
    if (state.chunkGeneration) {
        entry.chunkGeneration = state.chunkGeneration;
    } else {
        delete entry.chunkGeneration;
    }
    if (state.contentToken) {
        entry.contentToken = state.contentToken;
    } else {
        delete entry.contentToken;
    }
    if (state.contentRevision !== undefined) {
        entry.contentRevision = state.contentRevision;
    } else {
        delete entry.contentRevision;
    }
    if (state.sourceWitness) {
        entry.sourceWitness = true;
    } else {
        delete entry.sourceWitness;
    }
    if (state.pendingChunkGeneration) {
        entry.pendingChunkGeneration = state.pendingChunkGeneration;
    } else {
        delete entry.pendingChunkGeneration;
    }
    if (state.pendingChunkCount !== undefined) {
        entry.pendingChunkCount = state.pendingChunkCount;
    } else {
        delete entry.pendingChunkCount;
    }
    if (state.pendingChunkSize !== undefined) {
        entry.pendingChunkSize = state.pendingChunkSize;
    } else {
        delete entry.pendingChunkSize;
    }
    if (state.pendingFileSize !== undefined) {
        entry.pendingFileSize = state.pendingFileSize;
    } else {
        delete entry.pendingFileSize;
    }
    if (state.pendingChunkUpdatedAt !== undefined) {
        entry.pendingChunkUpdatedAt = state.pendingChunkUpdatedAt;
    } else {
        delete entry.pendingChunkUpdatedAt;
    }
}
