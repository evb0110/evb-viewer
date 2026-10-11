import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeAnnotationIdentityBindings,
    normalizePdfNativeMutationSet,
} from '@contracts/nativePdfMutations';
import {
    collectExpectedNativeIdentityIds, splitPdfNativeMutationSetIntoBoundedChunks,
} from '@pdf-core/nativePdfMutationPolicy';

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
    color: '#336699',
    open: true,
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
    open: true,
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
    items: readonly INativeBookmarkTestItem[];
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
    it('preserves bounded source destinations through save and rejects invalid coordinate shapes', () => {
        const originalDestination = {
            kind: 'XYZ',
            sourceTarget: {
                num: 17,
                gen: 0,
            },
            coordinates: [
                null,
                null,
                null,
            ],
        };
        const bookmark = {
            title: 'Source',
            pageIndex: null,
            pageYRatio: null,
            namedDest: null,
            originalDestination,
            bold: false,
            italic: false,
            color: null,
            items: [],
        };
        const mutations = {bookmarks: {
            totalPages: 2,
            untitledLabel: 'Untitled',
            items: [bookmark],
        }};
        expect(normalizePdfNativeMutationSet(mutations, 'mutations').bookmarks?.items[0]?.originalDestination).toEqual(originalDestination);
        for (const invalid of [
            {
                ...originalDestination,
                kind: 'Invalid',
            },
            {
                ...originalDestination,
                coordinates: [null],
            },
            {
                ...originalDestination,
                coordinates: [
                    NaN,
                    null,
                    null,
                ],
            },
            {
                ...originalDestination,
                sourceTarget: {
                    num: -1,
                    gen: 0,
                },
            },
        ]) {
            expect(() => normalizePdfNativeMutationSet({bookmarks: {
                ...mutations.bookmarks,
                items: [{
                    ...bookmark,
                    originalDestination: invalid,
                }],
            }}, 'mutations')).toThrow();
        }
    });

    it('normalizes native canonical identity bindings without changing their proof', () => {
        expect(normalizePdfNativeAnnotationIdentityBindings([{
            annotationId: '  app-annotation-1 ',
            pdfRef: '700 0 R',
        }])).toEqual([validIdentityBinding]);
    });

    it.each([
        [
            'Hebrew',
            'א'.repeat(1_024),
        ],
        [
            'Arabic',
            'ع'.repeat(1_024),
        ],
        [
            'CJK',
            `${'界'.repeat(682)}ab`,
        ],
    ])('budgets %s report identities in UTF-8 bytes', (_language, annotationId) => {
        const binding = {
            annotationId,
            pdfRef: '700 0 R',
        };
        expect(new TextEncoder().encode(annotationId)).toHaveLength(2_048);
        expect(normalizePdfNativeAnnotationIdentityBindings([binding])).toEqual([binding]);
        expect(() => normalizePdfNativeAnnotationIdentityBindings([{
            ...binding,
            annotationId: `${annotationId}a`,
        }])).toThrow('2048 UTF-8 bytes');
    });

    it('refuses the 3200-shape Unicode probe at mutation admission', () => {
        const identity = `evb-shape:${'é'.repeat(1_100)}`;
        expect(new TextEncoder().encode(identity)).toHaveLength(2_210);
        expect(() => normalizePdfNativeMutationSet({shapes: {
            totalPages: 1,
            rewriteShapeState: true,
            shapes: Array.from({length: 3_200}, (_, index) => ({
                ...validShape,
                stableKey: index === 3_199
                    ? identity
                    : `evb-shape:${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
            })),
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        }}, 'mutations')).toThrow('mutations.shapes.shapes[3199].stableKey must contain at most 2048 UTF-8 bytes');
    });

    it.each([
        {
            family: 'shape stable key',
            payload: (identity: string) => ({shapes: {
                totalPages: 1,
                rewriteShapeState: true,
                shapes: [{
                    ...validShape,
                    stableKey: identity,
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            }}),
        },
        {
            family: 'shape fallback identity',
            payload: (identity: string) => ({shapes: {
                totalPages: 1,
                rewriteShapeState: true,
                shapes: [{
                    ...validShape,
                    annotationId: identity,
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            }}),
        },
        {
            family: 'shape id',
            payload: (identity: string) => ({shapes: {
                totalPages: 1,
                rewriteShapeState: true,
                shapes: [{
                    ...validShape,
                    id: identity,
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            }}),
        },
        {
            family: 'deleted shape identity',
            payload: (identity: string) => ({shapes: {
                totalPages: 1,
                rewriteShapeState: true,
                shapes: [],
                deletedAnnotationIds: [identity],
                deletedStableKeys: [],
            }}),
        },
        {
            family: 'deleted shape stable key',
            payload: (identity: string) => ({shapes: {
                totalPages: 1,
                rewriteShapeState: true,
                shapes: [],
                deletedAnnotationIds: [],
                deletedStableKeys: [identity],
            }}),
        },
        {
            family: 'note stable key',
            payload: (identity: string) => ({freeTextNotes: [{
                ...validFreeTextNote,
                stableKey: identity,
            }]}),
        },
        {
            family: 'markup app identity',
            payload: (identity: string) => ({markup: {hints: [{
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect: validFreeTextNote.markerRect,
                source: 'editor',
                appAnnotationId: identity,
            }]}}),
        },
        {
            family: 'markup annotation identity',
            payload: (identity: string) => ({markup: {hints: [{
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect: validFreeTextNote.markerRect,
                annotationId: identity,
            }]}}),
        },
        {
            family: 'markup id',
            payload: (identity: string) => ({markup: {hints: [{
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect: validFreeTextNote.markerRect,
                id: identity,
            }]}}),
        },
        {
            family: 'image stable key',
            payload: (identity: string) => ({placedImages: [{
                ...validImage,
                stableKey: identity,
            }]}),
        },
        {
            family: 'image annotation identity',
            payload: (identity: string) => ({placedImages: [{
                ...validImage,
                annotationId: identity,
            }]}),
        },
        {
            family: 'image recovery stable key',
            payload: (identity: string) => ({placedImageGeometryUpdates: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                stableKey: identity,
            }]}),
        },
        {
            family: 'image geometry annotation identity',
            payload: (identity: string) => ({placedImageGeometryUpdates: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                annotationId: identity,
            }]}),
        },
    ])('budgets $family at mutation admission in UTF-8 bytes', ({payload}) => {
        for (const identity of [
            'א'.repeat(1_024),
            'ع'.repeat(1_024),
            `${'界'.repeat(682)}ab`,
        ]) {
            expect(new TextEncoder().encode(identity)).toHaveLength(2_048);
            expect(() => normalizePdfNativeMutationSet(payload(identity), 'mutations')).not.toThrow();
            expect(() => normalizePdfNativeMutationSet(payload(`${identity}a`), 'mutations')).toThrow('2048 UTF-8 bytes');
        }
    });

    it('preserves absent image geometry identity fields', () => {
        const normalized = normalizePdfNativeMutationSet({placedImageGeometryUpdates: [{
            pageIndex: 0,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.2,
        }]}, 'mutations');
        expect(normalized.placedImageGeometryUpdates?.[0]).not.toHaveProperty('annotationId');
        expect(normalized.placedImageGeometryUpdates?.[0]).not.toHaveProperty('stableKey');
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

    it('separates the native-call limits from the atomic save limit', () => {
        const bindings = Array.from({length: 4_097}, (_, index) => ({
            annotationId: `annotation-${index}`,
            pdfRef: `${index + 1} 0 R`,
        }));
        expect(normalizePdfNativeAnnotationIdentityBindings(bindings)).toEqual(bindings);
        expect(() => normalizePdfNativeAnnotationIdentityBindings(bindings, 'chunk', {scope: 'chunk'}))
            .toThrow('at most 4096');
        expect(() => normalizePdfNativeAnnotationIdentityBindings(Array(500_001)))
            .toThrow('at most 500000');
        const largeReport = Array.from({length: 256}, (_, index) => ({
            annotationId: `${index}:` + '\u0001'.repeat(1_800),
            pdfRef: `${index + 1} 0 R`,
        }));
        expect(() => normalizePdfNativeAnnotationIdentityBindings(largeReport, 'chunk', {scope: 'chunk'}))
            .toThrow('byte budget');
    });

    it('keeps every new identity across a chunked save and bounds each report', () => {
        const mutations = normalizePdfNativeMutationSet({
            freeTextNotes: Array.from({length: 4_097}, (_, index) => ({
                ...validFreeTextNote,
                stableKey: `uid:0:new-${index}`,
            })),
            shapes: {
                totalPages: 1,
                rewriteShapeState: true,
                shapes: Array.from({length: 4_096}, (_, index) => ({
                    ...validShape,
                    stableKey: `evb-shape:${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
                })),
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            },
        }, 'mutations');
        let nextRef = 1;
        const reports = splitPdfNativeMutationSetIntoBoundedChunks(mutations).map(chunk => {
            const bindings = collectExpectedNativeIdentityIds(chunk).map(annotationId => ({
                annotationId,
                pdfRef: `${nextRef++} 0 R`,
            }));
            expect(bindings.length).toBeLessThanOrEqual(4_096);
            expect(new TextEncoder().encode(JSON.stringify(bindings)).byteLength).toBeLessThanOrEqual(256 * 1024);
            return bindings;
        });
        const allBindings = reports.flat();
        expect(normalizePdfNativeAnnotationIdentityBindings(allBindings)).toEqual(allBindings);
        expect(new Set(allBindings.map(binding => binding.annotationId)))
            .toEqual(new Set(collectExpectedNativeIdentityIds(mutations)));
        expect(allBindings).toHaveLength(8_193);
    });

    it('keeps escaped and Unicode identities inside the native report byte budget', () => {
        const mutations = normalizePdfNativeMutationSet({freeTextNotes: Array.from({length: 256}, (_, index) => ({
            ...validFreeTextNote,
            stableKey: `uid:${index}:` + '\u0001'.repeat(1_800) + 'é'.repeat(100),
        }))}, 'mutations');
        const chunks = splitPdfNativeMutationSetIntoBoundedChunks(mutations);
        const reports = chunks.map(chunk => collectExpectedNativeIdentityIds(chunk).map((annotationId, index) => ({
            annotationId,
            pdfRef: `${4_294_967_295 - index} 65535 R`,
        })));
        expect(reports.flat()).toHaveLength(256);
        for (const report of reports) {
            expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(256 * 1024);
        }
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
            markup: {hints: [{
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
                opacity: 0.45,
            }]},
            placedImages: [validImage],
        };

        const preloadPayload = normalizePdfNativeMutationSet(rawMutations, 'mutations');
        expect(preloadPayload.placedImages?.[0]?.source).toEqual(validImage.source);
        expect(preloadPayload.bookmarks?.items[0]).toMatchObject({
            pageIndex: 0,
            pageYRatio: 0.25,
        });
        expect(preloadPayload.geometryUpdates).toEqual([validNoteGeometryUpdate]);
        expect(preloadPayload.freeTextNotes?.[0]?.open).toBe(true);
        expect(preloadPayload.markup?.hints[0]?.opacity).toBe(0.45);
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

        expect(() => normalizePdfNativeMutationSet({markup: {hints: [{
            subtype: 'Highlight',
            pageIndex: 0,
            appAnnotationId: '   ',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.2,
            },
        }]}}, 'mutations')).toThrow('appAnnotationId must be a non-empty string or null');

        expect(() => normalizePdfNativeMutationSet({markup: {hints: [{
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
        }]}}, 'mutations')).toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems} rectangles`);

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
            markup: {hints: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems + 1},
                (_, index) => ({
                    subtype: 'Highlight',
                    pageIndex: 0,
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.2,
                    },
                    id: `markup-${index}`,
                }),
            )},
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
        expect(chunks.reduce((total, chunk) => total + (chunk.markup?.hints.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems + 1);
        expect(chunks.reduce((total, chunk) => total + (chunk.placedImages?.length ?? 0), 0))
            .toBe(PDF_NATIVE_MUTATION_LIMITS.placedImages + 1);
        for (const chunk of chunks) {
            expect(chunk.updates?.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates);
            expect(chunk.geometryUpdates?.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.noteGeometryUpdates);
            expect(chunk.textBoxes?.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.textBoxes);
            expect(chunk.pageLabels?.ranges.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges);
            expect(chunk.bookmarks?.items.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.bookmarkItems);
            expect(chunk.shapes?.shapes.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.shapes);
            expect(chunk.markup?.hints.length ?? 0).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems);
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

    it('admits portable PNG and JPEG data without native source handles', () => {
        for (const mimeType of [
            'image/png',
            'image/jpeg',
        ]) {
            const image = {
                ...validImage,
                source: undefined,
                mimeType,
                bytesBase64: 'AQID',
                byteLength: 3,
                sha256: 'AB'.repeat(32),
            };
            const normalized = normalizePdfNativeMutationSet({placedImages: [image]}, 'mutations');
            expect(normalized.placedImages?.[0]).toMatchObject({
                mimeType,
                bytesBase64: 'AQID',
                byteLength: 3,
                sha256: 'ab'.repeat(32),
            });
            expect(normalized.placedImages?.[0]).not.toHaveProperty('source');
        }
    });

    it('splits inline image bytes before they exceed the native JSON sidecar budget', () => {
        const normalized = normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            source: undefined,
            bytesBase64: 'AQID',
            byteLength: 3,
            sha256: 'a'.repeat(64),
        }]}, 'mutations');
        const images = normalized.placedImages ?? [];
        for (const image of images) {
            image.bytesBase64 = 'A'.repeat(Math.ceil(PDF_NATIVE_MUTATION_LIMITS.placedImageBytes / 3) * 4);
        }
        const chunks = splitPdfNativeMutationSetIntoBoundedChunks({placedImages: [
            ...images,
            ...images,
        ]});
        expect(chunks).toHaveLength(2);
        expect(chunks.map(chunk => chunk.placedImages?.length)).toEqual([
            1,
            1,
        ]);
        expect(chunks[1]?.continuation?.family).toBe('placedImages');
    });

    it('takes legacy handle metadata from the managed source', () => {
        const normalized = normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            byteLength: 99,
            sha256: '0'.repeat(64),
        }]}, 'mutations');
        expect(normalized.placedImages?.[0]?.source).toEqual(validImage.source);
        expect(normalized.placedImages?.[0]).not.toHaveProperty('byteLength');
        expect(normalized.placedImages?.[0]).not.toHaveProperty('sha256');
    });

    it.each([
        {source: validImage.source},
        {
            bytesBase64: 'AQI=',
            byteLength: 3,
        },
        {bytesBase64: '!!!='},
        {byteLength: PDF_NATIVE_MUTATION_LIMITS.placedImageBytes + 1},
        {sha256: 'not-a-sha256'},
    ])('rejects invalid inline image admission %j', (invalid) => {
        expect(() => normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            source: undefined,
            bytesBase64: 'AQID',
            byteLength: 3,
            sha256: 'ab'.repeat(32),
            ...invalid,
        }]}, 'mutations')).toThrow();
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

describe('rotated placed image canonical bounds', () => {
    it('preserves unrotated bounds when native page geometry must validate the painted corners', () => {
        const mutations = normalizePdfNativeMutationSet({placedImages: [{
            ...validImage,
            x: -0.05,
            y: 0.4,
            width: 0.3,
            height: 0.05,
            rotationDegrees: 90,
        }]}, 'mutations');
        expect(mutations.placedImages?.[0]).toMatchObject({
            x: -0.05,
            y: 0.4,
            width: 0.3,
            height: 0.05,
        });
    });
});
