import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentRef } from '@contracts/documentRef';
import {isRecord} from '@contracts/runtimeGuards';
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

export function createChunkKey(ref: string, index: number, generation?: string) {
    return generation
        ? `${ref}::${generation}::${index}`
        : `${ref}::${index}`;
}
