import type {
    IScanCleanupMarginsMm,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {
    safeGetLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import {
    migrateScanCleanupDocumentOverridesV1,
    migrateScanCleanupPageOverrideV1,
    warnScanCleanupOverrideMigrationV1,
} from '@app/modules/scan-cleanup/persistence/migrations/v1';
import {
    assertFiniteScanCleanupPreferences,
    cloneScanCleanupPreferenceValue,
    decodeScanCleanupGlobalPreferences,
    decodeScanCleanupMarginsMm,
    parseScanCleanupPreferenceJson,
    scanCleanupPreferenceRecord,
    type IScanCleanupDocumentPreferencePatch,
    type IScanCleanupGlobalPreferences,
    type IScanCleanupGlobalPreferencePatch,
    type IScanCleanupLegacyStorageExport,
} from '@contracts/scanCleanupSettings';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scanCleanupPageOverrides';
import {
    decodeScanCleanupPageOverride,
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

export function exportScanCleanupLegacyStorage(
    storage: IScanCleanupPreferenceStorage = browserStorage,
): IScanCleanupLegacyStorageExport {
    return {
        settingsRaw: storage.get(SETTINGS_KEY),
        documentOverridesRaw: storage.get(OVERRIDES_KEY),
        exportedAtMs: Date.now(),
    };
}

export function clearScanCleanupLegacyStorage() {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        window.localStorage.removeItem(SETTINGS_KEY);
        window.localStorage.removeItem(OVERRIDES_KEY);
    } catch {
        // Best-effort cleanup after the file-backed store confirms migration.
    }
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

export function loadScanCleanupPreferences(
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    return decodeScanCleanupGlobalPreferences(parseScanCleanupPreferenceJson(storage.get(SETTINGS_KEY)));
}

export function saveScanCleanupPreferences(
    value: IScanCleanupGlobalPreferences,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    assertFiniteScanCleanupPreferences(value);
    const {
        outputMode: _ignoredLegacyOutputMode,
        runOcrAfterCleanup: _ignoredLegacyRunOcr,
        ...globalPreferences
    } = value as IScanCleanupGlobalPreferences & {
        outputMode?: unknown;
        runOcrAfterCleanup?: unknown;
    };
    const committed = storage.set(SETTINGS_KEY, JSON.stringify({
        ...globalPreferences,
        marginsMm: decodeScanCleanupMarginsMm(value.marginsMm),
    }));
    if (committed === false) {
        throw new Error('Failed to persist scan-cleanup preferences');
    }
}

export function saveScanCleanupPreferencesPatch(
    patch: IScanCleanupGlobalPreferencePatch,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    const current = loadScanCleanupPreferences(storage);
    const next: IScanCleanupGlobalPreferences = {
        ...current,
        ...patch,
        marginsMm: patch.marginsMm === undefined
            ? current.marginsMm
            : decodeScanCleanupMarginsMm(patch.marginsMm, current.marginsMm),
    };
    saveScanCleanupPreferences(next, storage);
    return next;
}

export function dismissScanCleanupFirstRunGuidance(
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    const preferences = loadScanCleanupPreferences(storage);
    if (!preferences.firstRunGuidanceDismissed) {
        saveScanCleanupPreferences({
            ...preferences,
            firstRunGuidanceDismissed: true,
        }, storage);
    }
}

export function toPlainScanCleanupOptions(value: IScanCleanupOptions): IScanCleanupOptions {
    const plain = cloneScanCleanupPreferenceValue(value);
    attachScanCleanupPageOverrideDefaults(
        plain.pageOverrides,
        plain.pageOverrideDefaults,
        plain.marginsMm,
    );
    return plain;
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
    if (migration.migratedLegacyGeometry) {
        entries[documentKey] = {
            ...(entry ?? {}),
            overrides: migration.overrides,
        };
        storage.set(OVERRIDES_KEY, JSON.stringify(entries));
        warnScanCleanupOverrideMigrationV1();
    }
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
    if (migration.migratedLegacyGeometry) {
        const entries = loadDocumentEntries(storage);
        entries[documentKey] = {
            ...(entry ?? {}),
            pageOverrideDefaults: migration.value,
        };
        storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
        warnScanCleanupOverrideMigrationV1();
    }
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

export function saveScanCleanupDocumentPreferences(
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

    const entries = loadDocumentEntries(storage);
    const existingEntry = scanCleanupPreferenceRecord(entries[documentKey]);
    const nextEntry = {...(existingEntry ?? {})};
    let writesUpdatedAt = false;
    const resetToEmptyOverrides = patch.resetOverrides === true
        && (patch.overrides === undefined || Object.keys(patch.overrides).length === 0);
    if (resetToEmptyOverrides) {
        Reflect.deleteProperty(nextEntry, 'overrides');
        Reflect.deleteProperty(nextEntry, 'pageOverrideDefaults');
    } else if (patch.overrides !== undefined) {
        nextEntry.overrides = decodeScanCleanupPageOverrides(patch.overrides);
        writesUpdatedAt = true;
    }
    if (patch.pageOverrideDefaults !== undefined && !resetToEmptyOverrides) {
        nextEntry.pageOverrideDefaults = decodeScanCleanupPageOverride(patch.pageOverrideDefaults);
        writesUpdatedAt = true;
    }
    if (patch.marginsMm !== undefined) {
        nextEntry.marginsMm = decodeScanCleanupMarginsMm(patch.marginsMm);
        writesUpdatedAt = true;
    }
    if (patch.outputMode !== undefined) {
        nextEntry.outputMode = patch.outputMode;
        writesUpdatedAt = true;
    }
    if (writesUpdatedAt) {
        nextEntry.updatedAt = Date.now();
    }
    if (Object.keys(nextEntry).length === 0) {
        Reflect.deleteProperty(entries, documentKey);
    } else {
        entries[documentKey] = nextEntry;
    }
    storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
}

export function saveScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    overrides: TScanCleanupPageOverrides,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    const validatedOverrides = decodeScanCleanupPageOverrides(overrides);
    const entries = loadDocumentEntries(storage);
    entries[documentKey] = {
        ...scanCleanupPreferenceRecord(entries[documentKey]),
        updatedAt: Date.now(),
        overrides: validatedOverrides,
    };
    storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
}

export function saveScanCleanupDocumentMargins(
    documentKey: string | null | undefined,
    marginsMm: IScanCleanupMarginsMm,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    if (Object.values(marginsMm).some(margin => !Number.isFinite(margin))) {
        throw new TypeError('Scan cleanup document margins require finite numeric values');
    }
    const entries = loadDocumentEntries(storage);
    entries[documentKey] = {
        ...scanCleanupPreferenceRecord(entries[documentKey]),
        updatedAt: Date.now(),
        marginsMm: decodeScanCleanupMarginsMm(marginsMm),
    };
    storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
}

export function saveScanCleanupDocumentOutputMode(
    documentKey: string | null | undefined,
    outputMode: TScanCleanupOutputModeSetting,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey || ![
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(outputMode)) {
        return;
    }
    const entries = loadDocumentEntries(storage);
    entries[documentKey] = {
        ...scanCleanupPreferenceRecord(entries[documentKey]),
        updatedAt: Date.now(),
        outputMode,
    };
    storage.set(OVERRIDES_KEY, JSON.stringify(boundedDocumentEntries(entries)));
}

export function resetScanCleanupDocumentOverrides(
    documentKey: string | null | undefined,
    storage: IScanCleanupPreferenceStorage = browserStorage,
) {
    if (!documentKey) {
        return;
    }
    const entries = loadDocumentEntries(storage);
    const entry = scanCleanupPreferenceRecord(entries[documentKey]);
    if (entry?.marginsMm !== undefined || entry?.outputMode !== undefined) {
        Reflect.deleteProperty(entry, 'overrides');
        Reflect.deleteProperty(entry, 'pageOverrideDefaults');
        entries[documentKey] = entry;
    } else {
        Reflect.deleteProperty(entries, documentKey);
    }
    storage.set(OVERRIDES_KEY, JSON.stringify(entries));
}
