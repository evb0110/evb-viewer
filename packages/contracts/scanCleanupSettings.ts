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

function isScanCleanupReadingOrder(value: unknown): value is IScanCleanupGlobalPreferences['readingOrder'] {
    return value === 'ltr' || value === 'rtl';
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

/** Result returned over the platform boundary after the main process reads the file. */
export interface IScanCleanupSettingsResult extends IScanCleanupSettingsFile {repaired?: true;}

export interface IScanCleanupSettingsFileDecodeResult {
    settingsFile: IScanCleanupSettingsFile;
    repaired: boolean;
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

const SCAN_CLEANUP_SETTINGS_RESULT_GLOBAL_KEYS = [
    'preserveOriginalQuality',
    'layoutMode',
    'binarization',
    'normalizeIllumination',
    'readingOrder',
    'thickness',
    'crop',
    'matchPageSize',
    'pageAlignment',
    'marginsMm',
    'despeckleLevel',
    'autoDewarp',
    'autoDewarpDepth',
    'skipBlankPages',
    'firstRunGuidanceDismissed',
] as const;
const SCAN_CLEANUP_SETTINGS_RESULT_REQUIRED_GLOBAL_KEYS = [
    'preserveOriginalQuality',
    'layoutMode',
    'binarization',
    'normalizeIllumination',
    'readingOrder',
    'thickness',
    'crop',
    'matchPageSize',
    'pageAlignment',
    'marginsMm',
    'despeckleLevel',
    'autoDewarp',
    'skipBlankPages',
    'firstRunGuidanceDismissed',
] as const;

function assertScanCleanupExactKeys(
    value: Record<string, unknown>,
    allowedKeys: readonly string[],
    label: string,
) {
    if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
        throw new Error(`Invalid scan-cleanup ${label}`);
    }
}

function decodeStrictScanCleanupMarginsMm(value: unknown, label: string): IScanCleanupMarginsMm {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error(`Invalid scan-cleanup ${label}`);
    }
    assertScanCleanupExactKeys(stored, [
        'leftMm',
        'topMm',
        'rightMm',
        'bottomMm',
    ], label);
    const decodeMargin = (candidate: unknown) => {
        if (
            typeof candidate !== 'number'
            || !Number.isFinite(candidate)
            || candidate < 0
            || candidate > SCAN_CLEANUP_MARGIN_MAX_MM
        ) {
            throw new Error(`Invalid scan-cleanup ${label}`);
        }
        return candidate;
    };
    return {
        leftMm: decodeMargin(stored.leftMm),
        topMm: decodeMargin(stored.topMm),
        rightMm: decodeMargin(stored.rightMm),
        bottomMm: decodeMargin(stored.bottomMm),
    };
}

function decodeStrictScanCleanupGlobalPreferences(value: unknown): IScanCleanupGlobalPreferences {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup settings result preferences');
    }
    assertScanCleanupExactKeys(stored, SCAN_CLEANUP_SETTINGS_RESULT_GLOBAL_KEYS, 'settings result preferences');
    for (const key of SCAN_CLEANUP_SETTINGS_RESULT_REQUIRED_GLOBAL_KEYS) {
        if (!Object.hasOwn(stored, key) || stored[key] === undefined) {
            throw new Error(`Invalid scan-cleanup settings result preference: ${key}`);
        }
    }
    if (
        typeof stored.preserveOriginalQuality !== 'boolean'
        || !isScanCleanupLayoutMode(stored.layoutMode)
        || !isScanCleanupBinarizationMethod(stored.binarization)
        || typeof stored.normalizeIllumination !== 'boolean'
        || !isScanCleanupReadingOrder(stored.readingOrder)
        || typeof stored.thickness !== 'number'
        || !Number.isSafeInteger(stored.thickness)
        || stored.thickness < -5
        || stored.thickness > 5
        || typeof stored.crop !== 'boolean'
        || typeof stored.matchPageSize !== 'boolean'
        || !isScanCleanupPageAlignment(stored.pageAlignment)
        || !isScanCleanupDespeckleLevel(stored.despeckleLevel)
        || typeof stored.autoDewarp !== 'boolean'
        || typeof stored.skipBlankPages !== 'boolean'
        || typeof stored.firstRunGuidanceDismissed !== 'boolean'
        || (stored.autoDewarpDepth !== undefined && (
            typeof stored.autoDewarpDepth !== 'number'
            || !Number.isFinite(stored.autoDewarpDepth)
            || stored.autoDewarpDepth < SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN
            || stored.autoDewarpDepth > SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX
        ))
    ) {
        throw new Error('Invalid scan-cleanup settings result preferences');
    }
    return {
        ...decodeScanCleanupGlobalPreferences(stored),
        marginsMm: decodeStrictScanCleanupMarginsMm(stored.marginsMm, 'settings result margins'),
    };
}

function decodeStrictScanCleanupDocumentOverrideEntry(
    value: unknown,
    budget: IScanCleanupInputBudget,
): IScanCleanupDocumentOverrideEntry {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        throw new Error('Invalid scan-cleanup settings result document override');
    }
    assertScanCleanupExactKeys(stored, [
        'overrides',
        'pageOverrideDefaults',
        'marginsMm',
        'outputMode',
        'lastUsedAtMs',
    ], 'settings result document override');
    if (
        typeof stored.lastUsedAtMs !== 'number'
        || !Number.isFinite(stored.lastUsedAtMs)
        || stored.lastUsedAtMs < 0
    ) {
        throw new Error('Invalid scan-cleanup settings result document override timestamp');
    }
    const outputMode = stored.outputMode === undefined
        ? undefined
        : decodeOutputMode(stored.outputMode);
    if (stored.outputMode !== undefined && outputMode === undefined) {
        throw new Error('Invalid scan-cleanup settings result document output mode');
    }
    const overrides = stored.overrides === undefined
        ? undefined
        : decodeScanCleanupPageOverrides(stored.overrides, budget);
    const pageOverrideDefaults = stored.pageOverrideDefaults === undefined
        ? undefined
        : decodeScanCleanupPageOverride(stored.pageOverrideDefaults, budget);
    const marginsMm = stored.marginsMm === undefined
        ? undefined
        : decodeStrictScanCleanupMarginsMm(stored.marginsMm, 'settings result document margins');
    return {
        ...(overrides === undefined ? {} : {overrides}),
        ...(pageOverrideDefaults === undefined ? {} : {pageOverrideDefaults}),
        ...(marginsMm === undefined ? {} : {marginsMm}),
        ...(outputMode === undefined ? {} : {outputMode}),
        lastUsedAtMs: stored.lastUsedAtMs,
    };
}

/** Decodes the canonical settings object crossing the main/renderer boundary. */
export function decodeScanCleanupSettingsResult(value: unknown): IScanCleanupSettingsResult {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored || stored.schemaVersion !== SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION) {
        throw new Error('Invalid scan-cleanup settings result');
    }
    assertScanCleanupExactKeys(stored, [
        'schemaVersion',
        'settings',
        'documentOverrides',
        'repaired',
    ], 'settings result');
    if (stored.repaired !== undefined && stored.repaired !== true) {
        throw new Error('Invalid scan-cleanup settings result repair marker');
    }
    const storedOverrides = scanCleanupPreferenceRecord(stored.documentOverrides);
    if (!storedOverrides) {
        throw new Error('Invalid scan-cleanup settings result documentOverrides');
    }
    if (Object.keys(storedOverrides).length > SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES) {
        throw new Error('Too many scan-cleanup settings result documentOverrides');
    }
    const documentOverrides: Record<string, IScanCleanupDocumentOverrideEntry> = {};
    for (const [
        key,
        entry,
    ] of Object.entries(storedOverrides)) {
        if (!isScanCleanupSourceSha256(key) || key !== key.toLowerCase()) {
            throw new Error('Invalid scan-cleanup settings result document key');
        }
        documentOverrides[key] = decodeStrictScanCleanupDocumentOverrideEntry(
            entry,
            createScanCleanupInputBudget(),
        );
    }
    return {
        schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        settings: decodeStrictScanCleanupGlobalPreferences(stored.settings),
        documentOverrides,
        ...(stored.repaired === true ? {repaired: true} : {}),
    };
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

function hasStoredScanCleanupMarginRepair(value: unknown): boolean {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        return true;
    }
    return [
        'leftMm',
        'topMm',
        'rightMm',
        'bottomMm',
    ].some(key => {
        const candidate = stored[key];
        return candidate !== undefined && (
            typeof candidate !== 'number'
            || !Number.isFinite(candidate)
            || candidate < 0
            || candidate > SCAN_CLEANUP_MARGIN_MAX_MM
        );
    });
}

function hasStoredScanCleanupGlobalRepair(value: unknown): boolean {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        return true;
    }
    const allowedKeys = new Set<string>([
        ...SCAN_CLEANUP_SETTINGS_RESULT_GLOBAL_KEYS,
        'marginMm',
        'despeckle',
    ]);
    if (Object.keys(stored).some(key => !allowedKeys.has(key))) {
        return true;
    }
    if (stored.layoutMode !== undefined && !isScanCleanupLayoutMode(stored.layoutMode)) return true;
    if (stored.binarization !== undefined && !isScanCleanupBinarizationMethod(stored.binarization)) return true;
    if (stored.normalizeIllumination !== undefined && typeof stored.normalizeIllumination !== 'boolean') return true;
    if (stored.preserveOriginalQuality !== undefined && typeof stored.preserveOriginalQuality !== 'boolean') return true;
    if (stored.readingOrder !== undefined && !isScanCleanupReadingOrder(stored.readingOrder)) return true;
    if (stored.thickness !== undefined && (
        typeof stored.thickness !== 'number'
        ||
        !Number.isSafeInteger(stored.thickness)
        || stored.thickness < -5
        || stored.thickness > 5
    )) return true;
    if (stored.crop !== undefined && typeof stored.crop !== 'boolean') return true;
    if (stored.matchPageSize !== undefined && typeof stored.matchPageSize !== 'boolean') return true;
    if (stored.pageAlignment !== undefined && !isScanCleanupPageAlignment(stored.pageAlignment)) return true;
    if (stored.marginsMm !== undefined && hasStoredScanCleanupMarginRepair(stored.marginsMm)) return true;
    if (stored.marginMm !== undefined && (
        typeof stored.marginMm !== 'number'
        || !Number.isFinite(stored.marginMm)
        || stored.marginMm < 0
        || stored.marginMm > SCAN_CLEANUP_MARGIN_MAX_MM
    )) return true;
    if (stored.despeckleLevel !== undefined && !isScanCleanupDespeckleLevel(stored.despeckleLevel)) return true;
    if (stored.despeckle !== undefined && typeof stored.despeckle !== 'boolean') return true;
    if (stored.autoDewarp !== undefined && typeof stored.autoDewarp !== 'boolean') return true;
    if (stored.autoDewarpDepth !== undefined && (
        typeof stored.autoDewarpDepth !== 'number'
        || !Number.isFinite(stored.autoDewarpDepth)
        || stored.autoDewarpDepth < SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN
        || stored.autoDewarpDepth > SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX
    )) return true;
    if (stored.skipBlankPages !== undefined && typeof stored.skipBlankPages !== 'boolean') return true;
    if (stored.firstRunGuidanceDismissed !== undefined && typeof stored.firstRunGuidanceDismissed !== 'boolean') return true;
    return false;
}

function hasStoredScanCleanupDocumentRepair(value: unknown): boolean {
    const stored = scanCleanupPreferenceRecord(value);
    if (!stored) {
        return true;
    }
    if (Object.keys(stored).some(key => ![
        'overrides',
        'pageOverrideDefaults',
        'marginsMm',
        'outputMode',
        'lastUsedAtMs',
    ].includes(key))) return true;
    if (
        typeof stored.lastUsedAtMs !== 'number'
        || !Number.isFinite(stored.lastUsedAtMs)
        || stored.lastUsedAtMs < 0
    ) return true;
    if (stored.outputMode !== undefined && !isScanCleanupOutputModeSetting(stored.outputMode)) return true;
    if (stored.marginsMm !== undefined && hasStoredScanCleanupMarginRepair(stored.marginsMm)) return true;
    try {
        const budget = createScanCleanupInputBudget();
        if (stored.overrides !== undefined) decodeScanCleanupPageOverrides(stored.overrides, budget);
        if (stored.pageOverrideDefaults !== undefined) decodeScanCleanupPageOverride(stored.pageOverrideDefaults, budget);
    } catch {
        return true;
    }
    return false;
}

export function isScanCleanupSourceSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value);
}

export function decodeScanCleanupSettingsFileWithDiagnostics(value: unknown): IScanCleanupSettingsFileDecodeResult {
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
    let repaired = Object.keys(stored).some(key => ![
        'schemaVersion',
        'settings',
        'documentOverrides',
    ].includes(key));
    repaired ||= hasStoredScanCleanupGlobalRepair(
        stored.settings,
    );
    const documentOverrides: Record<string, IScanCleanupDocumentOverrideEntry> = {};
    for (const [
        key,
        entry,
    ] of Object.entries(storedOverrides)) {
        if (!isScanCleanupSourceSha256(key)) {
            repaired = true;
            continue;
        }
        const normalizedKey = key.toLowerCase();
        if (Object.hasOwn(documentOverrides, normalizedKey)) {
            repaired = true;
        }
        if (hasStoredScanCleanupDocumentRepair(entry)) {
            repaired = true;
        }
        let decoded: IScanCleanupDocumentOverrideEntry | null;
        try {
            decoded = decodeDocumentOverrideEntry(entry, createScanCleanupInputBudget());
        } catch {
            repaired = true;
            continue;
        }
        if (decoded) {
            documentOverrides[normalizedKey] = decoded;
        } else {
            repaired = true;
        }
    }
    return {
        settingsFile: {
            schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
            settings: decodeScanCleanupGlobalPreferences(
                stored.settings,
                {preInkAlignment: schemaVersion === PRE_INK_SETTINGS_SCHEMA_VERSION},
            ),
            documentOverrides,
        },
        repaired,
    };
}

export function decodeScanCleanupSettingsFile(value: unknown): IScanCleanupSettingsFile {
    return decodeScanCleanupSettingsFileWithDiagnostics(value).settingsFile;
}

export function createDefaultScanCleanupSettingsFile(): IScanCleanupSettingsFile {
    return {
        schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        settings: cloneScanCleanupPreferenceValue(DEFAULT_SCAN_CLEANUP_PREFERENCES),
        documentOverrides: {},
    };
}
