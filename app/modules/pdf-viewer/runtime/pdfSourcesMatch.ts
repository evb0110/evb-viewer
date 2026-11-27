import type {TPdfSource} from '@app/types/pdfUi';

function isPdfPathSource(source: TPdfSource): source is Extract<TPdfSource, {kind: 'path'}> {
    return !(source instanceof Blob);
}

/**
 * Compares the source identity accepted by PDF.js with the current viewer
 * source. Vue may wrap or replace the serialized path descriptor while its
 * underlying file stays unchanged, so reference equality is only meaningful
 * for Blob sources.
 */
export function pdfSourcesMatch(left: TPdfSource | null, right: TPdfSource | null) {
    if (left === null || right === null) {
        return left === right;
    }
    if (left instanceof Blob || right instanceof Blob) {
        return left === right;
    }
    return (
        isPdfPathSource(left) &&
        isPdfPathSource(right) &&
        left.path === right.path &&
        left.size === right.size &&
        (left.revision ?? null) === (right.revision ?? null)
    );
}
