/* eslint-disable max-lines -- Native mutation validation and bounded continuation must share the exact protocol limits. */
import type {
    Merge,
    SetRequired,
    Simplify,
} from 'type-fest';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeBookmarksMutation,
    IPdfNativeFreeTextNote,
    IPdfNativeFreeTextNoteMarkerRect,
    IPdfNativeTextBoxMutation,
    IPdfNativeMarkupMarkerRect,
    IPdfNativeMarkupSubtypeHint,
    IPdfNativeMutationSet,
    IPdfNativeNoteChanges,
    IPdfNativePageLabelRange,
    IPdfNativePageLabelsMutation,
    IPdfNativePlacedImage,
    IPdfNativePlacedImageGeometryUpdate,
    IPdfNativeShapeAnnotation,
    IPdfNativeShapePoint,
    IPdfNativeShapesMutation,
    IPdfNoteGeometryUpdate,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import {decodeManagedTempFileHandle} from '@contracts/electronApiDocuments';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_MARKUP_SUBTYPES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import {
    isPdfNativeNormalizedBoxInsidePageBounds,
    isPdfNativeNormalizedRectInsidePageBounds,
} from '@contracts/nativePdfPageBounds';
import { requirePageIndex } from '@contracts/pageNumbers';
import {parsePdfJsAnnotationRef} from '@contracts/pdfAnnotationRefs';
import { PDF_PAGE_LABEL_STYLE_VALUES } from '@contracts/pdfPageLabels';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

export const PDF_NATIVE_MUTATION_LIMITS = {
    collectionItems: 100_000,
    noteTextUpdates: 256,
    noteGeometryUpdates: 256,
    noteChanges: 256,
    textBoxes: 256,
    /** @deprecated Use textBoxes. */
    freeTextEditors: 256,
    noteTextLength: 64 * 1024,
    pageLabelRanges: 2_048,
    bookmarkItems: 5_000,
    bookmarkDepth: 64,
    shapes: 4_096,
    shapeDeletedItems: 4_096,
    shapePoints: 20_000,
    shapeStrokes: 4_096,
    shapeTextLength: 2_048,
    markupItems: 4_096,
    markupGeometryItems: 512,
    markupTextLength: 2_048,
    placedImages: 16,
    placedImageBytes: 128 * 1024 * 1024,
    placedImagesTotalBytes: 512 * 1024 * 1024,
    placedImageGeometryUpdates: 256,
} as const;

export const PDF_NATIVE_MUTATION_ENUM_VALUES = {
    pageLabelStyles: PDF_PAGE_LABEL_STYLE_VALUES,
    shapeTypes: PDF_ANNOTATION_SHAPE_TYPES,
    shapePdfSubtypes: PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    shapeLineEndStyles: PDF_ANNOTATION_LINE_END_STYLES,
    markupSubtypes: PDF_ANNOTATION_MARKUP_SUBTYPES,
} as const;

export const PDF_NATIVE_DATE_PATTERN = /^D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?$/u;

const PDF_NATIVE_F32_MAX = 3.4028234663852886e38;

type TPdfNativeValidationErrorKind = 'typeError' | 'error';
export type IPdfNativePlacedImageNativeToolPayload = Simplify<
    Omit<SetRequired<IPdfNativePlacedImage, 'rotationDegrees'>, 'source'> & {
        bytesPath: string;
        byteLength: number;
        sha256: string;
    }
>;

export type TPdfNativeMutationSetNativeToolPayload = Simplify<
    Merge<IPdfNativeMutationSet, {
        continuation?: IPdfNativeMutationContinuation;
        placedImages?: IPdfNativePlacedImageNativeToolPayload[];
    }>
>;

export type TPdfNativeMutationContinuationFamily =
    | 'notes'
    | 'textBoxes'
    /** @deprecated Accepted for continuations produced before the text-box rename. */
    | 'freeTextEditors'
    | 'pageLabels'
    | 'bookmarks'
    | 'shapes'
    | 'markup'
    | 'placedImages';

export interface IPdfNativeMutationContinuation {
    family: TPdfNativeMutationContinuationFamily;
    chunkIndex: number;
    chunkCount: number;
    bookmarkPath?: number[];
}

export interface IPdfNativeValidationOptions {errorKind?: TPdfNativeValidationErrorKind;}

interface IPdfNativeNoteTextUpdateValidationOptions extends IPdfNativeValidationOptions {allowEmpty?: boolean;}

interface IPdfNativeMutationSetValidationOptions extends IPdfNativeValidationOptions {}

interface IPdfNativeBookmarkState {
    count: number;
    depth: number;
}

interface IPdfNativeShapePointState {count: number;}

interface IPdfNativePlacedImageByteState {totalBytes: number;}

function normalizePlacedImageGeometryUpdates(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativePlacedImageGeometryUpdate[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.placedImageGeometryUpdates) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.placedImageGeometryUpdates} updates`, options);
    }
    return value.map((item, index) => {
        if (!isRecord(item)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        const pageIndex = item.pageIndex;
        if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer`, options);
        }
        const annotationId = item.annotationId;
        if (annotationId !== undefined && annotationId !== null && typeof annotationId !== 'string') {
            fail(`${label}[${index}].annotationId must be a string or null`, options);
        }
        const stableKey = item.stableKey;
        if (stableKey !== undefined && (typeof stableKey !== 'string' || stableKey.trim().length === 0)) {
            fail(`${label}[${index}].stableKey must be a non-empty string`, options);
        }
        const x = normalizeFiniteUnitNumber(item.x, `${label}[${index}].x`, options);
        const y = normalizeFiniteUnitNumber(item.y, `${label}[${index}].y`, options);
        const width = normalizeFiniteUnitNumber(item.width, `${label}[${index}].width`, options);
        const height = normalizeFiniteUnitNumber(item.height, `${label}[${index}].height`, options);
        if (!isPdfNativeNormalizedBoxInsidePageBounds({
            x,
            y,
            width,
            height,
        })) {
            fail(`${label}[${index}] must fit inside the normalized page bounds`, options);
        }
        const rotationDegrees = item.rotationDegrees;
        if (rotationDegrees !== undefined && rotationDegrees !== null
            && (typeof rotationDegrees !== 'number' || !isNativeF32(rotationDegrees))) {
            fail(`${label}[${index}].rotationDegrees must be a finite number or null`, options);
        }
        return {
            pageIndex: requirePageIndex(pageIndex),
            ...(stableKey === undefined ? {} : {stableKey: stableKey.trim()}),
            ...(annotationId === undefined ? {} : {annotationId}),
            x,
            y,
            width,
            height,
            ...(rotationDegrees === undefined ? {} : {rotationDegrees}),
        };
    });
}

function createValidationError(message: string, options: IPdfNativeValidationOptions = {}) {
    return options.errorKind === 'error'
        ? new Error(message)
        : new TypeError(message);
}

function isNativeF32(value: number) {
    return Number.isFinite(value) && Math.abs(value) <= PDF_NATIVE_F32_MAX;
}

function fail(message: string, options: IPdfNativeValidationOptions = {}): never {
    throw createValidationError(message, options);
}

function normalizePositiveInteger(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        fail(`${label} must be a positive integer`, options);
    }
    return value;
}

function normalizeFiniteUnitNumber(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !isNativeF32(value) || value < 0 || value > 1) {
        fail(`${label} must be a finite number from 0 to 1`, options);
    }
    return value;
}

function normalizeFiniteNonNegativeNumber(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !isNativeF32(value) || value < 0) {
        fail(`${label} must be a finite non-negative number`, options);
    }
    return value;
}

function normalizeOptionalFiniteUnitNumber(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    return normalizeFiniteUnitNumber(value, label, options);
}

function normalizeOptionalString(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        fail(`${label} must be a string or null`, options);
    }
    return value;
}

function normalizeNativeShapeOptionalString(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    const normalized = normalizeOptionalString(value, label, options);
    if (normalized !== null && normalized.length > PDF_NATIVE_MUTATION_LIMITS.shapeTextLength) {
        fail(`${label} is too long`, options);
    }
    return normalized;
}

function normalizeOptionalTimestamp(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${label} must be a finite positive timestamp or null`, options);
    }
    return Math.trunc(value);
}

function normalizeNativeMarkerRect(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeFreeTextNoteMarkerRect {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const left = normalizeFiniteUnitNumber(value.left, `${label}.left`, options);
    const top = normalizeFiniteUnitNumber(value.top, `${label}.top`, options);
    const width = normalizeFiniteUnitNumber(value.width, `${label}.width`, options);
    const height = normalizeFiniteUnitNumber(value.height, `${label}.height`, options);
    if (!isPdfNativeNormalizedRectInsidePageBounds({
        left,
        top,
        width,
        height,
    })) {
        fail(`${label} must fit inside the normalized page bounds`, options);
    }
    return {
        left,
        top,
        width,
        height,
    };
}

function normalizeFreeTextNoteMarkerRect(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeFreeTextNoteMarkerRect {
    return normalizeNativeMarkerRect(value, label, options);
}

function normalizeMarkupMarkerRect(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeMarkupMarkerRect {
    return normalizeNativeMarkerRect(value, label, options);
}

function normalizeMarkupGeometry(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeMarkupMarkerRect[] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems} rectangles`, options);
    }
    return Array.from(value, (rect, index) =>
        normalizeMarkupMarkerRect(rect, `${label}[${index}]`, options));
}

function validateMarkupGeometryBudget(
    count: number,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (count > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(
            `${label} must contain at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} rectangles in total`,
            options,
        );
    }
}

function normalizeFreeTextNotes(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} notes`, options);
    }

    return Array.from(value, (note, index): IPdfNativeFreeTextNote => {
        if (!isRecord(note)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        if (
            typeof note.pageIndex !== 'number'
            || !Number.isSafeInteger(note.pageIndex)
            || note.pageIndex < 0
        ) {
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer`, options);
        }
        const stableKey = typeof note.stableKey === 'string' ? note.stableKey.trim() : '';
        if (!stableKey) {
            fail(`${label}[${index}].stableKey must be a non-empty string`, options);
        }
        if (typeof note.text !== 'string') {
            fail(`${label}[${index}].text must be a string`, options);
        }
        if (note.text.length > PDF_NATIVE_MUTATION_LIMITS.noteTextLength) {
            fail(`${label}[${index}].text must contain at most ${PDF_NATIVE_MUTATION_LIMITS.noteTextLength} characters`, options);
        }
        return {
            pageIndex: requirePageIndex(note.pageIndex),
            stableKey,
            text: note.text,
            markerRect: normalizeFreeTextNoteMarkerRect(note.markerRect, `${label}[${index}].markerRect`, options),
            author: normalizeOptionalString(note.author, `${label}[${index}].author`, options),
            color: normalizeOptionalString(note.color, `${label}[${index}].color`, options),
            createdAt: normalizeOptionalTimestamp(note.createdAt, `${label}[${index}].createdAt`, options),
        };
    });
}

function normalizeTextBoxes(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} text boxes`, options);
    }

    return Array.from(value, (editor, index): IPdfNativeTextBoxMutation => {
        if (!isRecord(editor)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        if (
            typeof editor.pageIndex !== 'number'
            || !Number.isSafeInteger(editor.pageIndex)
            || editor.pageIndex < 0
        ) {
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer`, options);
        }
        const stableKey = typeof editor.stableKey === 'string' ? editor.stableKey.trim() : '';
        if (!stableKey || stableKey.length > 512) {
            fail(`${label}[${index}].stableKey must be a non-empty string with at most 512 characters`, options);
        }
        const annotationId = normalizeOptionalString(
            editor.annotationId,
            `${label}[${index}].annotationId`,
            options,
        );
        if (typeof editor.text !== 'string' || editor.text.length > PDF_NATIVE_MUTATION_LIMITS.noteTextLength) {
            fail(`${label}[${index}].text must be a string with at most ${PDF_NATIVE_MUTATION_LIMITS.noteTextLength} characters`, options);
        }
        if (!Array.from(editor.text).every(character => (
            character === '\n'
            || character === '\t'
            || (character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) <= 0x7e)
        ))) {
            fail(`${label}[${index}].text contains characters unsupported by the bounded Helvetica appearance`, options);
        }
        if (
            !Array.isArray(editor.rect)
            || editor.rect.length !== 4
            || editor.rect.some(coordinate => typeof coordinate !== 'number' || !isNativeF32(coordinate))
            || editor.rect[2] <= editor.rect[0]
            || editor.rect[3] <= editor.rect[1]
        ) {
            fail(`${label}[${index}].rect must be a finite PDF rectangle with positive width and height`, options);
        }
        if (![
            0,
            90,
            180,
            270,
        ].includes(editor.rotation as number)) {
            fail(`${label}[${index}].rotation must be 0, 90, 180, or 270`, options);
        }
        if (typeof editor.fontSize !== 'number' || !isNativeF32(editor.fontSize) || editor.fontSize <= 0 || editor.fontSize > 512) {
            fail(`${label}[${index}].fontSize must be a finite number from 0 to 512`, options);
        }
        if (
            !Array.isArray(editor.color)
            || editor.color.length !== 3
            || editor.color.some(component => typeof component !== 'number' || !Number.isInteger(component) || component < 0 || component > 255)
        ) {
            fail(`${label}[${index}].color must contain three integer RGB components from 0 to 255`, options);
        }
        return {
            pageIndex: requirePageIndex(editor.pageIndex),
            stableKey,
            ...(editor.annotationId === undefined ? {} : {annotationId}),
            text: editor.text,
            rect: editor.rect.map(coordinate => Number(coordinate)) as [number, number, number, number],
            rotation: editor.rotation as 0 | 90 | 180 | 270,
            fontSize: editor.fontSize,
            color: editor.color.map(component => Number(component)) as [number, number, number],
            ...(editor.author === undefined
                ? {}
                : {author: normalizeOptionalString(editor.author, `${label}[${index}].author`, options)}),
            ...(editor.createdAt === undefined
                ? {}
                : {createdAt: normalizeOptionalTimestamp(editor.createdAt, `${label}[${index}].createdAt`, options)}),
            ...(editor.modifiedAt === undefined
                ? {}
                : {modifiedAt: normalizeOptionalTimestamp(editor.modifiedAt, `${label}[${index}].modifiedAt`, options)}),
        };
    });
}

function normalizeAnnotationDeletes(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} deletes`, options);
    }

    return Array.from(value, (item, index): IPdfNativeAnnotationDelete => {
        if (!isRecord(item)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        const stableKey = typeof item.stableKey === 'string' ? item.stableKey.trim() : '';
        const hasRef = item.objectNumber !== undefined || item.generationNumber !== undefined;
        const hasValidRef = typeof item.objectNumber === 'number'
            && Number.isSafeInteger(item.objectNumber)
            && item.objectNumber >= 1
            && typeof item.generationNumber === 'number'
            && Number.isSafeInteger(item.generationNumber)
            && item.generationNumber >= 0
            && item.generationNumber <= 65_535;
        const createdAt = item.createdAt ?? null;
        if (
            typeof item.pageIndex !== 'number'
            || !Number.isSafeInteger(item.pageIndex)
            || item.pageIndex < 0
            || (hasRef && !hasValidRef)
            || (!hasValidRef && !stableKey)
            || (createdAt !== null && (
                typeof createdAt !== 'number'
                || !Number.isFinite(createdAt)
                || createdAt < 0
            ))
        ) {
            fail(`${label}[${index}] must contain a valid pageIndex and either a PDF object ref or stableKey`, options);
        }
        const normalizedDelete = {
            pageIndex: requirePageIndex(item.pageIndex),
            ...(stableKey ? {stableKey} : {}),
            ...(createdAt !== null ? {createdAt: Math.trunc(createdAt)} : {}),
        };
        if (!hasValidRef) {
            return normalizedDelete;
        }
        return {
            ...normalizedDelete,
            objectNumber: item.objectNumber as number,
            generationNumber: item.generationNumber as number,
        };
    });
}

function normalizeOptionalPdfNativeNoteTextUpdates(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    return normalizePdfNativeNoteTextUpdates(value, label, {
        ...options,
        allowEmpty: true,
    });
}

function normalizePdfNativeNoteGeometryUpdates(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNoteGeometryUpdate[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} geometry updates`, options);
    }

    return Array.from(value, (update, index): IPdfNoteGeometryUpdate => {
        if (!isRecord(update)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        const objectNumber = update.objectNumber;
        const generationNumber = update.generationNumber;
        const pageIndex = update.pageIndex;
        if (typeof objectNumber !== 'number' || !Number.isSafeInteger(objectNumber) || objectNumber < 1) {
            fail(`${label}[${index}].objectNumber must be a positive safe integer`, options);
        }
        if (
            typeof generationNumber !== 'number'
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || generationNumber > 65_535
        ) {
            fail(`${label}[${index}].generationNumber must be an integer from 0 to 65535`, options);
        }
        if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer`, options);
        }
        return {
            objectNumber,
            generationNumber,
            pageIndex: requirePageIndex(pageIndex),
            markerRect: normalizeNativeMarkerRect(update.markerRect, `${label}[${index}].markerRect`, options),
        };
    });
}

function normalizePageLabelRange(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativePageLabelRange {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const startPage = value.startPage;
    const style = value.style;
    const prefix = value.prefix;
    const startNumber = value.startNumber;
    if (typeof startPage !== 'number' || !Number.isSafeInteger(startPage) || startPage < 1) {
        fail(`${label}.startPage must be a positive safe integer`, options);
    }
    if (style !== null && !isOneOf(PDF_NATIVE_MUTATION_ENUM_VALUES.pageLabelStyles, style)) {
        fail(`${label}.style must be a valid PDF page-label style or null`, options);
    }
    if (typeof prefix !== 'string') {
        fail(`${label}.prefix must be a string`, options);
    }
    if (typeof startNumber !== 'number' || !Number.isSafeInteger(startNumber) || startNumber < 1) {
        fail(`${label}.startNumber must be a positive safe integer`, options);
    }
    return {
        startPage,
        style,
        prefix,
        startNumber,
    };
}

function normalizePageLabelsMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativePageLabelsMutation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const totalPages = normalizePositiveInteger(value.totalPages, `${label}.totalPages`, options);
    if (!Array.isArray(value.ranges) || value.ranges.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label}.ranges must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} ranges`, options);
    }
    return {
        totalPages,
        ranges: Array.from(value.ranges, (range, index) =>
            normalizePageLabelRange(range, `${label}.ranges[${index}]`, options)),
    };
}

function normalizeBookmarkColor(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
        fail(`${label} must be a #RRGGBB color string or null`, options);
    }
    return value.toLowerCase();
}

function normalizeBookmarkItems(
    value: unknown,
    label: string,
    state: IPdfNativeBookmarkState,
    options: IPdfNativeValidationOptions,
): IPdfBookmarkEntry[] {
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`, options);
    }
    if (state.depth > PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth) {
        fail(`${label} exceeds the maximum bookmark depth`, options);
    }
    return Array.from(value, (item, index): IPdfBookmarkEntry => {
        state.count += 1;
        if (state.count > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
            fail(`bookmark mutations must include at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} items`, options);
        }
        if (!isRecord(item)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        const title = item.title;
        if (typeof title !== 'string') {
            fail(`${label}[${index}].title must be a string`, options);
        }
        const pageIndex = item.pageIndex;
        if (
            pageIndex !== null
            && (
                typeof pageIndex !== 'number'
                || !Number.isSafeInteger(pageIndex)
                || pageIndex < 0
            )
        ) {
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer or null`, options);
        }
        const namedDest = item.namedDest;
        if (namedDest !== null && typeof namedDest !== 'string') {
            fail(`${label}[${index}].namedDest must be a string or null`, options);
        }
        const pageYRatio = item.pageYRatio;
        if (
            pageYRatio !== undefined
            && pageYRatio !== null
            && (
                typeof pageYRatio !== 'number'
                || !isNativeF32(pageYRatio)
                || pageYRatio < 0
                || pageYRatio > 1
            )
        ) {
            fail(`${label}[${index}].pageYRatio must be a finite number from 0 to 1 or null`, options);
        }
        const previousDepth = state.depth;
        state.depth = previousDepth + 1;
        let items: IPdfBookmarkEntry[];
        try {
            items = normalizeBookmarkItems(item.items, `${label}[${index}].items`, state, options);
        } finally {
            state.depth = previousDepth;
        }
        if (state.count > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
            fail(`bookmark mutations must include at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} items`, options);
        }
        return {
            title,
            pageIndex: pageIndex,
            pageYRatio: typeof pageYRatio === 'number' ? pageYRatio : null,
            namedDest: namedDest,
            bold: item.bold === true,
            italic: item.italic === true,
            color: normalizeBookmarkColor(item.color, `${label}[${index}].color`, options),
            items,
        };
    });
}

function normalizeBookmarksMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeBookmarksMutation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    return {
        totalPages: normalizePositiveInteger(value.totalPages, `${label}.totalPages`, options),
        untitledLabel: typeof value.untitledLabel === 'string' ? value.untitledLabel : '',
        items: normalizeBookmarkItems(value.items, `${label}.items`, {
            count: 0,
            depth: 0,
        }, options),
    };
}

function normalizeShapePoint(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeShapePoint {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    return {
        x: normalizeFiniteUnitNumber(value.x, `${label}.x`, options),
        y: normalizeFiniteUnitNumber(value.y, `${label}.y`, options),
    };
}

function normalizeShapePoints(
    value: unknown,
    label: string,
    state: IPdfNativeShapePointState,
    options: IPdfNativeValidationOptions,
    shapeState: IPdfNativeShapePointState,
) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`, options);
    }
    if (value.length > PDF_NATIVE_MUTATION_LIMITS.shapePoints) {
        fail(`${label} must include at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points`, options);
    }
    shapeState.count += value.length;
    if (shapeState.count > PDF_NATIVE_MUTATION_LIMITS.shapePoints) {
        fail(
            `${label} must contain at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points per shape`,
            options,
        );
    }
    state.count += value.length;
    if (state.count > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`shape mutations must include at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} points`, options);
    }
    return Array.from(value, (point, index) => normalizeShapePoint(point, `${label}[${index}]`, options));
}

function normalizeShapeStrokes(
    value: unknown,
    label: string,
    state: IPdfNativeShapePointState,
    options: IPdfNativeValidationOptions,
    shapeState: IPdfNativeShapePointState,
) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`, options);
    }
    if (value.length > PDF_NATIVE_MUTATION_LIMITS.shapeStrokes) {
        fail(`${label} must contain at most ${PDF_NATIVE_MUTATION_LIMITS.shapeStrokes} strokes`, options);
    }
    return Array.from(value, (points, index) => normalizeShapePoints(
        points,
        `${label}[${index}]`,
        state,
        options,
        shapeState,
    ) ?? []);
}

function normalizeShapeEnum<T extends string>(
    value: unknown,
    label: string,
    allowed: readonly T[],
    options: IPdfNativeValidationOptions,
): T;
function normalizeShapeEnum<T extends string>(
    value: unknown,
    label: string,
    allowed: readonly T[],
    options: IPdfNativeValidationOptions & { optional: true },
): T | null;
function normalizeShapeEnum<T extends string>(
    value: unknown,
    label: string,
    allowed: readonly T[],
    options: IPdfNativeValidationOptions & { optional?: boolean },
): T | null {
    if (value === undefined || value === null) {
        if (options.optional) {
            return null;
        }
        fail(`${label} is required`, options);
    }
    if (!isOneOf(allowed, value)) {
        fail(`${label} is not a supported value`, options);
    }
    return value;
}

function normalizeShapeAnnotation(
    value: unknown,
    label: string,
    state: IPdfNativeShapePointState,
    options: IPdfNativeValidationOptions,
): IPdfNativeShapeAnnotation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const type = normalizeShapeEnum(value.type, `${label}.type`, PDF_NATIVE_MUTATION_ENUM_VALUES.shapeTypes, options);
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        fail(`${label}.pageIndex must be a non-negative safe integer`, options);
    }
    const color = value.color;
    if (typeof color !== 'string' || color.length > PDF_NATIVE_MUTATION_LIMITS.shapeTextLength) {
        fail(`${label}.color must be a color string`, options);
    }
    const opacity = value.opacity;
    if (typeof opacity !== 'number' || !isNativeF32(opacity) || opacity < 0 || opacity > 1) {
        fail(`${label}.opacity must be a finite number from 0 to 1`, options);
    }
    const id = normalizeNativeShapeOptionalString(value.id, `${label}.id`, options);
    const shapeState = {count: 0};
    const points = normalizeShapePoints(value.points, `${label}.points`, state, options, shapeState);
    const strokes = normalizeShapeStrokes(value.strokes, `${label}.strokes`, state, options, shapeState);
    const shape: IPdfNativeShapeAnnotation = {
        type,
        pageIndex: requirePageIndex(pageIndex),
        x: normalizeFiniteUnitNumber(value.x, `${label}.x`, options),
        y: normalizeFiniteUnitNumber(value.y, `${label}.y`, options),
        width: normalizeFiniteNonNegativeNumber(value.width, `${label}.width`, options),
        height: normalizeFiniteNonNegativeNumber(value.height, `${label}.height`, options),
        x2: normalizeOptionalFiniteUnitNumber(value.x2, `${label}.x2`, options),
        y2: normalizeOptionalFiniteUnitNumber(value.y2, `${label}.y2`, options),
        color,
        fillColor: normalizeNativeShapeOptionalString(value.fillColor, `${label}.fillColor`, options),
        opacity,
        strokeWidth: normalizeFiniteNonNegativeNumber(value.strokeWidth, `${label}.strokeWidth`, options),
        annotationId: normalizeNativeShapeOptionalString(value.annotationId, `${label}.annotationId`, options),
        stableKey: normalizeNativeShapeOptionalString(value.stableKey, `${label}.stableKey`, options),
        pdfSubtype: normalizeShapeEnum(
            value.pdfSubtype,
            `${label}.pdfSubtype`,
            PDF_NATIVE_MUTATION_ENUM_VALUES.shapePdfSubtypes,
            {
                ...options,
                optional: true,
            },
        ),
        lineStartStyle: normalizeShapeEnum(
            value.lineStartStyle,
            `${label}.lineStartStyle`,
            PDF_NATIVE_MUTATION_ENUM_VALUES.shapeLineEndStyles,
            {
                ...options,
                optional: true,
            },
        ),
        lineEndStyle: normalizeShapeEnum(
            value.lineEndStyle,
            `${label}.lineEndStyle`,
            PDF_NATIVE_MUTATION_ENUM_VALUES.shapeLineEndStyles,
            {
                ...options,
                optional: true,
            },
        ),
        createdAt: normalizeOptionalTimestamp(value.createdAt, `${label}.createdAt`, options),
        modifiedAt: normalizeOptionalTimestamp(value.modifiedAt, `${label}.modifiedAt`, options),
    };
    if (id !== null) {
        shape.id = id;
    }
    if (points !== undefined) {
        shape.points = points;
    }
    if (strokes !== undefined) {
        shape.strokes = strokes;
    }
    return shape;
}

function normalizeStringArray(
    value: unknown,
    label: string,
    maxItems: number,
    maxTextLength: number,
    options: IPdfNativeValidationOptions,
) {
    if (!Array.isArray(value) || value.length > maxItems) {
        fail(`${label} must be an array with at most ${maxItems} items`, options);
    }
    return Array.from(value, (item, index) => {
        if (typeof item !== 'string' || item.length > maxTextLength) {
            fail(`${label}[${index}] must be a string`, options);
        }
        return item.trim();
    }).filter(item => item.length > 0);
}

function normalizeMarkupSubtype(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (!isOneOf(PDF_NATIVE_MUTATION_ENUM_VALUES.markupSubtypes, value)) {
        fail(`${label} must be a supported text-markup subtype`, options);
    }
    return value;
}

function normalizeMarkupOptionalString(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    const normalized = normalizeOptionalString(value, label, options);
    if (normalized !== null && normalized.length > PDF_NATIVE_MUTATION_LIMITS.markupTextLength) {
        fail(`${label} is too long`, options);
    }
    return normalized;
}

function normalizeMarkupOptionalIndex(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail(`${label} must be a non-negative safe integer or null`, options);
    }
    return value;
}
export {normalizePdfNativeAnnotationIdentityBindings} from '@contracts/nativePdfIdentityBindings';
function normalizeMarkupOverride(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (!Array.isArray(value) || value.length !== 2) {
        fail(`${label} must be an [annotationId, subtype] tuple`, options);
    }
    const tuple: unknown[] = value;
    const [
        annotationId,
        subtype,
    ] = tuple;
    if (
        typeof annotationId !== 'string'
        || annotationId.trim().length === 0
        || annotationId.length > PDF_NATIVE_MUTATION_LIMITS.markupTextLength
    ) {
        fail(`${label}[0] must be a bounded annotation id`, options);
    }
    return [
        annotationId.trim(),
        normalizeMarkupSubtype(subtype, `${label}[1]`, options),
    ] as const;
}

function normalizeMarkupHint(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeMarkupSubtypeHint {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        fail(`${label}.pageIndex must be a non-negative safe integer`, options);
    }
    const appAnnotationId = normalizeMarkupOptionalString(
        value.appAnnotationId,
        `${label}.appAnnotationId`,
        options,
    );
    const canonicalAppAnnotationId = appAnnotationId?.trim() ?? null;
    if (canonicalAppAnnotationId !== null && canonicalAppAnnotationId.length === 0) {
        fail(`${label}.appAnnotationId must be a non-empty string or null`, options);
    }
    return {
        subtype: normalizeMarkupSubtype(value.subtype, `${label}.subtype`, options),
        pageIndex: requirePageIndex(pageIndex),
        markerRect: normalizeMarkupMarkerRect(value.markerRect, `${label}.markerRect`, options),
        markupGeometry: normalizeMarkupGeometry(value.markupGeometry, `${label}.markupGeometry`, options),
        ...(value.appAnnotationId === undefined ? {} : {appAnnotationId: canonicalAppAnnotationId}),
        annotationId: normalizeMarkupOptionalString(value.annotationId, `${label}.annotationId`, options),
        color: normalizeMarkupOptionalString(value.color, `${label}.color`, options),
        ...(value.contents === undefined
            ? {}
            : {contents: normalizeMarkupOptionalString(value.contents, `${label}.contents`, options)}),
        id: normalizeMarkupOptionalString(value.id, `${label}.id`, options),
        pageMarkupIndex: normalizeMarkupOptionalIndex(value.pageMarkupIndex, `${label}.pageMarkupIndex`, options),
        source: normalizeMarkupOptionalString(value.source, `${label}.source`, options),
    };
}

function normalizeMarkupMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): NonNullable<IPdfNativeMutationSet['markup']> {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    if (!Array.isArray(value.overrides) || value.overrides.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label}.overrides must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} items`, options);
    }
    if (!Array.isArray(value.hints) || value.hints.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label}.hints must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} items`, options);
    }
    const overrides = Array.from(value.overrides, (override, index) =>
        normalizeMarkupOverride(override, `${label}.overrides[${index}]`, options));
    let geometryCount = 0;
    const hints = Array.from(value.hints, (hint, index) => {
        const normalized = normalizeMarkupHint(hint, `${label}.hints[${index}]`, options);
        geometryCount += normalized.markupGeometry?.length ?? 0;
        validateMarkupGeometryBudget(geometryCount, `${label}.hints`, options);
        return normalized;
    });
    if (overrides.length + hints.length === 0) {
        fail(`${label} must include at least one text-markup rewrite`, options);
    }
    return {
        overrides,
        hints,
    };
}

function normalizePlacedImageSource(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): {
    source: NonNullable<ReturnType<typeof decodeManagedTempFileHandle>>;
    byteLength: number;
} {
    if (
        !decodeManagedTempFileHandle(value)
    ) {
        fail(`${label} must be a valid managed binary handle`, options);
    }

    const source = decodeManagedTempFileHandle(value);
    if (!source || source.size === 0 || source.size > PDF_NATIVE_MUTATION_LIMITS.placedImageBytes) {
        fail(`${label} must reference bounded non-empty image bytes`, options);
    }

    return {
        source,
        byteLength: source.size,
    };
}

function normalizePlacedImage(
    value: unknown,
    label: string,
    byteState: IPdfNativePlacedImageByteState,
    options: IPdfNativeValidationOptions,
): SetRequired<IPdfNativePlacedImage, 'rotationDegrees'> {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        fail(`${label}.pageIndex must be a non-negative safe integer`, options);
    }
    const x = normalizeFiniteUnitNumber(value.x, `${label}.x`, options);
    const y = normalizeFiniteUnitNumber(value.y, `${label}.y`, options);
    const width = normalizeFiniteUnitNumber(value.width, `${label}.width`, options);
    const height = normalizeFiniteUnitNumber(value.height, `${label}.height`, options);
    if (!isPdfNativeNormalizedBoxInsidePageBounds({
        x,
        y,
        width,
        height,
    })) {
        fail(`${label} must fit inside the normalized page bounds`, options);
    }
    const rotationDegrees = value.rotationDegrees ?? null;
    if (
        rotationDegrees !== null
        && (typeof rotationDegrees !== 'number' || !isNativeF32(rotationDegrees))
    ) {
        fail(`${label}.rotationDegrees must be a finite number or null`, options);
    }
    if (value.mimeType !== 'image/jpeg') {
        fail(`${label}.mimeType must be image/jpeg`, options);
    }
    const stableKey = normalizeOptionalString(value.stableKey, `${label}.stableKey`, options);
    if (value.stableKey !== undefined && (stableKey === null || stableKey.trim().length === 0)) {
        fail(`${label}.stableKey must be a non-empty string`, options);
    }
    const annotationId = normalizeOptionalString(value.annotationId, `${label}.annotationId`, options);
    const normalized = {
        pageIndex: requirePageIndex(pageIndex),
        ...(value.stableKey === undefined ? {} : {stableKey: stableKey?.trim() as string}),
        ...(value.annotationId === undefined ? {} : {annotationId}),
        x,
        y,
        width,
        height,
        rotationDegrees,
        mimeType: 'image/jpeg' as const,
    };

    const imageSource = normalizePlacedImageSource(value.source, `${label}.source`, options);
    byteState.totalBytes += imageSource.byteLength;
    if (byteState.totalBytes > PDF_NATIVE_MUTATION_LIMITS.placedImagesTotalBytes) {
        fail(`placed image bytes must total at most ${PDF_NATIVE_MUTATION_LIMITS.placedImagesTotalBytes} bytes`, options);
    }
    return {
        ...normalized,
        source: imageSource.source,
    };
}

function normalizePlacedImages(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} images`, options);
    }
    const byteState = {totalBytes: 0};
    return Array.from(value, (image, index) =>
        normalizePlacedImage(image, `${label}[${index}]`, byteState, options));
}

function normalizeShapesMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeShapesMutation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    if (!Array.isArray(value.shapes) || value.shapes.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label}.shapes must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} shapes`, options);
    }
    const pointState = {count: 0};
    return {
        totalPages: normalizePositiveInteger(value.totalPages, `${label}.totalPages`, options),
        rewriteShapeState: value.rewriteShapeState === true,
        shapes: Array.from(value.shapes, (shape, index) =>
            normalizeShapeAnnotation(shape, `${label}.shapes[${index}]`, pointState, options)),
        deletedAnnotationIds: normalizeStringArray(
            value.deletedAnnotationIds,
            `${label}.deletedAnnotationIds`,
            PDF_NATIVE_MUTATION_LIMITS.collectionItems,
            PDF_NATIVE_MUTATION_LIMITS.shapeTextLength,
            options,
        ),
        deletedStableKeys: normalizeStringArray(
            value.deletedStableKeys,
            `${label}.deletedStableKeys`,
            PDF_NATIVE_MUTATION_LIMITS.collectionItems,
            PDF_NATIVE_MUTATION_LIMITS.shapeTextLength,
            options,
        ),
    };
}

export function normalizePdfNativeModifiedAt(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions = {},
) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!PDF_NATIVE_DATE_PATTERN.test(normalized)) {
        fail(`${label} must be a PDF date string`, options);
    }
    return normalized;
}

export function normalizePdfNativeNoteTextUpdates(
    value: unknown,
    label: string,
    options: IPdfNativeNoteTextUpdateValidationOptions = {},
): IPdfNoteTextUpdate[] {
    if (
        !Array.isArray(value)
        || (!options.allowEmpty && value.length === 0)
        || value.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems
    ) {
        const emptyDescription = options.allowEmpty ? 'an array' : 'a non-empty array';
        fail(`${label} must be ${emptyDescription} with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} updates`, options);
    }

    return Array.from(value, (update, index): IPdfNoteTextUpdate => {
        if (!isRecord(update)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        const objectNumber = update.objectNumber;
        const generationNumber = update.generationNumber;
        const text = update.text;
        if (typeof objectNumber !== 'number' || !Number.isSafeInteger(objectNumber) || objectNumber < 1) {
            fail(`${label}[${index}].objectNumber must be a positive safe integer`, options);
        }
        if (
            typeof generationNumber !== 'number'
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || generationNumber > 65_535
        ) {
            fail(`${label}[${index}].generationNumber must be an integer from 0 to 65535`, options);
        }
        if (typeof text !== 'string') {
            fail(`${label}[${index}].text must be a string`, options);
        }
        if (text.length > PDF_NATIVE_MUTATION_LIMITS.noteTextLength) {
            fail(`${label}[${index}].text must contain at most ${PDF_NATIVE_MUTATION_LIMITS.noteTextLength} characters`, options);
        }
        return {
            objectNumber,
            generationNumber,
            text,
        };
    });
}

export function normalizePdfNativeNoteChanges(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions = {},
): IPdfNativeNoteChanges {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const updates = normalizeOptionalPdfNativeNoteTextUpdates(value.updates, `${label}.updates`, options);
    const geometryUpdates = normalizePdfNativeNoteGeometryUpdates(value.geometryUpdates, `${label}.geometryUpdates`, options);
    const freeTextNotes = normalizeFreeTextNotes(value.freeTextNotes, `${label}.freeTextNotes`, options);
    const deletes = normalizeAnnotationDeletes(value.deletes, `${label}.deletes`, options);
    if (updates.length + geometryUpdates.length + freeTextNotes.length + deletes.length === 0) {
        fail(`${label} must include at least one note change`, options);
    }
    const normalized: IPdfNativeNoteChanges = {
        ...(updates.length > 0 ? {updates} : {}),
        ...(geometryUpdates.length > 0 ? {geometryUpdates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
    };
    validateNativeMutationCollectionBudget(normalized, label, options);
    return normalized;
}

export function normalizePdfNativeMutationSet(
    value: unknown,
    label: string,
    options: IPdfNativeMutationSetValidationOptions = {},
): IPdfNativeMutationSet {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const updates = normalizeOptionalPdfNativeNoteTextUpdates(value.updates, `${label}.updates`, options);
    const geometryUpdates = normalizePdfNativeNoteGeometryUpdates(value.geometryUpdates, `${label}.geometryUpdates`, options);
    const freeTextNotes = normalizeFreeTextNotes(value.freeTextNotes, `${label}.freeTextNotes`, options);
    if (value.textBoxes !== undefined && value.freeTextEditors !== undefined) {
        fail(`${label} must include only one of textBoxes or freeTextEditors`, options);
    }
    const textBoxes = normalizeTextBoxes(
        value.textBoxes ?? value.freeTextEditors,
        `${label}.textBoxes`,
        options,
    );
    const deletes = normalizeAnnotationDeletes(value.deletes, `${label}.deletes`, options);
    const pageLabels = value.pageLabels === undefined
        ? null
        : normalizePageLabelsMutation(value.pageLabels, `${label}.pageLabels`, options);
    const bookmarks = value.bookmarks === undefined
        ? null
        : normalizeBookmarksMutation(value.bookmarks, `${label}.bookmarks`, options);
    const shapes = value.shapes === undefined
        ? null
        : normalizeShapesMutation(value.shapes, `${label}.shapes`, options);
    const markup = value.markup === undefined
        ? null
        : normalizeMarkupMutation(value.markup, `${label}.markup`, options);
    const placedImages = normalizePlacedImages(value.placedImages, `${label}.placedImages`, options);
    const placedImageGeometryUpdates = normalizePlacedImageGeometryUpdates(
        value.placedImageGeometryUpdates,
        `${label}.placedImageGeometryUpdates`,
        options,
    );
    if (
        updates.length + geometryUpdates.length + freeTextNotes.length + deletes.length + textBoxes.length === 0
        && !pageLabels
        && !bookmarks
        && !shapes
        && !markup
        && placedImages.length === 0
        && placedImageGeometryUpdates.length === 0
    ) {
        fail(`${label} must include at least one native PDF mutation`, options);
    }
    const normalized: IPdfNativeMutationSet = {
        ...(updates.length > 0 ? {updates} : {}),
        ...(geometryUpdates.length > 0 ? {geometryUpdates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(textBoxes.length > 0 ? {textBoxes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
        ...(pageLabels ? {pageLabels} : {}),
        ...(bookmarks ? {bookmarks} : {}),
        ...(shapes ? {shapes} : {}),
        ...(markup ? {markup} : {}),
        ...(placedImages.length > 0 ? {placedImages} : {}),
        ...(placedImageGeometryUpdates.length > 0 ? {placedImageGeometryUpdates} : {}),
    };
    validateNativeMutationCollectionBudget(normalized, label, options);
    return normalized;
}

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

function countBookmarkItems(items: readonly IPdfBookmarkEntry[]): number {
    return items.reduce((total, item) => total + 1 + countBookmarkItems(item.items), 0);
}

function getTextBoxes(mutations: IPdfNativeMutationSet): readonly IPdfNativeTextBoxMutation[] {
    if (mutations.textBoxes !== undefined && mutations.freeTextEditors !== undefined) {
        fail('native PDF mutations must include only one of textBoxes or freeTextEditors', {errorKind: 'error'});
    }
    return mutations.textBoxes ?? mutations.freeTextEditors ?? [];
}

function countNativeMutationItems(mutations: IPdfNativeMutationSet): number {
    let total = 0;
    const add = (count: number) => {
        total = Math.min(
            PDF_NATIVE_MUTATION_LIMITS.collectionItems + 1,
            total + count,
        );
    };
    add(mutations.updates?.length ?? 0);
    add(mutations.geometryUpdates?.length ?? 0);
    add(mutations.freeTextNotes?.length ?? 0);
    add(getTextBoxes(mutations).length);
    add(mutations.deletes?.length ?? 0);
    add(mutations.pageLabels?.ranges.length ?? 0);
    add(mutations.bookmarks ? countBookmarkItems(mutations.bookmarks.items) : 0);
    if (mutations.shapes) {
        add(mutations.shapes.shapes.length);
        add(mutations.shapes.deletedAnnotationIds.length);
        add(mutations.shapes.deletedStableKeys.length);
        for (const shape of mutations.shapes.shapes) {
            add((shape.strokes?.length ?? 0) + shapePointCount(shape));
        }
    }
    if (mutations.markup) {
        add(mutations.markup.overrides.length);
        add(mutations.markup.hints.length);
        for (const hint of mutations.markup.hints) {
            add(hint.markupGeometry?.length ?? 0);
        }
    }
    add(mutations.placedImages?.length ?? 0);
    add(mutations.placedImageGeometryUpdates?.length ?? 0);
    return total;
}

function validateNativeMutationCollectionBudget(
    mutations: IPdfNativeMutationSet,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (countNativeMutationItems(mutations) > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(
            `${label} exceed the ${PDF_NATIVE_MUTATION_LIMITS.collectionItems}-item aggregate admission ceiling`,
            options,
        );
    }
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

function shapePointCount(shape: IPdfNativeShapeAnnotation): number {
    return (shape.points?.length ?? 0) + (shape.strokes?.reduce((total, stroke) => total + stroke.length, 0) ?? 0);
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
        while (shapeIndex < shapes.shapes.length && chunkShapes.length < PDF_NATIVE_MUTATION_LIMITS.shapes) {
            const shape = shapes.shapes[shapeIndex]!;
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

interface IMarkupMutationChunk {
    overrides: Array<readonly [string, IPdfNativeMarkupSubtypeHint['subtype']]>;
    hints: IPdfNativeMarkupSubtypeHint[];
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
        while (hintIndex < markup.hints.length && hints.length < PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems) {
            const hint = markup.hints[hintIndex]!;
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

    const textBoxes = getTextBoxes(mutations);
    const textBoxChunks = sliceIntoChunks(textBoxes, PDF_NATIVE_MUTATION_LIMITS.textBoxes);
    const pageLabelChunks = mutations.pageLabels === undefined
        ? []
        : sliceIntoChunks(mutations.pageLabels.ranges, PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges)
            .map(ranges => ({
                ...mutations.pageLabels!,
                ranges,
            }));
    const bookmarkChunks = mutations.bookmarks === undefined
        ? []
        : splitBookmarkItems(mutations.bookmarks.items)
            .map(({
                items,
                bookmarkPath,
            }) => ({
                ...mutations.bookmarks!,
                items,
                ...(bookmarkPath === undefined ? {} : {bookmarkPath}),
            }));
    const shapeChunks = mutations.shapes === undefined ? [] : splitShapeMutation(mutations.shapes);
    const markupChunks = mutations.markup === undefined ? [] : splitMarkupMutation(mutations.markup);
    const imageChunks = sliceIntoChunks(mutations.placedImages ?? [], PDF_NATIVE_MUTATION_LIMITS.placedImages);

    const chunks: TPdfNativeMutationChunk[] = [];
    const base: TPdfNativeMutationChunk = {};
    const firstNotes = noteChunks[0];
    if (firstNotes) Object.assign(base, firstNotes);
    const firstTextBoxes = textBoxChunks[0];
    if (textBoxes.length && firstTextBoxes) base.textBoxes = firstTextBoxes;
    const firstPageLabels = pageLabelChunks[0];
    if (firstPageLabels) base.pageLabels = firstPageLabels;
    const firstBookmarks = bookmarkChunks[0];
    if (firstBookmarks) base.bookmarks = firstBookmarks;
    const firstShapes = shapeChunks[0];
    if (firstShapes) {
        base.shapes = {
            ...mutations.shapes!,
            ...firstShapes,
            rewriteShapeState: mutations.shapes!.rewriteShapeState,
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
        for (let index = 1; index < values.length; index += 1) {
            const chunk: TPdfNativeMutationChunk = {continuation: {
                family,
                chunkIndex: index,
                chunkCount: values.length,
                ...continuationFields?.(values[index]!),
            }};
            append(chunk, values[index]!);
            chunks.push(chunk);
        }
    };

    appendFamilyChunks('notes', noteChunks, (chunk, value) => Object.assign(chunk, value));
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
    appendFamilyChunks('shapes', shapeChunks, (chunk, value) => {
        chunk.shapes = {
            ...mutations.shapes!,
            ...value,
            rewriteShapeState: false,
        };
    });
    appendFamilyChunks('markup', markupChunks, (chunk, value) => {chunk.markup = value;});
    appendFamilyChunks('placedImages', imageChunks, (chunk, value) => {chunk.placedImages = value;});
    return chunks;
}
