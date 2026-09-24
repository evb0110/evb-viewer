import {
    describe,
    expect,
    it,
} from 'vitest';
import type {PDFObject} from 'pdf-lib';
import {
    getPdfAnnotationIdFromStableKey,
    parsePdfAnnotationStableKey,
    parsePdfAnnotationStableKeyRef,
} from '@app/modules/pdf-viewer/annotations/pdf-refs/parsePdfAnnotationStableKey';

interface ILiteralObject { [key: string]: PDFObject | string | number | boolean | null | undefined | ILiteralObject | TLiteralArray; }
type TLiteralArray = Array<PDFObject | string | number | boolean | null | undefined | ILiteralObject | TLiteralArray>;

describe('parsePdfAnnotationStableKey', () => {
    it('parses broad annotation stable keys without requiring PDF refs', () => {
        expect(parsePdfAnnotationStableKey(' ann:12:pdfjs_internal_editor_0 ')).toEqual({
            stableKey: 'ann:12:pdfjs_internal_editor_0',
            pageIndex: 12,
            annotationId: 'pdfjs_internal_editor_0',
        });
        expect(getPdfAnnotationIdFromStableKey('ann:0:12R0')).toBe('12R0');
    });

    it('parses and normalizes PDF ref annotation stable keys', () => {
        expect(parsePdfAnnotationStableKeyRef('ann:3:12R')).toEqual({
            stableKey: 'ann:3:12R',
            pageIndex: 3,
            annotationId: '12R',
            ref: {
                objectNumber: 12,
                generationNumber: 0,
            },
            normalizedAnnotationId: '12R',
        });
        expect(parsePdfAnnotationStableKeyRef('ann:3:12R4')?.normalizedAnnotationId).toBe('12R4');
        expect(parsePdfAnnotationStableKeyRef('ann:3:12 4 R')).toEqual({
            stableKey: 'ann:3:12 4 R',
            pageIndex: 3,
            annotationId: '12 4 R',
            ref: {
                objectNumber: 12,
                generationNumber: 4,
            },
            normalizedAnnotationId: '12R4',
        });
    });

    it('rejects invalid page indexes and non-ref strict stable keys', () => {
        expect(parsePdfAnnotationStableKey('ann:-1:12R0')).toBeNull();
        expect(parsePdfAnnotationStableKey('ann:1:')).toBeNull();
        expect(parsePdfAnnotationStableKeyRef('ann:1:pdfjs_internal_editor_0')).toBeNull();
        expect(parsePdfAnnotationStableKeyRef('uid:1:12R0')).toBeNull();
    });
});





