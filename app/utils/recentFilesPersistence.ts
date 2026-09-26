import type { IRecentFile } from '@contracts/shared';
import { take } from 'es-toolkit/array';
import {
    inferDocumentRefBackend,
    parseDocumentRef,
    type TDocumentBackend,
} from '@contracts/documentRef';
import { parseEpochMs } from '@contracts/timestamps';
import {isRecord} from '@contracts/runtimeGuards';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';
import * as v from 'valibot';

export const RECENT_FILES_COOKIE_KEY = 'evb_viewer_recent_files';
const RECENT_FILES_LIMIT = 30;

interface IRecentFilesCookieSnapshot {
    recentFiles: IRecentFile[];
    hasSnapshot: boolean;
    truncated: boolean;
}

function normalizeRecentFileBackend(value: unknown, originalPath: unknown): TDocumentBackend | null {
    if (value === 'browser' || value === 'electron') {
        return value;
    }
    const documentRef = parseDocumentRef(originalPath);
    if (documentRef === null) {
        return null;
    }

    const inferred = inferDocumentRefBackend(documentRef);
    return inferred === 'unknown' ? null : inferred;
}

const recentFileRecordSchema = v.pipe(
    v.object({
        originalPath: v.optional(v.unknown()),
        fileName: v.optional(v.unknown()),
        timestamp: v.optional(v.unknown()),
        backend: v.optional(v.unknown()),
        fileSize: v.optional(v.unknown()),
        modifiedAt: v.optional(v.unknown()),
    }),
    // Document references, backend inference and legacy optional values need domain normalization.
    v.transform(value => {
        const originalPath = typeof value.originalPath === 'string' ? value.originalPath : null;
        const fileName = typeof value.fileName === 'string' ? value.fileName : null;
        const timestamp = typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
            ? value.timestamp
            : null;
        const backend = normalizeRecentFileBackend(value.backend, originalPath);
        const documentRef = parseDocumentRef(originalPath);
        const parsedTimestamp = parseEpochMs(timestamp);
        const modifiedAt = typeof value.modifiedAt === 'number' && Number.isFinite(value.modifiedAt)
            ? value.modifiedAt
            : null;
        const parsedModifiedAt = modifiedAt === null ? null : parseEpochMs(modifiedAt);
        if (!documentRef || !fileName || parsedTimestamp === null || backend === null
            || (parsedModifiedAt === null && modifiedAt !== null)) {
            return null;
        }
        const fileSize = typeof value.fileSize === 'number' && Number.isFinite(value.fileSize)
            ? value.fileSize
            : null;
        return {
            originalPath: documentRef,
            backend,
            fileName,
            timestamp: parsedTimestamp,
            ...(fileSize === null ? {} : {fileSize}),
            ...(parsedModifiedAt === null ? {} : {modifiedAt: parsedModifiedAt}),
        };
    }),
    v.check(value => value !== null),
    v.transform(value => value as NonNullable<typeof value>),
);

const recentFileTupleSchema = v.pipe(
    v.array(v.unknown()),
    v.transform(tuple => {
        const originalPath = tuple[0];
        const fileName = tuple[1];
        const timestamp = tuple[2];
        const fileSize = tuple[3];
        const backend = normalizeRecentFileBackend(tuple[4], originalPath);
        const modifiedAt = tuple[5];
        const documentRef = parseDocumentRef(originalPath);
        const parsedTimestamp = parseEpochMs(timestamp);
        const parsedModifiedAt = modifiedAt === undefined || modifiedAt === null
            ? undefined
            : parseEpochMs(modifiedAt);
        if (documentRef === null || typeof fileName !== 'string' || parsedTimestamp === null
            || backend === null || parsedModifiedAt === null) {
            return null;
        }
        return {
            originalPath: documentRef,
            backend,
            fileName,
            timestamp: parsedTimestamp,
            ...(typeof fileSize === 'number' ? {fileSize} : {}),
            ...(parsedModifiedAt === undefined ? {} : {modifiedAt: parsedModifiedAt}),
        };
    }),
    v.check(value => value !== null),
    v.transform(value => value as NonNullable<typeof value>),
);

const recentFileCandidateSchema = v.union([
    recentFileRecordSchema,
    recentFileTupleSchema,
]);
const recentFilesSchema = v.array(recentFileCandidateSchema);
const legacyRecentFilesCookieSchema = v.object({
    v: v.literal(1),
    t: v.boolean(),
    f: recentFilesSchema,
});
const recentFilesStorageEnvelopeSchema = v.object({
    truncated: v.optional(v.unknown()),
    files: v.optional(v.unknown()),
});
const recentFilesCookieEnvelopeSchema = v.object({
    f: v.optional(v.unknown()),
    files: v.optional(v.unknown()),
    t: v.optional(v.unknown()),
    truncated: v.optional(v.unknown()),
});

type TNormalizedRecentFile = v.InferOutput<typeof recentFileCandidateSchema>;

function normalizeRecentFileTuple(value: unknown): IRecentFile | null {
    const result = v.safeParse(recentFileTupleSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

function normalizeRecentFilesCollection(value: unknown) {
    if (!Array.isArray(value)) {
        return [];
    }

    const recentFiles: IRecentFile[] = [];
    const seenPaths = new Set<string>();
    const values: unknown[] = value;

    for (const candidateValue of values) {
        const candidate = normalizeRecentFile(candidateValue) ?? normalizeRecentFileTuple(candidateValue);
        if (!candidate || seenPaths.has(candidate.originalPath)) {
            continue;
        }

        seenPaths.add(candidate.originalPath);
        recentFiles.push(candidate);
        if (recentFiles.length >= RECENT_FILES_LIMIT) {
            break;
        }
    }

    return recentFiles;
}

function parseJsonValue(raw: string | null | undefined): unknown {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function parseStrictRecentFilesSnapshot(
    collection: unknown,
    truncated: boolean,
): IRecentFilesCookieSnapshot {
    const parsed = v.safeParse(recentFilesSchema, collection, {abortEarly: true});
    if (!parsed.success) {
        return {
            recentFiles: [],
            hasSnapshot: false,
            truncated: false,
        };
    }
    return {
        recentFiles: normalizeNormalizedRecentFiles(parsed.output),
        hasSnapshot: true,
        truncated,
    };
}

export function parseLegacyRecentFilesCookieSnapshot(raw: string | null | undefined) {
    const parsed = parseJsonValue(raw);
    const decoded = v.safeParse(legacyRecentFilesCookieSchema, parsed, {abortEarly: true});
    if (!decoded.success) {
        return parseStrictRecentFilesSnapshot(null, false);
    }
    return {
        recentFiles: normalizeNormalizedRecentFiles(decoded.output.f),
        hasSnapshot: true,
        truncated: decoded.output.t,
    };
}

export function parseRecentFilesStorageSnapshot(raw: string | null | undefined) {
    const parsed = parseJsonValue(raw);
    if (Array.isArray(parsed)) {
        return parseStrictRecentFilesSnapshot(parsed, false);
    }
    if (isRecord(parsed)) {
        const decoded = v.safeParse(recentFilesStorageEnvelopeSchema, parsed, {abortEarly: true});
        if (decoded.success && decoded.output.truncated === true && Array.isArray(decoded.output.files)) {
            return parseStrictRecentFilesSnapshot(decoded.output.files, true);
        }
    }
    return parseStrictRecentFilesSnapshot(null, false);
}

function normalizeRecentFile(value: unknown): IRecentFile | null {
    const result = v.safeParse(recentFileRecordSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

function normalizeNormalizedRecentFiles(value: TNormalizedRecentFile[]) {
    const recentFiles: IRecentFile[] = [];
    const seenPaths = new Set<string>();
    for (const candidate of value) {
        if (seenPaths.has(candidate.originalPath)) {
            continue;
        }
        seenPaths.add(candidate.originalPath);
        recentFiles.push(candidate);
        if (recentFiles.length >= RECENT_FILES_LIMIT) {
            break;
        }
    }
    return recentFiles;
}

export function parseRecentFilesPayload(raw: string | null | undefined) {
    if (!raw) {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return normalizeRecentFilesCollection(parsed);
        }

        if (!isRecord(parsed)) {
            return [];
        }

        const envelope = v.safeParse(recentFilesCookieEnvelopeSchema, parsed, {abortEarly: true});
        return normalizeRecentFilesCollection(envelope.success
            ? Array.isArray(envelope.output.f) ? envelope.output.f : envelope.output.files
            : undefined);
    } catch {
        return [];
    }
}

export function parseRecentFilesCookieSnapshot(raw: string | null | undefined): IRecentFilesCookieSnapshot {
    if (!raw) {
        return {
            recentFiles: [],
            hasSnapshot: false,
            truncated: false,
        };
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return {
                recentFiles: normalizeRecentFilesCollection(parsed),
                hasSnapshot: true,
                truncated: false,
            };
        }

        if (!isRecord(parsed)) {
            return {
                recentFiles: [],
                hasSnapshot: false,
                truncated: false,
            };
        }

        const envelope = v.safeParse(recentFilesCookieEnvelopeSchema, parsed, {abortEarly: true});
        if (!envelope.success) {
            return {
                recentFiles: [],
                hasSnapshot: false,
                truncated: false,
            };
        }
        return {
            recentFiles: normalizeRecentFilesCollection(
                Array.isArray(envelope.output.f)
                    ? envelope.output.f
                    : envelope.output.files,
            ),
            hasSnapshot: true,
            truncated: envelope.output.t === true || envelope.output.truncated === true,
        };
    } catch {
        return {
            recentFiles: [],
            hasSnapshot: false,
            truncated: false,
        };
    }
}

function readCookieValue(key: string) {
    if (typeof document === 'undefined' || typeof document.cookie !== 'string') {
        return null;
    }

    const prefix = `${key}=`;
    const cookie = document.cookie
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(prefix));
    if (!cookie) {
        return null;
    }

    try {
        return decodeURIComponent(cookie.slice(prefix.length));
    } catch {
        return cookie.slice(prefix.length);
    }
}

export function expireLegacyRecentFilesCookie() {
    if (typeof document === 'undefined') {
        return;
    }
    const secureAttribute = typeof location !== 'undefined' && location.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${RECENT_FILES_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secureAttribute}`;
}

export function readBrowserRecentFilesSnapshot(): IRecentFilesCookieSnapshot {
    const legacySnapshot = parseLegacyRecentFilesCookieSnapshot(
        readCookieValue(RECENT_FILES_COOKIE_KEY),
    );
    if (legacySnapshot.hasSnapshot) {
        const committed = safeSetLocalStorageItem(
            BROWSER_RECENT_FILES_STORAGE_KEY,
            legacySnapshot.truncated
                ? JSON.stringify({
                    files: legacySnapshot.recentFiles,
                    truncated: true,
                })
                : serializeRecentFilesPayload(legacySnapshot.recentFiles),
        );
        if (committed) {
            expireLegacyRecentFilesCookie();
        }
        return legacySnapshot;
    }
    expireLegacyRecentFilesCookie();

    const rawStorageSnapshot = safeGetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    if (rawStorageSnapshot !== null) {
        const storageSnapshot = parseRecentFilesStorageSnapshot(rawStorageSnapshot);
        if (storageSnapshot.hasSnapshot) {
            return storageSnapshot;
        }
    }
    return {
        recentFiles: [],
        hasSnapshot: false,
        truncated: false,
    };
}

export function serializeRecentFilesPayload(recentFiles: IRecentFile[]) {
    return JSON.stringify(take(recentFiles, RECENT_FILES_LIMIT));
}
