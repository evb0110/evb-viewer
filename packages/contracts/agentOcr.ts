import type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

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

export interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    qualityProfile?: TOcrQualityProfile;
    preprocessingMode?: TOcrPreprocessingMode;
    pageSegmentationMode?: TOcrPageSegmentationMode;
    supersessionPolicy?: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged?: boolean;
    open?: boolean;
}

export const AGENT_OCR_RUN_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        pageRange: {
            type: 'string',
            enum: AGENT_OCR_PAGE_RANGES,
            description: 'Pages to OCR. Defaults to the OCR popup current setting.',
        },
        customRange: {
            type: 'string',
            description: 'Custom page range such as 1-3,7. Used when pageRange is custom.',
        },
        languages: {
            type: 'array',
            items: {type: 'string'},
            description: 'OCR language codes such as eng, deu, or tur. Select the languages present in the document. Defaults to the OCR popup current settings.',
        },
        qualityProfile: {
            type: 'string',
            enum: AGENT_OCR_QUALITY_PROFILES,
            description: 'OCR quality profile. Defaults to the OCR popup current setting.',
        },
        preprocessingMode: {
            type: 'string',
            enum: AGENT_OCR_PREPROCESSING_MODES,
            description: 'Optional image preprocessing mode before OCR. Defaults to the OCR popup current setting.',
        },
        pageSegmentationMode: {
            type: 'integer',
            enum: AGENT_OCR_PAGE_SEGMENTATION_MODES,
            description: 'Optional Tesseract page segmentation mode supported by EVB output OCR.',
        },
        supersessionPolicy: {
            type: 'string',
            enum: AGENT_OCR_SUPERSESSION_POLICIES,
            description: 'Existing text policy. Defaults to the OCR popup current setting.',
        },
        replaceAllAcknowledged: {
            type: 'boolean',
            description: 'Required and must be true when supersessionPolicy is replace-all.',
        },
        open: {
            type: 'boolean',
            description: 'Whether to open the OCR popup. Defaults to true.',
        },
    },
    allOf: [{
        if: {
            properties: {supersessionPolicy: {const: 'replace-all'}},
            required: ['supersessionPolicy'],
        },
        then: {
            properties: {replaceAllAcknowledged: {const: true}},
            required: ['replaceAllAcknowledged'],
        },
    }],
    additionalProperties: false,
};

function normalizeLanguages(value: unknown) {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const languages = value.flatMap((language) => {
        if (typeof language !== 'string') {
            return [];
        }
        const normalized = language.trim();
        return normalized ? [normalized] : [];
    });
    return [...new Set(languages)];
}

export function parseAgentOcrRunOptions(value: unknown): IAgentOcrRunOptions {
    if (!isRecord(value)) {
        return {};
    }

    const customRange = typeof value.customRange === 'string' && value.customRange.trim()
        ? value.customRange.trim()
        : undefined;
    const languages = normalizeLanguages(value.languages);
    return {
        ...(isOneOf(AGENT_OCR_PAGE_RANGES, value.pageRange) ? {pageRange: value.pageRange} : {}),
        ...(customRange === undefined ? {} : {customRange}),
        ...(languages === undefined ? {} : {languages}),
        ...(isOneOf(AGENT_OCR_QUALITY_PROFILES, value.qualityProfile)
            ? {qualityProfile: value.qualityProfile}
            : {}),
        ...(isOneOf(AGENT_OCR_PREPROCESSING_MODES, value.preprocessingMode)
            ? {preprocessingMode: value.preprocessingMode}
            : {}),
        ...(isSupportedPageSegmentationMode(value.pageSegmentationMode)
            ? {pageSegmentationMode: value.pageSegmentationMode}
            : {}),
        ...(isOneOf(AGENT_OCR_SUPERSESSION_POLICIES, value.supersessionPolicy)
            ? {supersessionPolicy: value.supersessionPolicy}
            : {}),
        ...(typeof value.replaceAllAcknowledged === 'boolean'
            ? {replaceAllAcknowledged: value.replaceAllAcknowledged}
            : {}),
        ...(typeof value.open === 'boolean' ? {open: value.open} : {}),
    };
}
