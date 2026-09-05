import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeAnnotationIdentityBindings,
    normalizePdfNativeMutationSet,
    splitPdfNativeMutationSetIntoBoundedChunks,
} from '@contracts/nativePdfMutations';

const validNoteTextUpdate = {
    objectNumber: 42,
    generationNumber: 0,
    text: 'Updated note',
};

const validNoteGeometryUpdate = {
    objectNumber: 42,
    generationNumber: 0,
    pageIndex: 1,
    markerRect: {
        left: 0.6,
        top: 0.25,
        width: 0.15,
        height: 0.12,
    },
};

const validFreeTextNote = {
    pageIndex: 0,
    stableKey: 'uid:0:pdfjs_internal_editor_0',
    text: 'Editor note',
    markerRect: {
        left: 0.1,
        top: 0.2,
        width: 0.0016,
        height: 0.0016,
    },
};

const validFreeTextEditor = {
    pageIndex: 854,
    stableKey: 'pdfjs_internal_editor_0',
    text: 'asdfadf',
    rect: [
        2.048192,
        554.41672,
        59.34848,
        580.43896,
    ],
    rotation: 0,
    fontSize: 16,
    color: [
        245,
        158,
        11,
    ],
};

const validPageLabelRange = {
    startPage: 1,
    style: 'D',
    prefix: '',
    startNumber: 1,
};

const validShape = {
    type: 'rectangle',
    pageIndex: 0,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.2,
    color: '#336699',
    opacity: 0.5,
    strokeWidth: 3,
};

const validImage = {
    pageIndex: 0,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.2,
    rotationDegrees: 0,
    mimeType: 'image/jpeg',
    source: {
        path: '/tmp/image.jpg',
        size: 3,
        sha256: 'a'.repeat(64),
        leaseId: 'image-lease',
        revision: null,
    },
};

const validIdentityBinding = {
    annotationId: 'app-annotation-1',
    pdfRef: '700 0 R',
};

interface INativeBookmarkTestItem {
    title: string;
    pageIndex: number | null;
    pageYRatio?: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: INativeBookmarkTestItem[];
}

function createBookmark(title = 'Chapter'): INativeBookmarkTestItem {
    return {
        title,
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createDeepBookmarkItems(depth: number) {
    const root = createBookmark('Root');
    let current = root;
    for (let index = 0; index < depth; index += 1) {
        const child = createBookmark(`Child ${index}`);
        current.items = [child];
        current = child;
    }
    return [root];
}

function countBookmarkItems(items: readonly INativeBookmarkTestItem[]): number {
    return items.reduce((count, item) => count + 1 + countBookmarkItems(item.items), 0);
}

describe('native PDF mutation contracts', () => {
    it('normalizes native canonical identity bindings without changing their proof', () => {
        expect(normalizePdfNativeAnnotationIdentityBindings([{
            annotationId: '  app-annotation-1 ',
            pdfRef: '700 0 R',
        }])).toEqual([validIdentityBinding]);
    });

    it.each([
        [
            'non-array',
            {
                annotationId: 'app-annotation-1',
                pdfRef: '700 0 R',
            },
        ],
        [
            'missing annotation id',
            [{pdfRef: '700 0 R'}],
        ],
        [
            'malformed PDF ref',
            [{
                annotationId: 'app-annotation-1',
                pdfRef: '700R',
            }],
        ],
        [
            'zero object number',
            [{
                annotationId: 'app-annotation-1',
                pdfRef: '0 0 R',
            }],
        ],
        [
            'unsafe object number',
            [{
                annotationId: 'app-annotation-1',
                pdfRef: '9007199254740992 0 R',
            }],
        ],
        [
            'unexpected field',
            [{
                ...validIdentityBinding,
                extra: true,
            }],
        ],
    ])('rejects %s identity bindings', (_label, value) => {
        expect(() => normalizePdfNativeAnnotationIdentityBindings(value)).toThrow();
    });

    it('rejects duplicate identity ids and duplicate PDF refs', () => {
        expect(() => normalizePdfNativeAnnotationIdentityBindings([
            validIdentityBinding,
            {
                annotationId: validIdentityBinding.annotationId,
                pdfRef: '701 0 R',
            },
        ])).toThrow('duplicate annotation identity');
        expect(() => normalizePdfNativeAnnotationIdentityBindings([
            validIdentityBinding,
            {
                annotationId: 'app-annotation-2',
                pdfRef: validIdentityBinding.pdfRef,
            },
        ])).toThrow('duplicate PDF object reference');
    });

    it('normalizes every native mutation family for preload and native-tool payloads', () => {
        const rawMutations = {
            updates: [validNoteTextUpdate],
            geometryUpdates: [validNoteGeometryUpdate],
            freeTextNotes: [validFreeTextNote],
            textBoxes: [validFreeTextEditor],
            pageLabels: {
                totalPages: 3,
                ranges: [validPageLabelRange],
            },
            bookmarks: {
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: [{
                    ...createBookmark(),
                    pageYRatio: 0.25,
                }],
            },
            shapes: {
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [validShape],
                deletedAnnotationIds: ['44R'],
                deletedStableKeys: ['evb-shape:deleted'],
            },
            markup: {
                overrides: [[
                    '44R',
                    'Squiggly',
                ]],
                hints: [{
                    subtype: 'Squiggly',
                    pageIndex: 0,
                    appAnnotationId: '  app-markup-1  ',
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.2,
                    },
                    markupGeometry: [
                        {
                            left: 0.1,
                            top: 0.2,
                            width: 0.1,
                            height: 0.2,
                        },
                        {
                            left: 0.3,
                            top: 0.2,
                            width: 0.1,
                            height: 0.2,
                        },
                    ],
                    annotationId: '44R',
                }],
            },
            placedImages: [validImage],
        };

        const preloadPayload = normalizePdfNativeMutationSet(rawMutations, 'mutations');
        expect(preloadPayload.placedImages?.[0]?.source).toEqual(validImage.source);
        expect(preloadPayload.bookmarks?.items[0]).toMatchObject({
            pageIndex: 0,
            pageYRatio: 0.25,
        });
        expect(preloadPayload.textBoxes).toEqual([validFreeTextEditor]);
        expect(preloadPayload.geometryUpdates).toEqual([validNoteGeometryUpdate]);
        expect(preloadPayload.markup?.hints[0]?.appAnnotationId).toBe('app-markup-1');
    });

    it('keeps depth, item, geometry, and byte validation while allowing continuation-sized collections', () => {
        expect(() => normalizePdfNativeMutationSet({bookmarks: {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: createDeepBookmarkItems(PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth + 1),
        }}, 'mutations')).toThrow('maximum bookmark depth');

        expect(() => normalizePdfNativeMutationSet({bookmarks: {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: createDeepBookmarkItems(10_000),
        }}, 'mutations')).toThrow('maximum bookmark depth');

        expect(() => normalizePdfNativeMutationSet({bookmarks: {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: [{
                ...createBookmark(),
                pageYRatio: 1.5,
            }],
        }}, 'mutations')).toThrow('pageYRatio must be a finite number from 0 to 1 or null');

        expect(() => normalizePdfNativeMutationSet({shapes: {
            totalPages: 3,
            rewriteShapeState: true,
            shapes: [{
                ...validShape,
                points: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.shapePoints + 1}, () => ({
                    x: 0.1,
                    y: 0.2,
                })),
            }],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        }}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points`);

        expect(() => normalizePdfNativeMutationSet({markup: {
            overrides: [[
                'x'.repeat(PDF_NATIVE_MUTATION_LIMITS.markupTextLength + 1),
                'Highlight',
            ]],
            hints: [],
        }}, 'mutations')).toThrow('bounded annotation id');

        expect(() => normalizePdfNativeMutationSet({markup: {
            overrides: [],
            hints: [{
                subtype: 'Highlight',
                pageIndex: 0,
                appAnnotationId: '   ',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.2,
                },
            }],
        }}, 'mutations')).toThrow('appAnnotationId must be a non-empty string or null');

        expect(() => normalizePdfNativeMutationSet({markup: {
            overrides: [],
            hints: [{
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.2,
                },
                markupGeometry: Array.from(
                    {length: PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems + 1},
                    () => ({
                        left: 0.1,
                        top: 0.2,
                        width: 0.1,
                        height: 0.2,
                    }),
                ),
            }],
        }}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems} rectangles`);

        expect(() => normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            source: null,
        }]}, 'mutations')).toThrow('valid managed binary handle');
    });

    it('rejects a native mutation request that exceeds the aggregate collection budget', () => {
        const updates = Array.from(
            {length: PDF_NATIVE_MUTATION_LIMITS.collectionItems},
            (_, index) => ({
                ...validNoteTextUpdate,
                objectNumber: index + 1,
            }),
        );

        expect(() => normalizePdfNativeMutationSet({
            updates,
            geometryUpdates: [validNoteGeometryUpdate],
        }, 'mutations')).toThrow(
            `mutations exceed the ${PDF_NATIVE_MUTATION_LIMITS.collectionItems}-item aggregate admission ceiling`,
        );
    });

    it('rejects nested ink stroke collections beyond their bounded shape budget', () => {
        expect(() => normalizePdfNativeMutationSet({shapes: {
            totalPages: 3,
            rewriteShapeState: true,
            shapes: [{
                ...validShape,
                strokes: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.shapeStrokes + 1}, () => []),
            }],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        }}, 'mutations')).toThrow(
            `at most ${PDF_NATIVE_MUTATION_LIMITS.shapeStrokes} strokes`,
        );

        const halfPointCount = Math.floor(PDF_NATIVE_MUTATION_LIMITS.shapePoints / 2) + 1;
        expect(() => normalizePdfNativeMutationSet({shapes: {
            totalPages: 3,
            rewriteShapeState: true,
            shapes: [{
                ...validShape,
                strokes: [
                    Array.from({length: halfPointCount}, () => ({
                        x: 0.1,
                        y: 0.2,
                    })),
                    Array.from({length: halfPointCount}, () => ({
                        x: 0.1,
                        y: 0.2,
                    })),
                ],
            }],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        }}, 'mutations')).toThrow(
            `at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points per shape`,
        );
    });

    it('continues valid cap-plus-one mutation families in bounded chunks', () => {
        const mutations = normalizePdfNativeMutationSet({
            updates: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates + 1}, (_, index) => ({
                ...validNoteTextUpdate,
                objectNumber: index + 1,
            })),
            geometryUpdates: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.noteGeometryUpdates + 1}, (_, index) => ({
                ...validNoteGeometryUpdate,
                objectNumber: index + 1,
            })),
            textBoxes: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.textBoxes + 1},
                (_, index) => ({
                    ...validFreeTextEditor,
                    stableKey: `editor-${index}`,
                }),
            ),
            pageLabels: {
                totalPages: PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges + 1,
                ranges: Array.from(
                    {length: PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges + 1},
                    (_, index) => ({
                        ...validPageLabelRange,
                        startPage: index + 1,
                    }),
                ),
            },
            bookmarks: {
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: Array.from(
                    {length: PDF_NATIVE_MUTATION_LIMITS.bookmarkItems + 1},
                    (_, index) => createBookmark(`Chapter ${index}`),
                ),
            },
            shapes: {
                totalPages: 3,
                rewriteShapeState: true,
                shapes: Array.from(
                    {length: PDF_NATIVE_MUTATION_LIMITS.shapes + 1},
                    (_, index) => ({
                        ...validShape,
                        id: `shape-${index}`,
                    }),
                ),
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            },
            markup: {
                overrides: Array.from(
                    {length: PDF_NATIVE_MUTATION_LIMITS.markupItems + 1},
                    (_, index) => [
                        `${index + 1}R`,
                        'Highlight',
                    ] as const,
                ),
                hints: [],
            },
            placedImages: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.placedImages + 1},
                (_, index) => ({
                    ...validImage,
                    stableKey: `image-${index}`,
                }),
            ),
        }, 'mutations');

        const chunks = splitPdfNativeMutationSetIntoBoundedChunks(mutations);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.reduce((total, chunk) => total + (chunk.updates?.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.geometryUpdates?.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.noteGeometryUpdates + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.textBoxes?.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.textBoxes + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.pageLabels?.ranges.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.bookmarks?.items.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.bookmarkItems + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.shapes?.shapes.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.shapes + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.markup?.overrides.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.markupItems + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.placedImages?.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.placedImages + 1);
        for (const chunk of chunks) {
            expect(chunk.updates?.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates);
            expect(chunk.geometryUpdates?.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.noteGeometryUpdates);
            expect(chunk.textBoxes?.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.textBoxes);
            expect(chunk.pageLabels?.ranges.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges);
            expect(chunk.bookmarks?.items.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.bookmarkItems);
            expect(chunk.shapes?.shapes.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.shapes);
            expect(chunk.markup?.overrides.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.markupItems);
            expect(chunk.placedImages?.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.placedImages);
        }
    });

    it('preserves exactly 10,001 bookmarks across path-addressed fragments', () => {
        const root = createBookmark('Root');
        root.items = Array.from(
            {length: 10_000},
            (_, index) => createBookmark(`Child ${index}`),
        );
        const normalized = normalizePdfNativeMutationSet({bookmarks: {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: [root],
        }}, 'mutations');

        const chunks = splitPdfNativeMutationSetIntoBoundedChunks(normalized);
        const bookmarkChunks = chunks.filter(chunk => chunk.bookmarks !== undefined);
        expect(bookmarkChunks).toHaveLength(3);
        expect(countBookmarkItems(bookmarkChunks[0]!.bookmarks!.items)).toBe(1);
        expect(bookmarkChunks[0]!.continuation).toBeUndefined();
        expect(bookmarkChunks.slice(1).every(chunk =>
            chunk.continuation?.family === 'bookmarks'
            && chunk.continuation.bookmarkPath?.join('.') === '0')).toBe(true);
        expect(bookmarkChunks.slice(1).reduce(
            (count, chunk) => count + countBookmarkItems(chunk.bookmarks!.items),
            0,
        )).toBe(10_000);
        for (const chunk of bookmarkChunks) {
            expect(countBookmarkItems(chunk.bookmarks!.items))
                .toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.bookmarkItems);
        }
        expect(bookmarkChunks.slice(1).flatMap(chunk => chunk.bookmarks!.items)
            .map(item => item.title)).toEqual([...Array.from(
            {length: 10_000},
            (_, index) => `Child ${index}`,
        )]);
    });

    it('accepts native mutation bounds that exactly touch normalized page edges', () => {
        const normalized = normalizePdfNativeMutationSet({
            freeTextNotes: [{
                ...validFreeTextNote,
                markerRect: {
                    left: 0.5,
                    top: 0.25,
                    width: 0.5,
                    height: 0.75,
                },
            }],
            placedImages: [{
                ...validImage,
                x: 0.75,
                y: 0.5,
                width: 0.25,
                height: 0.5,
            }],
        }, 'mutations');

        expect(normalized.freeTextNotes?.[0]?.markerRect).toEqual({
            left: 0.5,
            top: 0.25,
            width: 0.5,
            height: 0.75,
        });
        expect(normalized.placedImages?.[0]).toMatchObject({
            x: 0.75,
            y: 0.5,
            width: 0.25,
            height: 0.5,
        });
    });

    it.each([
        [
            'shape width',
            {shapes: {
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [{
                    ...validShape,
                    width: Number.MAX_VALUE,
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            }},
        ],
        [
            'FreeText editor rectangle coordinate',
            {textBoxes: [{
                ...validFreeTextEditor,
                rect: [
                    0,
                    0,
                    Number.MAX_VALUE,
                    1,
                ],
            }]},
        ],
        [
            'placed image rotation',
            {placedImages: [{
                ...validImage,
                rotationDegrees: Number.MAX_VALUE,
            }]},
        ],
    ])('rejects finite %s values outside the native f32 range at the IPC boundary', (_label, mutations) => {
        expect(() => normalizePdfNativeMutationSet(mutations, 'mutations'))
            .toThrowError(TypeError);
    });

    it('rejects zero-sized and overflowing normalized page bounds', () => {
        expect(() => normalizePdfNativeMutationSet({freeTextNotes: [{
            ...validFreeTextNote,
            markerRect: {
                ...validFreeTextNote.markerRect,
                width: 0,
            },
        }]}, 'mutations')).toThrow('must fit inside the normalized page bounds');

        expect(() => normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            x: 0.75,
            width: 0.26,
        }]}, 'mutations')).toThrow('must fit inside the normalized page bounds');
    });
});
