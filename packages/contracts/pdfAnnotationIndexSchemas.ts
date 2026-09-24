import {
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    type IPdfAnnotationIndexChunk,
    type IPdfAnnotationIndexChunkOptions,
    type IPdfAnnotationIndexEntry,
    type IPdfAnnotationIndexObjectRef,
    type IPdfAnnotationIndexOptions,
    type IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import {
    decodeArgumentArray,
    decodeSafeIntegerValue,
    documentArgs,
    documentResult,
    type TDocumentMethodArgs,
} from '@contracts/documentsPlatformFeatureSchemas';
import {
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    appendOptionalDocumentArg as appendOptional,
    decodeOptionalDocumentObject as decodeOptionalObject,
    decodePdfRevisionOptions as decodeRevisionOptions,
    decodeRequiredDocumentObject as decodeRequiredObject,
} from '@contracts/documentsPersistenceSchemas';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseSessionId,
    type TSessionId,
} from '@contracts/shared';

function fail(message: string): never {
    throw new Error(message);
}

const fixtureRevisionToken = requireDocumentRevisionToken('drt1:fixture');
const fixtureRevisionOptions = {expectedDocumentRevisionToken: fixtureRevisionToken};

function decodeDocumentRef(value: unknown, fieldName: string): TDocumentRef {
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        fail(`${fieldName} must be an absolute document reference`);
    }
    return parsed;
}

function decodeSessionId(value: unknown, fieldName: string): TSessionId {
    const parsed = parseSessionId(value);
    if (parsed === null) {
        fail(`${fieldName} must be a non-empty session ID`);
    }
    return parsed;
}

function decodeAnnotationIndexOptions(value: unknown): IPdfAnnotationIndexOptions {
    const decoded = decodeRevisionOptions(value);
    if (decoded === undefined) {
        fail('annotation index options must include expectedDocumentRevisionToken');
    }
    return {expectedDocumentRevisionToken: decoded.expectedDocumentRevisionToken};
}

function decodeChunkOptions(value: unknown): IPdfAnnotationIndexChunkOptions | undefined {
    const decoded = decodeOptionalObject(value, 'options');
    if (decoded === undefined) {
        return undefined;
    }
    if (decoded.chunkBytes === undefined) {
        return {};
    }
    const chunkBytes = decodeSafeIntegerValue(decoded.chunkBytes, 'options.chunkBytes', 1);
    if (chunkBytes > PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES) {
        fail(`options.chunkBytes must be at most ${PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES}`);
    }
    return {chunkBytes};
}

const beginPdfAnnotationIndexArgs = documentArgs<'beginPdfAnnotationIndex'>(
    value => {
        const args = decodeArgumentArray(value, 2);
        return [
            decodeDocumentRef(args[0], 'path'),
            decodeAnnotationIndexOptions(args[1]),
        ];
    },
    () => [
        decodeDocumentRef('/tmp/document.pdf', 'path'),
        fixtureRevisionOptions,
    ],
);
const readPdfAnnotationIndexChunkArgs = documentArgs<'readPdfAnnotationIndexChunk'>(
    value => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeSessionId(args[0], 'sessionId'),
            decodeSafeIntegerValue(args[1], 'offset'),
        ], decodeChunkOptions(args[2])) as TDocumentMethodArgs<'readPdfAnnotationIndexChunk'>;
    },
    () => [
        decodeSessionId('annotation-index-1', 'sessionId'),
        0,
    ],
);
const releasePdfAnnotationIndexArgs = documentArgs<'releasePdfAnnotationIndex'>(
    value => {
        const args = decodeArgumentArray(value, 1);
        return [decodeSessionId(args[0], 'sessionId')];
    },
    () => [decodeSessionId('annotation-index-1', 'sessionId')],
);

function decodeObjectRef(value: unknown, fieldName: string): IPdfAnnotationIndexObjectRef {
    const decoded = decodeRequiredObject(value, fieldName);
    return {
        objectNumber: decodeSafeIntegerValue(decoded.objectNumber, `${fieldName}.objectNumber`, 1),
        generationNumber: decodeSafeIntegerValue(decoded.generationNumber, `${fieldName}.generationNumber`),
    };
}

function decodeEntry(value: unknown): IPdfAnnotationIndexEntry {
    const decoded = decodeRequiredObject(value, 'annotation index entry');
    if (
        typeof decoded.subtype !== 'string'
        || decoded.subtype.length === 0
        || decoded.name !== null
        && typeof decoded.name !== 'string'
    ) {
        fail('invalid annotation index entry text fields');
    }
    return {
        pageIndex: requirePageIndex(
            decodeSafeIntegerValue(decoded.pageIndex, 'annotation index entry pageIndex'),
        ),
        objectNumber: decodeSafeIntegerValue(decoded.objectNumber, 'annotation index entry objectNumber'),
        generationNumber: decodeSafeIntegerValue(decoded.generationNumber, 'annotation index entry generationNumber'),
        subtype: decoded.subtype,
        name: decoded.name,
        popupRef: decoded.popupRef === undefined || decoded.popupRef === null
            ? null
            : decodeObjectRef(decoded.popupRef, 'annotation index entry popupRef'),
        parentRef: decoded.parentRef === undefined || decoded.parentRef === null
            ? null
            : decodeObjectRef(decoded.parentRef, 'annotation index entry parentRef'),
    };
}

const pdfAnnotationIndexSessionResult = documentResult<'beginPdfAnnotationIndex'>(
    value => {
        const decoded = decodeRequiredObject(value, 'annotation index session');
        if (
            parseSessionId(decoded.sessionId) === null
            || parseDocumentRef(decoded.documentRef) === null
        ) {
            fail('invalid annotation index session identifiers');
        }
        const documentRevisionToken = typeof decoded.documentRevisionToken === 'string'
            ? parseDocumentRevisionToken(decoded.documentRevisionToken)
            : null;
        if (documentRevisionToken === null) {
            fail('annotation index documentRevisionToken is invalid');
        }
        return {
            sessionId: parseSessionId(decoded.sessionId) ?? fail('annotation index session ID is invalid'),
            documentRef: parseDocumentRef(decoded.documentRef) ?? fail('annotation index document reference is invalid'),
            documentRevisionToken,
            pageCount: decodeSafeIntegerValue(decoded.pageCount, 'annotation index pageCount'),
            entryCount: decodeSafeIntegerValue(decoded.entryCount, 'annotation index entryCount'),
            totalBytes: decodeSafeIntegerValue(decoded.totalBytes, 'annotation index totalBytes'),
        } satisfies IPdfAnnotationIndexSession;
    },
    () => ({
        sessionId: decodeSessionId('annotation-index-1', 'sessionId'),
        documentRef: decodeDocumentRef('/tmp/document.pdf', 'documentRef'),
        documentRevisionToken: fixtureRevisionToken,
        pageCount: 1,
        entryCount: 0,
        totalBytes: 1,
    }),
);
const pdfAnnotationIndexChunkResult = documentResult<'readPdfAnnotationIndexChunk'>(
    value => {
        const decoded = decodeRequiredObject(value, 'annotation index chunk');
        const nextOffset = decoded.nextOffset === null || decoded.nextOffset === undefined
            ? null
            : decodeSafeIntegerValue(decoded.nextOffset, 'annotation index chunk nextOffset');
        if (typeof decoded.done !== 'boolean' || !Array.isArray(decoded.entries)) {
            fail('invalid annotation index chunk');
        }
        const byteLength = decodeSafeIntegerValue(decoded.byteLength, 'annotation index chunk byteLength');
        if (byteLength > PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES) {
            fail(`annotation index chunk exceeds ${PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} bytes`);
        }
        return {
            offset: decodeSafeIntegerValue(decoded.offset, 'annotation index chunk offset'),
            nextOffset,
            byteLength,
            done: decoded.done,
            entries: decoded.entries.map(decodeEntry),
        } satisfies IPdfAnnotationIndexChunk;
    },
    () => ({
        offset: 0,
        nextOffset: null,
        byteLength: 0,
        done: true,
        entries: [],
    }),
);

export {
    beginPdfAnnotationIndexArgs,
    pdfAnnotationIndexChunkResult,
    pdfAnnotationIndexSessionResult,
    readPdfAnnotationIndexChunkArgs,
    releasePdfAnnotationIndexArgs,
};
