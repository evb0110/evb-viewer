import {
    createRequestId, type TRequestId,
} from '@contracts/shared';
import type {
    IScanCleanupMarginsMm,
    IScanCleanupPageOverride,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    cloneScanCleanupPreferenceValue,
    createDefaultScanCleanupSettingsFile,
    isScanCleanupSourceSha256,
    type IScanCleanupDocumentPreferencePatch,
    type IScanCleanupGlobalPreferences,
    type IScanCleanupGlobalPreferencePatch,
    type IScanCleanupSettingsFile,
    type IScanCleanupSettingsReadRequest,
    type IScanCleanupSettingsUpdateRequest,
} from '@contracts/scan-cleanup/scanCleanupSettings';
import type {EffectScope} from 'vue';
import {isEqual} from 'es-toolkit/predicate';
import {
    clearScanCleanupLegacyStorage,
    exportScanCleanupLegacyStorage,
    hasScanCleanupLegacyDocumentEntry,
    loadScanCleanupDocumentMargins,
    loadScanCleanupDocumentPageOverrideDefaults,
    loadScanCleanupDocumentOutputMode,
    loadScanCleanupDocumentOverrides,
    loadScanCleanupPreferences,
    saveScanCleanupDocumentPreferences,
    saveScanCleanupPreferencesPatch,
    SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {isDesktopPlatformActive} from '@app/utils/platform';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';

interface IScanCleanupPreferencesStoreOptions {
    sourceSha256?: string | null;
    legacyDocumentKey?: string | null;
}

export interface IScanCleanupDocumentSettingsSnapshot {
    overrides: TScanCleanupPageOverrides;
    pageOverrideDefaults: IScanCleanupPageOverride | null;
    marginsMm: IScanCleanupMarginsMm | null;
    outputMode: TScanCleanupOutputModeSetting;
}

let preferences: IScanCleanupGlobalPreferences | null = null;
let persistenceScope: EffectScope | null = null;
let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPreferences: IScanCleanupGlobalPreferences | null = null;
let lifecycleListenersRegistered = false;
let desktopStore = false;
let preferencesHydrated = false;
let preferencesHydrationPromise: Promise<void> | null = null;
let remoteSettingsFile: IScanCleanupSettingsFile | null = null;
let remoteWriteQueue = Promise.resolve();
interface IPendingGlobalWrite {
    request: IScanCleanupSettingsUpdateRequest;
    acknowledge: () => void;
    promise: Promise<void>;
}
let pendingRemoteGlobalWrite: IPendingGlobalWrite | null = null;
let persistenceRetryTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceRetryAttempt = 0;
let persistedBrowserPreferences: IScanCleanupGlobalPreferences | null = null;
let migrationContext: IScanCleanupPreferencesStoreOptions = {};
let applyingRemotePreferences = false;
let acknowledgedPreferences: IScanCleanupGlobalPreferences | null = null;
let observedPreferences: IScanCleanupGlobalPreferences | null = null;
let unsubscribeCommittedGlobalPreferences: (() => void) | null = null;

const pendingGlobalFields = new Map<keyof IScanCleanupGlobalPreferences, unknown>();
interface IPendingDocumentUpdate {
    request: IScanCleanupSettingsUpdateRequest;
    token: IScanCleanupDocumentPersistenceToken;
    version: number;
    queued: boolean;
    writePromise?: Promise<void>;
}
const pendingDocumentUpdates = new Map<string, IPendingDocumentUpdate>();
interface IPendingLegacyDocumentUpdate {
    sourceSha256: string | null | undefined;
    legacyDocumentKey: string | null | undefined;
    patch: IScanCleanupDocumentPreferencePatch;
    token: IScanCleanupDocumentPersistenceToken;
}
const pendingLegacyDocumentUpdates = new Map<string, IPendingLegacyDocumentUpdate>();
let nextDocumentUpdateVersion = 0;
let documentPersistenceTimer: ReturnType<typeof setTimeout> | null = null;

function documentUpdateKey(request: IScanCleanupSettingsUpdateRequest) {
    if ('settingsPatch' in request) {
        return null;
    }
    return request.document === undefined
        ? null
        : `${request.document.sourceSha256.toLowerCase()}\0${request.document.legacyDocumentKey ?? ''}`;
}

function unresolvedDocumentUpdateKey(legacyDocumentKey: string | null | undefined) {
    return `\0${legacyDocumentKey ?? ''}`;
}

function promoteUnresolvedDocumentUpdate(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
) {
    if (!desktopStore || !isScanCleanupSourceSha256(sourceSha256)) {
        return;
    }
    const key = unresolvedDocumentUpdateKey(legacyDocumentKey);
    const pending = pendingLegacyDocumentUpdates.get(key);
    if (!pending) {
        return;
    }
    if (!isScanCleanupDocumentPersistenceTokenCurrent(pending.token)) {
        pendingLegacyDocumentUpdates.delete(key);
        return;
    }
    pendingLegacyDocumentUpdates.delete(key);
    void scheduleScanCleanupDocumentPreferencesInStore(sourceSha256, legacyDocumentKey, pending.patch)
        .catch(() => undefined);
}
const documentPersistenceEpochs = new Map<string, number>();
const PERSISTENCE_RETRY_BASE_DELAY_MS = 1_000;
const PERSISTENCE_RETRY_MAX_DELAY_MS = 30_000;
const MAX_PERSISTENCE_RETRY_ATTEMPTS = 5;

export interface IScanCleanupDocumentPersistenceToken {
    legacyDocumentKey: string | null;
    legacyDocumentKeyEpoch: number;
    sourceSha256: string | null;
    sourceSha256Epoch: number;
}

function documentPersistenceEpochKey(kind: 'legacy' | 'sha256', value: string | null | undefined) {
    if (!value) {
        return null;
    }
    return `${kind}:${kind === 'sha256' ? value.toLowerCase() : value}`;
}

function readDocumentPersistenceEpoch(key: string | null) {
    return key === null ? 0 : documentPersistenceEpochs.get(key) ?? 0;
}

export function captureScanCleanupDocumentPersistenceToken(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
): IScanCleanupDocumentPersistenceToken {
    const normalizedSourceSha256 = sourceSha256?.toLowerCase() ?? null;
    const normalizedLegacyDocumentKey = legacyDocumentKey ?? null;
    return {
        sourceSha256: normalizedSourceSha256,
        sourceSha256Epoch: readDocumentPersistenceEpoch(
            documentPersistenceEpochKey('sha256', normalizedSourceSha256),
        ),
        legacyDocumentKey: normalizedLegacyDocumentKey,
        legacyDocumentKeyEpoch: readDocumentPersistenceEpoch(
            documentPersistenceEpochKey('legacy', normalizedLegacyDocumentKey),
        ),
    };
}

export function isScanCleanupDocumentPersistenceTokenCurrent(
    token: IScanCleanupDocumentPersistenceToken,
) {
    return token.sourceSha256Epoch === readDocumentPersistenceEpoch(
        documentPersistenceEpochKey('sha256', token.sourceSha256),
    ) && token.legacyDocumentKeyEpoch === readDocumentPersistenceEpoch(
        documentPersistenceEpochKey('legacy', token.legacyDocumentKey),
    );
}

export function invalidateScanCleanupDocumentPersistence(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
) {
    if (desktopStore && legacyDocumentKey !== undefined && legacyDocumentKey !== null) {
        pendingLegacyDocumentUpdates.delete(unresolvedDocumentUpdateKey(legacyDocumentKey));
    }
    for (const key of [
        documentPersistenceEpochKey('sha256', sourceSha256),
        documentPersistenceEpochKey('legacy', legacyDocumentKey),
    ]) {
        if (key !== null) {
            documentPersistenceEpochs.set(key, readDocumentPersistenceEpoch(key) + 1);
        }
    }
}

function currentScanCleanupCapability() {
    const capability = getScanCleanupCapability();
    if (!capability) {
        throw new Error('Scan Cleanup platform capability is unavailable');
    }
    return capability;
}

async function readRemoteSettings(request: IScanCleanupSettingsReadRequest) {
    const getSettings = currentScanCleanupCapability().getSettings;
    if (!getSettings) {
        throw new Error('File-backed scan-cleanup settings are unavailable');
    }
    return getSettings(request);
}

function updateMigrationContext(options: IScanCleanupPreferencesStoreOptions | undefined) {
    if (!options) {
        return;
    }
    migrationContext = {
        ...(options.sourceSha256 === undefined ? {} : {sourceSha256: options.sourceSha256}),
        ...(options.legacyDocumentKey === undefined ? {} : {legacyDocumentKey: options.legacyDocumentKey}),
    };
}

function warnMissingDocumentSourceHash(action: 'load' | 'persist', legacyDocumentKey: string | null | undefined) {
    BrowserLogger.warn(
        'scan-cleanup',
        `Cannot ${action} document preferences without the authoritative source SHA-256`,
        () => ({
            reason: 'missing-authoritative-source-sha256',
            hasLegacyDocumentKey: Boolean(legacyDocumentKey),
        }),
    );
}

function createSettingsReadRequest(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
    includeLegacyStorage = false,
): IScanCleanupSettingsReadRequest {
    return {
        ...(includeLegacyStorage ? {legacyStorage: exportScanCleanupLegacyStorage()} : {}),
        ...(sourceSha256 === undefined ? {} : {sourceSha256}),
        ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
    };
}

function buildGlobalPreferencesPatch(
    previous: IScanCleanupGlobalPreferences,
    next: IScanCleanupGlobalPreferences,
): IScanCleanupGlobalPreferencePatch {
    const patch: IScanCleanupGlobalPreferencePatch = {};
    for (const key of Object.keys(createDefaultScanCleanupSettingsFile().settings) as Array<keyof IScanCleanupGlobalPreferences>) {
        if (!isEqual(previous[key], next[key])) {
            Object.assign(patch, {[key]: cloneScanCleanupPreferenceValue(next[key])});
        }
    }
    return patch;
}

function schedulePersistenceRetry() {
    if (
        persistenceRetryTimer !== null
        || (
            pendingDocumentUpdates.size === 0
            && pendingLegacyDocumentUpdates.size === 0
            && pendingRemoteGlobalWrite === null
            && pendingPreferences === null
        )
    ) {
        return;
    }
    if (persistenceRetryAttempt >= MAX_PERSISTENCE_RETRY_ATTEMPTS) {
        BrowserLogger.warn('scan-cleanup', 'Stopped retrying failed settings persistence', () => ({
            attempts: persistenceRetryAttempt,
            reason: 'retry-limit-reached',
        }));
        return;
    }
    const delayMs = Math.min(
        PERSISTENCE_RETRY_BASE_DELAY_MS * (2 ** persistenceRetryAttempt),
        PERSISTENCE_RETRY_MAX_DELAY_MS,
    );
    persistenceRetryAttempt += 1;
    persistenceRetryTimer = setTimeout(() => {
        persistenceRetryTimer = null;
        for (const [
            key,
            write,
        ] of pendingLegacyDocumentUpdates) {
            if (!isScanCleanupDocumentPersistenceTokenCurrent(write.token)) {
                pendingLegacyDocumentUpdates.delete(key);
                continue;
            }
            if (desktopStore && !isScanCleanupSourceSha256(write.sourceSha256)) {
                continue;
            }
            void Promise.resolve()
                .then(() => saveScanCleanupDocumentPreferencesInStore(
                    write.sourceSha256,
                    write.legacyDocumentKey,
                    write.patch,
                ))
                .then(() => pendingLegacyDocumentUpdates.delete(key), () => undefined);
        }
        for (const pending of pendingDocumentUpdates.values()) {
            if (pending.queued) {
                continue;
            }
            if (!isScanCleanupDocumentPersistenceTokenCurrent(pending.token)) {
                const key = documentUpdateKey(pending.request);
                if (key !== null) pendingDocumentUpdates.delete(key);
                continue;
            }
            void queueRemoteUpdate(pending.request, pending.token, pending.version).catch(() => undefined);
        }
        if (pendingPreferences) void flushScanCleanupPreferencesStore().catch(() => undefined);
    }, delayMs);
}

// Only the ordered stream acknowledges a global write; invoke replies carry no intent outcome.
function applyCommittedGlobalPreferences(settings: IScanCleanupGlobalPreferences, requestId?: TRequestId) {
    if (requestId !== undefined && requestId === pendingRemoteGlobalWrite?.request.requestId) {
        for (const [
            key,
            intent,
        ] of pendingGlobalFields) {
            if (isEqual(intent, pendingRemoteGlobalWrite.request.settingsPatch?.[key]) || isEqual(intent, settings[key])) {
                pendingGlobalFields.delete(key);
            }
        }
        pendingRemoteGlobalWrite.acknowledge();
        pendingPreferences = pendingGlobalFields.size === 0 ? null : pendingPreferences;
    }
    acknowledgedPreferences = cloneScanCleanupPreferenceValue(settings);
    if (!preferences) {
        return;
    }
    applyingRemotePreferences = true;
    for (const key of Object.keys(settings) as Array<keyof IScanCleanupGlobalPreferences>) {
        if (!pendingGlobalFields.has(key)) {
            preferences[key] = cloneScanCleanupPreferenceValue(settings[key]) as never;
        }
    }
    applyingRemotePreferences = false;
    observedPreferences = cloneScanCleanupPreferenceValue(preferences);
}

function queueRemoteUpdate(
    request: IScanCleanupSettingsUpdateRequest,
    documentToken?: IScanCleanupDocumentPersistenceToken,
    documentVersion?: number,
): Promise<void> {
    const isGlobalPreferencesWrite = 'settingsPatch' in request;
    const documentKey = isGlobalPreferencesWrite ? null : documentUpdateKey(request);
    const ownerCommit = isGlobalPreferencesWrite ? Promise.withResolvers<undefined>() : null;
    if (documentKey !== null && documentToken && documentVersion !== undefined) {
        pendingDocumentUpdates.set(documentKey, {
            request,
            token: documentToken,
            version: documentVersion,
            queued: true,
        });
    }
    const queuedRequest = request;
    let committed = false;
    const queuedWrite = remoteWriteQueue.then(async () => {
        const updateSettings = currentScanCleanupCapability().updateSettings;
        if (!updateSettings) {
            throw new Error('File-backed scan-cleanup settings are unavailable');
        }
        if (documentToken && !isScanCleanupDocumentPersistenceTokenCurrent(documentToken)) {
            committed = true;
            return;
        }
        const result = await updateSettings(request);
        remoteSettingsFile = result;
        await ownerCommit?.promise;
        committed = true;
    });
    remoteWriteQueue = queuedWrite.then(() => undefined, () => undefined);
    const observedWrite = queuedWrite.catch(error => {
        if (documentKey !== null) {
            const pending = pendingDocumentUpdates.get(documentKey);
            if (pending?.request === queuedRequest && pending.version === documentVersion) {
                pending.queued = false;
            }
        }
        BrowserLogger.error('scan-cleanup', 'Failed to persist file-backed settings', error, {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'});
        if (pendingRemoteGlobalWrite?.request === queuedRequest) {
            pendingRemoteGlobalWrite = null;
        }
        schedulePersistenceRetry();
        throw error;
    });
    if (ownerCommit) {
        pendingRemoteGlobalWrite = {
            request,
            acknowledge: () => { ownerCommit.resolve(undefined); },
            promise: observedWrite,
        };
    } else if (documentKey !== null) {
        const pending = pendingDocumentUpdates.get(documentKey);
        if (pending?.request === queuedRequest && pending.version === documentVersion) {
            pending.writePromise = observedWrite;
        }
    }
    void observedWrite.then(() => {
        if (!committed) {
            return;
        }
        if (pendingDocumentUpdates.size === 0 && pendingLegacyDocumentUpdates.size === 0) {
            persistenceRetryAttempt = 0;
        }
        if (isGlobalPreferencesWrite) {
            if (pendingRemoteGlobalWrite?.promise === observedWrite) pendingRemoteGlobalWrite = null;
            return;
        }
        if (documentKey !== null) {
            const pending = pendingDocumentUpdates.get(documentKey);
            if (pending?.request === queuedRequest && pending.version === documentVersion) {
                pendingDocumentUpdates.delete(documentKey);
            }
            if (pendingDocumentUpdates.size === 0 && pendingLegacyDocumentUpdates.size === 0) {
                persistenceRetryAttempt = 0;
            }
        }
    }, () => undefined);
    return observedWrite;
}

async function hydratePreferences() {
    if (!desktopStore || !preferences) {
        preferencesHydrated = true;
        return;
    }
    // Another surface can replace the migration context while this read is in
    // flight; what main adopted is decided by the context this request sent.
    const requestContext = {...migrationContext};
    try {
        const result = await readRemoteSettings(createSettingsReadRequest(
            requestContext.sourceSha256,
            requestContext.legacyDocumentKey,
            true,
        ));
        remoteSettingsFile = result;
        // The initial read seeds the projection only until the owner stream arrives.
        applyCommittedGlobalPreferences(acknowledgedPreferences ?? result.settings);
        const hydratedSourceSha256 = isScanCleanupSourceSha256(requestContext.sourceSha256)
            ? requestContext.sourceSha256.toLowerCase()
            : null;
        clearScanCleanupLegacyStorage(legacyDocumentKey => {
            const adoptedSha256 = isScanCleanupSourceSha256(legacyDocumentKey)
                ? legacyDocumentKey.toLowerCase()
                : legacyDocumentKey === requestContext.legacyDocumentKey ? hydratedSourceSha256 : null;
            return adoptedSha256 !== null && result.documentOverrides[adoptedSha256] !== undefined;
        });
        preferencesHydrated = true;
        pendingPreferences = pendingGlobalFields.size === 0 ? null : cloneScanCleanupPreferenceValue(preferences);
        if (pendingGlobalFields.size > 0) void flushScanCleanupPreferencesStore().catch(() => undefined);
    } catch (error) {
        BrowserLogger.error('scan-cleanup', 'Failed to load file-backed settings', error, {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'});
        throw error;
    }
}

function scheduleScanCleanupPreferencesPersistence(value: IScanCleanupGlobalPreferences) {
    // The coordinator is also imported by SSR and unit-test runners. There is
    // no durable browser store in those environments, so retaining a retry
    // timer would turn an intentional no-op into an endless error loop.
    if (applyingRemotePreferences || typeof window === 'undefined') {
        return;
    }
    const previous = observedPreferences ?? cloneScanCleanupPreferenceValue(value);
    const changedKeys = (Object.keys(value) as Array<keyof IScanCleanupGlobalPreferences>)
        .filter(key => !isEqual(previous[key], value[key]));
    for (const key of changedKeys) {
        pendingGlobalFields.set(key, cloneScanCleanupPreferenceValue(value[key]));
    }
    observedPreferences = cloneScanCleanupPreferenceValue(value);
    pendingPreferences = cloneScanCleanupPreferenceValue(value);
    if (!preferencesHydrated) {
        return;
    }
    if (persistenceTimer !== null) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(() => {
        void flushScanCleanupPreferencesStore().catch(() => undefined);
    }, SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS);
}

export async function flushScanCleanupPreferencesStore(): Promise<void> {
    if (persistenceTimer !== null) {
        clearTimeout(persistenceTimer);
        persistenceTimer = null;
    }
    if (!desktopStore) {
        const pending = pendingPreferences;
        if (!pending || !preferencesHydrated) {
            return;
        }
        const previous = persistedBrowserPreferences ?? loadScanCleanupPreferences();
        const settingsPatch = buildGlobalPreferencesPatch(previous, pending);
        if (Object.keys(settingsPatch).length === 0) {
            pendingPreferences = null;
            persistenceRetryAttempt = 0;
            return;
        }
        try {
            persistedBrowserPreferences = saveScanCleanupPreferencesPatch(settingsPatch);
            pendingPreferences = null;
            persistenceRetryAttempt = 0;
        } catch (error) {
            BrowserLogger.error('scan-cleanup', 'Failed to persist browser settings', error, {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'});
            schedulePersistenceRetry();
            return Promise.reject(error);
        }
        return;
    }

    while (preferences) {
        const pending = pendingPreferences;
        if (!preferencesHydrated) {
            await whenScanCleanupPreferencesReady();
            continue;
        }
        if (!pending || !remoteSettingsFile) {
            const queued = remoteWriteQueue;
            await queued;
            if (pendingPreferences === null || queued === remoteWriteQueue) {
                return;
            }
            continue;
        }
        const settingsPatch = Object.fromEntries([...pendingGlobalFields].map(([
            key,
            intent,
        ]) => [
            key,
            intent,
        ])) as IScanCleanupGlobalPreferencePatch;
        if (Object.keys(settingsPatch).length === 0) {
            pendingPreferences = null;
            return;
        }
        if (pendingRemoteGlobalWrite !== null) {
            await pendingRemoteGlobalWrite.promise;
        } else {
            await queueRemoteUpdate({
                settingsPatch,
                requestId: createRequestId('scan-cleanup-settings'),
            });
        }
    }
}

function handleWindowLifecycle() {
    void flushScanCleanupPreferencesStore().catch(() => undefined);
}

function registerLifecycleListeners() {
    if (lifecycleListenersRegistered || typeof window === 'undefined') {
        return;
    }
    lifecycleListenersRegistered = true;
    window.addEventListener('pagehide', handleWindowLifecycle);
}

function unregisterLifecycleListeners() {
    if (!lifecycleListenersRegistered || typeof window === 'undefined') {
        return;
    }
    lifecycleListenersRegistered = false;
    window.removeEventListener('pagehide', handleWindowLifecycle);
}

/** Renderer-wide global preferences shared by every mounted scan-cleanup surface. */
export function getScanCleanupPreferencesStore(options?: IScanCleanupPreferencesStoreOptions) {
    updateMigrationContext(options);
    if (preferences) {
        return preferences;
    }
    desktopStore = isDesktopPlatformActive();
    const initialPreferences = desktopStore
        ? cloneScanCleanupPreferenceValue(createDefaultScanCleanupSettingsFile().settings)
        : loadScanCleanupPreferences();
    persistedBrowserPreferences = desktopStore
        ? null
        : cloneScanCleanupPreferenceValue(initialPreferences);
    const sharedPreferences = reactive(initialPreferences);
    preferences = sharedPreferences;
    observedPreferences = cloneScanCleanupPreferenceValue(initialPreferences);
    preferencesHydrated = !desktopStore;
    preferencesHydrationPromise = desktopStore ? hydratePreferences() : Promise.resolve();
    persistenceScope = effectScope(true);
    persistenceScope.run(() => {
        watch(sharedPreferences, value => {
            scheduleScanCleanupPreferencesPersistence(value);
        }, {
            deep: true,
            flush: 'sync',
        });
    });
    registerLifecycleListeners();
    if (desktopStore) {
        unsubscribeCommittedGlobalPreferences = currentScanCleanupCapability().onSettingsChanged(change => {
            applyCommittedGlobalPreferences(change.settings, change.requestId);
        });
    }
    return preferences;
}

export function whenScanCleanupPreferencesReady(): Promise<void> {
    return preferencesHydrationPromise ?? Promise.resolve();
}

export function retryScanCleanupPreferences(): Promise<void> {
    if (!desktopStore || !preferences) {
        return Promise.resolve();
    }
    const retry = preferencesHydrated
        ? Promise.resolve()
        : (preferencesHydrationPromise = hydratePreferences());
    return retry.then(async () => {
        if (persistenceRetryTimer !== null) {
            clearTimeout(persistenceRetryTimer);
            persistenceRetryTimer = null;
        }
        await flushScanCleanupDocumentPreferencesStore();
        await flushScanCleanupPreferencesStore();
    });
}

export function loadScanCleanupDocumentSettings(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
): IScanCleanupDocumentSettingsSnapshot | Promise<IScanCleanupDocumentSettingsSnapshot> {
    if (!desktopStore) {
        const browserDocumentKey = legacyDocumentKey ?? sourceSha256;
        return {
            overrides: loadScanCleanupDocumentOverrides(browserDocumentKey),
            pageOverrideDefaults: loadScanCleanupDocumentPageOverrideDefaults(browserDocumentKey),
            marginsMm: loadScanCleanupDocumentMargins(browserDocumentKey),
            outputMode: loadScanCleanupDocumentOutputMode(browserDocumentKey),
        };
    }
    promoteUnresolvedDocumentUpdate(sourceSha256, legacyDocumentKey);
    return whenScanCleanupPreferencesReady().then(async () => {
        if (!isScanCleanupSourceSha256(sourceSha256)) {
            warnMissingDocumentSourceHash('load', legacyDocumentKey);
            return {
                overrides: {},
                pageOverrideDefaults: null,
                marginsMm: null,
                outputMode: 'auto' as const,
            };
        }
        const normalizedSourceSha256 = sourceSha256.toLowerCase();
        // A legacy entry saved under this document's path is adopted on the
        // first read that knows the document's hash.
        const legacyEntryPending = Boolean(legacyDocumentKey)
            && hasScanCleanupLegacyDocumentEntry(legacyDocumentKey!);
        try {
            await flushScanCleanupDocumentPreferencesStore();
            remoteSettingsFile = await readRemoteSettings(createSettingsReadRequest(
                normalizedSourceSha256,
                legacyDocumentKey,
                legacyEntryPending,
            ));
        } catch (error) {
            BrowserLogger.error('scan-cleanup', 'Failed to load document settings', error, {code: 'RENDERER_SCAN_CLEANUP_OPERATION_FAILED'});
            throw error;
        }
        if (legacyEntryPending && remoteSettingsFile.documentOverrides[normalizedSourceSha256] !== undefined) {
            clearScanCleanupLegacyStorage(key => key === legacyDocumentKey);
        }
        const entry = remoteSettingsFile?.documentOverrides[normalizedSourceSha256];
        return {
            overrides: cloneScanCleanupPreferenceValue(entry?.overrides ?? {}),
            pageOverrideDefaults: entry?.pageOverrideDefaults === undefined
                ? null
                : cloneScanCleanupPreferenceValue(entry.pageOverrideDefaults),
            marginsMm: entry?.marginsMm === undefined
                ? null
                : cloneScanCleanupPreferenceValue(entry.marginsMm),
            outputMode: entry?.outputMode ?? 'auto',
        };
    });
}

export function saveScanCleanupDocumentPreferencesInStore(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
    patch: IScanCleanupDocumentPreferencePatch,
) {
    if (!desktopStore) {
        saveScanCleanupDocumentPreferences(legacyDocumentKey ?? sourceSha256, patch);
        return;
    }
    if (!isScanCleanupSourceSha256(sourceSha256)) {
        warnMissingDocumentSourceHash('persist', legacyDocumentKey);
        return Promise.resolve();
    }
    const request: IScanCleanupSettingsUpdateRequest = {document: {
        sourceSha256: sourceSha256.toLowerCase(),
        ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
        patch: cloneScanCleanupPreferenceValue(patch),
    }};
    const key = documentUpdateKey(request);
    if (key === null) {
        return Promise.resolve();
    }
    const previous = pendingDocumentUpdates.get(key);
    const usablePrevious = previous && isScanCleanupDocumentPersistenceTokenCurrent(previous.token)
        ? previous
        : undefined;
    const previousDocument = usablePrevious?.request.document;
    const requestDocument = request.document;
    if (requestDocument === undefined) {
        return Promise.resolve();
    }
    const mergedPatch = {
        ...(previousDocument?.patch ?? {}),
        ...requestDocument.patch,
    };
    const version = ++nextDocumentUpdateVersion;
    const token = captureScanCleanupDocumentPersistenceToken(sourceSha256, legacyDocumentKey);
    const mergedRequest: IScanCleanupSettingsUpdateRequest = {document: {
        ...requestDocument,
        patch: mergedPatch,
    }};
    return queueRemoteUpdate(mergedRequest, token, version);
}

export function scheduleScanCleanupDocumentPreferencesInStore(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
    patch: IScanCleanupDocumentPreferencePatch,
) {
    if (!desktopStore || !isScanCleanupSourceSha256(sourceSha256)) {
        const key = desktopStore
            ? unresolvedDocumentUpdateKey(legacyDocumentKey)
            : `${sourceSha256 ?? ''}\0${legacyDocumentKey ?? ''}`;
        const previous = pendingLegacyDocumentUpdates.get(key);
        const token = captureScanCleanupDocumentPersistenceToken(sourceSha256, legacyDocumentKey);
        const usablePrevious = previous && isScanCleanupDocumentPersistenceTokenCurrent(previous.token)
            ? previous
            : undefined;
        pendingLegacyDocumentUpdates.set(key, {
            sourceSha256,
            legacyDocumentKey,
            patch: {
                ...(usablePrevious?.patch ?? {}),
                ...cloneScanCleanupPreferenceValue(patch),
            },
            token,
        });
        if (documentPersistenceTimer !== null) clearTimeout(documentPersistenceTimer);
        documentPersistenceTimer = setTimeout(() => {
            documentPersistenceTimer = null;
            for (const [
                key,
                write,
            ] of pendingLegacyDocumentUpdates) {
                if (!isScanCleanupDocumentPersistenceTokenCurrent(write.token)) {
                    pendingLegacyDocumentUpdates.delete(key);
                    continue;
                }
                if (desktopStore && !isScanCleanupSourceSha256(write.sourceSha256)) continue;
                pendingLegacyDocumentUpdates.delete(key);
                void Promise.resolve(saveScanCleanupDocumentPreferencesInStore(
                    write.sourceSha256,
                    write.legacyDocumentKey,
                    write.patch,
                )).catch(() => undefined);
            }
        }, SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS);
        return Promise.resolve();
    }
    promoteUnresolvedDocumentUpdate(sourceSha256, legacyDocumentKey);
    const request: IScanCleanupSettingsUpdateRequest = {document: {
        sourceSha256: sourceSha256.toLowerCase(),
        ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
        patch: cloneScanCleanupPreferenceValue(patch),
    }};
    const requestDocument = request.document;
    if (requestDocument === undefined) {
        return Promise.resolve();
    }
    const key = documentUpdateKey(request)!;
    const previous = pendingDocumentUpdates.get(key);
    const usablePrevious = previous && isScanCleanupDocumentPersistenceTokenCurrent(previous.token)
        ? previous
        : undefined;
    const version = ++nextDocumentUpdateVersion;
    const token = captureScanCleanupDocumentPersistenceToken(sourceSha256, legacyDocumentKey);
    pendingDocumentUpdates.set(key, {
        request: {document: {
            ...requestDocument,
            patch: {
                ...(usablePrevious?.request.document?.patch ?? {}),
                ...requestDocument.patch,
            },
        }},
        token,
        version,
        queued: false,
    });
    if (documentPersistenceTimer !== null) clearTimeout(documentPersistenceTimer);
    documentPersistenceTimer = setTimeout(() => {
        documentPersistenceTimer = null;
        for (const pending of pendingDocumentUpdates.values()) {
            if (!pending.queued) void queueRemoteUpdate(pending.request, pending.token, pending.version).catch(() => undefined);
        }
    }, SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS);
    return Promise.resolve();
}

export async function flushScanCleanupDocumentPreferencesStore() {
    if (documentPersistenceTimer !== null) {
        clearTimeout(documentPersistenceTimer);
        documentPersistenceTimer = null;
    }
    const writes = [...pendingLegacyDocumentUpdates.values()];
    pendingLegacyDocumentUpdates.clear();
    let firstError: unknown = null;
    for (const write of writes) {
        if (!isScanCleanupDocumentPersistenceTokenCurrent(write.token)) {
            continue;
        }
        if (desktopStore && !isScanCleanupSourceSha256(write.sourceSha256)) {
            pendingLegacyDocumentUpdates.set(unresolvedDocumentUpdateKey(write.legacyDocumentKey), write);
            continue;
        }
        try {
            await saveScanCleanupDocumentPreferencesInStore(write.sourceSha256, write.legacyDocumentKey, write.patch);
        } catch (error) {
            const key = `${write.sourceSha256 ?? ''}\0${write.legacyDocumentKey ?? ''}`;
            pendingLegacyDocumentUpdates.set(key, write);
            firstError ??= error;
        }
    }
    for (const pending of pendingDocumentUpdates.values()) {
        if (!pending.queued) {
            try {
                await queueRemoteUpdate(pending.request, pending.token, pending.version);
            } catch (error) {
                firstError ??= error;
            }
        } else if (pending.writePromise) {
            try {
                await pending.writePromise;
            } catch (error) {
                firstError ??= error;
            }
        }
    }
    if (firstError !== null) {
        schedulePersistenceRetry();
        throw firstError instanceof Error
            ? firstError
            : new Error('Scan cleanup document persistence failed');
    }
}

export function dismissScanCleanupFirstRunGuidanceInStore() {
    getScanCleanupPreferencesStore().firstRunGuidanceDismissed = true;
}

/** Re-loads the singleton on its next access. Primarily useful for isolated tests. */
export function resetScanCleanupPreferencesStore() {
    pendingPreferences = null;
    if (persistenceTimer !== null) clearTimeout(persistenceTimer);
    persistenceTimer = null;
    persistenceScope?.stop();
    persistenceScope = null;
    unregisterLifecycleListeners();
    unsubscribeCommittedGlobalPreferences?.();
    unsubscribeCommittedGlobalPreferences = null;
    preferences = null;
    preferencesHydrated = false;
    preferencesHydrationPromise = null;
    remoteSettingsFile = null;
    remoteWriteQueue = Promise.resolve();
    pendingDocumentUpdates.clear();
    pendingLegacyDocumentUpdates.clear();
    pendingGlobalFields.clear();
    pendingRemoteGlobalWrite?.acknowledge();
    pendingRemoteGlobalWrite = null;
    persistenceRetryAttempt = 0;
    if (persistenceRetryTimer !== null) {
        clearTimeout(persistenceRetryTimer);
        persistenceRetryTimer = null;
    }
    acknowledgedPreferences = null;
    observedPreferences = null;
    persistedBrowserPreferences = null;
    nextDocumentUpdateVersion = 0;
    if (documentPersistenceTimer !== null) {
        clearTimeout(documentPersistenceTimer);
        documentPersistenceTimer = null;
    }
    migrationContext = {};
    desktopStore = false;
    applyingRemotePreferences = false;
    documentPersistenceEpochs.clear();
}
