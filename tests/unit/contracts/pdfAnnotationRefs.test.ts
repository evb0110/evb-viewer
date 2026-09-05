import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
    parsePdfAnnotationRef,
    parsePdfJsAnnotationRef,
    parsePdfNativeAnnotationRef,
} from '@contracts/pdfAnnotationRefs';

describe('PDF.js annotation reference contract', () => {
    it('parses compact references with an optional generation number', () => {
        expect(parsePdfJsAnnotationRef('42R')).toEqual({
            objectNumber: 42,
            generationNumber: 0,
        });
        expect(parsePdfJsAnnotationRef(' 42r7 ')).toEqual({
            objectNumber: 42,
            generationNumber: 7,
        });
    });

    it('rejects invalid and unsafe references', () => {
        expect(parsePdfJsAnnotationRef('0R')).toBeNull();
        expect(parsePdfJsAnnotationRef('42 0 R')).toBeNull();
        expect(parsePdfJsAnnotationRef('9007199254740992R')).toBeNull();
        expect(parsePdfJsAnnotationRef('42R65536')).toBeNull();
    });

    it('parses native PDF object references through the cross-layer parser', () => {
        expect(parsePdfNativeAnnotationRef(' 42 0 R ')).toEqual({
            objectNumber: 42,
            generationNumber: 0,
        });
        expect(parsePdfNativeAnnotationRef('42 7 R')).toEqual({
            objectNumber: 42,
            generationNumber: 7,
        });
        expect(parsePdfAnnotationRef('42 0 R')).toEqual({
            objectNumber: 42,
            generationNumber: 0,
        });
    });

    it('formats and normalizes compact references', () => {
        expect(formatPdfJsAnnotationRef({
            objectNumber: 42,
            generationNumber: 0,
        })).toBe('42R');
        expect(formatPdfJsAnnotationRef({
            objectNumber: 42,
            generationNumber: 7,
        })).toBe('42R7');
        expect(normalizePdfJsAnnotationId(' 42R0 ')).toBe('42R');
        expect(normalizePdfJsAnnotationId(' custom-id ')).toBe('custom-id');
        expect(normalizePdfJsAnnotationId('   ')).toBeNull();
    });

    it('normalizes native PDF object references for cross-layer matching', () => {
        expect(normalizePdfJsAnnotationId(' 42 0 R ')).toBe('42R');
        expect(normalizePdfJsAnnotationId('42 7 R')).toBe('42R7');
    });
});
