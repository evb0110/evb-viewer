 
import type {
    IPdfNativeMarkupMutation,
    IPdfNativeMarkupSubtypeHint,
    IPdfNativeMutationSet,
    IPdfNativePlacedImage,
    IPdfNativeShapeAnnotation,
    IPdfNativeShapesMutation,
    IPdfNativeTextBoxMutation,
} from '@contracts/electronApiDocuments';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {parsePdfJsAnnotationRef} from '@contracts/pdfAnnotationRefs';
import {PDF_NATIVE_MUTATION_LIMITS} from '@contracts/nativePdfMutations';
import {PDF_NATIVE_IDENTITY_BINDING_LIMITS} from '@contracts/nativePdfIdentityBindings';
import type {
    IPdfNativeMutationContinuation,
    TPdfNativeMutationContinuationFamily,
} from '@contracts/nativePdfMutations';

function fail(message: string, _options?: unknown): never {
    throw new Error(message);
}

export function countBookmarkItems(items: readonly IPdfBookmarkEntry[]): number {
    return items.reduce((total, item) => total + 1 + countBookmarkItems(item.items), 0);
}

export function getTextBoxes(mutations: IPdfNativeMutationSet): readonly IPdfNativeTextBoxMutation[] {
    if (mutations.textBoxes !== undefined && mutations.freeTextEditors !== undefined) {
        fail('native PDF mutations must include only one of textBoxes or freeTextEditors');
    }
    return mutations.textBoxes ?? mutations.freeTextEditors ?? [];
}

export function shapePointCount(shape: IPdfNativeShapeAnnotation): number {
    return (shape.points?.length ?? 0) + (shape.strokes?.reduce((total, stroke) => total + stroke.length, 0) ?? 0);
}

export {
    normalizePdfNativeAnnotationIdentityBindings,
    PDF_NATIVE_MUTATION_ENUM_VALUES,
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
} from '@contracts/nativePdfMutations';

function addExpectedNativeIdentityCandidate(
    ids: Set<string>,
    candidate: string | null | undefined,
) {
    const normalizedCandidate = candidate?.trim();
    if (!normalizedCandidate) {
        return;
    }
    if (ids.has(normalizedCandidate)) {
        throw new Error(`Duplicate native annotation identity candidate ${normalizedCandidate}`);
    }
    ids.add(normalizedCandidate);
}

function addNewNativeAnnotationIdentityCandidate(
    ids: Set<string>,
    primaryIdentity: string | null | undefined,
    fallbackIdentity: string | null | undefined,
    existingAnnotationId: string | null | undefined,
) {
    if (parsePdfJsAnnotationRef(existingAnnotationId)) {
        return;
    }
    const normalizedPrimaryIdentity = primaryIdentity?.trim();
    if (normalizedPrimaryIdentity) {
        addExpectedNativeIdentityCandidate(ids, normalizedPrimaryIdentity);
        return;
    }
    addExpectedNativeIdentityCandidate(ids, fallbackIdentity?.trim());
}

function isNewNativeFreeTextNote(
    note: NonNullable<IPdfNativeMutationSet['freeTextNotes']>[number],
) {
    const stableKey = note.stableKey.trim();
    return !/^(?:ann|nm):/iu.test(stableKey);
}

/** Return identities the native writer can bind while creating annotations. */
export function collectExpectedNativeIdentityIds(mutations: IPdfNativeMutationSet): string[] {
    const ids = new Set<string>();
    for (const hint of mutations.markup?.hints ?? []) {
        const annotationId = hint.annotationId?.trim();
        const appAnnotationId = hint.appAnnotationId?.trim();
        if (
            !appAnnotationId
            || (hint.source !== 'editor' && hint.source !== 'editor-live')
            || parsePdfJsAnnotationRef(annotationId)
        ) {
            continue;
        }
        addExpectedNativeIdentityCandidate(ids, appAnnotationId);
    }
    for (const note of mutations.freeTextNotes ?? []) {
        if (isNewNativeFreeTextNote(note)) {
            addExpectedNativeIdentityCandidate(ids, note.stableKey);
        }
    }
    for (const editor of mutations.textBoxes ?? mutations.freeTextEditors ?? []) {
        addNewNativeAnnotationIdentityCandidate(ids, editor.stableKey, null, editor.annotationId);
    }
    for (const shape of mutations.shapes?.shapes ?? []) {
        addNewNativeAnnotationIdentityCandidate(ids, shape.stableKey, shape.annotationId, shape.annotationId);
    }
    for (const image of mutations.placedImages ?? []) {
        addNewNativeAnnotationIdentityCandidate(ids, image.stableKey, image.annotationId, image.annotationId);
    }
    return [...ids];
}
export type TPdfNativeMutationChunk = IPdfNativeMutationSet & {continuation?: IPdfNativeMutationContinuation;};

function sliceIntoChunks<T>(value: readonly T[], chunkSize: number): T[][] {
    if (value.length === 0) {
        return [[]];
    }
    const chunks: T[][] = [];
    for (let offset = 0; offset < value.length; offset += chunkSize) {
        chunks.push(value.slice(offset, offset + chunkSize));
    }
    return chunks;
}
interface IBookmarkMutationChunk {
    items: IPdfBookmarkEntry[];
    bookmarkPath?: number[];
}

function splitBookmarkItems(items: readonly IPdfBookmarkEntry[]): IBookmarkMutationChunk[] {
    const chunks: IBookmarkMutationChunk[] = [];
    let current: IPdfBookmarkEntry[] = [];
    let currentCount = 0;

    const flush = (bookmarkPath: number[]) => {
        if (current.length === 0) {
            return;
        }
        chunks.push({
            items: current,
            ...(bookmarkPath.length === 0 ? {} : {bookmarkPath}),
        });
        current = [];
        currentCount = 0;
    };

    const emitLevel = (levelItems: readonly IPdfBookmarkEntry[], bookmarkPath: number[]) => {
        levelItems.forEach((item, index) => {
            const itemCount = countBookmarkItems([item]);
            if (itemCount <= PDF_NATIVE_MUTATION_LIMITS.bookmarkItems
                && currentCount + itemCount <= PDF_NATIVE_MUTATION_LIMITS.bookmarkItems) {
                current.push(item);
                currentCount += itemCount;
                return;
            }

            if (itemCount <= PDF_NATIVE_MUTATION_LIMITS.bookmarkItems) {
                flush(bookmarkPath);
                current.push(item);
                currentCount = itemCount;
                return;
            }

            // A subtree cannot cross the native cap in one payload. Add its
            // parent as a shell first, then append each child level by path.
            // The shell keeps the original sibling index, so later fragments
            // can resolve it without flattening the outline hierarchy.
            if (currentCount === PDF_NATIVE_MUTATION_LIMITS.bookmarkItems) {
                flush(bookmarkPath);
            }
            current.push({
                ...item,
                items: [],
            });
            currentCount += 1;
            flush(bookmarkPath);
            emitLevel(item.items, [
                ...bookmarkPath,
                index,
            ]);
        });

        flush(bookmarkPath);
    };

    if (items.length === 0) {
        return [{items: []}];
    }
    emitLevel(items, []);
    return chunks;
}

interface IShapeMutationChunk {
    shapes: IPdfNativeShapeAnnotation[];
    deletedAnnotationIds: string[];
    deletedStableKeys: string[];
}

function splitShapeMutation(
    shapes: IPdfNativeShapesMutation,
    identityChunkItems: number,
): IShapeMutationChunk[] {
    const chunks: IShapeMutationChunk[] = [];
    let shapeIndex = 0;
    let deletedAnnotationIndex = 0;
    let deletedStableKeyIndex = 0;
    while (
        shapeIndex < shapes.shapes.length
        || deletedAnnotationIndex < shapes.deletedAnnotationIds.length
        || deletedStableKeyIndex < shapes.deletedStableKeys.length
        || chunks.length === 0
    ) {
        const chunkShapes: IPdfNativeShapeAnnotation[] = [];
        let pointCount = 0;
        while (chunkShapes.length < Math.min(PDF_NATIVE_MUTATION_LIMITS.shapes, identityChunkItems)) {
            const shape = shapes.shapes[shapeIndex];
            if (shape === undefined) {
                break;
            }
            const nextPointCount = pointCount + shapePointCount(shape);
            if (chunkShapes.length > 0 && nextPointCount > PDF_NATIVE_MUTATION_LIMITS.shapePoints) {
                break;
            }
            if (nextPointCount > PDF_NATIVE_MUTATION_LIMITS.shapePoints) {
                fail('shape mutations contain a chunk that exceeds the point limit', {errorKind: 'error'});
            }
            chunkShapes.push(shape);
            pointCount = nextPointCount;
            shapeIndex += 1;
        }
        const deletedAnnotationIds = shapes.deletedAnnotationIds.slice(
            deletedAnnotationIndex,
            deletedAnnotationIndex + PDF_NATIVE_MUTATION_LIMITS.shapeDeletedItems,
        );
        deletedAnnotationIndex += deletedAnnotationIds.length;
        const deletedStableKeys = shapes.deletedStableKeys.slice(
            deletedStableKeyIndex,
            deletedStableKeyIndex + PDF_NATIVE_MUTATION_LIMITS.shapeDeletedItems,
        );
        deletedStableKeyIndex += deletedStableKeys.length;
        chunks.push({
            shapes: chunkShapes,
            deletedAnnotationIds,
            deletedStableKeys,
        });
    }
    return chunks;
}

function markupGeometryCount(hint: IPdfNativeMarkupSubtypeHint): number {
    return hint.markupGeometry?.length ?? 0;
}

function splitMarkupMutation(markup: IPdfNativeMarkupMutation, identityChunkItems: number): IPdfNativeMarkupMutation[] {
    const chunks: IPdfNativeMarkupMutation[] = [];
    let hintIndex = 0;
    while (hintIndex < markup.hints.length || chunks.length === 0) {
        const hints: IPdfNativeMarkupSubtypeHint[] = [];
        let geometryCount = 0;
        while (hints.length < Math.min(PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems, identityChunkItems)) {
            const hint = markup.hints[hintIndex];
            if (hint === undefined) {
                break;
            }
            const nextGeometryCount = geometryCount + markupGeometryCount(hint);
            if (hints.length > 0 && nextGeometryCount > PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems) {
                break;
            }
            if (nextGeometryCount > PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems) {
                fail('text-markup mutations contain a hint that exceeds the geometry limit', {errorKind: 'error'});
            }
            hints.push(hint);
            geometryCount = nextGeometryCount;
            hintIndex += 1;
        }
        if (hints.length === 0) {
            fail('text-markup mutations could not be split into bounded chunks', {errorKind: 'error'});
        }
        chunks.push({hints});
    }
    return chunks;
}

// PDF object ids are u32/u16 in the native writer. Reserve their largest
// canonical reference before it is known, including JSON escaping and UTF-8.
function identityBindingReportBytes(annotationIds: readonly string[]) {
    return new TextEncoder().encode(JSON.stringify(annotationIds.map(annotationId => ({
        annotationId,
        pdfRef: '4294967295 65535 R',
    })))).byteLength;
}

export function splitPdfNativeMutationSetIntoBoundedChunks(
    mutations: IPdfNativeMutationSet,
): TPdfNativeMutationChunk[] {
    const identityIds = collectExpectedNativeIdentityIds(mutations);
    const maxEntryBytes = identityIds.reduce((largest, id) => Math.max(largest, identityBindingReportBytes([id]) - 1), 1);
    const identityChunkItems = Math.min(
        PDF_NATIVE_IDENTITY_BINDING_LIMITS.chunkItems,
        Math.floor((PDF_NATIVE_IDENTITY_BINDING_LIMITS.chunkBytes - 1) / maxEntryBytes),
    );
    if (identityChunkItems === 0) fail('A native annotation identity exceeds the report byte budget');
    const noteChunkItems = Math.min(PDF_NATIVE_MUTATION_LIMITS.noteChanges, identityChunkItems);
    const noteChunks: Array<Pick<TPdfNativeMutationChunk, 'updates' | 'geometryUpdates' | 'placedImageGeometryUpdates' | 'freeTextNotes' | 'deletes'>> = [];
    let updateIndex = 0;
    let geometryUpdateIndex = 0;
    let placedImageGeometryUpdateIndex = 0;
    let noteIndex = 0;
    let deleteIndex = 0;
    while (
        updateIndex < (mutations.updates?.length ?? 0)
        || geometryUpdateIndex < (mutations.geometryUpdates?.length ?? 0)
        || placedImageGeometryUpdateIndex < (mutations.placedImageGeometryUpdates?.length ?? 0)
        || noteIndex < (mutations.freeTextNotes?.length ?? 0)
        || deleteIndex < (mutations.deletes?.length ?? 0)
        || noteChunks.length === 0
    ) {
        const updates = (mutations.updates ?? []).slice(updateIndex, updateIndex + noteChunkItems);
        updateIndex += updates.length;
        const geometryUpdates = (mutations.geometryUpdates ?? []).slice(geometryUpdateIndex, geometryUpdateIndex + Math.max(
            0,
            noteChunkItems - updates.length,
        ));
        geometryUpdateIndex += geometryUpdates.length;
        const placedImageGeometryUpdates = (mutations.placedImageGeometryUpdates ?? []).slice(
            placedImageGeometryUpdateIndex,
            placedImageGeometryUpdateIndex + Math.max(
                0,
                noteChunkItems - updates.length - geometryUpdates.length,
            ),
        );
        placedImageGeometryUpdateIndex += placedImageGeometryUpdates.length;
        const freeTextNotes = (mutations.freeTextNotes ?? []).slice(noteIndex, noteIndex + Math.max(
            0,
            noteChunkItems - updates.length - geometryUpdates.length
                - placedImageGeometryUpdates.length,
        ));
        noteIndex += freeTextNotes.length;
        const deletes = (mutations.deletes ?? []).slice(deleteIndex, deleteIndex + Math.max(
            0,
            noteChunkItems - updates.length - geometryUpdates.length
                - placedImageGeometryUpdates.length - freeTextNotes.length,
        ));
        deleteIndex += deletes.length;
        if (updates.length + geometryUpdates.length + placedImageGeometryUpdates.length
            + freeTextNotes.length + deletes.length === 0) {
            break;
        }
        noteChunks.push({
            ...(updates.length > 0 ? {updates} : {}),
            ...(geometryUpdates.length > 0 ? {geometryUpdates} : {}),
            ...(placedImageGeometryUpdates.length > 0 ? {placedImageGeometryUpdates} : {}),
            ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
            ...(deletes.length > 0 ? {deletes} : {}),
        });
    }

    const textBoxes = getTextBoxes(mutations);
    const textBoxChunks = sliceIntoChunks(textBoxes, Math.min(PDF_NATIVE_MUTATION_LIMITS.textBoxes, identityChunkItems));
    const {
        pageLabels: pageLabelsMutation,
        bookmarks: bookmarksMutation,
        shapes: shapesMutation,
    } = mutations;
    const pageLabelChunks = pageLabelsMutation === undefined
        ? []
        : sliceIntoChunks(pageLabelsMutation.ranges, PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges)
            .map(ranges => ({
                ...pageLabelsMutation,
                ranges,
            }));
    const bookmarkChunks = bookmarksMutation === undefined
        ? []
        : splitBookmarkItems(bookmarksMutation.items)
            .map(({
                items,
                bookmarkPath,
            }) => ({
                ...bookmarksMutation,
                items,
                ...(bookmarkPath === undefined ? {} : {bookmarkPath}),
            }));
    const shapeChunks = shapesMutation === undefined ? [] : splitShapeMutation(shapesMutation, identityChunkItems);
    const markupChunks = mutations.markup === undefined ? [] : splitMarkupMutation(mutations.markup, identityChunkItems);
    const imageChunks: IPdfNativePlacedImage[][] = [[]];
    let imageChunkBytes = 0;
    for (const image of mutations.placedImages ?? []) {
        const encodedBytes = image.bytesBase64?.length ?? 0;
        let chunk = imageChunks[imageChunks.length - 1]!;
        if (chunk.length >= Math.min(PDF_NATIVE_MUTATION_LIMITS.placedImages, identityChunkItems)
            || (chunk.length > 0 && imageChunkBytes + encodedBytes > PDF_NATIVE_MUTATION_LIMITS.placedImagesInlineChunkBytes)) {
            chunk = [];
            imageChunks.push(chunk);
            imageChunkBytes = 0;
        }
        chunk.push(image);
        imageChunkBytes += encodedBytes;
    }

    const base: TPdfNativeMutationChunk = {};
    const chunks: TPdfNativeMutationChunk[] = [base];

    const appendFamilyChunks = <T>(
        family: TPdfNativeMutationContinuationFamily,
        values: readonly T[],
        append: (chunk: TPdfNativeMutationChunk, value: T) => void,
        continuationFields?: (value: T) => Partial<IPdfNativeMutationContinuation>,
    ) => {
        for (const [
            index,
            value,
        ] of values.entries()) {
            const chunk: TPdfNativeMutationChunk = index === 0 ? {} : {continuation: {
                family,
                chunkIndex: index,
                chunkCount: values.length,
                ...continuationFields?.(value),
            }};
            append(chunk, value);
            const combined = {
                ...base,
                ...chunk,
            };
            const combinedIds = index === 0 ? collectExpectedNativeIdentityIds(combined) : [];
            if (index === 0 && combinedIds.length <= PDF_NATIVE_IDENTITY_BINDING_LIMITS.chunkItems
                && identityBindingReportBytes(combinedIds) <= PDF_NATIVE_IDENTITY_BINDING_LIMITS.chunkBytes) {
                Object.assign(base, chunk);
            } else {
                chunks.push(chunk);
            }
        }
    };

    appendFamilyChunks('notes', noteChunks, (chunk, value) => Object.assign(chunk, value));

    appendFamilyChunks('textBoxes', textBoxes.length ? textBoxChunks : [], (chunk, value) => {chunk.textBoxes = value;});
    appendFamilyChunks('pageLabels', pageLabelChunks, (chunk, value) => {chunk.pageLabels = value;});
    appendFamilyChunks(
        'bookmarks',
        bookmarkChunks,
        (chunk, value) => {
            const {
                bookmarkPath: _bookmarkPath,
                ...bookmarks
            } = value as typeof value & {bookmarkPath?: number[]};
            chunk.bookmarks = bookmarks;
        },
        value => {
            const bookmarkPath = (value as typeof value & {bookmarkPath?: number[]}).bookmarkPath;
            return bookmarkPath === undefined ? {} : {bookmarkPath};
        },
    );
    if (shapesMutation !== undefined) {
        appendFamilyChunks('shapes', shapeChunks, (chunk, value) => {
            chunk.shapes = {
                ...shapesMutation,
                ...value,
                rewriteShapeState: value === shapeChunks[0] && shapesMutation.rewriteShapeState,
            };
        });
    }
    appendFamilyChunks('markup', markupChunks, (chunk, value) => {chunk.markup = value;});
    appendFamilyChunks('placedImages', mutations.placedImages?.length ? imageChunks : [], (chunk, value) => {chunk.placedImages = value;});
    if (Object.keys(base).length === 0) fail('native PDF mutations could not be split into bounded chunks');
    return chunks;
}
