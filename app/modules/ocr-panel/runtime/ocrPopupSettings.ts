import type {IAgentOcrRunOptions} from '@contracts/agentOcr';
import {parseAgentOcrRunOptions} from '@contracts/agentOcr';
import type {TOcrQualityProfile} from '@contracts/electronApiOcr';
import {
    DEFAULT_OCR_RECOGNITION_OPTIONS,
    POOR_SCAN_OCR_RECOGNITION_OPTIONS,
} from '@contracts/electronApiOcr';
import type {IOcrSettings} from '@app/utils/ocr/ocrTypes';

export const OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE = '__automatic_page_segmentation__';

function isOcrPageSegmentationMode(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 13;
}

function normalizeSelectedOcrLanguages(selectedLanguages: string[]) {
    return Array.from(new Set(selectedLanguages));
}

function normalizeAgentLanguages(
    value: unknown,
    availableLanguageCodes: ReadonlySet<string>,
) {
    if (!Array.isArray(value)) {
        return null;
    }

    const languages: string[] = [];
    for (const language of value) {
        if (typeof language !== 'string') {
            continue;
        }

        const trimmedLanguage = language.trim();
        if (trimmedLanguage && availableLanguageCodes.has(trimmedLanguage)) {
            languages.push(trimmedLanguage);
        }
    }

    return normalizeSelectedOcrLanguages(languages);
}

export function cloneOcrSettingsSnapshot(value: IOcrSettings | null | undefined) {
    return value
        ? {
            pageRange: value.pageRange,
            customRange: value.customRange,
            selectedLanguages: [...value.selectedLanguages],
            qualityProfile: value.qualityProfile,
            preprocessingMode: value.preprocessingMode,
            pageSegmentationMode: value.pageSegmentationMode,
            supersessionPolicy: value.supersessionPolicy,
        }
        : null;
}

export function applyAgentOcrOptionsToSettings(
    currentSettings: IOcrSettings,
    options: IAgentOcrRunOptions,
    availableLanguageCodes: ReadonlySet<string>,
) {
    const parsedOptions = parseAgentOcrRunOptions(options);
    const nextSettings = {
        ...currentSettings,
        selectedLanguages: [...currentSettings.selectedLanguages],
    };

    if (parsedOptions.pageRange !== undefined) {
        nextSettings.pageRange = parsedOptions.pageRange;
    }
    if (parsedOptions.customRange !== undefined) {
        nextSettings.customRange = parsedOptions.customRange;
    }
    if (parsedOptions.qualityProfile !== undefined) {
        nextSettings.qualityProfile = parsedOptions.qualityProfile;
    }
    if (parsedOptions.preprocessingMode !== undefined) {
        nextSettings.preprocessingMode = parsedOptions.preprocessingMode;
    }
    if (parsedOptions.pageSegmentationMode !== undefined) {
        nextSettings.pageSegmentationMode = parsedOptions.pageSegmentationMode;
    }
    // An agent replaces other apps' hidden OCR only when it acknowledges that
    // explicitly; asked for it, or inheriting it from the dialog, without
    // acknowledging, it still repairs EVB's own recognition.
    const supersessionPolicy = parsedOptions.supersessionPolicy ?? currentSettings.supersessionPolicy;
    nextSettings.supersessionPolicy = supersessionPolicy === 'replace-all' && parsedOptions.replaceAllAcknowledged !== true
        ? 'replace-evb'
        : supersessionPolicy;

    const languages = normalizeAgentLanguages(parsedOptions.languages, availableLanguageCodes);
    if (languages !== null) {
        nextSettings.selectedLanguages = languages;
    }

    return nextSettings;
}

export function resolveOcrPageSegmentationSelectValue(pageSegmentationMode: number | null) {
    return pageSegmentationMode === null
        ? OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE
        : String(pageSegmentationMode);
}

export function resolveOcrPageSegmentationModeFromSelectValue(value: string) {
    const pageSegmentationMode = value === OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE
        ? null
        : Number(value);

    return isOcrPageSegmentationMode(pageSegmentationMode)
        ? pageSegmentationMode
        : null;
}

export function resolveQualityProfileSettings(
    currentSettings: IOcrSettings,
    nextProfile: TOcrQualityProfile,
    previousProfile: TOcrQualityProfile,
) {
    if (nextProfile === 'poor-scan' && currentSettings.preprocessingMode === DEFAULT_OCR_RECOGNITION_OPTIONS.preprocessingMode) {
        return {
            ...currentSettings,
            preprocessingMode: POOR_SCAN_OCR_RECOGNITION_OPTIONS.preprocessingMode,
        };
    }

    if (
        previousProfile === 'poor-scan'
        && nextProfile !== 'poor-scan'
        && currentSettings.preprocessingMode === POOR_SCAN_OCR_RECOGNITION_OPTIONS.preprocessingMode
    ) {
        return {
            ...currentSettings,
            preprocessingMode: DEFAULT_OCR_RECOGNITION_OPTIONS.preprocessingMode,
        };
    }

    return currentSettings;
}
