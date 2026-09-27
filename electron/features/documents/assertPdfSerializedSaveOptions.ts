import type {IPdfSerializedSaveOptions} from '@contracts/electronApiDocuments';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {isRecord} from '@contracts/runtimeGuards';

const PDF_OBJECT_REF_PATTERN = /^\d+\s+\d+\s+R$/u;

export default function assertPdfSerializedSaveOptions(value: unknown, label: string): IPdfSerializedSaveOptions {
    if (value === undefined || value === null) {
        throw new TypeError(`${label}.expectedDocumentRevisionToken must be a non-empty string`);
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const token = value.expectedDocumentRevisionToken;
    const parsedToken = parseDocumentRevisionToken(token);
    if (parsedToken === null) {
        throw new TypeError(`${label}.expectedDocumentRevisionToken must be a non-empty string`);
    }

    const changedObjectRefs = value.changedObjectRefs;
    if (changedObjectRefs !== undefined && (
        !Array.isArray(changedObjectRefs)
        || changedObjectRefs.length > 128
        || !changedObjectRefs.every(ref => typeof ref === 'string' && PDF_OBJECT_REF_PATTERN.test(ref))
    )) {
        throw new TypeError(`${label}.changedObjectRefs must contain at most 128 canonical PDF object references`);
    }
    if (value.workingCopyOnly !== undefined && value.workingCopyOnly !== true) {
        throw new TypeError(`${label}.workingCopyOnly must be true when provided`);
    }
    return {
        expectedDocumentRevisionToken: parsedToken,
        ...(Array.isArray(changedObjectRefs)
            ? {changedObjectRefs: [...new Set(changedObjectRefs as string[])]}
            : {}),
        ...(value.workingCopyOnly === true ? {workingCopyOnly: true as const} : {}),
    };
}
