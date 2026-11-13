import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createPdfAnnotationPreviewTextResolver,
    resolvePdfAnnotationPreviewTextFromMarkerRects,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/resolvePdfAnnotationPreviewText';

const viewport = {
    transform: [
        1,
        0,
        0,
        -1,
        0,
        100,
    ],
    width: 100,
    height: 100,
    scale: 1,
};

const lineTextItem = {
    str: 'ABCDEFGH',
    transform: [
        10,
        0,
        0,
        10,
        10,
        70,
    ],
    width: 80,
    height: 10,
};

describe('resolvePdfAnnotationPreviewText', () => {
    it('derives canonical selected text from marker rects and fails quietly without text', () => {
        const preview = resolvePdfAnnotationPreviewTextFromMarkerRects(
            'Highlight',
            [{
                left: 0.3,
                top: 0.2,
                width: 0.2,
                height: 0.1,
            }],
            [lineTextItem],
            viewport,
        );

        expect(preview).toBe('CD');
        expect(resolvePdfAnnotationPreviewTextFromMarkerRects(
            'Highlight',
            [{
                left: 0.7,
                top: 0.8,
                width: 0.1,
                height: 0.1,
            }],
            [lineTextItem],
            viewport,
        )).toBeNull();
    });
});

describe('page preview text derivation', () => {
    it('preserves item order, whitespace and overlapping or disjoint selected ranges across highlights', () => {
        const resolve = createPdfAnnotationPreviewTextResolver([
            lineTextItem,
            {
                ...lineTextItem,
                str: '  tail\t words  ',
            },
            {
                ...lineTextItem,
                str: 'ABCDEFGH',
            },
        ], viewport);
        const partial = {
            left: 0.3,
            top: 0.2,
            width: 0.2,
            height: 0.1,
        };
        const full = {
            ...partial,
            left: 0.1,
            width: 0.8,
        };

        expect(resolve('Highlight', [
            partial,
            partial,
        ])).toBe('CD ail CD');
        expect(resolve('Underline', [full])).toBe('ABCDEFGH tail words ABCDEFGH');
        expect(resolve('StrikeOut', [
            {
                ...partial,
                left: 0.7,
            },
            partial,
            {
                ...partial,
                left: 0.4,
            },
        ])).toBe('CDE GH ail wo ds CDE GH');
        expect(resolve('Squiggly', [partial])).toBe('CD ail CD');
        expect(resolve('Text', [full])).toBeNull();
        expect(resolve('Highlight', [])).toBeNull();
    });

    it('keeps the existing 280-character clamp and three-dot ellipsis after joining all segments', () => {
        const resolve = createPdfAnnotationPreviewTextResolver([
            {
                ...lineTextItem,
                str: 'a'.repeat(278),
            },
            {
                ...lineTextItem,
                str: ' b\t c ',
            },
        ], viewport);
        const full = [{
            left: 0.1,
            top: 0.2,
            width: 0.8,
            height: 0.1,
        }];

        expect(resolve('Highlight', full)).toBe(`${'a'.repeat(278)}...`);
        expect(createPdfAnnotationPreviewTextResolver([{
            ...lineTextItem,
            str: 'a'.repeat(280),
        }], viewport)('Highlight', full)).toBe('a'.repeat(280));
    });

    it('omits unusable items and viewport geometry without losing valid selected text', () => {
        const full = [{
            left: 0.1,
            top: 0.2,
            width: 0.8,
            height: 0.1,
        }];
        const items = [
            {str: 'marked content'},
            {
                ...lineTextItem,
                str: '   ',
            },
            {
                ...lineTextItem,
                str: 'short matrix',
                transform: [
                    1,
                    0,
                ],
            },
            {
                ...lineTextItem,
                str: 'invalid matrix',
                transform: [
                    1,
                    0,
                    0,
                    1,
                    Infinity,
                    70,
                ],
            },
            {
                ...lineTextItem,
                str: 'no width',
                width: 0,
            },
            {
                ...lineTextItem,
                str: 'no height',
                height: 0,
                transform: [
                    0,
                    0,
                    0,
                    0,
                    10,
                    70,
                ],
            },
            lineTextItem,
        ];

        expect(createPdfAnnotationPreviewTextResolver(items, viewport)('Highlight', full)).toBe('ABCDEFGH');
        for (const invalidViewport of [
            null,
            {
                ...viewport,
                width: 0,
            },
            {
                ...viewport,
                height: -1,
            },
            {
                ...viewport,
                transform: [
                    1,
                    0,
                ],
            },
            {
                ...viewport,
                transform: [
                    1,
                    0,
                    0,
                    -1,
                    NaN,
                    100,
                ],
            },
        ]) {
            expect(createPdfAnnotationPreviewTextResolver(items, invalidViewport)('Highlight', full)).toBeNull();
            expect(resolvePdfAnnotationPreviewTextFromMarkerRects('Highlight', full, items, invalidViewport)).toBeNull();
        }
    });
});
