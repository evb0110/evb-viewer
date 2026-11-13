/**
 * The platform-neutral provenance stamp: schema, canonical JSON, digests
 * and hex transport. A stamp is built from options already validated where
 * they entered the process; decoding is where one is validated. Whole-file source hashing is each platform's:
 * sha256ScanCleanupFile on Node, WebCrypto in the browser.
 */
import * as v from 'valibot';
import {sha256Utf8Hex} from '@evb/scan-cleanup/core/sha256Utf8Hex';
import type {
    INativeScanCleanupOptionsV3,
    IScanCleanupManualZones,
    IScanCleanupOptions,
    TScanCleanupLayoutMode,
    TScanCleanupPageAlignment,
    TScanCleanupPageRotation,
    TScanCleanupOutputModeSetting,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
} from '@contracts/scan-cleanup/geometry';
import {SCAN_CLEANUP_OUTPUT_HALVES} from '@contracts/scan-cleanup/domain';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {
    SCAN_CLEANUP_ASSEMBLER_BACKENDS,
    SCAN_CLEANUP_TRANSPORT_MODES,
    type IScanCleanupOutputMapping,
    type TScanCleanupAssemblerBackend,
    type TScanCleanupTransportMode,
} from '@evb/scan-cleanup/core/types';
import {embeddedScanCleanupBuildGitSha} from '@evb/scan-cleanup/core/buildGitSha';
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
    renderCrop: IScanCleanupNormalizedRect | null;
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
    manualSplit: IScanCleanupNormalizedSplit | null;
    automaticSplit: IScanCleanupNormalizedSplit | null;
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

const sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
const sourcePageSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const buildIdsEntries = {
    coreBuildId: v.pipe(v.string(), v.minLength(1)),
    nativeBinarySha256s: v.record(v.string(), sha256Schema),
    assemblerBackend: v.picklist(SCAN_CLEANUP_ASSEMBLER_BACKENDS),
    transportMode: v.picklist(SCAN_CLEANUP_TRANSPORT_MODES),
};
const stampEntries = {
    sourceSha256: sha256Schema,
    resolvedPlanSha256: sha256Schema,
    effectiveOptions: v.strictObject({perSourcePage: v.pipe(v.array(v.strictObject({
        sourcePage: sourcePageSchema,
        // Covered by its page plan digest, which decoding recomputes.
        options: v.custom<IScanCleanupStampEffectiveOptions>(isRecord),
    })), v.minLength(1))}),
    outputMappings: v.pipe(v.array(v.strictObject({
        sourcePage: sourcePageSchema,
        half: v.picklist(SCAN_CLEANUP_OUTPUT_HALVES),
        outputOrdinal: v.nullable(sourcePageSchema),
        rotationDegrees: v.picklist([0, 90, 180, 270] as const),
        excluded: v.boolean(),
        blank: v.boolean(),
    })), v.minLength(1)),
    pagePlanDigests: v.array(v.strictObject({
        sourcePage: sourcePageSchema,
        planSha256: sha256Schema,
        evidenceSha256: sha256Schema,
    })),
};
/**
 * A stamp read back from a document: v1 when the build had no source
 * revision, v2 carrying it. Its digests must match its own content.
 */
const stampShapeSchema = v.variant('schemaVersion', [
    v.strictObject({
        ...stampEntries,
        schemaVersion: v.literal(SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1),
        buildIds: v.strictObject({
            ...buildIdsEntries,
            coreSchemaId: v.literal(SCAN_CLEANUP_STAMP_SCHEMA_ID_V1),
        }),
    }),
    v.strictObject({
        ...stampEntries,
        schemaVersion: v.literal(SCAN_CLEANUP_STAMP_SCHEMA_VERSION),
        buildIds: v.strictObject({
            ...buildIdsEntries,
            coreSchemaId: v.literal(SCAN_CLEANUP_STAMP_SCHEMA_ID),
            gitSha: v.pipe(v.string(), v.regex(SCAN_CLEANUP_GIT_SHA_HEX_PATTERN)),
        }),
    }),
]);

export type TScanCleanupProvenanceStamp = v.InferOutput<typeof stampShapeSchema>;
export type IScanCleanupProvenanceStamp = TScanCleanupProvenanceStamp;
export type TScanCleanupStampBuildIds = TScanCleanupProvenanceStamp['buildIds'];
type IScanCleanupStampBuildIdsV1 = Extract<TScanCleanupStampBuildIds, {coreSchemaId: typeof SCAN_CLEANUP_STAMP_SCHEMA_ID_V1}>;
type IScanCleanupStampBuildIdsV2 = Extract<TScanCleanupStampBuildIds, {coreSchemaId: typeof SCAN_CLEANUP_STAMP_SCHEMA_ID}>;
export type IScanCleanupStampEffectiveOptionsRecord = TScanCleanupProvenanceStamp['effectiveOptions']['perSourcePage'][number];
export type IScanCleanupStampPagePlanDigest = TScanCleanupProvenanceStamp['pagePlanDigests'][number];

const SCAN_CLEANUP_PROVENANCE_STAMP_SCHEMA = v.pipe(stampShapeSchema, v.check(stamp => stamp.pagePlanDigests.every(digest => {
    const record = stamp.effectiveOptions.perSourcePage.find(item => item.sourcePage === digest.sourcePage);
    return record !== undefined && sha256ScanCleanupJson(record.options) === digest.planSha256;
}), 'pagePlanDigests do not match effective options'), v.check(stamp => sha256ScanCleanupJson({
    sourceSha256: stamp.sourceSha256,
    effectiveOptions: stamp.effectiveOptions,
    outputMappings: stamp.outputMappings,
    pagePlanDigests: stamp.pagePlanDigests,
    buildIds: buildResolvedPlanBuildIds(stamp.buildIds),
}) === stamp.resolvedPlanSha256, 'resolved plan digest does not match the stamp payload'));

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
    return sha256Utf8Hex(canonicalScanCleanupJson(value));
}

/** A content digest for a role whose executable identity is a backend name, not a file. */
export function hashScanCleanupBackendMarker(role: string, backend: TScanCleanupAssemblerBackend) {
    return sha256Utf8Hex(`${role}:${backend}`);
}

/**
 * The build identities a run stamps: the shared core, the native engines it
 * actually executed and the embedded source revision when the build has one.
 */
export function composeScanCleanupStampBuildIds({
    nativeBinarySha256s, assemblerBackend, transportMode,
}: {
    nativeBinarySha256s: Readonly<Record<string, string>>;
    assemblerBackend: TScanCleanupAssemblerBackend;
    transportMode: TScanCleanupTransportMode;
}): TScanCleanupStampBuildIds {
    const sha = embeddedScanCleanupBuildGitSha?.trim().toLowerCase() ?? '';
    const gitSha = SCAN_CLEANUP_GIT_SHA_HEX_PATTERN.test(sha) ? sha : null;
    const legacyBuildIds = {
        coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
        nativeBinarySha256s: Object.keys(nativeBinarySha256s).length === 0
            ? {assembler: sha256Utf8Hex(`assembler:${assemblerBackend}`)}
            : {...nativeBinarySha256s},
        assemblerBackend,
        transportMode,
    };
    return gitSha === null
        ? {
            ...legacyBuildIds,
            coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
        }
        : {
            ...legacyBuildIds,
            coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
            gitSha,
        };
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
    return gitSha === null
        ? {
            schemaVersion: SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1,
            ...commonPayload,
            buildIds: buildV1BuildIds(buildIds),
        }
        : {
            schemaVersion: SCAN_CLEANUP_STAMP_SCHEMA_VERSION,
            ...commonPayload,
            buildIds: buildV2BuildIds(buildIds, gitSha),
        };
}

export function encodeScanCleanupProvenanceStampHex(
    payload: TScanCleanupProvenanceStamp,
): string {
    return Array.from(
        new TextEncoder().encode(canonicalScanCleanupJson(payload)),
        byte => byte.toString(16).padStart(2, '0'),
    ).join('');
}

export function decodeScanCleanupProvenanceStampHex(hex: string): TScanCleanupProvenanceStamp {
    if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) {
        throw new Error('provenance stamp must be lowercase hexadecimal');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    let json: string;
    try {
        json = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
        }).decode(bytes);
    } catch {
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
    return v.parse(SCAN_CLEANUP_PROVENANCE_STAMP_SCHEMA, parsed, {abortEarly: true});
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
): IScanCleanupStampBuildIdsV2 {
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
