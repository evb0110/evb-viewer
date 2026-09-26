import type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import * as v from 'valibot';

const AGENT_OCR_PAGE_RANGES = [
    'all',
    'current',
    'custom',
] as const;
const AGENT_OCR_QUALITY_PROFILES = [
    'balanced',
    'accurate',
    'poor-scan',
] as const satisfies readonly TOcrQualityProfile[];
const AGENT_OCR_PREPROCESSING_MODES = [
    'off',
    'clean',
] as const satisfies readonly TOcrPreprocessingMode[];
const AGENT_OCR_SUPERSESSION_POLICIES = [
    'missing-only',
    'replace-evb',
    'replace-all',
] as const satisfies readonly TOcrTextSupersessionPolicy[];
export const AGENT_OCR_PAGE_SEGMENTATION_MODES = [
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    13,
] as const;

export type TOcrPageSegmentationMode = typeof AGENT_OCR_PAGE_SEGMENTATION_MODES[number];

export function isSupportedPageSegmentationMode(value: unknown): value is TOcrPageSegmentationMode {
    return typeof value === 'number'
        && AGENT_OCR_PAGE_SEGMENTATION_MODES.some(mode => mode === value);
}

export type TAgentOcrPageRange = typeof AGENT_OCR_PAGE_RANGES[number];

const agentOcrRunInputProperties = {
    pageRange: v.optional(v.pipe(v.picklist(AGENT_OCR_PAGE_RANGES), v.description('Pages to OCR. Defaults to the OCR popup current setting.'))),
    customRange: v.optional(v.pipe(v.string(), v.description('Custom page range such as 1-3,7. Used when pageRange is custom.'))),
    languages: v.optional(v.pipe(v.array(v.string()), v.description('OCR language codes such as eng, deu, or tur. Select the languages present in the document. Defaults to the OCR popup current settings.'))),
    qualityProfile: v.optional(v.pipe(v.picklist(AGENT_OCR_QUALITY_PROFILES), v.description('OCR quality profile. Defaults to the OCR popup current setting.'))),
    preprocessingMode: v.optional(v.pipe(v.picklist(AGENT_OCR_PREPROCESSING_MODES), v.description('Optional image preprocessing mode before OCR. Defaults to the OCR popup current setting.'))),
    pageSegmentationMode: v.optional(v.pipe(v.picklist(AGENT_OCR_PAGE_SEGMENTATION_MODES), v.integer(), v.description('Optional Tesseract page segmentation mode supported by EVB output OCR.'))),
    supersessionPolicy: v.optional(v.pipe(v.picklist(AGENT_OCR_SUPERSESSION_POLICIES), v.description('Existing text policy. Defaults to the OCR popup current setting.'))),
    replaceAllAcknowledged: v.optional(v.pipe(v.boolean(), v.description('Required and must be true when supersessionPolicy is replace-all.'))),
    open: v.optional(v.pipe(v.boolean(), v.description('Whether to open the OCR popup. Defaults to true.'))),
};
export const AGENT_OCR_RUN_INPUT_SCHEMA = v.union([
    v.strictObject({
        ...agentOcrRunInputProperties,
        supersessionPolicy: v.literal('replace-all'),
        replaceAllAcknowledged: v.literal(true),
    }),
    v.strictObject({
        ...agentOcrRunInputProperties,
        supersessionPolicy: v.optional(v.picklist([
            'missing-only',
            'replace-evb',
        ])),
    }),
]);

const agentOcrRunOptionsSchema = v.fallback(v.object({
    pageRange: v.fallback(v.optional(v.picklist(AGENT_OCR_PAGE_RANGES)), undefined),
    customRange: v.fallback(v.optional(v.string()), undefined),
    languages: v.fallback(v.optional(v.array(v.unknown())), undefined),
    qualityProfile: v.fallback(v.optional(v.picklist(AGENT_OCR_QUALITY_PROFILES)), undefined),
    preprocessingMode: v.fallback(v.optional(v.picklist(AGENT_OCR_PREPROCESSING_MODES)), undefined),
    pageSegmentationMode: v.fallback(v.optional(v.picklist(AGENT_OCR_PAGE_SEGMENTATION_MODES)), undefined),
    supersessionPolicy: v.fallback(v.optional(v.picklist(AGENT_OCR_SUPERSESSION_POLICIES)), undefined),
    replaceAllAcknowledged: v.fallback(v.optional(v.boolean()), undefined),
    open: v.fallback(v.optional(v.boolean()), undefined),
}), {});

export const AGENT_OCR_RUN_OPTIONS_SCHEMA = v.pipe(
    agentOcrRunOptionsSchema,
    v.transform((options) => {
        const customRange = options.customRange?.trim();
        const languages = options.languages?.flatMap((language) => {
            if (typeof language !== 'string') {
                return [];
            }
            const normalized = language.trim();
            return normalized ? [normalized] : [];
        });
        return {
            ...(options.pageRange === undefined ? {} : {pageRange: options.pageRange}),
            ...(customRange ? {customRange} : {}),
            ...(languages === undefined ? {} : {languages: [...new Set(languages)]}),
            ...(options.qualityProfile === undefined ? {} : {qualityProfile: options.qualityProfile}),
            ...(options.preprocessingMode === undefined ? {} : {preprocessingMode: options.preprocessingMode}),
            ...(options.pageSegmentationMode === undefined ? {} : {pageSegmentationMode: options.pageSegmentationMode}),
            ...(options.supersessionPolicy === undefined ? {} : {supersessionPolicy: options.supersessionPolicy}),
            ...(options.replaceAllAcknowledged === undefined ? {} : {replaceAllAcknowledged: options.replaceAllAcknowledged}),
            ...(options.open === undefined ? {} : {open: options.open}),
        };
    }),
);
export type IAgentOcrRunOptions = v.InferOutput<typeof AGENT_OCR_RUN_OPTIONS_SCHEMA>;

export function parseAgentOcrRunOptions(value: unknown): IAgentOcrRunOptions {
    return v.parse(AGENT_OCR_RUN_OPTIONS_SCHEMA, value);
}
