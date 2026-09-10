import { getErrorMessage } from '@electron/utils/error';
import {
    readFile,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';
import {
    assertScanCleanupLegacyStorageByteLimit,
    cloneScanCleanupPreferenceValue,
    createDefaultScanCleanupSettingsFile,
    decodeScanCleanupGlobalPreferences,
    decodeScanCleanupMarginsMm,
    decodeScanCleanupSettingsFile,
    isScanCleanupSourceSha256,
    scanCleanupPreferenceRecord,
    SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS,
    SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES,
    SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
    type IScanCleanupDocumentOverrideEntry,
    type IScanCleanupLegacyStorageExport,
    type IScanCleanupSettingsFile,
    type IScanCleanupSettingsReadRequest,
    type IScanCleanupSettingsUpdateRequest,
} from '@contracts/scanCleanupSettings';
import {
    createScanCleanupInputBudget,
    type IScanCleanupInputBudget,
} from '@contracts/scan-cleanup/inputLimits';
import {decodeScanCleanupPageOverrides} from '@contracts/scan-cleanup/ipcRequestCodecs';
import type {TScanCleanupOutputModeSetting} from '@contracts/scan-cleanup/domain';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    createLogger,
    type ILogger,
} from '@electron/utils/createLogger';
import {quarantineCorruptFile} from '@electron/utils/quarantineCorruptFile';

interface IScanCleanupSettingsStoreFileSystem {
    readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
    writeFile: (filePath: string, value: string, encoding: 'utf8') => Promise<void>;
    unlink: (filePath: string) => Promise<void>;
}

interface IScanCleanupSettingsStoreOptions {
    filePath: string;
    logger?: Pick<ILogger, 'warn'>;
    now?: () => number;
    fileSystem?: Partial<IScanCleanupSettingsStoreFileSystem>;
    replace?: (sourcePath: string, targetPath: string) => Promise<void>;
}

interface ILegacyCandidate {
    entry: IScanCleanupDocumentOverrideEntry;
    legacyDocumentKey: string;
}

interface ILegacyMigrationDiagnostics {
    invalidDocumentEntries: number;
    invalidEnvelopes: number;
    invalidGlobals: number;
    firstCause: string | null;
}

interface IScanCleanupSettingsStore {
    get: (request?: IScanCleanupSettingsReadRequest) => Promise<IScanCleanupSettingsFile>;
    update: (request: IScanCleanupSettingsUpdateRequest) => Promise<IScanCleanupSettingsFile>;
}

const DEFAULT_STORE_FILE_SYSTEM: IScanCleanupSettingsStoreFileSystem = {
    readFile: async (filePath, encoding) => readFile(filePath, {encoding}),
    writeFile: async (filePath, value, encoding) => {
        await writeFile(filePath, value, {encoding});
    },
    unlink: async filePath => {
        await unlink(filePath);
    },
};
const DEFAULT_LOGGER = createLogger('scan-cleanup-settings');

function finiteTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function legacyTimestamp(entry: Record<string, unknown> | null, fallback: number) {
    return finiteTimestamp(entry?.lastUsedAtMs)
        ?? finiteTimestamp(entry?.updatedAt)
        ?? fallback;
}

function decodeLegacyDocumentEntry(
    value: unknown,
    fallbackTimestamp: number,
    budget: IScanCleanupInputBudget,
): IScanCleanupDocumentOverrideEntry | null {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        return null;
    }
    const overrides = stored.overrides === undefined
        ? undefined
        : decodeScanCleanupPageOverrides(stored.overrides, budget);
    const outputMode = [
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(String(stored.outputMode))
        ? stored.outputMode as TScanCleanupOutputModeSetting
        : undefined;
    const marginsMm = stored.marginsMm === undefined
        ? undefined
        : decodeScanCleanupMarginsMm(stored.marginsMm);
    return {
        ...(overrides === undefined ? {} : {overrides}),
        ...(marginsMm === undefined ? {} : {marginsMm}),
        ...(outputMode === undefined ? {} : {outputMode}),
        lastUsedAtMs: legacyTimestamp(stored, fallbackTimestamp),
    };
}

function createLegacyMigrationDiagnostics(): ILegacyMigrationDiagnostics {
    return {
        invalidDocumentEntries: 0,
        invalidEnvelopes: 0,
        invalidGlobals: 0,
        firstCause: null,
    };
}

function recordLegacyMigrationFailure(
    diagnostics: ILegacyMigrationDiagnostics,
    kind: keyof Omit<ILegacyMigrationDiagnostics, 'firstCause'>,
    error: unknown,
) {
    diagnostics[kind] += 1;
    diagnostics.firstCause ??= getErrorMessage(error);
}

function parseLegacyStorageValue(
    raw: string | null,
    diagnostics: ILegacyMigrationDiagnostics,
    label: string,
) {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as unknown;
    } catch (error) {
        recordLegacyMigrationFailure(
            diagnostics,
            'invalidEnvelopes',
            new Error(`${label}: ${getErrorMessage(error)}`),
        );
        return null;
    }
}

function readLegacyCandidates(
    legacyStorage: IScanCleanupLegacyStorageExport | undefined,
    now: number,
): {
    settings: ReturnType<typeof decodeScanCleanupGlobalPreferences> | null;
    documentCandidates: Map<string, ILegacyCandidate>;
    documentCandidatesByLegacyKey: Map<string, IScanCleanupDocumentOverrideEntry>;
    diagnostics: ILegacyMigrationDiagnostics;
} {
    const documentCandidates = new Map<string, ILegacyCandidate>();
    const documentCandidatesByLegacyKey = new Map<string, IScanCleanupDocumentOverrideEntry>();
    const diagnostics = createLegacyMigrationDiagnostics();
    if (!legacyStorage) {
        return {
            settings: null,
            documentCandidates,
            documentCandidatesByLegacyKey,
            diagnostics,
        };
    }
    try {
        assertScanCleanupLegacyStorageByteLimit(legacyStorage);
    } catch (error) {
        recordLegacyMigrationFailure(diagnostics, 'invalidEnvelopes', error);
        return {
            settings: null,
            documentCandidates,
            documentCandidatesByLegacyKey,
            diagnostics,
        };
    }
    const budget = createScanCleanupInputBudget();
    const legacyFallbackTimestamp = finiteTimestamp(legacyStorage.exportedAtMs) ?? now;
    const rawSettings = parseLegacyStorageValue(legacyStorage.settingsRaw, diagnostics, 'global settings');
    const settingsRecord = scanCleanupPreferenceRecord(rawSettings);
    const settingsValue = settingsRecord?.settings ?? rawSettings;
    let settings: ReturnType<typeof decodeScanCleanupGlobalPreferences> | null = null;
    if (settingsValue !== null) {
        if (scanCleanupPreferenceRecord(settingsValue) === null) {
            recordLegacyMigrationFailure(
                diagnostics,
                'invalidGlobals',
                new Error('global settings are not an object'),
            );
        } else {
            try {
                settings = decodeScanCleanupGlobalPreferences(settingsValue, {preInkAlignment: true});
            } catch (error) {
                recordLegacyMigrationFailure(diagnostics, 'invalidGlobals', error);
            }
        }
    }
    const rawOverridesValue = parseLegacyStorageValue(
        legacyStorage.documentOverridesRaw,
        diagnostics,
        'document settings',
    );
    const rawOverrides = scanCleanupPreferenceRecord(rawOverridesValue);
    if (rawOverridesValue !== null && rawOverrides === null) {
        recordLegacyMigrationFailure(
            diagnostics,
            'invalidEnvelopes',
            new Error('document settings are not an object'),
        );
    }
    if (rawOverrides) {
        for (const [
            legacyDocumentKey,
            value,
        ] of Object.entries(rawOverrides)) {
            let entry: IScanCleanupDocumentOverrideEntry | null;
            try {
                entry = decodeLegacyDocumentEntry(value, legacyFallbackTimestamp, budget);
            } catch (error) {
                recordLegacyMigrationFailure(diagnostics, 'invalidDocumentEntries', error);
                continue;
            }
            if (!entry) {
                recordLegacyMigrationFailure(
                    diagnostics,
                    'invalidDocumentEntries',
                    new Error(`document entry ${JSON.stringify(legacyDocumentKey)} is not an object`),
                );
                continue;
            }
            documentCandidatesByLegacyKey.set(legacyDocumentKey, entry);
            if (isScanCleanupSourceSha256(legacyDocumentKey)) {
                const sourceSha256 = legacyDocumentKey.toLowerCase();
                const previous = documentCandidates.get(sourceSha256);
                if (!previous || previous.entry.lastUsedAtMs <= entry.lastUsedAtMs) {
                    documentCandidates.set(sourceSha256, {
                        entry,
                        legacyDocumentKey,
                    });
                }
            }
        }
    }
    return {
        settings,
        documentCandidates,
        documentCandidatesByLegacyKey,
        diagnostics,
    };
}

function chooseNewerEntry(
    previous: IScanCleanupDocumentOverrideEntry | undefined,
    candidate: IScanCleanupDocumentOverrideEntry,
) {
    return previous === undefined || candidate.lastUsedAtMs >= previous.lastUsedAtMs
        ? candidate
        : previous;
}

function pruneDocumentOverrides(
    state: IScanCleanupSettingsFile,
    now: number,
) {
    const entries = Object.entries(state.documentOverrides)
        .filter(([
            , entry,
        ]) => now - entry.lastUsedAtMs <= SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS)
        .sort((left, right) => right[1].lastUsedAtMs - left[1].lastUsedAtMs)
        .slice(0, SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES);
    const nextEntries = Object.fromEntries(entries);
    const changed = entries.length !== Object.keys(state.documentOverrides).length
        || entries.some(([key]) => state.documentOverrides[key] === undefined);
    if (changed) {
        state.documentOverrides = nextEntries;
    }
    return changed;
}

function cloneSettingsFile(state: IScanCleanupSettingsFile): IScanCleanupSettingsFile {
    return cloneScanCleanupPreferenceValue(state);
}

export function createScanCleanupSettingsStore(options: IScanCleanupSettingsStoreOptions): IScanCleanupSettingsStore {
    const now = options.now ?? Date.now;
    const logger = options.logger ?? DEFAULT_LOGGER;
    const fileSystem: IScanCleanupSettingsStoreFileSystem = {
        ...DEFAULT_STORE_FILE_SYSTEM,
        ...options.fileSystem,
    };
    const replace = options.replace ?? (async (sourcePath, targetPath) => {
        await atomicReplace(sourcePath, targetPath, {
            durable: true,
            markMutationCommitStarted: false,
        });
    });
    let queue = Promise.resolve();
    const reportedLegacyWarnings = new Set<string>();

    function enqueue<T>(operation: () => Promise<T>) {
        const next = queue.then(operation, operation);
        queue = next.then(() => undefined, () => undefined);
        return next;
    }

    async function readFileState() {
        let raw: string;
        try {
            raw = await fileSystem.readFile(options.filePath, 'utf8');
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return {
                    state: createDefaultScanCleanupSettingsFile(),
                    exists: false,
                    schemaUpgraded: false,
                };
            }
            throw error;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch (error) {
            if (!(error instanceof SyntaxError)) {
                throw error;
            }
            const quarantinePath = await quarantineCorruptFile(options.filePath);
            const state = createDefaultScanCleanupSettingsFile();
            await writeState(state);
            logger.warn(`Quarantined corrupt scan-cleanup settings at ${quarantinePath ?? options.filePath}`);
            return {
                state,
                exists: true,
                schemaUpgraded: false,
            };
        }
        return {
            state: decodeScanCleanupSettingsFile(parsed),
            exists: true,
            schemaUpgraded: scanCleanupPreferenceRecord(parsed)?.schemaVersion !== SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        };
    }

    async function writeState(state: IScanCleanupSettingsFile) {
        const temporaryPath = makeSiblingTempPath(options.filePath);
        try {
            await fileSystem.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            await replace(temporaryPath, options.filePath);
        } finally {
            await fileSystem.unlink(temporaryPath).catch(() => undefined);
        }
    }

    function mergeLegacyStorage(
        state: IScanCleanupSettingsFile,
        request: IScanCleanupSettingsReadRequest,
        initialRead: boolean,
        timestamp: number,
    ) {
        const {
            settings,
            documentCandidates,
            documentCandidatesByLegacyKey,
            diagnostics,
        } = readLegacyCandidates(request.legacyStorage, timestamp);
        const invalidCount = diagnostics.invalidGlobals
            + diagnostics.invalidDocumentEntries
            + diagnostics.invalidEnvelopes;
        if (invalidCount > 0) {
            const warning = 'Skipped malformed scan-cleanup legacy settings while preserving valid data: '
                + `${String(diagnostics.invalidGlobals)} global, `
                + `${String(diagnostics.invalidDocumentEntries)} document entr${diagnostics.invalidDocumentEntries === 1 ? 'y' : 'ies'}, `
                + `${String(diagnostics.invalidEnvelopes)} envelope; first issue: ${diagnostics.firstCause ?? 'unknown'}`;
            if (!reportedLegacyWarnings.has(warning)) {
                reportedLegacyWarnings.add(warning);
                logger.warn(warning);
            }
        }
        let changed = false;
        if (initialRead && settings) {
            state.settings = settings;
            changed = true;
        }
        if (initialRead) {
            for (const [
                sourceSha256,
                candidate,
            ] of documentCandidates) {
                const nextEntry = chooseNewerEntry(state.documentOverrides[sourceSha256], candidate.entry);
                if (nextEntry !== state.documentOverrides[sourceSha256]) {
                    state.documentOverrides[sourceSha256] = nextEntry;
                    changed = true;
                }
            }
        }
        const sourceSha256 = request.sourceSha256;
        const legacyDocumentKey = request.legacyDocumentKey;
        if (isScanCleanupSourceSha256(sourceSha256) && legacyDocumentKey) {
            const mapped = documentCandidatesByLegacyKey.get(legacyDocumentKey);
            if (mapped) {
                const normalizedSourceSha256 = sourceSha256.toLowerCase();
                const nextEntry = chooseNewerEntry(state.documentOverrides[normalizedSourceSha256], mapped);
                if (nextEntry !== state.documentOverrides[normalizedSourceSha256]) {
                    state.documentOverrides[normalizedSourceSha256] = nextEntry;
                    changed = true;
                }
            }
        }
        return changed;
    }

    async function loadAndNormalize(request: IScanCleanupSettingsReadRequest) {
        const loaded = await readFileState();
        const state = loaded.state;
        const timestamp = now();
        const mergedLegacyStorage = mergeLegacyStorage(state, request, !loaded.exists, timestamp);
        const changed = pruneDocumentOverrides(state, timestamp) || mergedLegacyStorage;
        if (!loaded.exists || loaded.schemaUpgraded || changed) {
            await writeState(state);
        }
        return state;
    }

    async function get(request: IScanCleanupSettingsReadRequest = {}) {
        return enqueue(async () => cloneSettingsFile(await loadAndNormalize(request)));
    }

    async function update(request: IScanCleanupSettingsUpdateRequest) {
        return enqueue(async () => {
            const state = await loadAndNormalize({});
            if (request.settings !== undefined) {
                state.settings = request.settings;
            }
            if (request.settingsPatch !== undefined) {
                state.settings = {
                    ...state.settings,
                    ...request.settingsPatch,
                    ...(request.settingsPatch.marginsMm === undefined
                        ? {}
                        : {marginsMm: cloneScanCleanupPreferenceValue(request.settingsPatch.marginsMm)}),
                };
            }
            const document = request.document;
            if (document) {
                const sourceSha256 = document.sourceSha256.toLowerCase();
                const patch = document.patch;
                const previous = state.documentOverrides[sourceSha256];
                const nextEntry: IScanCleanupDocumentOverrideEntry = {
                    ...(previous ?? {}),
                    lastUsedAtMs: now(),
                };
                const resetToEmptyOverrides = patch.resetOverrides === true
                    && (patch.overrides === undefined || Object.keys(patch.overrides).length === 0);
                if (resetToEmptyOverrides) {
                    Reflect.deleteProperty(nextEntry, 'overrides');
                    Reflect.deleteProperty(nextEntry, 'pageOverrideDefaults');
                } else if (patch.overrides !== undefined) {
                    nextEntry.overrides = patch.overrides;
                }
                if (patch.pageOverrideDefaults !== undefined && !resetToEmptyOverrides) {
                    nextEntry.pageOverrideDefaults = patch.pageOverrideDefaults;
                }
                if (patch.marginsMm !== undefined) {
                    nextEntry.marginsMm = patch.marginsMm;
                }
                if (patch.outputMode !== undefined) {
                    nextEntry.outputMode = patch.outputMode;
                }
                const hasDocumentValues = nextEntry.overrides !== undefined
                    || nextEntry.pageOverrideDefaults !== undefined
                    || nextEntry.marginsMm !== undefined
                    || nextEntry.outputMode !== undefined;
                if (hasDocumentValues) {
                    state.documentOverrides[sourceSha256] = nextEntry;
                } else {
                    Reflect.deleteProperty(state.documentOverrides, sourceSha256);
                }
            }
            pruneDocumentOverrides(state, now());
            await writeState(state);
            return cloneSettingsFile(state);
        });
    }

    return {
        get,
        update,
    };
}
