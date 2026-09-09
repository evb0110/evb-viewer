import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';

export type TBrowserDocumentStorageMode =
    | 'inline'
    | 'handle'
    | 'chunked'
    | 'source-proxy';

export interface IBrowserPersistedDocumentRecord {
    ref: string;
    fileName: string;
    mimeType: string;
    kind: 'source' | 'working' | 'output';
    retention?: 'durable' | 'transient';
    sourceRef?: string;
    data: Uint8Array;
    fileSize: number;
    fileLastModified?: number | undefined;
    updatedAt: number;
    contentToken?: string;
    contentRevision?: number;
    saveName?: string;
    saveKind?: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    sourceWitness?: boolean;
    storageMode?: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
    pendingChunkGeneration?: string;
    pendingChunkCount?: number;
    pendingChunkSize?: number;
    pendingFileSize?: number;
    pendingChunkUpdatedAt?: number;
}

export interface IBrowserDocumentEntry extends IBrowserPersistedDocumentRecord {
    ref: TDocumentRef;
    /** Volatile runtime state: persistence failed, so unloading would lose the document. */
    memoryOnly?: boolean;
    /** Volatile immutable File snapshot used for consistent browser range reads. */
    fileSnapshot?: File;
    pendingLoad: Promise<void> | null;
    retention: 'durable' | 'transient';
    saveName?: string;
    saveKind: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null;
    sourceWitness?: boolean;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount: number;
    chunkSize: number;
    chunkGeneration?: string;
    pendingChunkGeneration?: string;
    pendingChunkCount?: number;
    pendingChunkSize?: number;
    pendingFileSize?: number;
    pendingChunkUpdatedAt?: number;
}

export interface IRegisterFileOptions {
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    saveKind?: IBrowserDocumentEntry['saveKind'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
}

export interface ICreateStoredDocumentOptions {
    mimeType: string;
    saveKind?: IBrowserDocumentEntry['saveKind'];
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
    storageMode?: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
}

export interface IWriteDocumentOptions {
    unloadAfterPersist?: boolean;
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    skipDocumentRevisionCheckForBootstrap?: boolean;
}

export interface IBrowserDocumentChunkRecord {
    key: string;
    ref: string;
    index: number;
    generation?: string;
    data: Uint8Array;
}

export interface IBrowserDocumentLeaseDependency {
    ref: string;
    chunkGeneration?: string;
}

export interface IBrowserDocumentLiveLease {
    id: string;
    ownerId: string;
    generation: number;
    leaseRevision: number;
    status: 'active' | 'suspended' | 'dead';
    heartbeatAt: number;
    protectedDependencies: IBrowserDocumentLeaseDependency[];
}

export interface IChunkKeyRecord {
    ref: string;
    index: number;
    generation?: string;
}

export interface IBrowserDocumentEntryInput {
    ref: TDocumentRef;
    fileName: string;
    mimeType: string;
    kind: IBrowserDocumentEntry['kind'];
    retention: IBrowserDocumentEntry['retention'];
    sourceRef?: string;
    data: Uint8Array;
    fileSize: number;
    fileLastModified?: number | undefined;
    contentToken?: string;
    contentRevision?: number;
    saveKind: IBrowserDocumentEntry['saveKind'];
    saveHandle: FileSystemFileHandle | null;
    sourceWitness?: boolean;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
}
