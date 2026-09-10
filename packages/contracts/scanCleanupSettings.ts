import type {IScanCleanupMarginsMm} from '@contracts/scan-cleanup/geometry';
import {SCAN_CLEANUP_MARGIN_MAX_MM} from '@contracts/scan-cleanup/geometry';
import type {
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    TScanCleanupBinarizationMethod,
    TScanCleanupDespeckleLevel,
    TScanCleanupLayoutMode,
    TScanCleanupOutputModeSetting,
    TScanCleanupPageAlignment,
    TScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/domain';
import {
    SCAN_CLEANUP_ALIGNMENTS,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
} from '@contracts/scan-cleanup/domain';
import {isRecord} from '@contracts/runtimeGuards';
import {
    createScanCleanupInputBudget,
    decodeBoundedScanCleanupString,
    type IScanCleanupInputBudget,
    SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    SCAN_CLEANUP_LEGACY_STORAGE_MAX_BYTES,
    scanCleanupUtf8ByteLength,
} from '@contracts/scan-cleanup/inputLimits';
import {
    decodeScanCleanupPageOverride,
    decodeScanCleanupPageOverrides,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {stringifyJson} from '@contracts/stringifyJson';

export const SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION = 2 as const;
// Schema 1 predates the `ink` alignment: a stored `top-center` was the
// un-chosen default of that era, so it migrates to the current default.
const PRE_INK_SETTINGS_SCHEMA_VERSION = 1;
const PRE_INK_DEFAULT_ALIGNMENT = 'top-center';
export const SCAN_CLEANUP_SETTINGS_FILE_NAME = 'scan-cleanup-settings.json';
export const SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES = 50;

const SCAN_CLEANUP_LAYOUT_MODES = [
    'auto',
    'force-single',
    'force-two-page',
] as const;
const SCAN_CLEANUP_BINARIZATION_METHODS = [
    'auto',
    'otsu',
    'sauvola',
    'wolf',
] as const;
const SCAN_CLEANUP_DESPECKLE_LEVELS = [
    'off',
    'cautious',
    'normal',
    'aggressive',
] as const;
const SCAN_CLEANUP_OUTPUT_MODE_SETTINGS = [
    'auto',
    'bw',
    'mixed',
    'grayscale',
    'color',
] as const;

function isScanCleanupLayoutMode(value: unknown): value is TScanCleanupLayoutMode {
    return SCAN_CLEANUP_LAYOUT_MODES.some(mode => mode === value);
}

function isScanCleanupBinarizationMethod(value: unknown): value is TScanCleanupBinarizationMethod {
    return SCAN_CLEANUP_BINARIZATION_METHODS.some(method => method === value);
}

function isScanCleanupDespeckleLevel(value: unknown): value is TScanCleanupDespeckleLevel {
    return SCAN_CLEANUP_DESPECKLE_LEVELS.some(level => level === value);
}

function isScanCleanupOutputModeSetting(value: unknown): value is TScanCleanupOutputModeSetting {
    return SCAN_CLEANUP_OUTPUT_MODE_SETTINGS.some(mode => mode === value);
}

function isScanCleanupPageAlignment(value: unknown): value is TScanCleanupPageAlignment {
    return SCAN_CLEANUP_ALIGNMENTS.some(alignment => alignment === value);
}

function isScanCleanupGlobalPreferenceKey(value: string): value is keyof IScanCleanupGlobalPreferences {
    return Object.hasOwn(DEFAULT_SCAN_CLEANUP_PREFERENCES, value);
}

export interface IScanCleanupGlobalPreferences extends Omit<
    IScanCleanupOptions,
    'autoDewarp' | 'autoDewarpDepth' | 'binarization' | 'despeckle' | 'despeckleLevel' | 'normalizeIllumination' | 'outputMode' | 'pageOverrides' | 'pageOverrideDefaults'
> {
    autoDewarp: boolean;
    autoDewarpDepth: number | undefined;
    binarization: TScanCleanupBinarizationMethod;
    despeckleLevel: TScanCleanupDespeckleLevel;
    normalizeIllumination: boolean;
    firstRunGuidanceDismissed: boolean;
}

export const DEFAULT_SCAN_CLEANUP_PREFERENCES: Readonly<IScanCleanupGlobalPreferences> = Object.freeze({
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'ink',
    marginsMm: Object.freeze({
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    }),
    despeckleLevel: 'normal',
    autoDewarp: false,
    autoDewarpDepth: undefined,
    skipBlankPages: false,
    firstRunGuidanceDismissed: false,
});

export interface IScanCleanupDocumentOverrideEntry {
    overrides?: TScanCleanupPageOverrides;
    pageOverrideDefaults?: IScanCleanupPageOverride;
    marginsMm?: IScanCleanupMarginsMm;
    outputMode?: TScanCleanupOutputModeSetting;
    lastUsedAtMs: number;
}

export interface IScanCleanupSettingsFile {
    schemaVersion: typeof SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION;
    settings: IScanCleanupGlobalPreferences;
    documentOverrides: Record<string, IScanCleanupDocumentOverrideEntry>;
}

/**
 * Renderer-side export of the old origin-scoped storage. The main process
 * intentionally receives values only; it never reaches into renderer storage.
 */
export interface IScanCleanupLegacyStorageExport {
    settingsRaw: string | null;
    documentOverridesRaw: string | null;
    exportedAtMs?: number;
}

export interface IScanCleanupSettingsReadRequest {
    legacyStorage?: IScanCleanupLegacyStorageExport;
    sourceSha256?: string | null;
    legacyDocumentKey?: string | null;
}

export interface IScanCleanupDocumentPreferencePatch {
    overrides?: TScanCleanupPageOverrides;
    pageOverrideDefaults?: IScanCleanupPageOverride;
    marginsMm?: IScanCleanupMarginsMm;
    outputMode?: TScanCleanupOutputModeSetting;
    resetOverrides?: boolean;
}

export type IScanCleanupGlobalPreferencePatch = Partial<IScanCleanupGlobalPreferences>;

export interface IScanCleanupSettingsUpdateRequest {
    settings?: IScanCleanupGlobalPreferences;
    settingsPatch?: IScanCleanupGlobalPreferencePatch;
    document?: {
        sourceSha256: string;
        legacyDocumentKey?: string | null;
        patch: IScanCleanupDocumentPreferencePatch;
    };
}

function decodeNullablePath(value: unknown, label: string): string | null | undefined {
    if (value === undefined || value === null) {
        return value;
    }
    return decodeBoundedScanCleanupString(value, `settings ${label}`, SCAN_CLEANUP_INPUT_MAX_PATH_BYTES);
}

export function assertScanCleanupLegacyStorageByteLimit(
    value: Pick<IScanCleanupLegacyStorageExport, 'settingsRaw' | 'documentOverridesRaw'>,
) {
    const rawBytes = scanCleanupUtf8ByteLength(value.settingsRaw ?? '')
        + scanCleanupUtf8ByteLength(value.documentOverridesRaw ?? '');
    if (rawBytes > SCAN_CLEANUP_LEGACY_STORAGE_MAX_BYTES) {
        throw new Error('Scan-cleanup legacy storage export exceeds its byte limit');
    }
}

function decodeLegacyStorageExport(value: unknown): IScanCleanupLegacyStorageExport {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored || (stored.settingsRaw !== null && typeof stored.settingsRaw !== 'string')
        || (stored.documentOverridesRaw !== null && typeof stored.documentOverridesRaw !== 'string')
        || (stored.exportedAtMs !== undefined
            && (typeof stored.exportedAtMs !== 'number' || !Number.isFinite(stored.exportedAtMs)))) {
        throw new Error('Invalid scan-cleanup legacy storage export');
    }
    const decoded = {
        settingsRaw: stored.settingsRaw,
        documentOverridesRaw: stored.documentOverridesRaw,
        ...(stored.exportedAtMs === undefined ? {} : {exportedAtMs: stored.exportedAtMs}),
    };
    assertScanCleanupLegacyStorageByteLimit(decoded);
    return decoded;
}

export function decodeScanCleanupSettingsReadRequest(value: unknown): IScanCleanupSettingsReadRequest {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup settings read request');
    }
    const sourceSha256 = stored.sourceSha256 === undefined
        ? undefined
        : stored.sourceSha256 === null
            ? null
            : (() => {
                if (!isScanCleanupSourceSha256(stored.sourceSha256)) {
                    throw new Error('Invalid scan-cleanup settings source hash');
                }
                return stored.sourceSha256.toLowerCase();
            })();
    const legacyDocumentKey = stored.legacyDocumentKey === undefined
        ? undefined
        : decodeNullablePath(stored.legacyDocumentKey, 'legacy document key');
    return {
        ...(stored.legacyStorage === undefined ? {} : {legacyStorage: decodeLegacyStorageExport(stored.legacyStorage)}),
        ...(sourceSha256 === undefined ? {} : {sourceSha256}),
        ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
    };
}

function decodeDocumentPatch(value: unknown): IScanCleanupDocumentPreferencePatch {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup document settings patch');
    }
    const outputMode = decodeOutputMode(stored.outputMode);
    if (stored.outputMode !== undefined && outputMode === undefined) {
        throw new Error('Invalid scan-cleanup document output mode');
    }
    if (stored.resetOverrides !== undefined && typeof stored.resetOverrides !== 'boolean') {
        throw new Error('Invalid scan-cleanup document reset flag');
    }
    const marginsMm = stored.marginsMm === undefined
        ? undefined
        : decodeScanCleanupMarginsMm(stored.marginsMm);
    const overrides = stored.overrides === undefined
        ? undefined
        : decodeScanCleanupPageOverrides(stored.overrides);
    const pageOverrideDefaults = stored.pageOverrideDefaults === undefined
        ? undefined
        : decodeScanCleanupPageOverride(stored.pageOverrideDefaults);
    return {
        ...(overrides === undefined ? {} : {overrides}),
        ...(pageOverrideDefaults === undefined ? {} : {pageOverrideDefaults}),
        ...(marginsMm === undefined ? {} : {marginsMm}),
        ...(outputMode === undefined ? {} : {outputMode}),
        ...(stored.resetOverrides === undefined ? {} : {resetOverrides: stored.resetOverrides}),
    };
}

export function decodeScanCleanupSettingsUpdateRequest(value: unknown): IScanCleanupSettingsUpdateRequest {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup settings update request');
    }
    const settings = stored.settings === undefined
        ? undefined
        : decodeScanCleanupGlobalPreferences(stored.settings);
    const settingsPatch = stored.settingsPatch === undefined
        ? undefined
        : decodeScanCleanupGlobalPreferencesPatch(stored.settingsPatch);
    if (settings !== undefined && settingsPatch !== undefined) {
        throw new Error('Scan-cleanup settings and settingsPatch cannot be supplied together');
    }
    if (stored.document === undefined) {
        return {
            ...(settings === undefined ? {} : {settings}),
            ...(settingsPatch === undefined ? {} : {settingsPatch}),
        };
    }
    const documentValue = scanCleanupPreferenceRecord(stored.document);
    if (!documentValue) {
        throw new Error('Invalid scan-cleanup document settings update');
    }
    const sourceSha256 = documentValue.sourceSha256;
    if (!isScanCleanupSourceSha256(sourceSha256)) {
        throw new Error('Scan-cleanup document settings require a SHA-256 source key');
    }
    const legacyDocumentKey = documentValue.legacyDocumentKey === undefined
        ? undefined
        : decodeNullablePath(documentValue.legacyDocumentKey, 'legacy document key');
    return {
        ...(settings === undefined ? {} : {settings}),
        ...(settingsPatch === undefined ? {} : {settingsPatch}),
        document: {
            sourceSha256: sourceSha256.toLowerCase(),
            ...(legacyDocumentKey === undefined ? {} : {legacyDocumentKey}),
            patch: decodeDocumentPatch(documentValue.patch),
        },
    };
}

export function scanCleanupPreferenceRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

export function parseScanCleanupPreferenceJson(raw: string | null | undefined) {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
}

function isJsonClone<T>(value: unknown, serialized: string): value is T {
    try {
        return JSON.stringify(value) === serialized;
    } catch {
        return false;
    }
}

export function cloneScanCleanupPreferenceValue<T>(value: T): T {
    const serialized = stringifyJson(value);
    if (serialized === undefined) {
        return value;
    }
    const cloned: unknown = JSON.parse(serialized);
    if (!isJsonClone<T>(cloned, serialized)) {
        throw new TypeError('Failed to clone scan-cleanup preference value');
    }
    return cloned;
}

function clampScanCleanupMargin(value: unknown, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(SCAN_CLEANUP_MARGIN_MAX_MM, Math.max(0, value))
        : fallback;
}

export function decodeScanCleanupMarginsMm(
    value: unknown,
    fallback: IScanCleanupMarginsMm = DEFAULT_SCAN_CLEANUP_PREFERENCES.marginsMm,
): IScanCleanupMarginsMm {
    const stored = scanCleanupPreferenceRecord(value);
    return {
        leftMm: clampScanCleanupMargin(stored?.leftMm, fallback.leftMm),
        topMm: clampScanCleanupMargin(stored?.topMm, fallback.topMm),
        rightMm: clampScanCleanupMargin(stored?.rightMm, fallback.rightMm),
        bottomMm: clampScanCleanupMargin(stored?.bottomMm, fallback.bottomMm),
    };
}

/** `preInkAlignment`: the stored value predates the `ink` alignment (schema 1 or legacy renderer storage). */
export interface IScanCleanupPreferenceDecodeOptions {preInkAlignment?: boolean}

export function decodeScanCleanupGlobalPreferences(
    value: unknown,
    {preInkAlignment = false}: IScanCleanupPreferenceDecodeOptions = {},
): IScanCleanupGlobalPreferences {
    const stored = scanCleanupPreferenceRecord(value);
    const defaults = DEFAULT_SCAN_CLEANUP_PREFERENCES;
    if (!stored) {
        return cloneScanCleanupPreferenceValue(defaults);
    }
    const legacyMarginMm = typeof stored.marginMm === 'number' && Number.isFinite(stored.marginMm)
        ? Math.min(SCAN_CLEANUP_MARGIN_MAX_MM, Math.max(0, stored.marginMm))
        : null;
    const legacyMargins = legacyMarginMm === null
        ? defaults.marginsMm
        : {
            leftMm: legacyMarginMm,
            topMm: legacyMarginMm,
            rightMm: legacyMarginMm,
            bottomMm: legacyMarginMm,
        };
    const layoutMode = isScanCleanupLayoutMode(stored.layoutMode)
        ? stored.layoutMode
        : defaults.layoutMode;
    const binarization = isScanCleanupBinarizationMethod(stored.binarization)
        ? stored.binarization
        : defaults.binarization;
    const pageAlignment = isScanCleanupPageAlignment(stored.pageAlignment)
        && !(preInkAlignment && stored.pageAlignment === PRE_INK_DEFAULT_ALIGNMENT)
        ? stored.pageAlignment
        : defaults.pageAlignment;
    const despeckleLevel = isScanCleanupDespeckleLevel(stored.despeckleLevel)
        ? stored.despeckleLevel
        : typeof stored.despeckle === 'boolean'
            ? stored.despeckle ? 'normal' : 'off'
            : defaults.despeckleLevel;
    return {
        preserveOriginalQuality: typeof stored.preserveOriginalQuality === 'boolean'
            ? stored.preserveOriginalQuality
            : defaults.preserveOriginalQuality,
        layoutMode,
        binarization,
        normalizeIllumination: typeof stored.normalizeIllumination === 'boolean'
            ? stored.normalizeIllumination
            : defaults.normalizeIllumination,
        readingOrder: stored.readingOrder === 'rtl' ? 'rtl' : 'ltr',
        thickness: typeof stored.thickness === 'number' && Number.isFinite(stored.thickness)
            ? Math.min(5, Math.max(-5, Math.trunc(stored.thickness)))
            : defaults.thickness,
        crop: typeof stored.crop === 'boolean' ? stored.crop : defaults.crop,
        matchPageSize: typeof stored.matchPageSize === 'boolean' ? stored.matchPageSize : defaults.matchPageSize,
        pageAlignment,
        marginsMm: decodeScanCleanupMarginsMm(stored.marginsMm, legacyMargins),
        despeckleLevel,
        autoDewarp: typeof stored.autoDewarp === 'boolean' ? stored.autoDewarp : defaults.autoDewarp,
        autoDewarpDepth: typeof stored.autoDewarpDepth === 'number'
            && Number.isFinite(stored.autoDewarpDepth)
            && stored.autoDewarpDepth >= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN
            && stored.autoDewarpDepth <= SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX
            ? stored.autoDewarpDepth
            : defaults.autoDewarpDepth,
        skipBlankPages: typeof stored.skipBlankPages === 'boolean' ? stored.skipBlankPages : defaults.skipBlankPages,
        firstRunGuidanceDismissed: typeof stored.firstRunGuidanceDismissed === 'boolean'
            ? stored.firstRunGuidanceDismissed
            : defaults.firstRunGuidanceDismissed,
    };
}

export function decodeScanCleanupGlobalPreferencesPatch(value: unknown): IScanCleanupGlobalPreferencePatch {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup global settings patch');
    }
    const allowedKeys = new Set(Object.keys(DEFAULT_SCAN_CLEANUP_PREFERENCES));
    for (const key of Object.keys(stored)) {
        if (!allowedKeys.has(key)) {
            throw new Error(`Invalid scan-cleanup global settings patch field: ${key}`);
        }
    }
    const decoded = decodeScanCleanupGlobalPreferences(stored);
    const patch: IScanCleanupGlobalPreferencePatch = {};
    for (const key of Object.keys(stored).filter(isScanCleanupGlobalPreferenceKey)) {
        if (stored[key] === undefined) {
            throw new Error(`Invalid scan-cleanup global settings patch value: ${key}`);
        }
        const decodedField = decodeScanCleanupGlobalPreferences({[key]: stored[key]})[key];
        if (!areScanCleanupPreferenceValuesEqual(stored[key], decodedField)) {
            throw new Error(`Invalid scan-cleanup global settings patch value: ${key}`);
        }
        Object.assign(patch, {[key]: decoded[key]});
    }
    return patch;
}

function areScanCleanupPreferenceValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (!isRecord(left) || !isRecord(right)) {
        return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
        && leftKeys.every(key => Object.hasOwn(right, key)
            && areScanCleanupPreferenceValuesEqual(left[key], right[key]));
}

export function assertFiniteScanCleanupPreferences(value: IScanCleanupGlobalPreferences) {
    if (
        !Number.isFinite(value.thickness)
        || (value.autoDewarpDepth !== undefined && !Number.isFinite(value.autoDewarpDepth))
        || Object.values(value.marginsMm).some(margin => !Number.isFinite(margin))
    ) {
        throw new TypeError('Scan cleanup preferences require finite numeric values');
    }
}

function decodeOutputMode(value: unknown): TScanCleanupOutputModeSetting | undefined {
    return isScanCleanupOutputModeSetting(value) ? value : undefined;
}

function decodeDocumentOverrideEntry(
    value: unknown,
    budget: IScanCleanupInputBudget,
): IScanCleanupDocumentOverrideEntry | null {
    const stored = scanCleanupPreferenceRecord(value);
    const lastUsedAtMs = stored?.lastUsedAtMs;
    if (typeof lastUsedAtMs !== 'number' || !Number.isFinite(lastUsedAtMs) || lastUsedAtMs < 0) {
        return null;
    }
    const outputMode = decodeOutputMode(stored?.outputMode);
    const marginsMm = stored?.marginsMm === undefined
        ? undefined
        : decodeScanCleanupMarginsMm(stored.marginsMm);
    const overrides = stored?.overrides === undefined
        ? undefined
        : scanCleanupPreferenceRecord(stored.overrides) === null
            ? null
            : decodeScanCleanupPageOverrides(stored.overrides, budget);
    if (overrides === null) {
        return null;
    }
    const decodedOverrides = overrides;
    const pageOverrideDefaults = stored?.pageOverrideDefaults === undefined
        ? undefined
        : decodeScanCleanupPageOverride(stored.pageOverrideDefaults, budget);
    return {
        ...(decodedOverrides === undefined ? {} : {overrides: decodedOverrides}),
        ...(pageOverrideDefaults === undefined ? {} : {pageOverrideDefaults}),
        ...(marginsMm === undefined ? {} : {marginsMm}),
        ...(outputMode === undefined ? {} : {outputMode}),
        lastUsedAtMs,
    };
}

export function isScanCleanupSourceSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value);
}

export function decodeScanCleanupSettingsFile(value: unknown): IScanCleanupSettingsFile {
    const stored = scanCleanupPreferenceRecord(value);
    const schemaVersion = stored?.schemaVersion;
    if (
        !stored
        || (schemaVersion !== SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION
            && schemaVersion !== PRE_INK_SETTINGS_SCHEMA_VERSION)
    ) {
        throw new Error(`Unsupported scan-cleanup settings schema version: ${stringifyJson(schemaVersion) ?? 'missing'}`);
    }
    const storedOverrides = scanCleanupPreferenceRecord(stored.documentOverrides);
    if (!storedOverrides) {
        throw new Error('Invalid scan-cleanup settings documentOverrides');
    }
    if (Object.keys(storedOverrides).length > SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES) {
        throw new Error('Too many scan-cleanup settings documentOverrides');
    }
    const documentOverrides: Record<string, IScanCleanupDocumentOverrideEntry> = {};
    for (const [
        key,
        entry,
    ] of Object.entries(storedOverrides)) {
        if (!isScanCleanupSourceSha256(key)) {
            continue;
        }
        let decoded: IScanCleanupDocumentOverrideEntry | null;
        try {
            decoded = decodeDocumentOverrideEntry(entry, createScanCleanupInputBudget());
        } catch {
            continue;
        }
        if (decoded) {
            documentOverrides[key.toLowerCase()] = decoded;
        }
    }
    return {
        schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        settings: decodeScanCleanupGlobalPreferences(
            stored.settings,
            {preInkAlignment: schemaVersion === PRE_INK_SETTINGS_SCHEMA_VERSION},
        ),
        documentOverrides,
    };
}

export function createDefaultScanCleanupSettingsFile(): IScanCleanupSettingsFile {
    return {
        schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        settings: cloneScanCleanupPreferenceValue(DEFAULT_SCAN_CLEANUP_PREFERENCES),
        documentOverrides: {},
    };
}
