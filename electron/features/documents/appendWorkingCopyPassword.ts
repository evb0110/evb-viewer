import {
    isPdfDecryptPassword,
    PDF_DECRYPT_PASSWORD_MAX_BYTES,
} from '@contracts/pdfDecryptSchemas';

export function assertOptionalPdfDecryptPassword(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isPdfDecryptPassword(value)) {
        throw new Error(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
    }
    return value;
}

export function appendWorkingCopyPassword(
    originalPath: string | undefined,
    password: string | undefined,
) {
    return originalPath === undefined && password === undefined
        ? []
        : [
            originalPath,
            password,
        ];
}
