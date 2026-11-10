import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IOcrSettings } from '@app/utils/ocr/ocrTypes';
import { resolveOcrExportLanguages } from '@app/utils/ocr/resolveOcrExportLanguages';

function settings(selectedLanguages: string[]): IOcrSettings {
    return {
        pageRange: 'all',
        customRange: '',
        selectedLanguages,
        qualityProfile: 'balanced',
        preprocessingMode: 'off',
        pageSegmentationMode: null,
        supersessionPolicy: 'missing-only',
    };
}

describe('resolveOcrExportLanguages', () => {
    it('prefers the last completed run over an active run', () => {
        expect(resolveOcrExportLanguages(
            settings(['heb']),
            settings(['eng']),
            settings(['fra']),
        )).toEqual(['heb']);
    });

    it('uses the active run before draft settings when there is no completed run', () => {
        expect(resolveOcrExportLanguages(
            null,
            settings(['eng']),
            settings(['fra']),
        )).toEqual(['eng']);
    });

    it('returns a copy of the selected language list', () => {
        const fallback = settings(['eng']);
        const resolved = resolveOcrExportLanguages(null, null, fallback);

        resolved.push('fra');

        expect(fallback.selectedLanguages).toEqual(['eng']);
    });
});
