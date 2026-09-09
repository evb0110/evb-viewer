import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TMarkupSubtype} from '@app/types/annotations';
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
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                ' 44R0 ',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                subtype: 'Squiggly',
                pageIndex: requirePageIndex(0),
                markerRect,
                annotationId: '45R0',
                color: null,
                id: null,
                pageMarkupIndex: null,
                source: null,
                consumed: false,
            }],
        });

        expect(mutation?.overrides).toEqual([[
            '44R0',
            'Underline',
        ]]);
        expect(mutation?.hints).toEqual([
            expect.objectContaining({
                subtype: 'Squiggly',
                annotationId: '45R0',
            }),
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

    it('matches a live markup hint by its canonical app annotation identity', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };
        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment({
                appAnnotationId: 'app-markup-1',
                id: 'current-runtime-id',
                stableKey: 'ann:0:current-runtime-id',
                subtype: 'Highlight',
                source: 'editor',
                annotationId: null,
                markerRect,
            })],
            annotationWorkDirty: true,
            markupSubtypeOverrides: undefined,
            markupSubtypeHints: [{
                appAnnotationId: 'app-markup-1',
                subtype: 'Highlight',
                pageIndex: requirePageIndex(0),
                markerRect,
                annotationId: null,
                color: '#ffee00',
                id: 'stale-runtime-id',
                pageMarkupIndex: null,
                source: 'editor-live',
                consumed: false,
            }],
        });

        expect(mutation?.hints).toContainEqual(expect.objectContaining({
            appAnnotationId: 'app-markup-1',
            id: 'stale-runtime-id',
        }));
    });

    it('drops a retired PDF override when an undone markup is editor-owned', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };
        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment({
                appAnnotationId: 'app-markup-1',
                id: '9R',
                stableKey: 'ann:0:9R',
                subtype: 'Highlight',
                source: 'editor',
                annotationId: null,
                markerRect,
            })],
            annotationWorkDirty: true,
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                '9R0',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                appAnnotationId: 'app-markup-1',
                subtype: 'Highlight',
                pageIndex: requirePageIndex(0),
                markerRect,
                annotationId: '9R0',
                color: '#ffee00',
                id: 'pdfjs_saved_highlight_undo',
                pageMarkupIndex: 0,
                source: 'editor-live',
                consumed: false,
            }],
        });

        expect(mutation?.overrides).toEqual([]);
        expect(mutation?.hints).toContainEqual(expect.objectContaining({
            appAnnotationId: 'app-markup-1',
            id: '9R',
            annotationId: null,
            source: 'editor',
        }));
    });

    it('drops stale markup hints and overrides that no longer match current markup comments', () => {
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        };

        const mutation = buildNativeMarkupMutationForSave({
            canonicalComments: [createComment()],
            annotationWorkDirty: true,
            markupSubtypeOverrides: new Map<string, TMarkupSubtype>([[
                '44R0',
                'Underline',
            ]]),
            markupSubtypeHints: [{
                subtype: 'Squiggly',
                pageIndex: requirePageIndex(0),
                markerRect,
                annotationId: '45R0',
                color: null,
                id: null,
                pageMarkupIndex: null,
                source: null,
                consumed: false,
            }],
        });

        expect(mutation).toBeNull();
    });
});
