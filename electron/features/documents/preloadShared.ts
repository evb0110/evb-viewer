import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipcAssertions';
import type {IPdfSerializedSaveOptions} from '@contracts/electronApiDocuments';
import {IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES} from '@contracts/electronApiDocuments';
import type {IPdfSidecarChunkOptions} from '@contracts/pdfAnnotationParseTypes';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {isRecord} from '@contracts/runtimeGuards';

const MAX_IPC_FILE_NAME_LENGTH = 255;
const MAX_IPC_WRITE_BYTES = IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES;

function assertWriteData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (value.byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`${fieldName} exceeds maximum size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
    return value;
}

function assertWorkingCopyFileName(value: unknown, fieldName: string) {
    const normalized = assertNonEmptyString(value, fieldName, MAX_IPC_FILE_NAME_LENGTH);
    if (normalized.includes('/') || normalized.includes('\\')) {
        throw new Error(`${fieldName} must be a file name, not a path`);
    }
    if (normalized === '.' || normalized === '..') {
        throw new Error(`${fieldName} is invalid`);
    }
    return normalized;
}

const PDF_OBJECT_REF_PATTERN = /^\d+\s+\d+\s+R$/u;

export function assertPdfSerializedSaveOptions(value: unknown, label: string): IPdfSerializedSaveOptions {
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

export function assertPdfIndexChunkOptions(
    value: unknown,
    fieldName: string,
    maxChunkBytes: number,
): IPdfSidecarChunkOptions | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new TypeError(`${fieldName} must be an object`);
    }
    const rawChunkBytes = value.chunkBytes;
    if (
        rawChunkBytes !== undefined
        && (
            typeof rawChunkBytes !== 'number'
            || !Number.isSafeInteger(rawChunkBytes)
            || rawChunkBytes < 1
            || rawChunkBytes > maxChunkBytes
        )
    ) {
        throw new TypeError(`${fieldName}.chunkBytes must be between 1 and ${maxChunkBytes}`);
    }
    return rawChunkBytes === undefined ? {} : {chunkBytes: rawChunkBytes};
}

export function assertPdfSidecarChunkOffset(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${fieldName} must be a non-negative safe integer`);
    }
    return value;
}

function assertOptionalFileName(value: unknown, fieldName: string) {
    return typeof value === 'string'
        ? assertNonEmptyString(value, fieldName, MAX_IPC_FILE_NAME_LENGTH)
        : undefined;
}

export {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertOptionalFileName,
    assertWriteData,
    assertWorkingCopyFileName,
};
