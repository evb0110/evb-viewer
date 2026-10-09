import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildNativeMarkupMutationForSave,
    toNativeMarkupHint,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeMarkupProjection';
import {PDF_NATIVE_MUTATION_LIMITS} from '@contracts/nativePdfMutations';
import {requirePageIndex} from '@contracts/pageNumbers';
import {createComment} from '@tests/unit/app/services/pdf-save/createComment';

describe('native markup builders', () => {
    it('converts eligible markup hints and edited comment hints', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };

        expect(toNativeMarkupHint({
            subtype: 'Highlight',
            pageIndex: requirePageIndex(0),
            markerRect,
            markupGeometry: [markerRect],
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
            contents: 'Edited markup note',
            opacity: 0.45,
            consumed: false,
        })).toEqual({
            subtype: 'Highlight',
            pageIndex: requirePageIndex(0),
            markerRect,
            markupGeometry: [markerRect],
            annotationId: '44R0',
            color: '#ffee00',
            id: 'hint-1',
            pageMarkupIndex: 3,
            source: 'editor',
            contents: 'Edited markup note',
            opacity: 0.45,
        });

        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [
                createComment({
                    stableKey: 'ann:0:44R0',
                    subtype: 'Highlight',
                    color: '#ffee00',
                    colorEdited: true,
                    annotationId: '44R0',
                    markerRect,
                    markupGeometry: [markerRect],
                }),
                createComment({
                    stableKey: 'ann:0:45R0',
                    subtype: 'Squiggly',
                    annotationId: '45R0',
                    markerRect,
                }),
                createComment({
                    stableKey: 'ann:0:46R0',
                    subtype: 'Underline',
                    annotationId: '46R0',
                    color: '#224466',
                    opacity: 0.4,
                    markerRect,
                }),
            ],
            changedComments: [
                createComment({
                    stableKey: 'ann:0:44R0',
                    subtype: 'Highlight',
                    color: '#ffee00',
                    colorEdited: true,
                    annotationId: '44R0',
                    markerRect,
                    markupGeometry: [markerRect],
                }),
                createComment({
                    stableKey: 'ann:0:46R0',
                    subtype: 'Underline',
                    annotationId: '46R0',
                    color: '#224466',
                    opacity: 0.4,
                    markerRect,
                }),
            ],
            annotationWorkDirty: true,
        });

        expect(mutation?.hints).toEqual([
            expect.objectContaining({
                subtype: 'Highlight',
                annotationId: '44R0',
                markupGeometry: [markerRect],
            }),
            expect.objectContaining({
                subtype: 'Underline',
                annotationId: '46R0',
                color: '#224466',
                opacity: 0.4,
            }),
        ]);
    });

    it('emits the changed canonical geometry for an edited comment', () => {
        const canonicalRect = {
            left: 0.2,
            top: 0.2,
            width: 0.5,
            height: 0.1,
        };
        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment({
                stableKey: 'ann:0:44R0',
                subtype: 'Highlight',
                annotationId: '44R0',
                color: '#ffee00',
                colorEdited: true,
                markerRect: canonicalRect,
                markupGeometry: [canonicalRect],
            })],
            changedComments: [createComment({
                stableKey: 'ann:0:44R0',
                subtype: 'Highlight',
                annotationId: '44R0',
                color: '#ffee00',
                colorEdited: true,
                markerRect: canonicalRect,
                markupGeometry: [canonicalRect],
            })],
            annotationWorkDirty: true,
        });

        expect(mutation?.hints).toEqual([expect.objectContaining({
            annotationId: '44R0',
            markupGeometry: [canonicalRect],
        })]);
    });

    it.each([
        'Highlight',
        'Underline',
        'StrikeOut',
        'Squiggly',
    ] as const)(
        'rejects malformed explicit %s geometry instead of saving only its style',
        subtype => {
            const markerRect = {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.04,
            };
            const comment = createComment({
                subtype,
                annotationId: '44R0',
                markerRect,
                markupGeometry: [
                    markerRect,
                    {
                        ...markerRect,
                        width: 0,
                    },
                ],
            });
            expect(() => buildNativeMarkupMutationForSave({
                canonicalComments: [comment],
                changedComments: [comment],
                annotationWorkDirty: true,
            })).toThrow('Cannot save text-markup annotation with invalid geometry');
        },
    );

    it('keeps the marker rectangle when detailed geometry exceeds the native bound', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };
        const nativeHint = toNativeMarkupHint({
            subtype: 'Squiggly',
            pageIndex: requirePageIndex(0),
            markerRect,
            markupGeometry: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems + 1},
                () => markerRect,
            ),
            annotationId: null,
            color: '#336699',
            id: 'bounded-fallback',
            pageMarkupIndex: null,
            source: 'editor',
            consumed: false,
        });

        expect(nativeHint).toEqual(expect.objectContaining({markerRect}));
        expect(nativeHint).not.toHaveProperty('markupGeometry');
    });
});
