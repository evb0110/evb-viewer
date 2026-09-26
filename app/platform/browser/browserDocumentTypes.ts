import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import * as v from 'valibot';

export const BROWSER_DOCUMENT_STORAGE_MODE_SCHEMA = v.picklist([
    'inline',
    'handle',
    'chunked',
    'source-proxy',
]);

export type TBrowserDocumentStorageMode = v.InferOutput<typeof BROWSER_DOCUMENT_STORAGE_MODE_SCHEMA>;

const nonNegativeNumberSchema = v.pipe(v.number(), v.minValue(0));
const finiteNonNegativeNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const safeNonNegativeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const BROWSER_PERSISTED_DOCUMENT_RECORD_SCHEMA = v.object({
    ref: v.pipe(v.string(), v.minLength(1)),
    fileName: v.pipe(v.string(), v.minLength(1)),
    mimeType: v.pipe(v.string(), v.minLength(1)),
    kind: v.picklist([
        'source',
        'working',
        'output',
    ]),
    retention: v.optional(v.picklist([
        'durable',
        'transient',
    ])),
    sourceRef: v.optional(v.string()),
    data: v.custom<Uint8Array>(value => value instanceof Uint8Array),
    fileSize: safeNonNegativeIntegerSchema,
    fileLastModified: v.optional(safeNonNegativeIntegerSchema),
    updatedAt: safeNonNegativeIntegerSchema,
    contentToken: v.optional(v.string()),
    contentRevision: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    saveName: v.optional(v.string()),
    saveKind: v.optional(v.picklist([
        'pdf',
        'docx',
        'generic',
    ])),
    saveHandle: v.optional(v.nullable(v.custom<FileSystemFileHandle>(value => (
        typeof value === 'object'
        && value !== null
        && 'kind' in value
        && value.kind === 'file'
        && 'name' in value
        && typeof value.name === 'string'
        && 'getFile' in value
        && typeof value.getFile === 'function'
    )))),
    sourceWitness: v.optional(v.boolean()),
    sourceBaseWitness: v.optional(v.string()),
    storageMode: v.optional(BROWSER_DOCUMENT_STORAGE_MODE_SCHEMA),
    chunkCount: v.optional(safeNonNegativeIntegerSchema),
    chunkSize: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    chunkGeneration: v.optional(v.string()),
    pendingChunkGeneration: v.optional(v.string()),
    pendingChunkCount: v.optional(safeNonNegativeIntegerSchema),
    pendingChunkSize: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    pendingFileSize: v.optional(safeNonNegativeIntegerSchema),
    pendingChunkUpdatedAt: v.optional(nonNegativeNumberSchema),
});

export type IBrowserPersistedDocumentRecord = v.InferOutput<typeof BROWSER_PERSISTED_DOCUMENT_RECORD_SCHEMA>;

export interface IBrowserDocumentEntry extends IBrowserPersistedDocumentRecord {
    ref: TDocumentRef;
    /** Volatile runtime state: persistence failed, so unloading would lose the document. */
    memoryOnly?: boolean;
    /** Volatile immutable File snapshot used for consistent browser range reads. */
    fileSnapshot?: File;
    pendingLoad: Promise<void> | null;
    retention: 'durable' | 'transient';
    saveName?: string | undefined;
    saveKind: 'pdf' | 'docx' | 'generic';
    saveHandle?: FileSystemFileHandle | null | undefined;
    sourceWitness?: boolean | undefined;
    sourceBaseWitness?: string | undefined;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount: number;
    chunkSize: number;
    chunkGeneration?: string | undefined;
    pendingChunkGeneration?: string | undefined;
    pendingChunkCount?: number | undefined;
    pendingChunkSize?: number | undefined;
    pendingFileSize?: number | undefined;
    pendingChunkUpdatedAt?: number | undefined;
}

export interface IRegisterFileOptions {
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    saveKind?: IBrowserDocumentEntry['saveKind'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
    sourceBaseWitness?: string;
}

export interface ICreateStoredDocumentOptions {
    mimeType: string;
    saveKind?: IBrowserDocumentEntry['saveKind'];
    kind?: IBrowserDocumentEntry['kind'];
    retention?: IBrowserDocumentEntry['retention'];
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
    sourceBaseWitness?: string;
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

export const BROWSER_DOCUMENT_CHUNK_RECORD_SCHEMA = v.object({
    key: v.string(),
    ref: v.string(),
    index: nonNegativeNumberSchema,
    generation: v.optional(v.string()),
    data: v.custom<Uint8Array>(value => value instanceof Uint8Array),
});

export type IBrowserDocumentChunkRecord = v.InferOutput<typeof BROWSER_DOCUMENT_CHUNK_RECORD_SCHEMA>;

export const BROWSER_DOCUMENT_LEASE_DEPENDENCY_SCHEMA = v.object({
    ref: v.pipe(v.string(), v.minLength(1)),
    chunkGeneration: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type IBrowserDocumentLeaseDependency = v.InferOutput<typeof BROWSER_DOCUMENT_LEASE_DEPENDENCY_SCHEMA>;

export const BROWSER_DOCUMENT_LIVE_LEASE_SCHEMA = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    ownerId: v.pipe(v.string(), v.minLength(1)),
    generation: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    leaseRevision: safeNonNegativeIntegerSchema,
    status: v.picklist([
        'active',
        'suspended',
        'dead',
    ]),
    heartbeatAt: finiteNonNegativeNumberSchema,
    protectedDependencies: v.array(BROWSER_DOCUMENT_LEASE_DEPENDENCY_SCHEMA),
});

export type IBrowserDocumentLiveLease = v.InferOutput<typeof BROWSER_DOCUMENT_LIVE_LEASE_SCHEMA>;

export const BROWSER_CHUNK_KEY_RECORD_SCHEMA = v.object({
    ref: v.string(),
    index: nonNegativeNumberSchema,
    generation: v.optional(v.string()),
});

export type IChunkKeyRecord = v.InferOutput<typeof BROWSER_CHUNK_KEY_RECORD_SCHEMA>;

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
    sourceBaseWitness?: string;
    storageMode: TBrowserDocumentStorageMode;
    chunkCount?: number;
    chunkSize?: number;
    chunkGeneration?: string;
}
