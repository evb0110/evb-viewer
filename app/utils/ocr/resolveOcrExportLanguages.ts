import type {IOcrSettings} from '@app/utils/ocr/ocrTypes';

export function resolveOcrExportLanguages(
    lastCompletedRunSettings: IOcrSettings | null | undefined,
    activeRunSettings: IOcrSettings | null | undefined,
    fallbackSettings: IOcrSettings,
) {
    const sourceSettings = lastCompletedRunSettings ?? activeRunSettings ?? fallbackSettings;
    return [...sourceSettings.selectedLanguages];
}
