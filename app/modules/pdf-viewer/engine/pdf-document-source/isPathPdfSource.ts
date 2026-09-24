import type {
    IPdfPathSource,
    TPdfSource,
} from '@app/types/pdfUi';

export function isPathPdfSource(value: TPdfSource | null | undefined): value is IPdfPathSource {
    return Boolean(
        value
        && typeof value === 'object'
        && !(value instanceof Blob)
        && typeof value.path === 'string',
    );
}
