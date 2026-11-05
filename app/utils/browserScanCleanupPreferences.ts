import {DOCUMENTS_STORE} from '@app/platform/browser/browserDocumentConstants';
import {runObjectStoreTransaction} from '@app/platform/browser/browserDocumentIdb';
import type {
    IScanCleanupMarginsMm,
    IScanCleanupPageOverride,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import {
    migrateScanCleanupDocumentOverridesV1,
    migrateScanCleanupPageOverrideV1,
} from '@contracts/scan-cleanup/scanCleanupSettingsMigration';
import {BrowserLogger} from '@app/utils/browserLogger';
import {
    assertFiniteScanCleanupPreferences,
    decodeScanCleanupGlobalPreferences,
    isScanCleanupSourceSha256,
    applyScanCleanupDocumentPreferencePatch,
    decodeScanCleanupMarginsMm,
    parseScanCleanupPreferenceJson,
    scanCleanupPreferenceRecord,
    type IScanCleanupDocumentOverrideEntry,
    type IScanCleanupDocumentPreferencePatch,
    type IScanCleanupGlobalPreferences,
    type IScanCleanupGlobalPreferencePatch,
    type IScanCleanupLegacyStorageExport,
} from '@contracts/scan-cleanup/scanCleanupSettings';
import {
    decodeScanCleanupPageOverride,
    decodeScanCleanupPageOverrideEdits,
    decodeScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/ipcRequestCodecs';

const SETTINGS_KEY = 'evb.scanCleanup.settings.v1';
const OVERRIDES_KEY = 'evb.scanCleanup.documentOverrides.v1';
const MAX_DOCUMENTS = 50;
export const DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE: TScanCleanupOutputModeSetting = 'auto';
export const SCAN_CLEANUP_PREFERENCES_PERSISTENCE_DEBOUNCE_MS = 300;

export interface IScanCleanupPreferenceStorage {
    get: (key: string) => string | null;
    set: (key: string, value: string) => boolean | undefined;
}

const browserStorage: IScanCleanupPreferenceStorage = {
    get: safeGetLocalStorageItem,
    set: safeSetLocalStorageItem,
};

async function runSerializedScanCleanupPreferencesMutation<T>(mutate: () => T): Promise<T> {
    const result = await runObjectStoreTransaction<{value: T} | {error: unknown}>(DOCUMENTS_STORE, 'readwrite', (store, setResult) => {
        const read = store.get('__evb_scan_cleanup_preferences_storage_lock__');
        read.onsuccess = () => {
            try {
                setResult({value: mutate()});
            } catch (error) {
                setResult({error});
            }
        };
    });
    if (result === null) throw new Error('Failed to serialize scan-cleanup preferences');
    if ('error' in result) throw result.error;
    return result.value;
}

export function exportScanCleanupLegacyStorage(
    storage: IScanCleanupPreferenceStorage = browserStorage,
): IScanCleanupLegacyStorageExport {
    return {
        settingsRaw: storage.get(SETTINGS_KEY),
        documentOverridesRaw: storage.get(OVERRIDES_KEY),
        exportedAtMs: Date.now(),
    };
}

/**
 * Removes legacy storage the file-backed store has adopted. Global settings
 * migrate on the first read. A document entry keyed by its path can only be
 * adopted once that document's source hash is known, so it stays until then.
 */
export async function clearScanCleanupLegacyStorage(isDocumentAdopted: (legacyDocumentKey: string) => boolean) {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        await runSerializedScanCleanupPreferencesMutation(() => {
            window.localStorage.removeItem(SETTINGS_KEY);
            const remaining = Object.entries(loadDocumentEntries(browserStorage))
                .filter(([legacyDocumentKey]) => !isDocumentAdopted(legacyDocumentKey));
            if (remaining.length === 0) {
                window.localStorage.removeItem(OVERRIDES_KEY);
            } else {
                window.localStorage.setItem(OVERRIDES_KEY, JSON.stringify(Object.fromEntries(remaining)));
            }
        });
    } catch {
        // Best-effort cleanup after the file-backed store confirms migration.
    }
}

export function hasScanCleanupLegacyDocumentEntry(legacyDocumentKey: string) {
    return Object.hasOwn(loadDocumentEntries(browserStorage), legacyDocumentKey);
}

let legacyOverrideWarningShown = false;

function warnScanCleanupOverrideMigrationV1() {
    if (legacyOverrideWarningShown) {
        return;
    }
    legacyOverrideWarningShown = true;
    BrowserLogger.warn(
        'scan-cleanup',
        'Migrated legacy pixel-based overrides; geometry without known 150-DPI raster dimensions was dropped.',
    );
}

function loadDocumentEntries(storage: IScanCleanupPreferenceStorage) {
    return scanCleanupPreferenceRecord(parseScanCleanupPreferenceJson(storage.get(OVERRIDES_KEY))) ?? {};
}

function boundedDocumentEntries(entries: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(entries)
        .sort((left, right) => {
            const rightUpdatedAt = scanCleanupPreferenceRecord(right[1])?.updatedAt;
            const leftUpdatedAt = scanCleanupPreferenceRecord(left[1])?.updatedAt;
            return (typeof rightUpdatedAt === 'number' && Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0)
                - (typeof leftUpdatedAt === 'number' && Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0);
        })
        .slice(0, MAX_DOCUMENTS));
}

/** A document edit is saved only once storage has taken it. */
function saveDocumentEntries(entries: Record<string, unknown>, storage: IScanCleanupPreferenceStorage) {
    if (storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries))) === false) {
        throw new Error('Failed to persist scan-cleanup document preferences');
    }
}

/**
 * The key a document's preferences live under: its source SHA-256 once that
 * is known, which survives the document being reopened under another
 * reference. An entry saved under the document's reference before its hash
 * was known moves to the hash on the first such read; while storage refuses
 * that move, the reference stays the key.
 */
export async function adoptScanCleanupDocumentKey(
    sourceSha256: string | null | undefined,
    legacyDocumentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): Promise<string | null> {
    if (!isScanCleanupSourceSha256(sourceSha256)) {
        return legacyDocumentKey ?? null;
    }
    const key = sourceSha256.toLowerCase();
    if (!legacyDocumentKey || legacyDocumentKey === key) {
        return key;
    }
    return runSerializedScanCleanupPreferencesMutation(() => {
        const entries = loadDocumentEntries(storage);
        if (Object.hasOwn(entries, legacyDocumentKey) && !Object.hasOwn(entries, key)) {
            entries[key] = entries[legacyDocumentKey];
            Reflect.deleteProperty(entries, legacyDocumentKey);
            saveDocumentEntries(entries, storage);
        }
        return key;
    }).catch(() => legacyDocumentKey);
}

/**
 * Gives a document saved as a new file the Scan Cleanup settings of the
 * document it was saved from: the first of `sourceKeys` that has an entry,
 * copied whole. The source keeps its entry, since it can still be opened, and
 * a saved file that already has settings keeps them.
 */
export function copyScanCleanupDocumentPreferences(
    sourceKeys: readonly string[],
    savedKey: string,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    return runSerializedScanCleanupPreferencesMutation(() => {
        const entries = loadDocumentEntries(storage);
        if (Object.hasOwn(entries, savedKey)) return;
        const sourceKey = sourceKeys.find(key => Object.hasOwn(entries, key));
        if (sourceKey === undefined) return;
        const entry = scanCleanupPreferenceRecord(entries[sourceKey]);
        if (!entry) return;
        // Both documents were just in use: fresh times keep the size bound from
        // dropping either the copy or the source it came from.
        const updatedAt = Date.now();
        entries[sourceKey] = {
            ...entry,
            updatedAt,
        };
        entries[savedKey] = {
            ...entry,
            updatedAt,
        };
        saveDocumentEntries(entries, storage);
    });
}

export function loadScanCleanupPreferences(
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    return decodeScanCleanupGlobalPreferences(parseScanCleanupPreferenceJson(storage.get(SETTINGS_KEY)));
}

function writeScanCleanupPreferences(
    value: IScanCleanupGlobalPreferences,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    assertFiniteScanCleanupPreferences(value);
    const preferences = decodeScanCleanupGlobalPreferences(value);
    if (storage.set(SETTINGS_KEY, JSON.stringify(preferences)) === false) {
        throw new Error('Failed to persist scan-cleanup preferences');
    }
    return preferences;
}

export function saveScanCleanupPreferences(value: IScanCleanupGlobalPreferences, storage: IScanCleanupPreferenceStorage = browserStorage) {
    return runSerializedScanCleanupPreferencesMutation(() => writeScanCleanupPreferences(value, storage));
}

export function saveScanCleanupPreferencesPatch(
    patch: IScanCleanupGlobalPreferencePatch,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    return runSerializedScanCleanupPreferencesMutation(() => {
        const current = loadScanCleanupPreferences(storage);
        const next: IScanCleanupGlobalPreferences = {
            ...current,
            ...patch,
            marginsMm: patch.marginsMm === undefined
                ? current.marginsMm
                : decodeScanCleanupMarginsMm(patch.marginsMm, current.marginsMm),
        };
        return writeScanCleanupPreferences(next, storage);
    });
}

export function dismissScanCleanupFirstRunGuidance(storage: IScanCleanupPreferenceStorage = browserStorage) {
    return saveScanCleanupPreferencesPatch({firstRunGuidanceDismissed: true}, storage);
}

export function loadScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): TScanCleanupPageOverrides {
    if (!documentKey) {
        return {};
    }
    const entries = loadDocumentEntries(storage);
    const entry = scanCleanupPreferenceRecord(entries[documentKey]);
    const migration = migrateScanCleanupDocumentOverridesV1(entry);
    if (migration.migratedLegacyGeometry) warnScanCleanupOverrideMigrationV1();
    return migration.overrides;
}

export function loadScanCleanupDocumentMargins(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): IScanCleanupMarginsMm | null {
    if (!documentKey) {
        return null;
    }
    const entry = scanCleanupPreferenceRecord(loadDocumentEntries(storage)[documentKey]);
    const marginsMm = scanCleanupPreferenceRecord(entry?.marginsMm);
    if (!marginsMm) {
        return null;
    }
    return decodeScanCleanupMarginsMm(marginsMm);
}

export function loadScanCleanupDocumentPageOverrideDefaults(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): IScanCleanupPageOverride | null {
    if (!documentKey) {
        return null;
    }
    const entry = scanCleanupPreferenceRecord(loadDocumentEntries(storage)[documentKey]);
    if (entry?.pageOverrideDefaults === undefined) {
        return null;
    }
    const migration = migrateScanCleanupPageOverrideV1(entry.pageOverrideDefaults);
    if (migration.migratedLegacyGeometry) warnScanCleanupOverrideMigrationV1();
    try {
        return decodeScanCleanupPageOverride(migration.value);
    } catch {
        return null;
    }
}

export function loadScanCleanupDocumentOutputMode(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): TScanCleanupOutputModeSetting {
    if (!documentKey) {
        return DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE;
    }
    const entry = scanCleanupPreferenceRecord(loadDocumentEntries(storage)[documentKey]);
    return [
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(String(entry?.outputMode))
        ? entry?.outputMode as TScanCleanupOutputModeSetting
        : DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE;
}

/** A document's saved preferences as the settings file carries them, if it has any. */
export function loadScanCleanupDocumentEntry(
    documentKey: string,
    storage: IScanCleanupPreferenceStorage = browserStorage,
): IScanCleanupDocumentOverrideEntry | undefined {
    const entry = scanCleanupPreferenceRecord(loadDocumentEntries(storage)[documentKey]);
    if (entry === null) {
        return undefined;
    }
    const pageOverrideDefaults = loadScanCleanupDocumentPageOverrideDefaults(documentKey, storage);
    const marginsMm = loadScanCleanupDocumentMargins(documentKey, storage);
    return {
        overrides: loadScanCleanupDocumentOverrides(documentKey, storage),
        ...(pageOverrideDefaults === null ? {} : {pageOverrideDefaults}),
        ...(marginsMm === null ? {} : {marginsMm}),
        ...(entry.outputMode === undefined ? {} : {outputMode: loadScanCleanupDocumentOutputMode(documentKey, storage)}),
        lastUsedAtMs: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
    };
}

export async function saveScanCleanupDocumentPreferences(
    documentKey: string | null | undefined,
    patch: IScanCleanupDocumentPreferencePatch,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    if (patch.outputMode !== undefined && ![
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(patch.outputMode)) {
        return;
    }
    if (patch.marginsMm !== undefined && Object.values(patch.marginsMm).some(margin => !Number.isFinite(margin))) {
        throw new TypeError('Scan cleanup document margins require finite numeric values');
    }

    return runSerializedScanCleanupPreferencesMutation(() => {
        const entries = loadDocumentEntries(storage);
        const existingEntry = scanCleanupPreferenceRecord(entries[documentKey]);
        const nextEntry: Record<string, unknown> = {
            ...(existingEntry ?? {}),
            ...(existingEntry?.overrides === undefined ? {} : {overrides: migrateScanCleanupDocumentOverridesV1(existingEntry).overrides}),
            ...(existingEntry?.pageOverrideDefaults === undefined ? {} : {pageOverrideDefaults: migrateScanCleanupPageOverrideV1(existingEntry.pageOverrideDefaults).value}),
        };
        // Validated here because this store reads renderer storage, not IPC.
        const writesUpdatedAt = applyScanCleanupDocumentPreferencePatch(nextEntry, {
            ...patch,
            ...(patch.overrides === undefined ? {} : {overrides: decodeScanCleanupPageOverrides(patch.overrides)}),
            ...(patch.overrideEdits === undefined
                ? {}
                : {overrideEdits: decodeScanCleanupPageOverrideEdits(patch.overrideEdits)}),
            ...(patch.pageOverrideDefaults === undefined
                ? {}
                : {pageOverrideDefaults: decodeScanCleanupPageOverride(patch.pageOverrideDefaults)}),
            ...(patch.marginsMm === undefined ? {} : {marginsMm: decodeScanCleanupMarginsMm(patch.marginsMm)}),
        });
        if (writesUpdatedAt) {
            nextEntry.updatedAt = Date.now();
        }
        if (Object.keys(nextEntry).length === 0) {
            Reflect.deleteProperty(entries, documentKey);
        } else {
            entries[documentKey] = nextEntry;
        }
        saveDocumentEntries(entries, storage);
    });
}

export function saveScanCleanupDocumentOverrides(documentKey: string | null | undefined, overrides: TScanCleanupPageOverrides, storage: IScanCleanupPreferenceStorage = browserStorage) {
    return saveScanCleanupDocumentPreferences(documentKey, {overrides}, storage);
}

export function saveScanCleanupDocumentMargins(documentKey: string | null | undefined, marginsMm: IScanCleanupMarginsMm, storage: IScanCleanupPreferenceStorage = browserStorage) {
    return saveScanCleanupDocumentPreferences(documentKey, {marginsMm}, storage);
}

export function saveScanCleanupDocumentOutputMode(documentKey: string | null | undefined, outputMode: TScanCleanupOutputModeSetting, storage: IScanCleanupPreferenceStorage = browserStorage) {
    return saveScanCleanupDocumentPreferences(documentKey, {outputMode}, storage);
}

export async function resetScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    return runSerializedScanCleanupPreferencesMutation(() => {
        const entries = loadDocumentEntries(storage);
        const entry = scanCleanupPreferenceRecord(entries[documentKey]);
        if (entry?.marginsMm !== undefined || entry?.outputMode !== undefined) {
            Reflect.deleteProperty(entry, 'overrides');
            Reflect.deleteProperty(entry, 'pageOverrideDefaults');
            entries[documentKey] = {
                ...entry,
                updatedAt: Date.now(),
            };
        } else {
            Reflect.deleteProperty(entries, documentKey);
        }
        saveDocumentEntries(entries, storage);
    });
}
