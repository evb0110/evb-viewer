import type {
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeStagedCommitOptions,
} from '@contracts/electronApiDocuments';
import {isRecord} from '@contracts/runtimeGuards';

export const PDF_NATIVE_IDENTITY_BINDING_LIMITS = {
    annotationIdBytes: 2_048,
    chunkItems: 4_096,
    chunkBytes: 256 * 1024,
    // A save admits up to 100,000 records in each of the five creation
    // families: notes, text boxes, shapes, text markup and placed images.
    saveItems: 5 * 100_000,
} as const;
const PDF_NATIVE_IDENTITY_BINDING_REF_PATTERN = /^([1-9]\d*) ([0-9]+) R$/u;

interface IPdfNativeIdentityBindingValidationOptions {
    errorKind?: 'typeError' | 'error';
    scope?: 'chunk' | 'save';
}

function failIdentityBindingValidation(
    message: string,
    options: IPdfNativeIdentityBindingValidationOptions,
): never {
    throw options.errorKind === 'error' ? new Error(message) : new TypeError(message);
}

/** Decode a complete save report, or a single bounded native-call report. */
export function normalizePdfNativeAnnotationIdentityBindings(
    value: unknown,
    label = 'identityBindings',
    options: IPdfNativeIdentityBindingValidationOptions = {},
): IPdfNativeAnnotationIdentityBinding[] {
    if (value === undefined) {
        return [];
    }
    const maxItems = options.scope === 'chunk'
        ? PDF_NATIVE_IDENTITY_BINDING_LIMITS.chunkItems
        : PDF_NATIVE_IDENTITY_BINDING_LIMITS.saveItems;
    if (!Array.isArray(value) || value.length > maxItems) {
        failIdentityBindingValidation(
            `${label} must be an array with at most ${maxItems} items`,
            options,
        );
    }
    const annotationIds = new Set<string>();
    const pdfRefs = new Set<string>();
    const bindings = value.map((entry, index) => {
        if (!isRecord(entry)) {
            failIdentityBindingValidation(`${label}[${index}] must be an object`, options);
        }
        const keys = Object.keys(entry).sort();
        if (keys.length !== 2 || keys[0] !== 'annotationId' || keys[1] !== 'pdfRef') {
            failIdentityBindingValidation(
                `${label}[${index}] must contain only annotationId and pdfRef`,
                options,
            );
        }
        if (
            typeof entry.annotationId !== 'string'
            || entry.annotationId.trim().length === 0
            || new TextEncoder().encode(entry.annotationId).byteLength > PDF_NATIVE_IDENTITY_BINDING_LIMITS.annotationIdBytes
        ) {
            failIdentityBindingValidation(
                `${label}[${index}].annotationId must be a non-empty string with at most ${PDF_NATIVE_IDENTITY_BINDING_LIMITS.annotationIdBytes} UTF-8 bytes`,
                options,
            );
        }
        const annotationId = entry.annotationId.trim();
        if (annotationIds.has(annotationId)) {
            failIdentityBindingValidation(`${label} contains a duplicate annotation identity`, options);
        }
        annotationIds.add(annotationId);
        if (typeof entry.pdfRef !== 'string') {
            failIdentityBindingValidation(
                `${label}[${index}].pdfRef must be a canonical PDF object reference`,
                options,
            );
        }
        const pdfRef = entry.pdfRef.trim();
        const match = PDF_NATIVE_IDENTITY_BINDING_REF_PATTERN.exec(pdfRef);
        if (!match) {
            failIdentityBindingValidation(
                `${label}[${index}].pdfRef must use the canonical N G R form`,
                options,
            );
        }
        const objectNumber = Number(match[1]);
        const generationNumber = Number(match[2]);
        if (!Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(generationNumber)) {
            failIdentityBindingValidation(
                `${label}[${index}].pdfRef must contain safe integer object numbers`,
                options,
            );
        }
        if (pdfRefs.has(pdfRef)) {
            failIdentityBindingValidation(`${label} contains a duplicate PDF object reference`, options);
        }
        pdfRefs.add(pdfRef);
        return {
            annotationId,
            pdfRef,
        };
    });
    if (options.scope === 'chunk'
        && new TextEncoder().encode(JSON.stringify(bindings)).byteLength > PDF_NATIVE_IDENTITY_BINDING_LIMITS.chunkBytes) {
        failIdentityBindingValidation(`${label} exceeds the native report byte budget`, options);
    }
    return bindings;
}

export function appendPdfNativeAnnotationIdentityBindings(
    options: IPdfNativeStagedCommitOptions,
    value: unknown,
    label: string,
): IPdfNativeStagedCommitOptions {
    if (!isRecord(value) || value.identityBindings === undefined) {
        return options;
    }
    return {
        ...options,
        identityBindings: normalizePdfNativeAnnotationIdentityBindings(
            value.identityBindings,
            `${label}.identityBindings`,
        ),
    };
}
