import type { TSplitPayload } from '@contracts/windowTabs';
import type { Ref } from 'vue';
import { omit } from 'es-toolkit/object';
import { cleanupSplitPayloadSnapshot } from '@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot';
import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';

interface IWorkspaceSplitCacheEntry {
    id: string;
    payload: TSplitPayload;
    createdAt: number;
    session?: IWorkspaceSplitCacheSessionState;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
let nextCacheEntryId = 0;

function createCacheEntryId() {
    nextCacheEntryId += 1;
    return `split-cache-entry:${Date.now()}:${nextCacheEntryId}`;
}

function useSplitPayloadCache() {
    return useState<Record<string, IWorkspaceSplitCacheEntry>>(
        'workspace-split:cache',
        () => ({}),
    );
}

function useSplitPayloadCacheRevision() {
    return useState<number>(
        'workspace-split:cache-revision',
        () => 0,
    );
}

function bumpCacheRevision(cacheRevision: Ref<number>) {
    cacheRevision.value += 1;
}

function isEntryExpired(entry: IWorkspaceSplitCacheEntry, now = Date.now()) {
    return now - entry.createdAt > CACHE_TTL_MS;
}

function clonePayload(payload: TSplitPayload): TSplitPayload {
    if (payload.kind === 'empty') {
        return { kind: 'empty' };
    }

    if (payload.kind === 'djvu') {
        return {
            kind: 'djvu',
            sourcePath: payload.sourcePath,
            ...(payload.sourceBackend === undefined ? {} : {sourceBackend: payload.sourceBackend}),
            ...(payload.currentPage !== undefined ? { currentPage: payload.currentPage } : {}),
            ...(payload.totalPages !== undefined ? { totalPages: payload.totalPages } : {}),
        };
    }

    return {
        kind: 'pdfSnapshot',
        fileName: payload.fileName,
        originalPath: payload.originalPath,
        ...(payload.originalBackend === undefined ? {} : {originalBackend: payload.originalBackend}),
        snapshotPath: payload.snapshotPath,
        ...(payload.snapshotBackend === undefined ? {} : {snapshotBackend: payload.snapshotBackend}),
        isDirty: payload.isDirty,
        ...(payload.isGenerated === undefined ? {} : {isGenerated: payload.isGenerated}),
        ...(payload.currentPage !== undefined ? { currentPage: payload.currentPage } : {}),
        ...(payload.totalPages !== undefined ? { totalPages: payload.totalPages } : {}),
    };
}

function cloneSession(
    session: IWorkspaceSplitCacheSessionState | null | undefined,
) {
    return session === undefined || session === null
        ? undefined
        : {
            sessionId: session.sessionId,
            sessionRevision: session.sessionRevision,
            documentRef: session.documentRef,
            ...(session.documentBackend === undefined ? {} : {documentBackend: session.documentBackend}),
            documentInstanceId: session.documentInstanceId ?? null,
            ...(session.documentRevisionToken === undefined ? {} : {documentRevisionToken: session.documentRevisionToken}),
        };
}

function entryMatchesSession(
    entry: IWorkspaceSplitCacheEntry,
    expectedSession: IWorkspaceSplitCacheSessionState | null | undefined,
) {
    if (!expectedSession || !entry.session) {
        return true;
    }

    return entry.session.sessionId === expectedSession.sessionId
        && entry.session.sessionRevision === expectedSession.sessionRevision
        && entry.session.documentRef === expectedSession.documentRef
        && entry.session.documentBackend === expectedSession.documentBackend
        && (entry.session.documentInstanceId ?? null) === (expectedSession.documentInstanceId ?? null)
        && entry.session.documentRevisionToken === expectedSession.documentRevisionToken;
}

function omitCacheEntry(
    entries: Record<string, IWorkspaceSplitCacheEntry>,
    tabId: string,
) {
    return omit(entries, [tabId]);
}

function pruneCache(
    cache: Ref<Record<string, IWorkspaceSplitCacheEntry>>,
    cacheRevision: Ref<number>,
    now = Date.now(),
) {
    let changed = false;
    let nextEntries = { ...cache.value };
    const removedEntries: Array<[string, IWorkspaceSplitCacheEntry]> = [];

    for (const [
        tabId,
        entry,
    ] of Object.entries(nextEntries)) {
        if (isEntryExpired(entry, now)) {
            removedEntries.push([
                tabId,
                entry,
            ]);
            nextEntries = omitCacheEntry(nextEntries, tabId);
            changed = true;
        }
    }

    const entries = Object.entries(nextEntries);
    if (entries.length > MAX_CACHE_ENTRIES) {
        const overflowCount = entries.length - MAX_CACHE_ENTRIES;
        const sorted = entries
            .sort((left, right) => left[1].createdAt - right[1].createdAt);

        for (let index = 0; index < overflowCount; index += 1) {
            const item = sorted[index];
            if (!item) {
                break;
            }
            removedEntries.push(item);
            nextEntries = omitCacheEntry(nextEntries, item[0]);
            changed = true;
        }
    }

    if (!changed) {
        return;
    }

    cache.value = nextEntries;
    bumpCacheRevision(cacheRevision);
    removedEntries.forEach(([
        tabId,
        entry,
    ]) => {
        void cleanupSplitPayloadSnapshot(entry.payload, {
            logSection: 'split-cache',
            context: 'prune-cache',
            metadata: { tabId },
        });
    });
}

export const useWorkspaceSplitCache = () => {
    const splitPayloadCache = useSplitPayloadCache();
    const splitPayloadCacheRevision = useSplitPayloadCacheRevision();

    function set(
        tabId: string,
        payload: TSplitPayload | null | undefined,
        options: {session?: IWorkspaceSplitCacheSessionState | null} = {},
    ) {
        const previousEntry = splitPayloadCache.value[tabId];

        if (!payload || payload.kind === 'empty') {
            if (!(tabId in splitPayloadCache.value)) {
                return null;
            }

            splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
            bumpCacheRevision(splitPayloadCacheRevision);
            if (previousEntry) {
                void cleanupSplitPayloadSnapshot(previousEntry.payload, {
                    logSection: 'split-cache',
                    context: 'clear-entry',
                    metadata: { tabId },
                });
            }
            return null;
        }

        const id = createCacheEntryId();
        const session = cloneSession(options.session);
        splitPayloadCache.value = {
            ...splitPayloadCache.value,
            [tabId]: {
                id,
                payload: clonePayload(payload),
                createdAt: Date.now(),
                ...(session === undefined ? {} : {session}),
            },
        };
        bumpCacheRevision(splitPayloadCacheRevision);
        if (
            previousEntry
            && (
                previousEntry.payload.kind !== 'pdfSnapshot'
                || payload.kind !== 'pdfSnapshot'
                || previousEntry.payload.snapshotPath !== payload.snapshotPath
            )
        ) {
            void cleanupSplitPayloadSnapshot(previousEntry.payload, {
                logSection: 'split-cache',
                context: 'replace-entry',
                metadata: { tabId },
            });
        }
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);
        return id;
    }

    function peek(
        tabId: string,
        options: {session?: IWorkspaceSplitCacheSessionState | null} = {},
    ): {
        id: string;
        payload: TSplitPayload;
        session?: IWorkspaceSplitCacheSessionState;
    } | null {
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);

        const entry = splitPayloadCache.value[tabId];
        if (!entry || !entryMatchesSession(entry, options.session)) {
            return null;
        }

        const session = cloneSession(entry.session);
        return {
            id: entry.id,
            payload: clonePayload(entry.payload),
            ...(session === undefined ? {} : {session}),
        };
    }

    function consume(
        tabId: string,
        entryId?: string | null,
        options: {session?: IWorkspaceSplitCacheSessionState | null} = {},
    ): TSplitPayload | null {
        pruneCache(splitPayloadCache, splitPayloadCacheRevision);

        const entry = splitPayloadCache.value[tabId];
        if (!entry || (entryId && entry.id !== entryId) || !entryMatchesSession(entry, options.session)) {
            return null;
        }

        splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
        bumpCacheRevision(splitPayloadCacheRevision);
        return clonePayload(entry.payload);
    }

    function has(
        tabId: string,
        options: {session?: IWorkspaceSplitCacheSessionState | null} = {},
    ) {
        void splitPayloadCacheRevision.value;
        const entry = splitPayloadCache.value[tabId];
        if (!entry) {
            return false;
        }

        if (!entryMatchesSession(entry, options.session)) {
            return false;
        }

        if (!isEntryExpired(entry)) {
            return true;
        }

        splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
        bumpCacheRevision(splitPayloadCacheRevision);
        void cleanupSplitPayloadSnapshot(entry.payload, {
            logSection: 'split-cache',
            context: 'has-expired-entry',
            metadata: { tabId },
        });
        return false;
    }

    function clear(tabId: string, entryId?: string | null) {
        const entry = splitPayloadCache.value[tabId];
        if (!entry) {
            return;
        }
        if (entryId && entry.id !== entryId) {
            return;
        }

        splitPayloadCache.value = omitCacheEntry(splitPayloadCache.value, tabId);
        bumpCacheRevision(splitPayloadCacheRevision);
        void cleanupSplitPayloadSnapshot(entry.payload, {
            logSection: 'split-cache',
            context: 'clear-tab',
            metadata: { tabId },
        });
    }

    return {
        set,
        peek,
        consume,
        has,
        clear,
    };
};
