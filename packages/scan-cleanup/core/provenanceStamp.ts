import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import type {
    INativeScanCleanupOptionsV3,
    IScanCleanupManualZones,
    IScanCleanupOptions,
    TScanCleanupLayoutMode,
    TScanCleanupPageAlignment,
    TScanCleanupPageRotation,
    TScanCleanupOutputModeSetting,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_ALIGNMENTS} from '@contracts/electronApiScanCleanup';
import {
    consumeScanCleanupVertices,
    consumeScanCleanupZones,
    createScanCleanupInputBudget,
    type IScanCleanupInputBudget,
    SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON,
    SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE,
} from '@contracts/scan-cleanup/inputLimits';
import {assertSimpleScanCleanupPolygon} from '@contracts/scan-cleanup/assertSimpleScanCleanupPolygon';
import {getErrorMessage} from '@contracts/getErrorMessage';
import type {
    IScanCleanupOutputMapping,
    TScanCleanupAssemblerBackend,
    TScanCleanupTransportMode,
} from '@evb/scan-cleanup/core/types';
import type {
    IEffectiveNativeScanCleanupOptionsV3,
    TScanCleanupQualityPath,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

export const SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1 = 1 as const;
export const SCAN_CLEANUP_STAMP_SCHEMA_ID_V1 = 'urn:evb:scan-cleanup:stamp:v1';
export const SCAN_CLEANUP_STAMP_SCHEMA_VERSION = 2 as const;
export const SCAN_CLEANUP_STAMP_SCHEMA_ID = 'urn:evb:scan-cleanup:stamp:v2';
export const SCAN_CLEANUP_CORE_BUILD_ID = 'evb-viewer-scan-cleanup-core-v1';
export const SCAN_CLEANUP_GIT_SHA_HEX_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

type TNormalizedRect = NonNullable<INativeScanCleanupOptionsV3['renderCrop']>;
type TNormalizedSplit = NonNullable<INativeScanCleanupOptionsV3['manualSplit']>;
type TTextToneDiagnostics = NonNullable<INativeScanCleanupOptionsV3['resolvedTextToneDiagnostics']>;

export interface IScanCleanupStampEffectiveOptions {
    qualityPath: TScanCleanupQualityPath;
    preserveOriginalQuality: boolean;
    layoutMode: TScanCleanupLayoutMode;
    readingOrder: 'ltr' | 'rtl';
    dpi: number;
    sourceDpi: number;
    sourceHasBilevelLayer: boolean;
    sourceBackgroundDpi: number | null;
    requestedRenderDpi: number;
    renderCrop: TNormalizedRect | null;
    binarization: 'auto' | 'otsu' | 'sauvola' | 'wolf';
    thickness: number;
    normalizeIllumination: boolean;
    despeckle: boolean;
    despeckleLevel: 'off' | 'cautious' | 'normal' | 'aggressive';
    outputMode: TScanCleanupOutputModeSetting;
    preferSoftAlphaForeground: boolean | null;
    resolvedTextToneDiagnostics: TTextToneDiagnostics | null;
    ocrMode: boolean;
    layout: INativeScanCleanupOptionsV3['layout'];
    manualSplit: TNormalizedSplit | null;
    automaticSplit: TNormalizedSplit | null;
    manualSkewDegrees: number | null;
    manualContentBoxes: NonNullable<INativeScanCleanupOptionsV3['manualContentBoxes']>;
    automaticSkewDegrees: NonNullable<INativeScanCleanupOptionsV3['automaticSkewDegrees']>;
    automaticContentBoxes: NonNullable<INativeScanCleanupOptionsV3['automaticContentBoxes']>;
    /**
     * Recorded only by a run that resolved `ink` anchors. Every other run —
     * and every run predating `ink` — writes the stamp it always wrote, so an
     * already-stamped document keeps verifying byte-for-byte.
     */
    placementAnchors?: NonNullable<INativeScanCleanupOptionsV3['placementAnchors']>;
    manualZones: IScanCleanupManualZones;
    cropContent: boolean;
    matchPageSize: boolean;
    pageAlignment: TScanCleanupPageAlignment;
    placementOverrides: NonNullable<INativeScanCleanupOptionsV3['placementOverrides']>;
    margins: INativeScanCleanupOptionsV3['margins'];
    experimental: {
        autoDewarp: boolean;
        autoDewarpDepth: number | null;
    };
    rotationDegrees: TScanCleanupPageRotation;
    excluded: boolean;
    skipBlankPages: boolean;
    maxPixels: number;
    maxDimensionPx: number;
}

export interface IScanCleanupStampEffectiveOptionsRecord {
    sourcePage: number;
    options: IScanCleanupStampEffectiveOptions;
}

export interface IScanCleanupStampPagePlanDigest {
    sourcePage: number;
    planSha256: string;
    evidenceSha256: string;
}

interface IScanCleanupStampBuildIdsBase extends Record<string, unknown> {
    coreBuildId: string;
    nativeBinarySha256s: Record<string, string>;
    assemblerBackend: TScanCleanupAssemblerBackend;
    transportMode: TScanCleanupTransportMode;
}

export interface IScanCleanupStampBuildIdsV1 extends IScanCleanupStampBuildIdsBase {coreSchemaId: typeof SCAN_CLEANUP_STAMP_SCHEMA_ID_V1;}

export interface IScanCleanupStampBuildIds extends IScanCleanupStampBuildIdsBase {
    coreSchemaId: typeof SCAN_CLEANUP_STAMP_SCHEMA_ID;
    gitSha: string;
}

export type TScanCleanupStampBuildIds = IScanCleanupStampBuildIdsV1 | IScanCleanupStampBuildIds;

interface IScanCleanupProvenanceStampBase {
    sourceSha256: string;
    resolvedPlanSha256: string;
    effectiveOptions: {perSourcePage: IScanCleanupStampEffectiveOptionsRecord[];};
    outputMappings: IScanCleanupOutputMapping[];
    pagePlanDigests: IScanCleanupStampPagePlanDigest[];
}

export interface IScanCleanupProvenanceStampV1 extends IScanCleanupProvenanceStampBase {
    schemaVersion: typeof SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1;
    buildIds: IScanCleanupStampBuildIdsV1;
}

export interface IScanCleanupProvenanceStampV2 extends IScanCleanupProvenanceStampBase {
    schemaVersion: typeof SCAN_CLEANUP_STAMP_SCHEMA_VERSION;
    buildIds: IScanCleanupStampBuildIds;
}

export type TScanCleanupProvenanceStamp = IScanCleanupProvenanceStampV1 | IScanCleanupProvenanceStampV2;
export type IScanCleanupProvenanceStamp = TScanCleanupProvenanceStamp;

export interface IBuildScanCleanupProvenanceStampInput {
    sourceSha256: string;
    effectiveOptions: readonly IScanCleanupStampEffectiveOptionsRecord[];
    outputMappings: readonly IScanCleanupOutputMapping[];
    pagePlanDigests: readonly IScanCleanupStampPagePlanDigest[];
    buildIds: TScanCleanupStampBuildIds;
}

export interface IScanCleanupStampVerification {
    status: 'valid' | 'unstamped' | 'invalid';
    reason?: string;
    payload?: TScanCleanupProvenanceStamp;
}

export interface IVerifyScanCleanupProvenanceStampOptions {
    expectedSourceSha256?: string;
    expectedCoreBuildId?: string;
    expectedAssemblerBackend?: TScanCleanupAssemblerBackend;
    expectedNativeBinarySha256s?: Record<string, string>;
}

export function canonicalScanCleanupJson(value: unknown): string {
    return JSON.stringify(sortJsonValue(value));
}

function sha256ScanCleanupJson(value: unknown): string {
    return sha256Utf8(canonicalScanCleanupJson(value));
}

export async function sha256ScanCleanupFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
            throw new Error(`Scan cleanup source stream produced an unsupported chunk: ${path}`);
        }
        hash.update(chunk);
    }
    return hash.digest('hex');
}

export function materializeScanCleanupStampOptions({
    nativeOptions,
    options,
    qualityPath,
}: {
    nativeOptions: Partial<IEffectiveNativeScanCleanupOptionsV3>;
    options: IScanCleanupOptions;
    qualityPath: TScanCleanupQualityPath;
}): IScanCleanupStampEffectiveOptions {
    const outputMode = nativeOptions.outputMode ?? 'auto';
    const despeckleLevel = nativeOptions.despeckleLevel
        ?? (nativeOptions.despeckle === false ? 'off' : 'normal');
    return {
        qualityPath,
        preserveOriginalQuality: options.preserveOriginalQuality,
        layoutMode: options.layoutMode,
        readingOrder: options.readingOrder,
        dpi: requiredNumber(nativeOptions.dpi, 'dpi'),
        sourceDpi: requiredNumber(nativeOptions.sourceDpi ?? nativeOptions.dpi, 'sourceDpi'),
        sourceHasBilevelLayer: nativeOptions.sourceHasBilevelLayer === true,
        sourceBackgroundDpi: nativeOptions.sourceBackgroundDpi ?? null,
        requestedRenderDpi: requiredNumber(
            nativeOptions.requestedRenderDpi ?? nativeOptions.dpi,
            'requestedRenderDpi',
        ),
        renderCrop: nativeOptions.renderCrop ?? null,
        binarization: nativeOptions.binarization ?? 'auto',
        thickness: nativeOptions.thickness ?? 0,
        normalizeIllumination: nativeOptions.normalizeIllumination ?? (qualityPath === 'raster'),
        despeckle: despeckleLevel !== 'off',
        despeckleLevel,
        outputMode,
        preferSoftAlphaForeground: nativeOptions.preferSoftAlphaForeground ?? null,
        resolvedTextToneDiagnostics: nativeOptions.resolvedTextToneDiagnostics ?? null,
        ocrMode: nativeOptions.ocrMode ?? false,
        layout: nativeOptions.layout ?? 'auto',
        manualSplit: nativeOptions.manualSplit ?? null,
        automaticSplit: nativeOptions.automaticSplit ?? null,
        manualSkewDegrees: nativeOptions.manualSkewDegrees ?? null,
        manualContentBoxes: nativeOptions.manualContentBoxes ?? {},
        automaticSkewDegrees: nativeOptions.automaticSkewDegrees ?? {},
        automaticContentBoxes: nativeOptions.automaticContentBoxes ?? {},
        ...(nativeOptions.placementAnchors === undefined
        || Object.keys(nativeOptions.placementAnchors).length === 0
            ? {}
            : {placementAnchors: nativeOptions.placementAnchors}),
        manualZones: nativeOptions.manualZones ?? {
            picture: [],
            fill: [],
        },
        cropContent: nativeOptions.cropContent ?? options.crop,
        matchPageSize: nativeOptions.matchPageSize ?? options.matchPageSize,
        pageAlignment: nativeOptions.pageAlignment ?? options.pageAlignment,
        placementOverrides: nativeOptions.placementOverrides ?? {},
        margins: nativeOptions.margins ?? {...options.marginsMm},
        experimental: {
            autoDewarp: nativeOptions.experimental?.autoDewarp ?? false,
            autoDewarpDepth: nativeOptions.experimental?.autoDewarpDepth ?? null,
        },
        rotationDegrees: nativeOptions.rotationDegrees ?? 0,
        excluded: nativeOptions.excluded ?? false,
        skipBlankPages: nativeOptions.skipBlankPages ?? false,
        maxPixels: nativeOptions.maxPixels ?? (outputMode === 'bw' || outputMode === 'auto'
            ? 160_000_000
            : 80_000_000),
        maxDimensionPx: nativeOptions.maxDimensionPx ?? 40_000,
    };
}

export function buildScanCleanupProvenanceStamp({
    sourceSha256,
    effectiveOptions,
    outputMappings,
    pagePlanDigests,
    buildIds,
}: IBuildScanCleanupProvenanceStampInput): TScanCleanupProvenanceStamp {
    const normalizedEffectiveOptions = [...effectiveOptions].sort(compareSourcePage);
    const normalizedPagePlanDigests = [...pagePlanDigests].sort(compareSourcePage);
    const normalizedMappings = [...outputMappings]
        .map(mapping => ({...mapping}))
        .sort(compareOutputMapping);
    const gitSha = readBuildIdsGitSha(buildIds);
    const resolvedPlanSha256 = sha256ScanCleanupJson({
        sourceSha256,
        effectiveOptions: {perSourcePage: normalizedEffectiveOptions},
        outputMappings: normalizedMappings,
        pagePlanDigests: normalizedPagePlanDigests,
        buildIds: buildResolvedPlanBuildIds(buildIds),
    });
    const commonPayload = {
        sourceSha256,
        resolvedPlanSha256,
        effectiveOptions: {perSourcePage: normalizedEffectiveOptions},
        outputMappings: normalizedMappings,
        pagePlanDigests: normalizedPagePlanDigests,
    };
    let payload: TScanCleanupProvenanceStamp;
    if (gitSha === null) {
        payload = {
            schemaVersion: SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1,
            ...commonPayload,
            buildIds: buildV1BuildIds(buildIds),
        };
    } else {
        payload = {
            schemaVersion: SCAN_CLEANUP_STAMP_SCHEMA_VERSION,
            ...commonPayload,
            buildIds: buildV2BuildIds(buildIds, gitSha),
        };
    }
    assertScanCleanupProvenanceStamp(payload);
    return payload;
}

export function encodeScanCleanupProvenanceStampHex(
    payload: TScanCleanupProvenanceStamp,
): string {
    assertScanCleanupProvenanceStamp(payload);
    return Buffer.from(canonicalScanCleanupJson(payload), 'utf8').toString('hex');
}

export function decodeScanCleanupProvenanceStampHex(hex: string): TScanCleanupProvenanceStamp {
    if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) {
        throw new Error('provenance stamp must be lowercase hexadecimal');
    }
    const bytes = Buffer.from(hex, 'hex');
    const json = bytes.toString('utf8');
    if (Buffer.from(json, 'utf8').compare(bytes) !== 0) {
        throw new Error('provenance stamp is not valid UTF-8');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error('provenance stamp is not valid JSON');
    }
    if (canonicalScanCleanupJson(parsed) !== json) {
        throw new Error('provenance stamp JSON is not canonical sorted-key JSON');
    }
    assertScanCleanupProvenanceStamp(parsed);
    return parsed;
}

export function readScanCleanupStampGitSha(stamp: TScanCleanupProvenanceStamp): string | null {
    if (stamp.schemaVersion === SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1) {
        return null;
    }
    return stamp.buildIds.gitSha;
}

export function verifyScanCleanupProvenanceStampHex(
    hex: string | null | undefined,
    options: IVerifyScanCleanupProvenanceStampOptions = {},
): IScanCleanupStampVerification {
    if (hex === undefined || hex === null || hex === '') {
        return {
            status: 'unstamped',
            reason: 'missing provenance stamp',
        };
    }
    try {
        const payload = decodeScanCleanupProvenanceStampHex(hex);
        if (options.expectedSourceSha256 !== undefined && payload.sourceSha256 !== options.expectedSourceSha256) {
            throw new Error('source hash does not match the provenance stamp');
        }
        if (
            options.expectedCoreBuildId !== undefined
            && payload.buildIds.coreBuildId !== options.expectedCoreBuildId
        ) {
            throw new Error('core build ID does not match the provenance stamp');
        }
        if (
            options.expectedAssemblerBackend !== undefined
            && payload.buildIds.assemblerBackend !== options.expectedAssemblerBackend
        ) {
            throw new Error('assembler backend does not match the provenance stamp');
        }
        for (const [
            role,
            expected,
        ] of Object.entries(options.expectedNativeBinarySha256s ?? {})) {
            if (payload.buildIds.nativeBinarySha256s[role] !== expected) {
                throw new Error(`native binary hash does not match for ${role}`);
            }
        }
        return {
            status: 'valid',
            payload,
        };
    } catch (error) {
        return {
            status: 'invalid',
            reason: getErrorMessage(error),
        };
    }
}

export function assertScanCleanupProvenanceStamp(value: unknown): asserts value is TScanCleanupProvenanceStamp {
    if (!isRecord(value)) fail('stamp must be an object');
    assertExactKeys(value, [
        'schemaVersion',
        'sourceSha256',
        'resolvedPlanSha256',
        'effectiveOptions',
        'outputMappings',
        'pagePlanDigests',
        'buildIds',
    ]);
    if (
        value.schemaVersion !== SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1
        && value.schemaVersion !== SCAN_CLEANUP_STAMP_SCHEMA_VERSION
    ) {
        fail(`stamp schema version mismatch: expected v1 or v2, received ${String(value.schemaVersion)}`);
    }
    assertSha256(value.sourceSha256, 'sourceSha256');
    assertSha256(value.resolvedPlanSha256, 'resolvedPlanSha256');
    if (!isRecord(value.effectiveOptions)) fail('effectiveOptions must be an object');
    assertExactKeys(value.effectiveOptions, ['perSourcePage']);
    if (!isUnknownArray(value.effectiveOptions.perSourcePage) || value.effectiveOptions.perSourcePage.length === 0) {
        fail('effectiveOptions.perSourcePage must be non-empty');
    }
    const effectiveRecords = value.effectiveOptions.perSourcePage;
    const inputBudget = createScanCleanupInputBudget();
    const optionsBySource = new Map<number, IScanCleanupStampEffectiveOptions>();
    const sourcePages = effectiveRecords.map((record, index) => {
        if (!isRecord(record)) fail(`effectiveOptions.perSourcePage[${String(index)}] must be an object`);
        assertExactKeys(record, [
            'sourcePage',
            'options',
        ]);
        assertPositiveInteger(record.sourcePage, `effectiveOptions.perSourcePage[${String(index)}].sourcePage`);
        assertStampEffectiveOptions(record.options, inputBudget);
        optionsBySource.set(record.sourcePage as number, record.options);
        return record.sourcePage as number;
    });
    assertStrictlyIncreasing(sourcePages, 'effectiveOptions.perSourcePage');
    if (
        !Array.isArray(value.outputMappings)
        || value.outputMappings.length === 0
    ) fail('outputMappings must be a bounded non-empty array');
    const outputMappings = value.outputMappings.map((mapping, index) => {
        assertOutputMapping(mapping, `outputMappings[${String(index)}]`);
        if (mapping.outputOrdinal !== null && (mapping.excluded || mapping.blank)) {
            fail('produced output mapping cannot be excluded or blank');
        }
        return mapping;
    });
    if (
        !isUnknownArray(value.pagePlanDigests)
    ) fail('pagePlanDigests must be a bounded array');
    const digestRecords = value.pagePlanDigests;
    const digestPages = digestRecords.map((digest, index) => {
        if (!isRecord(digest)) fail(`pagePlanDigests[${String(index)}] must be an object`);
        assertExactKeys(digest, [
            'sourcePage',
            'planSha256',
            'evidenceSha256',
        ]);
        assertPositiveInteger(digest.sourcePage, `pagePlanDigests[${String(index)}].sourcePage`);
        assertSha256(digest.planSha256, `pagePlanDigests[${String(index)}].planSha256`);
        assertSha256(digest.evidenceSha256, `pagePlanDigests[${String(index)}].evidenceSha256`);
        return digest.sourcePage as number;
    });
    assertStrictlyIncreasing(digestPages, 'pagePlanDigests');
    if (!isRecord(value.buildIds)) fail('buildIds must be an object');
    assertBuildIds(value.buildIds, value.schemaVersion);
    const mappingPages = [...new Set(outputMappings.map(mapping => mapping.sourcePage))].sort((a, b) => a - b);
    if (JSON.stringify(mappingPages) !== JSON.stringify(sourcePages)) {
        fail('outputMappings do not cover every effective source page exactly');
    }
    const mappingsBySource = new Map<number, IScanCleanupOutputMapping[]>();
    for (const mapping of outputMappings) {
        const records = mappingsBySource.get(mapping.sourcePage) ?? [];
        records.push(mapping);
        mappingsBySource.set(mapping.sourcePage, records);
    }
    for (const sourcePage of sourcePages) {
        const records = mappingsBySource.get(sourcePage)!;
        const emptyRecords = records.filter(record => record.outputOrdinal === null);
        if (emptyRecords.length > 0 && (records.length !== 1 || !emptyRecords[0]!.excluded && !emptyRecords[0]!.blank)) {
            fail('empty output mapping must be the only mapping for its source page');
        }
    }
    if (JSON.stringify(digestPages) !== JSON.stringify(sourcePages)) {
        fail('pagePlanDigests do not cover every effective source page exactly');
    }
    for (const digest of digestRecords) {
        if (!isRecord(digest)) fail('pagePlanDigests must contain objects');
        assertSha256(digest.planSha256, 'pagePlanDigests.planSha256');
        const options = optionsBySource.get(digest.sourcePage as number);
        if (options === undefined || sha256ScanCleanupJson(options) !== digest.planSha256) {
            fail('pagePlanDigests do not match effective options');
        }
    }
    const ordinalMappings = outputMappings.filter(mapping => mapping.outputOrdinal !== null);
    ordinalMappings.forEach((mapping, index) => {
        if (mapping.outputOrdinal !== index + 1) {
            fail('outputMappings contain duplicate or out-of-order output ordinals');
        }
    });
    for (const mapping of outputMappings.filter(item => item.outputOrdinal === null)) {
        if (!mapping.excluded && !mapping.blank) fail('empty output mapping must be excluded or blank');
    }
    const recomputedPlan = sha256ScanCleanupJson({
        sourceSha256: value.sourceSha256,
        effectiveOptions: value.effectiveOptions,
        outputMappings,
        pagePlanDigests: value.pagePlanDigests,
        buildIds: buildResolvedPlanBuildIds(value.buildIds),
    });
    if (recomputedPlan !== value.resolvedPlanSha256) fail('resolved plan digest does not match the stamp payload');
}

function readBuildIdsGitSha(buildIds: TScanCleanupStampBuildIds): string | null {
    if (!('gitSha' in buildIds) || typeof buildIds.gitSha !== 'string') {
        return null;
    }
    return buildIds.gitSha;
}

function buildV1BuildIds(buildIds: TScanCleanupStampBuildIds): IScanCleanupStampBuildIdsV1 {
    return {
        coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
        coreBuildId: buildIds.coreBuildId,
        nativeBinarySha256s: {...buildIds.nativeBinarySha256s},
        assemblerBackend: buildIds.assemblerBackend,
        transportMode: buildIds.transportMode,
    };
}

function buildV2BuildIds(
    buildIds: TScanCleanupStampBuildIds,
    gitSha: string,
): IScanCleanupStampBuildIds {
    return {
        coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
        coreBuildId: buildIds.coreBuildId,
        nativeBinarySha256s: {...buildIds.nativeBinarySha256s},
        assemblerBackend: buildIds.assemblerBackend,
        transportMode: buildIds.transportMode,
        gitSha,
    };
}

function buildResolvedPlanBuildIds(
    buildIds: TScanCleanupStampBuildIds,
): IScanCleanupStampBuildIdsV1 {
    return buildV1BuildIds(buildIds);
}

export function buildScanCleanupPagePlanDigest(
    sourcePage: number,
    effectiveOptions: IScanCleanupStampEffectiveOptions,
    evidence: unknown,
): IScanCleanupStampPagePlanDigest {
    return {
        sourcePage,
        planSha256: sha256ScanCleanupJson(effectiveOptions),
        evidenceSha256: sha256ScanCleanupJson(evidence),
    };
}

function compareSourcePage(left: {sourcePage: number}, right: {sourcePage: number}) {
    return left.sourcePage - right.sourcePage;
}

function compareOutputMapping(left: IScanCleanupOutputMapping, right: IScanCleanupOutputMapping) {
    if (left.outputOrdinal === null && right.outputOrdinal !== null) {
        return 1;
    }
    if (left.outputOrdinal !== null && right.outputOrdinal === null) {
        return -1;
    }
    if (left.outputOrdinal !== null && right.outputOrdinal !== null) {
        return left.outputOrdinal - right.outputOrdinal;
    }
    if (left.sourcePage !== right.sourcePage) {
        return left.sourcePage - right.sourcePage;
    }
    return left.half.localeCompare(right.half);
}

function requiredNumber(value: number | undefined, name: string) {
    if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`Missing finite positive ${name}`);
    return value;
}

function sha256Utf8(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJsonValue);
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.keys(value).sort().map(key => [
            key,
            sortJsonValue(value[key]),
        ]));
    }
    if (value === undefined) throw new Error('Cannot canonicalize undefined');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
    if (!hasExactKeys(value, keys)) {
        fail('stamp contains an unsupported or missing field');
    }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
    const expected = new Set(keys);
    const actual = Object.keys(value);
    return actual.length === expected.size && actual.every(key => expected.has(key));
}

function assertPositiveInteger(value: unknown, label: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer`);
}

function assertSha256(value: unknown, label: string) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) fail(`${label} must be lowercase SHA-256 hex`);
}

function assertStrictlyIncreasing(values: readonly number[], label: string) {
    for (let index = 1; index < values.length; index += 1) {
        if (values[index]! <= values[index - 1]!) fail(`${label} must be ordered without duplicates`);
    }
}

function assertOutputMapping(value: unknown, label: string): asserts value is IScanCleanupOutputMapping {
    if (!isRecord(value)) fail(`${label} must be an object`);
    assertExactKeys(value, [
        'sourcePage',
        'half',
        'outputOrdinal',
        'rotationDegrees',
        'excluded',
        'blank',
    ]);
    assertPositiveInteger(value.sourcePage, `${label}.sourcePage`);
    if (value.half !== 'full' && value.half !== 'left' && value.half !== 'right') fail(`${label}.half is invalid`);
    if (value.outputOrdinal !== null) assertPositiveInteger(value.outputOrdinal, `${label}.outputOrdinal`);
    if (![
        0,
        90,
        180,
        270,
    ].includes(value.rotationDegrees as number)) fail(`${label}.rotationDegrees is invalid`);
    if (typeof value.excluded !== 'boolean' || typeof value.blank !== 'boolean') fail(`${label} flags are invalid`);
}

function assertStampEffectiveOptions(
    value: unknown,
    inputBudget: IScanCleanupInputBudget,
): asserts value is IScanCleanupStampEffectiveOptions {
    if (!isRecord(value)) fail('effective page options must be an object');
    const keys = [
        'qualityPath',
        'preserveOriginalQuality',
        'layoutMode',
        'readingOrder',
        'dpi',
        'sourceDpi',
        'sourceHasBilevelLayer',
        'sourceBackgroundDpi',
        'requestedRenderDpi',
        'renderCrop',
        'binarization',
        'thickness',
        'normalizeIllumination',
        'despeckle',
        'despeckleLevel',
        'outputMode',
        'preferSoftAlphaForeground',
        'resolvedTextToneDiagnostics',
        'ocrMode',
        'layout',
        'manualSplit',
        'automaticSplit',
        'manualSkewDegrees',
        'manualContentBoxes',
        'automaticSkewDegrees',
        'automaticContentBoxes',
        'manualZones',
        'cropContent',
        'matchPageSize',
        'pageAlignment',
        'placementOverrides',
        'margins',
        'experimental',
        'rotationDegrees',
        'excluded',
        'skipBlankPages',
        'maxPixels',
        'maxDimensionPx',
    ];
    // `placementAnchors` is written only by a run that resolved `ink` anchors,
    // so requiring it would reject every stamp written before that choice
    // existed.
    assertExactKeys(value, 'placementAnchors' in value ? [
        ...keys,
        'placementAnchors',
    ] : keys);
    for (const key of [
        'dpi',
        'sourceDpi',
        'requestedRenderDpi',
    ]) {
        if (!positiveNumber(value[key])) fail(`${key} is invalid`);
    }
    for (const key of [
        'maxPixels',
        'maxDimensionPx',
    ]) {
        if (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0) fail(`${key} is invalid`);
    }
    for (const key of [
        'preserveOriginalQuality',
        'sourceHasBilevelLayer',
        'normalizeIllumination',
        'despeckle',
        'ocrMode',
        'cropContent',
        'matchPageSize',
        'excluded',
        'skipBlankPages',
    ]) {
        if (typeof value[key] !== 'boolean') fail(`${key} is invalid`);
    }
    if (![
        'raster',
        'lossless',
    ].includes(value.qualityPath as string)) fail('qualityPath is invalid');
    if (![
        'auto',
        'force-single',
        'force-two-page',
    ].includes(value.layoutMode as string)) fail('layoutMode is invalid');
    if (![
        'ltr',
        'rtl',
    ].includes(value.readingOrder as string)) fail('readingOrder is invalid');
    if (![
        'auto',
        'otsu',
        'sauvola',
        'wolf',
    ].includes(value.binarization as string)) fail('binarization is invalid');
    if (![
        'off',
        'cautious',
        'normal',
        'aggressive',
    ].includes(value.despeckleLevel as string)) fail('despeckleLevel is invalid');
    if (![
        'auto',
        'bw',
        'mixed',
        'grayscale',
        'color',
    ].includes(value.outputMode as string)) fail('outputMode is invalid');
    if (value.despeckle !== (value.despeckleLevel !== 'off')) fail('despeckle does not match despeckleLevel');
    if (typeof value.thickness !== 'number' || !Number.isFinite(value.thickness)) fail('thickness is invalid');
    if (![
        0,
        90,
        180,
        270,
    ].includes(value.rotationDegrees as number)) fail('rotationDegrees is invalid');
    if (value.sourceBackgroundDpi !== null && !positiveNumber(value.sourceBackgroundDpi)) fail('sourceBackgroundDpi is invalid');
    if (value.preferSoftAlphaForeground !== null && typeof value.preferSoftAlphaForeground !== 'boolean') fail('preferSoftAlphaForeground is invalid');
    if (value.layout !== 'auto' && value.layout !== 'force-single' && value.layout !== 'page-with-offcut'
        && value.layout !== 'keep-left' && value.layout !== 'keep-right' && value.layout !== 'force-two-page') {
        fail('layout is invalid');
    }
    if (!(SCAN_CLEANUP_ALIGNMENTS as readonly string[]).includes(value.pageAlignment as string)) {
        fail('pageAlignment is invalid');
    }
    if (value.renderCrop !== null) assertNormalizedRect(value.renderCrop, 'renderCrop');
    if (value.manualSplit !== null) assertNormalizedSplit(value.manualSplit, 'manualSplit');
    if (value.automaticSplit !== null) assertNormalizedSplit(value.automaticSplit, 'automaticSplit');
    if (value.manualSkewDegrees !== null && !boundedNumber(value.manualSkewDegrees, -15, 15)) fail('manualSkewDegrees is invalid');
    assertNormalizedRectMap(value.manualContentBoxes, 'manualContentBoxes');
    assertNumberMap(value.automaticSkewDegrees, 'automaticSkewDegrees');
    assertNormalizedRectMap(value.automaticContentBoxes, 'automaticContentBoxes');
    if ('placementAnchors' in value) {
        assertPlacementAnchorMap(value.placementAnchors, 'placementAnchors');
    }
    assertTextToneDiagnostics(value.resolvedTextToneDiagnostics);
    assertManualZones(value.manualZones, inputBudget);
    assertMargins(value.margins);
    assertPlacementOverrides(value.placementOverrides);
    if (!isRecord(value.experimental) || Object.keys(value.experimental).some(key => ![
        'autoDewarp',
        'autoDewarpDepth',
    ].includes(key))
        || typeof value.experimental.autoDewarp !== 'boolean') fail('experimental is invalid');
    if (value.experimental.autoDewarpDepth !== null && !positiveNumber(value.experimental.autoDewarpDepth)) fail('experimental.autoDewarpDepth is invalid');
}

function assertBuildIds(
    value: Record<string, unknown>,
    schemaVersion:
        | typeof SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1
        | typeof SCAN_CLEANUP_STAMP_SCHEMA_VERSION,
): asserts value is TScanCleanupStampBuildIds {
    const legacyKeys = [
        'coreSchemaId',
        'coreBuildId',
        'nativeBinarySha256s',
        'assemblerBackend',
        'transportMode',
    ];
    if (schemaVersion === SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1) {
        if (!hasExactKeys(value, legacyKeys)) {
            fail('stamp schema version mismatch: v1 buildIds must use the legacy exact key set');
        }
    } else if (!hasExactKeys(value, [
        ...legacyKeys,
        'gitSha',
    ])) {
        fail('stamp schema v2 buildIds must carry gitSha alongside the legacy key set');
    }
    const expectedSchemaId = schemaVersion === SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1
        ? SCAN_CLEANUP_STAMP_SCHEMA_ID_V1
        : SCAN_CLEANUP_STAMP_SCHEMA_ID;
    if (value.coreSchemaId !== expectedSchemaId) {
        fail(`stamp schema version mismatch: schemaVersion v${String(schemaVersion)} requires coreSchemaId ${expectedSchemaId}`);
    }
    for (const key of [
        'coreSchemaId',
        'coreBuildId',
    ]) {
        if (typeof value[key] !== 'string' || value[key].length === 0 || /[/\\]|timestamp|username|basename/iu.test(value[key])) fail(`${key} is invalid`);
    }
    if (!isRecord(value.nativeBinarySha256s) || Object.keys(value.nativeBinarySha256s).length === 0) fail('nativeBinarySha256s is invalid');
    for (const [
        role,
        hash,
    ] of Object.entries(value.nativeBinarySha256s)) {
        if (/path|timestamp|username|basename/iu.test(role)) fail('native binary role is invalid');
        assertSha256(hash, `nativeBinarySha256s.${role}`);
    }
    if (![
        'native-pdf-image-combine',
        'native-pdf-page-ops',
        'cli-wasm-pdf-image-combine',
        'cli-fallback-img2pdf-qpdf',
        'cli-fallback-wasm-or-img2pdf-qpdf',
        'cli-fallback-qpdf-page-ops',
        'source-preserved',
    ].includes(value.assemblerBackend as string)) fail('assemblerBackend is invalid');
    if (![
        'fifo-ppm',
        'file-ppm',
        'file-png',
        'source-preserved',
    ].includes(value.transportMode as string)) fail('transportMode is invalid');
    if (
        schemaVersion === SCAN_CLEANUP_STAMP_SCHEMA_VERSION
        && 'gitSha' in value
        && (typeof value.gitSha !== 'string' || !SCAN_CLEANUP_GIT_SHA_HEX_PATTERN.test(value.gitSha))
    ) {
        fail('stamp schema v2 buildIds.gitSha must be lowercase 40- or 64-character hex');
    }
}

function positiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function assertNormalizedRect(value: unknown, label: string): asserts value is TNormalizedRect {
    if (!isRecord(value)) fail(`${label} is invalid`);
    assertExactKeys(value, [
        'xNormalized',
        'yNormalized',
        'widthNormalized',
        'heightNormalized',
        'rotationDegrees',
    ]);
    if (!boundedNumber(value.xNormalized, 0, 1) || !boundedNumber(value.yNormalized, 0, 1)
        || !boundedNumber(value.widthNormalized, 0, 1) || !boundedNumber(value.heightNormalized, 0, 1)
        || (value.widthNormalized) <= 0 || (value.heightNormalized) <= 0
        || (value.xNormalized) + (value.widthNormalized) > 1 + Number.EPSILON * 8
        || (value.yNormalized) + (value.heightNormalized) > 1 + Number.EPSILON * 8
        || ![
            0,
            90,
            180,
            270,
        ].includes(value.rotationDegrees as number)) {
        fail(`${label} is invalid`);
    }
}

function assertNormalizedSplit(value: unknown, label: string): asserts value is TNormalizedSplit {
    if (!isRecord(value)) fail(`${label} is invalid`);
    assertExactKeys(value, [
        'rotationDegrees',
        'xNormalized',
    ]);
    if (![
        0,
        90,
        180,
        270,
    ].includes(value.rotationDegrees as number)
        || !boundedNumber(value.xNormalized, 0, 1)
        || (value.xNormalized) <= 0
        || (value.xNormalized) >= 1) {
        fail(`${label} is invalid`);
    }
}

function assertNormalizedRectMap(value: unknown, label: string) {
    if (!isRecord(value)) fail(`${label} is invalid`);
    for (const [
        half,
        rect,
    ] of Object.entries(value)) {
        if (![
            'full',
            'left',
            'right',
        ].includes(half)) fail(`${label} contains an invalid half`);
        assertNormalizedRect(rect, `${label}.${half}`);
    }
}

function assertPlacementAnchorMap(value: unknown, label: string) {
    if (!isRecord(value)) fail(`${label} is invalid`);
    for (const [
        half,
        anchor,
    ] of Object.entries(value)) {
        if (![
            'full',
            'left',
            'right',
        ].includes(half)) fail(`${label} contains an invalid half`);
        if (!isRecord(anchor)
            || !boundedNumberOrZero(anchor.yNormalized)
            || Object.keys(anchor).some(key => key !== 'yNormalized')) {
            fail(`${label}.${half} is invalid`);
        }
    }
}

function assertNumberMap(value: unknown, label: string) {
    if (!isRecord(value)) fail(`${label} is invalid`);
    for (const [
        half,
        skew,
    ] of Object.entries(value)) {
        if (![
            'full',
            'left',
            'right',
        ].includes(half) || typeof skew !== 'number' || !Number.isFinite(skew)) {
            fail(`${label} is invalid`);
        }
    }
}

function assertTextToneDiagnostics(value: unknown) {
    if (value === null) {
        return;
    }
    if (!isRecord(value)) fail('resolvedTextToneDiagnostics is invalid');
    for (const [
        half,
        diagnostics,
    ] of Object.entries(value)) {
        if (![
            'full',
            'left',
            'right',
        ].includes(half) || !isRecord(diagnostics)) fail('resolvedTextToneDiagnostics is invalid');
        assertExactKeys(diagnostics, [
            'applied',
            'rule',
            'textLineCount',
            'textInkPixels',
            'pictureFraction',
            'outsideMidtoneFraction',
            'outsideMidtoneLargestComponentFraction',
            'outsideMidtoneLargestComponentWidthFraction',
            'outsideMidtoneLargestComponentHeightFraction',
            'inkAnchor',
            'blackPoint',
            'slope',
        ]);
        const inkAnchorIsValid = diagnostics.inkAnchor === null
            || Number.isSafeInteger(diagnostics.inkAnchor)
                && Number(diagnostics.inkAnchor) >= 0
                && Number(diagnostics.inkAnchor) <= 255;
        const blackPointIsValid = diagnostics.blackPoint === null
            || typeof diagnostics.blackPoint === 'number'
                && Number.isFinite(diagnostics.blackPoint)
                && diagnostics.blackPoint >= 0;
        const slopeIsValid = diagnostics.slope === null
            || typeof diagnostics.slope === 'number'
                && Number.isFinite(diagnostics.slope)
                && diagnostics.slope > 0;
        if (typeof diagnostics.applied !== 'boolean'
            || ![
                'applied',
                'picture-evidence',
                'insufficient-text',
                'tonal-mass-outside-text',
                'already-dark',
            ].includes(diagnostics.rule as string)
            || !Number.isSafeInteger(diagnostics.textLineCount) || (diagnostics.textLineCount as number) < 0
            || !Number.isSafeInteger(diagnostics.textInkPixels) || (diagnostics.textInkPixels as number) < 0
            || !boundedNumberOrZero(diagnostics.pictureFraction) || !boundedNumberOrZero(diagnostics.outsideMidtoneFraction)
            || !boundedNumberOrZero(diagnostics.outsideMidtoneLargestComponentFraction)
            || !boundedNumberOrZero(diagnostics.outsideMidtoneLargestComponentWidthFraction)
            || !boundedNumberOrZero(diagnostics.outsideMidtoneLargestComponentHeightFraction)
            || !inkAnchorIsValid
            || !blackPointIsValid
            || !slopeIsValid
            || diagnostics.applied !== (diagnostics.rule === 'applied')
            || diagnostics.applied !== (diagnostics.blackPoint !== null && diagnostics.slope !== null)) {
            fail('resolvedTextToneDiagnostics is invalid');
        }
    }
}

function assertManualZones(value: unknown, inputBudget: IScanCleanupInputBudget) {
    if (!isRecord(value) || Object.keys(value).some(key => ![
        'picture',
        'fill',
    ].includes(key))
        || !Array.isArray(value.picture) || !Array.isArray(value.fill)) fail('manualZones is invalid');
    const zoneCount = value.picture.length + value.fill.length;
    if (zoneCount > SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE) {
        fail('manualZones exceeds the per-page zone limit');
    }
    consumeScanCleanupZones(inputBudget, zoneCount, 'provenance manual zones');
    value.picture.forEach((zone, index) => {
        if (!isRecord(zone)) fail(`manualZones.picture[${String(index)}] is invalid`);
        assertExactKeys(zone, [
            'polygon',
            'layer',
        ]);
        if (![
            'eraser1',
            'painter2',
            'eraser3',
        ].includes(zone.layer as string)) fail('manualZones picture layer is invalid');
        assertNormalizedPolygon(
            zone.polygon,
            `manualZones.picture[${String(index)}].polygon`,
            inputBudget,
        );
    });
    value.fill.forEach((polygon, index) => assertNormalizedPolygon(
        polygon,
        `manualZones.fill[${String(index)}]`,
        inputBudget,
    ));
}

function assertNormalizedPolygon(
    value: unknown,
    label: string,
    inputBudget: IScanCleanupInputBudget,
) {
    if (!isRecord(value)) fail(`${label} is invalid`);
    assertExactKeys(value, [
        'points',
        'rotationDegrees',
    ]);
    if (
        !Array.isArray(value.points)
        || value.points.length < 3
        || value.points.length > SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON
        || ![
            0,
            90,
            180,
            270,
        ].includes(value.rotationDegrees as number)) {
        fail(`${label} is invalid`);
    }
    consumeScanCleanupVertices(inputBudget, value.points.length, 'provenance manual-zone vertices');
    value.points.forEach((point, index) => {
        if (!isRecord(point)) fail(`${label}.points[${String(index)}] is invalid`);
        assertExactKeys(point, [
            'xNormalized',
            'yNormalized',
        ]);
        if (!boundedNumber(point.xNormalized, 0, 1) || !boundedNumber(point.yNormalized, 0, 1)) fail(`${label}.points is invalid`);
    });
    assertSimpleScanCleanupPolygon(
        value.points as IScanCleanupManualZones['fill'][number]['points'],
        label,
    );
}

function assertMargins(value: unknown) {
    if (!isRecord(value)) fail('margins is invalid');
    assertExactKeys(value, [
        'leftMm',
        'topMm',
        'rightMm',
        'bottomMm',
    ]);
    for (const key of [
        'leftMm',
        'topMm',
        'rightMm',
        'bottomMm',
    ]) {
        if (!boundedNumber(value[key], 0, 25)) fail('margins is invalid');
    }
}

function assertPlacementOverrides(value: unknown) {
    if (!isRecord(value)) fail('placementOverrides is invalid');
    for (const [
        half,
        alignment,
    ] of Object.entries(value)) {
        if (![
            'full',
            'left',
            'right',
        ].includes(half)
            || !(SCAN_CLEANUP_ALIGNMENTS as readonly string[]).includes(alignment as string)) {
            fail('placementOverrides is invalid');
        }
    }
}

function boundedNumberOrZero(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function fail(message: string): never {
    throw new Error(message);
}
