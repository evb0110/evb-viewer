import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ocrErrorCodeMessageKeys,
    ocrErrorMessageKeys,
} from '@app/utils/ocr/ocrErrorMessageKeys';
import { EN_MESSAGE_SCHEMA } from '@i18n-app';
import { flattenObject } from 'es-toolkit/object';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

describe('ocrErrorMessageKeys', () => {
    const knownEnKeys = new Set(
        Object.entries(flattenObject(EN_MESSAGE_SCHEMA))
            .filter(entry => typeof entry[1] === 'string')
            .map(entry => entry[0]),
    );

    it('has no duplicate entries', () => {
        const unique = new Set(ocrErrorMessageKeys);
        expect(unique.size).toBe(ocrErrorMessageKeys.length);
    });

    it('points to keys present in the English message schema', () => {
        expect(ocrErrorMessageKeys.length).toBeGreaterThan(0);

        for (const key of ocrErrorMessageKeys) {
            expect(knownEnKeys.has(key)).toBe(true);
        }
    });

    it('maps every structured OCR error code to a known translation key', () => {
        expect(Object.keys(ocrErrorCodeMessageKeys).sort()).toEqual([
            'OCR_INTERNAL_ERROR',
            'OCR_INVALID_PAYLOAD',
            'OCR_QUEUE_BACKPRESSURE',
            'OCR_TOOLS_VALIDATION_FAILED',
            'OCR_WORKER_UNAVAILABLE',
        ]);

        for (const key of Object.values(ocrErrorCodeMessageKeys)) {
            expect(knownEnKeys.has(key)).toBe(true);
        }
    });
});

describe('useOcrErrorLocalizer', () => {
    it('uses structured OCR error codes before generic fallback messages', async () => {
        const { useOcrErrorLocalizer } = await import('@app/composables/useOcrErrorLocalizer');
        const { localizeOcrError } = useOcrErrorLocalizer();

        expect(localizeOcrError({
            code: 'OCR_QUEUE_BACKPRESSURE',
            message: 'Queue has 2048 pages waiting',
            retryable: true,
            timestamp: 1,
        }, 'errors.ocr.start')).toBe(
            'errors.ocr.errorCode.queueBackpressure: Queue has 2048 pages waiting',
        );
    });

    it('normalizes Electron remote and Error prefixes before matching file errors', async () => {
        const { useOcrErrorLocalizer } = await import('@app/composables/useOcrErrorLocalizer');
        const { localizeOcrError } = useOcrErrorLocalizer();

        expect(localizeOcrError(
            'Error invoking remote method \'ocr:create-searchable-pdf\': Error: Invalid file path',
            'errors.ocr.start',
        )).toBe('errors.file.invalid');
    });
});
