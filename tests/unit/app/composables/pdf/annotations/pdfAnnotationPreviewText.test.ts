import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolvePdfAnnotationPreviewText,
    resolvePdfAnnotationPreviewTextFromMarkerRects,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/resolvePdfAnnotationPreviewText';

const pageView = [
    0,
    0,
    100,
    100,
];

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
    it('extracts only the substring covered by a small text-markup quad', () => {
        const preview = resolvePdfAnnotationPreviewText(
            {
                subtype: 'Highlight',
                quadPoints: [
                    30,
                    80,
                    50,
                    80,
                    30,
                    70,
                    50,
                    70,
                ],
            },
            [lineTextItem],
            pageView,
            0,
            viewport,
        );

        expect(preview).toBe('CD');
    });

    it('does not pull text from the next line when the padded target barely overlaps it', () => {
        const preview = resolvePdfAnnotationPreviewText(
            {
                subtype: 'StrikeOut',
                rect: [
                    30,
                    70,
                    50,
                    80,
                ],
            },
            [
                lineTextItem,
                {
                    str: 'lower words',
                    transform: [
                        4,
                        0,
                        0,
                        4,
                        10,
                        67,
                    ],
                    width: 80,
                    height: 4,
                },
            ],
            pageView,
            0,
            viewport,
        );

        expect(preview).toBe('CD');
    });

    it('keeps rect-only fallback text for legacy markup without quad points', () => {
        const preview = resolvePdfAnnotationPreviewText(
            {
                subtype: 'Highlight',
                rect: [
                    10,
                    70,
                    90,
                    80,
                ],
            },
            [lineTextItem],
            pageView,
            0,
            viewport,
        );

        expect(preview).toBe('ABCDEFGH');
    });

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
