import {requireEpochMs} from '@contracts/timestamps';

export const PDF_NATIVE_MUTATION_LIMITS = {
    collectionItems: 100_000,
    noteTextUpdates: 256,
    noteGeometryUpdates: 256,
    noteChanges: 256,
    textBoxes: 256,
    textBoxTextBytes: 64 * 1024,
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
    markupGeometryItems: 512,
    markupTextLength: 2_048,
    placedImages: 16,
    placedImageBytes: 128 * 1024 * 1024,
    placedImagesTotalBytes: 512 * 1024 * 1024,
    // Native sidecars admit 256 MiB. Leave 64 MiB for other mutation families.
    placedImagesInlineChunkBytes: 192 * 1024 * 1024,
    placedImageGeometryUpdates: 256,
} as const;

const PDF_NATIVE_F32_MAX = 3.4028234663852886e38;
const PDF_NATIVE_ROTATIONS = [
    0,
    90,
    180,
    270,
] as const;

export interface IPdfNativeValidationOptions {errorKind?: 'typeError' | 'error';}

function createValidationError(message: string, options: IPdfNativeValidationOptions = {}) {
    return options.errorKind === 'error'
        ? new Error(message)
        : new TypeError(message);
}

export function isNativeF32(value: number) {
    return Number.isFinite(value) && Math.abs(value) <= PDF_NATIVE_F32_MAX;
}

export function fail(message: string, options: IPdfNativeValidationOptions = {}): never {
    throw createValidationError(message, options);
}

export function normalizeNativeF32(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !isNativeF32(value)) {
        fail(`${label} must be a finite number`, options);
    }
    return value;
}

export function isPdfRotation(value: unknown): value is typeof PDF_NATIVE_ROTATIONS[number] {
    return PDF_NATIVE_ROTATIONS.some(rotation => rotation === value);
}

export function normalizeOptionalString(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
    maxUtf8Bytes?: number,
) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        fail(`${label} must be a string or null`, options);
    }
    if (maxUtf8Bytes !== undefined && new TextEncoder().encode(value).byteLength > maxUtf8Bytes) {
        fail(`${label} must contain at most ${maxUtf8Bytes} UTF-8 bytes`, options);
    }
    return value;
}

export function normalizeOptionalTimestamp(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${label} must be a finite positive timestamp or null`, options);
    }
    return requireEpochMs(Math.trunc(value));
}
