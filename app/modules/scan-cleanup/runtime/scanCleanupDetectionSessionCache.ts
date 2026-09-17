import type {
    IScanCleanupDetectionResult,
    TScanCleanupDetectionJobState,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {isScanCleanupSourceSha256} from '@contracts/scan-cleanup/scanCleanupSettings';

export interface IScanCleanupDetectionSessionCacheEntry {
    ownerId: string;
    results: IScanCleanupDetectionResult[];
    signatures: Map<number, string>;
    /** Scalar document/settings tokens avoid rechecking every page on restore. */
    documentSignature?: string;
    signatureToken?: string;
    state: TScanCleanupDetectionJobState;
    totalPages: number;
}

export interface IScanCleanupDetectionSessionCacheLimits {
    maxBytes: number;
    maxEntries: number;
}

const SCAN_CLEANUP_DETECTION_SESSION_CACHE_LIMITS: Readonly<IScanCleanupDetectionSessionCacheLimits> = {
    // A handful of recently visited documents makes back/forward restoration
    // instant without allowing full-page detection evidence to accumulate for
    // an unbounded renderer lifetime.
    maxEntries: 8,
    maxBytes: 8 * 1024 * 1024,
};

function documentKeyFor(key: string) {
    return key.split('\u0000', 1)[0] ?? key;
}

function lifecycleRevisionFor(key: string) {
    const separator = key.indexOf('\u0000');
    return separator < 0 ? null : key.slice(separator + 1);
}

function estimateEntryBytes(entry: IScanCleanupDetectionSessionCacheEntry) {
    try {
        return new TextEncoder().encode(JSON.stringify({
            ownerId: entry.ownerId,
            results: entry.results,
            signatures: [...entry.signatures],
            documentSignature: entry.documentSignature,
            signatureToken: entry.signatureToken,
            state: entry.state,
            totalPages: entry.totalPages,
        })).byteLength;
    } catch {
        // Detection results are bridge-safe data. If a future result violates
        // that contract, do not keep an entry whose retained size is unknown.
        return Number.POSITIVE_INFINITY;
    }
}

class ScanCleanupDetectionSessionCache extends Map<string, IScanCleanupDetectionSessionCacheEntry> {
    private readonly entryBytes = new Map<string, number>();
    private retainedBytes = 0;

    constructor(private readonly limits: Readonly<IScanCleanupDetectionSessionCacheLimits>) {
        super();
    }

    get bytes() {
        return this.retainedBytes;
    }

    override get(key: string) {
        const entry = super.get(key);
        if (entry === undefined) {
            return undefined;
        }
        // Map insertion order is the LRU order. A restore counts as use.
        super.delete(key);
        super.set(key, entry);
        return entry;
    }

    override set(key: string, entry: IScanCleanupDetectionSessionCacheEntry) {
        const documentKey = documentKeyFor(key);
        for (const existingKey of [...this.keys()]) {
            if (existingKey !== key && documentKeyFor(existingKey) === documentKey) {
                this.delete(existingKey);
            }
        }
        this.delete(key);
        const bytes = estimateEntryBytes(entry);
        if (!Number.isFinite(bytes) || bytes > this.limits.maxBytes) {
            return this;
        }
        super.set(key, entry);
        this.entryBytes.set(key, bytes);
        this.retainedBytes += bytes;
        this.evictToBudget();
        return this;
    }

    override delete(key: string) {
        const bytes = this.entryBytes.get(key);
        if (bytes !== undefined) {
            this.entryBytes.delete(key);
            this.retainedBytes -= bytes;
        }
        return super.delete(key);
    }

    override clear() {
        super.clear();
        this.entryBytes.clear();
        this.retainedBytes = 0;
    }

    private evictToBudget() {
        while (
            this.size > this.limits.maxEntries
            || this.retainedBytes > this.limits.maxBytes
        ) {
            const oldestKey = this.keys().next().value;
            if (oldestKey === undefined) {
                return;
            }
            this.delete(oldestKey);
        }
    }
}

export function createScanCleanupDetectionSessionCache(
    limits: Readonly<IScanCleanupDetectionSessionCacheLimits> = SCAN_CLEANUP_DETECTION_SESSION_CACHE_LIMITS,
) {
    return new ScanCleanupDetectionSessionCache(limits);
}

/** Session-restore caches keyed by lifecycle identity (path/SHA + NUL + revision). */
export const scanCleanupDetectionSessionCache = createScanCleanupDetectionSessionCache();
export const scanCleanupAutoDetectionCanceledDocuments = new Set<string>();

function matchesDocument(key: string, documentKey: string) {
    return key === documentKey || key.startsWith(`${documentKey}\u0000`);
}

/** Retires stale revisions when the source lifecycle identity advances. */
export function retireSupersededScanCleanupDetectionState(lifecycleKey: string | null | undefined) {
    if (!lifecycleKey) {
        return;
    }
    const documentKey = documentKeyFor(lifecycleKey);
    for (const key of [...scanCleanupDetectionSessionCache.keys()]) {
        if (matchesDocument(key, documentKey) && key !== lifecycleKey) {
            scanCleanupDetectionSessionCache.delete(key);
        }
    }
    for (const key of [...scanCleanupAutoDetectionCanceledDocuments]) {
        if (matchesDocument(key, documentKey) && key !== lifecycleKey) {
            scanCleanupAutoDetectionCanceledDocuments.delete(key);
        }
    }
}

/**
 * A source hash is published after the renderer has already started work for
 * the same source path.  Treat that publication as an identity promotion,
 * rather than a document replacement, only when the path and lifecycle
 * revision are unchanged.  Keeping this predicate beside the session cache
 * makes the identity boundary shared by detection and preview sessions.
 */
export function isScanCleanupLifecycleIdentityPromotion(
    previousLifecycleKey: string | null | undefined,
    currentLifecycleKey: string | null | undefined,
    sourcePath: string | null | undefined,
    sourceSha256: string | null | undefined,
    documentRevision: string | null | undefined,
) {
    if (
        !previousLifecycleKey
        || !currentLifecycleKey
        || !sourcePath
        || !sourceSha256
        || documentRevision === null
        || documentRevision === undefined
        || previousLifecycleKey === currentLifecycleKey
    ) {
        return false;
    }
    const previousDocumentKey = documentKeyFor(previousLifecycleKey);
    const currentDocumentKey = documentKeyFor(currentLifecycleKey);
    return previousDocumentKey === sourcePath
        && isScanCleanupSourceSha256(currentDocumentKey)
        && currentDocumentKey === sourceSha256.toLowerCase()
        && lifecycleRevisionFor(previousLifecycleKey) === documentRevision
        && lifecycleRevisionFor(currentLifecycleKey) === documentRevision;
}

/**
 * Promotes one provisional lifecycle entry to its authoritative SHA-256 key.
 * The guard is deliberately part of the cache owner: callers cannot migrate
 * state across a source path or revision by passing arbitrary aliases.
 */
export function promoteScanCleanupDetectionState(options: {
    provisionalLifecycleKey: string | null | undefined;
    authoritativeLifecycleKey: string | null | undefined;
    sourcePath: string | null | undefined;
    sourceSha256: string | null | undefined;
    documentRevision: string | null | undefined;
}) {
    const {
        authoritativeLifecycleKey,
        documentRevision,
        provisionalLifecycleKey,
        sourcePath,
        sourceSha256,
    } = options;
    if (!isScanCleanupLifecycleIdentityPromotion(
        provisionalLifecycleKey,
        authoritativeLifecycleKey,
        sourcePath,
        sourceSha256,
        documentRevision,
    )) {
        return false;
    }
    if (!provisionalLifecycleKey || !authoritativeLifecycleKey) {
        return false;
    }

    const cached = scanCleanupDetectionSessionCache.get(provisionalLifecycleKey);
    if (cached !== undefined) {
        // `set` owns the one-entry-per-document invariant and evicts a stale
        // authoritative alias before inserting the promoted entry.
        scanCleanupDetectionSessionCache.delete(provisionalLifecycleKey);
        scanCleanupDetectionSessionCache.set(authoritativeLifecycleKey, cached);
    }
    if (scanCleanupAutoDetectionCanceledDocuments.delete(provisionalLifecycleKey)) {
        scanCleanupAutoDetectionCanceledDocuments.add(authoritativeLifecycleKey);
    }
    return true;
}

/** Drops all revisions for each of several lifecycle aliases. */
export function discardScanCleanupDetectionStateForAliases(
    documentKeys: ReadonlyArray<string | null | undefined>,
) {
    const aliases = new Set(
        documentKeys
            .filter((documentKey): documentKey is string => Boolean(documentKey))
            .map(documentKeyFor),
    );
    if (aliases.size === 0) {
        return;
    }
    for (const key of [...scanCleanupDetectionSessionCache.keys()]) {
        if (aliases.has(documentKeyFor(key))) {
            scanCleanupDetectionSessionCache.delete(key);
        }
    }
    for (const key of [...scanCleanupAutoDetectionCanceledDocuments]) {
        if (aliases.has(documentKeyFor(key))) {
            scanCleanupAutoDetectionCanceledDocuments.delete(key);
        }
    }
}
