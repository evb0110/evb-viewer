import {
    describe,
    expect,
    it,
} from 'vitest';
import { createOcrErrorLocalizer } from '@app/composables/ocrErrorLocalization';

const dictionary: Record<string, string> = {
    'errors.file.invalid': 'Invalid file',
    'errors.ocr.loadLanguages': 'Load languages failed',
    'errors.ocr.noValidPages': 'No valid pages',
    'errors.ocr.timeout': 'OCR timeout',
    'errors.ocr.start': 'OCR start failed',
    'errors.ocr.noPdfData': 'No PDF data',
    'errors.ocr.createSearchablePdf': 'Create searchable PDF failed',
    'errors.ocr.noText': 'No text available',
    'errors.ocr.exportDocx': 'DOCX export failed',
};

const t = (key: string) => dictionary[key] ?? key;

describe('createOcrErrorLocalizer', () => {
    it('maps known invalid file errors to localized invalid file message', () => {
        const { localizeOcrError } = createOcrErrorLocalizer(t);

        const result = localizeOcrError(
            'Error invoking remote method \'file:read\': Invalid file path',
            'errors.ocr.createSearchablePdf',
        );

        expect(result).toBe('Invalid file');
    });

    it('prepends localized fallback for unknown errors', () => {
        const { localizeOcrError } = createOcrErrorLocalizer(t);

        const result = localizeOcrError('boom', 'errors.ocr.exportDocx');

        expect(result).toBe('DOCX export failed: boom');
    });
});
