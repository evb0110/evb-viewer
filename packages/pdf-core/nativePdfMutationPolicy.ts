 
import type {
    IPdfNativeMarkupSubtypeHint,
    IPdfNativeMutationSet,
    IPdfNativePlacedImage,
    IPdfNativeShapeAnnotation,
    IPdfNativeShapesMutation,
} from '@contracts/electronApiDocuments';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {parsePdfJsAnnotationRef} from '@contracts/pdfAnnotationRefs';
import {
    countBookmarkItems,
    getTextBoxes,
    PDF_NATIVE_MUTATION_LIMITS,
    shapePointCount,
} from '@contracts/nativePdfMutations';
import type {
    IPdfNativeMutationContinuation,
    TPdfNativeMutationContinuationFamily,
} from '@contracts/nativePdfMutations';

function fail(message: string, _options?: unknown): never {
    throw new Error(message);
}

export {
    normalizePdfNativeAnnotationIdentityBindings,
    PDF_NATIVE_MUTATION_ENUM_VALUES,
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
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
        while (chunkShapes.length < PDF_NATIVE_MUTATION_LIMITS.shapes) {
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

interface IMarkupMutationChunk {
    overrides: Array<readonly [string, IPdfNativeMarkupSubtypeHint['subtype']]>;
    hints: IPdfNativeMarkupSubtypeHint[];
}

function markupGeometryCount(hint: IPdfNativeMarkupSubtypeHint): number {
    return hint.markupGeometry?.length ?? 0;
}

function splitMarkupMutation(markup: NonNullable<IPdfNativeMutationSet['markup']>): IMarkupMutationChunk[] {
    const chunks: IMarkupMutationChunk[] = [];
    let overrideIndex = 0;
    let hintIndex = 0;
    while (overrideIndex < markup.overrides.length || hintIndex < markup.hints.length || chunks.length === 0) {
        const overrides = markup.overrides.slice(
            overrideIndex,
            overrideIndex + PDF_NATIVE_MUTATION_LIMITS.markupItems,
        );
        overrideIndex += overrides.length;
        const hints: IPdfNativeMarkupSubtypeHint[] = [];
        let geometryCount = 0;
        while (hints.length < PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems) {
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
        if (overrides.length === 0 && hints.length === 0) {
            fail('text-markup mutations could not be split into bounded chunks', {errorKind: 'error'});
        }
        chunks.push({
            overrides,
            hints,
        });
    }
    return chunks;
}

export function splitPdfNativeMutationSetIntoBoundedChunks(
    mutations: IPdfNativeMutationSet,
): TPdfNativeMutationChunk[] {
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
        const updates = (mutations.updates ?? []).slice(updateIndex, updateIndex + PDF_NATIVE_MUTATION_LIMITS.noteChanges);
        updateIndex += updates.length;
        const geometryUpdates = (mutations.geometryUpdates ?? []).slice(geometryUpdateIndex, geometryUpdateIndex + Math.max(
            0,
            PDF_NATIVE_MUTATION_LIMITS.noteChanges - updates.length,
        ));
        geometryUpdateIndex += geometryUpdates.length;
        const placedImageGeometryUpdates = (mutations.placedImageGeometryUpdates ?? []).slice(
            placedImageGeometryUpdateIndex,
            placedImageGeometryUpdateIndex + Math.max(
                0,
                PDF_NATIVE_MUTATION_LIMITS.noteChanges - updates.length - geometryUpdates.length,
            ),
        );
        placedImageGeometryUpdateIndex += placedImageGeometryUpdates.length;
        const freeTextNotes = (mutations.freeTextNotes ?? []).slice(noteIndex, noteIndex + Math.max(
            0,
            PDF_NATIVE_MUTATION_LIMITS.noteChanges - updates.length - geometryUpdates.length
                - placedImageGeometryUpdates.length,
        ));
        noteIndex += freeTextNotes.length;
        const deletes = (mutations.deletes ?? []).slice(deleteIndex, deleteIndex + Math.max(
            0,
            PDF_NATIVE_MUTATION_LIMITS.noteChanges - updates.length - geometryUpdates.length
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

    // Keep the legacy field in the chunk writer until old callers complete the
    // migration to textBoxes.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const editorChunks = sliceIntoChunks(mutations.freeTextEditors ?? [], PDF_NATIVE_MUTATION_LIMITS.freeTextEditors);
    const textBoxes = getTextBoxes(mutations);
    const textBoxChunks = sliceIntoChunks(textBoxes, PDF_NATIVE_MUTATION_LIMITS.textBoxes);
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
    const shapeChunks = shapesMutation === undefined ? [] : splitShapeMutation(shapesMutation);
    const markupChunks = mutations.markup === undefined ? [] : splitMarkupMutation(mutations.markup);
    const imageChunks: IPdfNativePlacedImage[][] = [[]];
    let imageChunkBytes = 0;
    for (const image of mutations.placedImages ?? []) {
        const encodedBytes = image.bytesBase64?.length ?? 0;
        let chunk = imageChunks[imageChunks.length - 1]!;
        if (chunk.length >= PDF_NATIVE_MUTATION_LIMITS.placedImages
            || (chunk.length > 0 && imageChunkBytes + encodedBytes > PDF_NATIVE_MUTATION_LIMITS.placedImagesInlineChunkBytes)) {
            chunk = [];
            imageChunks.push(chunk);
            imageChunkBytes = 0;
        }
        chunk.push(image);
        imageChunkBytes += encodedBytes;
    }

    const chunks: TPdfNativeMutationChunk[] = [];
    const base: TPdfNativeMutationChunk = {};
    const firstNotes = noteChunks[0];
    if (firstNotes) Object.assign(base, firstNotes);
    const firstEditors = editorChunks[0];
    if (mutations.freeTextEditors?.length && firstEditors) base.freeTextEditors = firstEditors;
    const firstTextBoxes = textBoxChunks[0];
    if (textBoxes.length && firstTextBoxes) base.textBoxes = firstTextBoxes;
    const firstPageLabels = pageLabelChunks[0];
    if (firstPageLabels) base.pageLabels = firstPageLabels;
    const firstBookmarks = bookmarkChunks[0];
    if (firstBookmarks) base.bookmarks = firstBookmarks;
    const firstShapes = shapeChunks[0];
    if (shapesMutation !== undefined && firstShapes) {
        base.shapes = {
            ...shapesMutation,
            ...firstShapes,
            rewriteShapeState: shapesMutation.rewriteShapeState,
        };
    }
    const firstMarkup = markupChunks[0];
    if (firstMarkup) base.markup = firstMarkup;
    const firstImages = imageChunks[0];
    if (mutations.placedImages?.length && firstImages) base.placedImages = firstImages;
    if (Object.keys(base).length === 0) {
        fail('native PDF mutations could not be split into bounded chunks', {errorKind: 'error'});
    }
    chunks.push(base);

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
            if (index === 0) {
                continue;
            }
            const chunk: TPdfNativeMutationChunk = {continuation: {
                family,
                chunkIndex: index,
                chunkCount: values.length,
                ...continuationFields?.(value),
            }};
            append(chunk, value);
            chunks.push(chunk);
        }
    };

    appendFamilyChunks('notes', noteChunks, (chunk, value) => Object.assign(chunk, value));
    appendFamilyChunks('freeTextEditors', editorChunks, (chunk, value) => {chunk.freeTextEditors = value;});
    appendFamilyChunks('textBoxes', textBoxChunks, (chunk, value) => {chunk.textBoxes = value;});
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
                rewriteShapeState: false,
            };
        });
    }
    appendFamilyChunks('markup', markupChunks, (chunk, value) => {chunk.markup = value;});
    appendFamilyChunks('placedImages', imageChunks, (chunk, value) => {chunk.placedImages = value;});
    return chunks;
}
