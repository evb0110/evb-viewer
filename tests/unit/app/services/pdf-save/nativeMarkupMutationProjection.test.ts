import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildNativeMarkupMutationForSave,
    toNativeMarkupHint,
} from '@app/modules/pdf-viewer/annotations/persistence/nativeMarkupProjection';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeMutationSet,
} from '@contracts/nativePdfMutations';
import {requireEpochMs} from '@contracts/timestamps';
import {requirePageIndex} from '@contracts/pageNumbers';
import {createComment} from '@tests/unit/app/services/pdf-save/createComment';

describe('native markup builders', () => {
    it.each([
        'Highlight',
        'Underline',
        'StrikeOut',
        'Squiggly',
    ] as const)(
        'keeps %s dates through collection, projection and contract normalization', subtype => {
            for (const [
                createdAt,
                modifiedAt,
            ] of [
                    [
                        requireEpochMs(1793750400000),
                        requireEpochMs(1793750460000),
                    ],
                    [
                        requireEpochMs(0),
                        requireEpochMs(0),
                    ],
                    [
                        null,
                        null,
                    ],
                ] as const) {
                const comment = createComment({
                    subtype,
                    annotationId: null,
                    source: 'editor',
                    createdAt,
                    modifiedAt,
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.1,
                    },
                    markupGeometry: [{
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.1,
                    }],
                });
                const markup = buildNativeMarkupMutationForSave({
                    canonicalComments: [comment],
                    changedComments: [comment],
                    annotationWorkDirty: true,
                });
                const normalized = normalizePdfNativeMutationSet({markup: markup ?? undefined}, 'collected markup dates');
                expect(normalized.markup?.hints[0]).toMatchObject({
                    subtype,
                    createdAt,
                    modifiedAt,
                });
            }
            const absent = toNativeMarkupHint({
                subtype,
                pageIndex: requirePageIndex(0),
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.1,
                },
                consumed: false,
            });
            const normalized = normalizePdfNativeMutationSet({markup: {hints: [absent!]}}, 'absent markup dates');
            expect(normalized.markup?.hints[0]).not.toHaveProperty('createdAt');
            expect(normalized.markup?.hints[0]).not.toHaveProperty('modifiedAt');
        },
    );

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

    it('saves every rectangle up to the native bound and refuses a longer list', () => {
        // One distinct line per rectangle, so a dropped one cannot hide.
        const lines = (count: number) => Array.from({length: count}, (_, index) => ({
            left: 0.1,
            top: index / 1_024,
            width: 0.3,
            height: 0.0008,
        }));
        const comment = (count: number) => createComment({
            subtype: 'Highlight',
            annotationId: null,
            markerRect: {
                left: 0.1,
                top: 0,
                width: 0.3,
                height: count / 1_024,
            },
            markupGeometry: lines(count),
        });
        const limit = PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems;
        const atLimit = comment(limit);

        expect(buildNativeMarkupMutationForSave({
            canonicalComments: [atLimit],
            changedComments: [atLimit],
            annotationWorkDirty: true,
        })?.hints[0]?.markupGeometry).toEqual(lines(limit));
        const overLimit = comment(limit + 1);
        expect(() => buildNativeMarkupMutationForSave({
            canonicalComments: [overLimit],
            changedComments: [overLimit],
            annotationWorkDirty: true,
        })).toThrow(`more than ${String(limit)} rectangles`);
    });
});
