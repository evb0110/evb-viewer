import {
    PDF_ANNOTATION_MARKUP_SUBTYPES,
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import {
    PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES,
    PDF_ANNOTATION_PARSE_MAX_ENTRIES,
    PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
    type IPdfAnnotationForeignEntry,
    type IPdfAnnotationHighlightEntry,
    type IPdfAnnotationNoteEntry,
    type IPdfAnnotationNoteReply,
    type IPdfAnnotationParseChunk,
    type IPdfAnnotationParseChunkOptions,
    type IPdfAnnotationParseEntry,
    type IPdfAnnotationParsePoint,
    type IPdfAnnotationParseOptions,
    type IPdfAnnotationParseResult,
    type IPdfAnnotationParseSession,
    type IPdfAnnotationShapeEntry,
    type IPdfAnnotationStampEntry,
    type IPdfAnnotationStampImageReference,
    type IPdfAnnotationTextBoxEntry,
} from '@contracts/pdfAnnotationParseTypes';
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
import {
    appendOptionalDocumentArg as appendOptional,
    decodeOptionalDocumentObject as decodeOptionalObject,
    decodePdfRevisionOptions as decodeRevisionOptions,
    decodeRequiredDocumentObject as decodeRequiredObject,
} from '@contracts/documentsPersistenceSchemas';
import {isPdfNativeNormalizedRectInsidePageBounds} from '@contracts/nativePdfPageBounds';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

function fail(message: string): never {
    throw new Error(message);
}

function rejectUnknownFields(value: Record<string, unknown>, fieldName: string, allowed: readonly string[]) {
    const unknown = Object.keys(value).find(key => !allowed.includes(key));
    if (unknown !== undefined) {
        fail(`${fieldName} contains unsupported field ${unknown}`);
    }
}

const fixtureRevisionToken = requireDocumentRevisionToken('drt1:annotation-parse-fixture');
const fixtureRevisionOptions = {expectedDocumentRevisionToken: fixtureRevisionToken};
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

function decodeStringValue(value: unknown, fieldName: string, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        fail(`${fieldName} must be ${allowEmpty ? '' : 'a non-empty '}string`);
    }
    return value;
}

function decodeFiniteNumber(value: unknown, fieldName: string, min?: number, max?: number) {
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || (min !== undefined && value < min)
        || (max !== undefined && value > max)
    ) {
        const lowerBound = min === undefined ? '' : ` >= ${min}`;
        const upperBound = max === undefined ? '' : ` <= ${max}`;
        fail(`${fieldName} must be a finite number${lowerBound}${upperBound}`);
    }
    return value;
}

function decodeOptionalString(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    return decodeStringValue(value, fieldName, true);
}

function decodeTimestamp(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        fail(`${fieldName} must be a safe integer timestamp or null`);
    }
    return value;
}

function decodeMarkerRect(value: unknown, fieldName: string) {
    const decoded = decodeRequiredObject<{
        left?: unknown;
        top?: unknown;
        width?: unknown;
        height?: unknown;
    }>(value, fieldName);
    rejectUnknownFields(decoded, fieldName, [
        'left',
        'top',
        'width',
        'height',
    ]);
    const rect = {
        left: decodeFiniteNumber(decoded.left, `${fieldName}.left`),
        top: decodeFiniteNumber(decoded.top, `${fieldName}.top`),
        width: decodeFiniteNumber(decoded.width, `${fieldName}.width`, 0),
        height: decodeFiniteNumber(decoded.height, `${fieldName}.height`, 0),
    };
    if (!isPdfNativeNormalizedRectInsidePageBounds(rect)) {
        fail(`${fieldName} must be inside the normalized page bounds`);
    }
    return rect;
}

function decodeRgbColor(value: unknown, fieldName: string) {
    const color = decodeStringValue(value, fieldName);
    if (!/^#[0-9a-f]{6}$/iu.test(color)) {
        fail(`${fieldName} must be an 8-bit RGB color`);
    }
    return color.toLowerCase();
}

function decodeSha256(value: unknown, fieldName: string) {
    const digest = decodeStringValue(value, fieldName);
    if (!SHA256_PATTERN.test(digest)) {
        fail(`${fieldName} must be a 64-character hexadecimal SHA-256 digest`);
    }
    return digest.toLowerCase();
}

function decodeIdentity(value: Record<string, unknown>, fieldName: string) {
    return {
        pageIndex: decodeSafeIntegerValue(value.pageIndex, `${fieldName}.pageIndex`) as IPdfAnnotationTextBoxEntry['pageIndex'],
        objectNumber: decodeSafeIntegerValue(value.objectNumber, `${fieldName}.objectNumber`),
        generationNumber: decodeSafeIntegerValue(value.generationNumber, `${fieldName}.generationNumber`),
        name: decodeStringValue(value.name, `${fieldName}.name`),
        author: decodeOptionalString(value.author, `${fieldName}.author`),
        createdAt: decodeTimestamp(value.createdAt, `${fieldName}.createdAt`),
        modifiedAt: decodeTimestamp(value.modifiedAt, `${fieldName}.modifiedAt`),
    };
}

function decodeRotation(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || ![
        0,
        90,
        180,
        270,
    ].includes(value)) {
        fail(`${fieldName} must be 0, 90, 180, or 270`);
    }
    return value as 0 | 90 | 180 | 270;
}

function decodeTextBox(value: Record<string, unknown>): IPdfAnnotationTextBoxEntry {
    rejectUnknownFields(value, 'annotation parse text-box', [
        'kind',
        'pageIndex',
        'objectNumber',
        'generationNumber',
        'name',
        'author',
        'createdAt',
        'modifiedAt',
        'text',
        'rect',
        'rotation',
        'fontSize',
        'color',
    ]);
    const identity = decodeIdentity(value, 'annotation parse text-box');
    return {
        kind: 'text-box',
        ...identity,
        text: decodeStringValue(value.text, 'annotation parse text-box.text', true),
        rect: decodeMarkerRect(value.rect, 'annotation parse text-box.rect'),
        rotation: decodeRotation(value.rotation, 'annotation parse text-box.rotation'),
        fontSize: decodeFiniteNumber(value.fontSize, 'annotation parse text-box.fontSize', Number.MIN_VALUE, 512),
        color: decodeRgbColor(value.color, 'annotation parse text-box.color'),
    };
}

function decodeReply(value: unknown, index: number): IPdfAnnotationNoteReply {
    const decoded = decodeRequiredObject<{
        objectNumber?: unknown;
        generationNumber?: unknown;
        contents?: unknown;
        author?: unknown;
        createdAt?: unknown;
        modifiedAt?: unknown;
    }>(value, `annotation parse note.replies[${index}]`);
    rejectUnknownFields(decoded, `annotation parse note.replies[${index}]`, [
        'objectNumber',
        'generationNumber',
        'contents',
        'author',
        'createdAt',
        'modifiedAt',
    ]);
    return {
        objectNumber: decodeSafeIntegerValue(decoded.objectNumber, `annotation parse note.replies[${index}].objectNumber`),
        generationNumber: decodeSafeIntegerValue(decoded.generationNumber, `annotation parse note.replies[${index}].generationNumber`),
        contents: decodeStringValue(decoded.contents, `annotation parse note.replies[${index}].contents`, true),
        author: decodeOptionalString(decoded.author, `annotation parse note.replies[${index}].author`),
        createdAt: decodeTimestamp(decoded.createdAt, `annotation parse note.replies[${index}].createdAt`),
        modifiedAt: decodeTimestamp(decoded.modifiedAt, `annotation parse note.replies[${index}].modifiedAt`),
    };
}

function decodeNote(value: Record<string, unknown>): IPdfAnnotationNoteEntry {
    rejectUnknownFields(value, 'annotation parse note', [
        'kind',
        'pageIndex',
        'objectNumber',
        'generationNumber',
        'name',
        'author',
        'createdAt',
        'modifiedAt',
        'position',
        'contents',
        'color',
        'open',
        'replies',
    ]);
    const identity = decodeIdentity(value, 'annotation parse note');
    if (typeof value.open !== 'boolean') {
        fail('annotation parse note.open must be a boolean');
    }
    if (!Array.isArray(value.replies) || value.replies.length > 4_096) {
        fail('annotation parse note.replies must contain at most 4096 replies');
    }
    return {
        kind: 'note',
        ...identity,
        position: decodeMarkerRect(value.position, 'annotation parse note.position'),
        contents: decodeStringValue(value.contents, 'annotation parse note.contents', true),
        color: value.color === undefined || value.color === null
            ? null
            : decodeRgbColor(value.color, 'annotation parse note.color'),
        open: value.open,
        replies: value.replies.map(decodeReply),
    };
}

function decodeHighlight(value: Record<string, unknown>): IPdfAnnotationHighlightEntry {
    rejectUnknownFields(value, 'annotation parse highlight', [
        'kind',
        'pageIndex',
        'objectNumber',
        'generationNumber',
        'name',
        'author',
        'createdAt',
        'modifiedAt',
        'subtype',
        'quadPoints',
        'color',
        'opacity',
        'contents',
    ]);
    const identity = decodeIdentity(value, 'annotation parse highlight');
    if (!isOneOf(PDF_ANNOTATION_MARKUP_SUBTYPES, value.subtype)) {
        fail('annotation parse highlight.subtype is unsupported');
    }
    if (!Array.isArray(value.quadPoints) || value.quadPoints.length > 512) {
        fail('annotation parse highlight.quadPoints must contain at most 512 rectangles');
    }
    return {
        kind: 'highlight',
        ...identity,
        subtype: value.subtype,
        quadPoints: value.quadPoints.map((point, index) => decodeMarkerRect(point, `annotation parse highlight.quadPoints[${index}]`)),
        color: decodeRgbColor(value.color, 'annotation parse highlight.color'),
        opacity: decodeFiniteNumber(value.opacity, 'annotation parse highlight.opacity', 0, 1),
        contents: decodeStringValue(value.contents, 'annotation parse highlight.contents', true),
    };
}

function decodeStamp(value: Record<string, unknown>): IPdfAnnotationStampEntry {
    rejectUnknownFields(value, 'annotation parse stamp', [
        'kind',
        'pageIndex',
        'objectNumber',
        'generationNumber',
        'name',
        'author',
        'createdAt',
        'modifiedAt',
        'rect',
        'rotation',
        'image',
    ]);
    const identity = decodeIdentity(value, 'annotation parse stamp');
    const image = decodeRequiredObject<{
        objectNumber?: unknown;
        generationNumber?: unknown;
        byteLength?: unknown;
        sha256?: unknown;
    }>(value.image, 'annotation parse stamp.image');
    rejectUnknownFields(image, 'annotation parse stamp.image', [
        'objectNumber',
        'generationNumber',
        'byteLength',
        'sha256',
    ]);
    const imageReference: IPdfAnnotationStampImageReference = {
        objectNumber: decodeSafeIntegerValue(image.objectNumber, 'annotation parse stamp.image.objectNumber'),
        generationNumber: decodeSafeIntegerValue(image.generationNumber, 'annotation parse stamp.image.generationNumber'),
        byteLength: decodeSafeIntegerValue(image.byteLength, 'annotation parse stamp.image.byteLength'),
        sha256: decodeSha256(image.sha256, 'annotation parse stamp.image.sha256'),
    };
    return {
        kind: 'stamp',
        ...identity,
        rect: decodeMarkerRect(value.rect, 'annotation parse stamp.rect'),
        rotation: decodeRotation(value.rotation, 'annotation parse stamp.rotation'),
        image: imageReference,
    };
}

function decodeShape(value: Record<string, unknown>): IPdfAnnotationShapeEntry {
    rejectUnknownFields(value, 'annotation parse shape', [
        'kind',
        'pageIndex',
        'objectNumber',
        'generationNumber',
        'name',
        'author',
        'createdAt',
        'modifiedAt',
        'stableKey',
        'pdfSubtype',
        'type',
        'x',
        'y',
        'width',
        'height',
        'x2',
        'y2',
        'color',
        'fillColor',
        'opacity',
        'strokeWidth',
        'points',
        'strokes',
        'lineStartStyle',
        'lineEndStyle',
    ]);
    const identity = decodeIdentity(value, 'annotation parse shape');
    if (!isOneOf(PDF_ANNOTATION_SHAPE_PDF_SUBTYPES, value.pdfSubtype)) {
        fail('annotation parse shape.pdfSubtype is unsupported');
    }
    if (!isOneOf(PDF_ANNOTATION_SHAPE_TYPES, value.type)) {
        fail('annotation parse shape.type is unsupported');
    }
    const decodeOptionalShapeNumber = (fieldName: string) => value[fieldName] === undefined || value[fieldName] === null
        ? null
        : decodeFiniteNumber(value[fieldName], `annotation parse shape.${fieldName}`);
    const points = decodePointsFromValue(value.points, 'annotation parse shape.points');
    let strokes = null;
    if (value.strokes !== undefined && value.strokes !== null) {
        if (!Array.isArray(value.strokes) || value.strokes.length > 4_096) {
            fail('annotation parse shape.strokes is too large');
        }
        strokes = value.strokes.map((stroke, index) => decodePointsFromValue(
            stroke,
            `annotation parse shape.strokes[${index}]`,
        ) ?? []);
    }
    const lineStartStyle = decodeOptionalShapeEnum(value.lineStartStyle, PDF_ANNOTATION_LINE_END_STYLES, 'lineStartStyle');
    const lineEndStyle = decodeOptionalShapeEnum(value.lineEndStyle, PDF_ANNOTATION_LINE_END_STYLES, 'lineEndStyle');
    return {
        kind: 'shape',
        ...identity,
        pdfSubtype: value.pdfSubtype,
        type: value.type,
        x: decodeFiniteNumber(value.x, 'annotation parse shape.x'),
        y: decodeFiniteNumber(value.y, 'annotation parse shape.y'),
        width: decodeFiniteNumber(value.width, 'annotation parse shape.width', 0),
        height: decodeFiniteNumber(value.height, 'annotation parse shape.height', 0),
        x2: decodeOptionalShapeNumber('x2'),
        y2: decodeOptionalShapeNumber('y2'),
        color: decodeRgbColor(value.color, 'annotation parse shape.color'),
        fillColor: value.fillColor === undefined || value.fillColor === null
            ? null
            : decodeRgbColor(value.fillColor, 'annotation parse shape.fillColor'),
        opacity: decodeFiniteNumber(value.opacity, 'annotation parse shape.opacity', 0, 1),
        strokeWidth: decodeFiniteNumber(value.strokeWidth, 'annotation parse shape.strokeWidth', 0),
        points,
        strokes,
        lineStartStyle,
        lineEndStyle,
        stableKey: decodeOptionalString(value.stableKey, 'annotation parse shape.stableKey'),
    };
}

function decodePointsFromValue(value: unknown, fieldName: string): IPdfAnnotationParsePoint[] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > 40_000) {
        fail(`${fieldName} is too large`);
    }
    return value.map((point, index) => {
        const decoded = decodeRequiredObject<{
            x?: unknown;
            y?: unknown
        }>(point, `${fieldName}[${index}]`);
        rejectUnknownFields(decoded, `${fieldName}[${index}]`, [
            'x',
            'y',
        ]);
        return {
            x: decodeFiniteNumber(decoded.x, `${fieldName}[${index}].x`),
            y: decodeFiniteNumber(decoded.y, `${fieldName}[${index}].y`),
        };
    });
}

function decodeOptionalShapeEnum<T extends readonly string[]>(value: unknown, allowed: T, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (!isOneOf(allowed, value)) fail(`annotation parse shape.${fieldName} is unsupported`);
    return value as T[number];
}

function decodeForeign(value: Record<string, unknown>): IPdfAnnotationForeignEntry {
    rejectUnknownFields(value, 'annotation parse foreign', [
        'kind',
        'pageIndex',
        'objectNumber',
        'generationNumber',
        'name',
        'subtype',
        'reason',
    ]);
    return {
        kind: 'foreign',
        pageIndex: decodeSafeIntegerValue(value.pageIndex, 'annotation parse foreign.pageIndex') as IPdfAnnotationForeignEntry['pageIndex'],
        objectNumber: decodeSafeIntegerValue(value.objectNumber, 'annotation parse foreign.objectNumber'),
        generationNumber: decodeSafeIntegerValue(value.generationNumber, 'annotation parse foreign.generationNumber'),
        name: decodeStringValue(value.name, 'annotation parse foreign.name'),
        subtype: decodeStringValue(value.subtype, 'annotation parse foreign.subtype'),
        reason: decodeStringValue(value.reason, 'annotation parse foreign.reason'),
    };
}

export function decodePdfAnnotationParseEntry(value: unknown): IPdfAnnotationParseEntry {
    const decoded = decodeRequiredObject<Record<string, unknown>>(value, 'annotation parse entry');
    switch (decoded.kind) {
        case 'text-box': return decodeTextBox(decoded);
        case 'note': return decodeNote(decoded);
        case 'highlight': return decodeHighlight(decoded);
        case 'stamp': return decodeStamp(decoded);
        case 'shape': return decodeShape(decoded);
        case 'foreign': return decodeForeign(decoded);
        default: fail('annotation parse entry kind is unsupported');
    }
}

export interface IPdfAnnotationParseProtocolFixture {
    format: 'evb-pdf-annotation-parse';
    schemaVersion: 1;
    pageCount: number;
    chunkBytes: number;
    chunkIndex: number;
    entries: IPdfAnnotationParseEntry[];
}

export function decodePdfAnnotationParseProtocolFixture(value: unknown): IPdfAnnotationParseProtocolFixture {
    const decoded = decodeRequiredObject<{
        format?: unknown;
        schemaVersion?: unknown;
        pageCount?: unknown;
        chunkBytes?: unknown;
        chunkIndex?: unknown;
        entries?: unknown;
    }>(value, 'annotation parse protocol fixture');
    rejectUnknownFields(decoded, 'annotation parse protocol fixture', [
        'format',
        'schemaVersion',
        'pageCount',
        'chunkBytes',
        'chunkIndex',
        'entries',
    ]);
    if (decoded.format !== 'evb-pdf-annotation-parse' || decoded.schemaVersion !== 1) {
        fail('annotation parse protocol fixture header is unsupported');
    }
    if (!Array.isArray(decoded.entries)) {
        fail('annotation parse protocol fixture entries must be an array');
    }
    const chunkBytes = decodeSafeIntegerValue(decoded.chunkBytes, 'annotation parse fixture chunkBytes', 64);
    if (chunkBytes > PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES) {
        fail(`annotation parse fixture chunkBytes must be at most ${PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES}`);
    }
    return {
        format: decoded.format,
        schemaVersion: decoded.schemaVersion,
        pageCount: decodeSafeIntegerValue(decoded.pageCount, 'annotation parse fixture pageCount'),
        chunkBytes,
        chunkIndex: decodeSafeIntegerValue(decoded.chunkIndex, 'annotation parse fixture chunkIndex'),
        entries: decoded.entries.map(decodePdfAnnotationParseEntry),
    };
}

export function decodePdfAnnotationParseResult(value: unknown): IPdfAnnotationParseResult {
    const decoded = decodeRequiredObject<{
        documentRevisionToken?: unknown;
        pageCount?: unknown;
        entities?: unknown;
        foreign?: unknown;
    }>(value, 'annotation parse result');
    rejectUnknownFields(decoded, 'annotation parse result', [
        'documentRevisionToken',
        'pageCount',
        'entities',
        'foreign',
    ]);
    const documentRevisionToken = typeof decoded.documentRevisionToken === 'string'
        ? parseDocumentRevisionToken(decoded.documentRevisionToken)
        : null;
    if (documentRevisionToken === null) {
        fail('annotation parse result documentRevisionToken is invalid');
    }
    const pageCount = decodeSafeIntegerValue(decoded.pageCount, 'annotation parse result pageCount');
    if (!Array.isArray(decoded.entities)) {
        fail('annotation parse result entities must be an array');
    }
    if (!Array.isArray(decoded.foreign)) {
        fail('annotation parse result foreign must be an array');
    }
    if (decoded.entities.length + decoded.foreign.length > PDF_ANNOTATION_PARSE_MAX_ENTRIES) {
        fail(`annotation parse result contains more than ${PDF_ANNOTATION_PARSE_MAX_ENTRIES} entries`);
    }
    const entities = decoded.entities.map(decodePdfAnnotationParseEntry).map((entry, index) => {
        if (entry.kind === 'foreign') {
            fail(`annotation parse result.entities[${index}] must be editable`);
        }
        return entry;
    });
    const foreign = decoded.foreign.map(decodePdfAnnotationParseEntry).map((entry, index) => {
        if (entry.kind !== 'foreign') {
            fail(`annotation parse result.foreign[${index}] must be foreign`);
        }
        return entry;
    });
    return {
        documentRevisionToken,
        pageCount,
        entities,
        foreign,
    };
}

function decodeParseOptions(value: unknown): IPdfAnnotationParseOptions {
    const decoded = decodeRevisionOptions(value);
    if (decoded === undefined) fail('annotation parse options must include expectedDocumentRevisionToken');
    return {expectedDocumentRevisionToken: decoded.expectedDocumentRevisionToken};
}

function decodeChunkOptions(value: unknown): IPdfAnnotationParseChunkOptions | undefined {
    const decoded = decodeOptionalObject<{chunkBytes?: unknown}>(value, 'options');
    if (decoded === undefined) {
        return undefined;
    }
    if (decoded.chunkBytes === undefined) {
        return {};
    }
    const chunkBytes = decodeSafeIntegerValue(decoded.chunkBytes, 'options.chunkBytes', 1);
    if (chunkBytes > PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES) {
        fail(`options.chunkBytes must be at most ${PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES}`);
    }
    return {chunkBytes};
}

const beginPdfAnnotationParseArgs = documentArgs<'beginPdfAnnotationParse'>(
    value => {
        const args = decodeArgumentArray(value, 2);
        return [
            decodeStringValue(args[0], 'path'),
            decodeParseOptions(args[1]),
        ];
    },
    () => [
        '/tmp/document.pdf',
        fixtureRevisionOptions,
    ],
);
const readPdfAnnotationParseChunkArgs = documentArgs<'readPdfAnnotationParseChunk'>(
    value => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'sessionId'),
            decodeSafeIntegerValue(args[1], 'offset'),
        ], decodeChunkOptions(args[2])) as TDocumentMethodArgs<'readPdfAnnotationParseChunk'>;
    },
    () => [
        'annotation-parse-1',
        0,
    ],
);
const releasePdfAnnotationParseArgs = documentArgs<'releasePdfAnnotationParse'>(
    value => [decodeStringValue(decodeArgumentArray(value, 1)[0], 'sessionId')],
    () => ['annotation-parse-1'],
);
const cancelPdfAnnotationParseArgs = documentArgs<'cancelPdfAnnotationParse'>(
    value => [decodeStringValue(decodeArgumentArray(value, 1)[0], 'sessionId')],
    () => ['annotation-parse-1'],
);

const parsePdfAnnotationsArgs = documentArgs<'parsePdfAnnotations'>(
    value => {
        const args = decodeArgumentArray(value, 2);
        return [
            decodeStringValue(args[0], 'path'),
            decodeParseOptions(args[1]),
        ];
    },
    () => [
        '/tmp/document.pdf',
        fixtureRevisionOptions,
    ],
);

const pdfAnnotationParseResult = documentResult<'parsePdfAnnotations'>(
    decodePdfAnnotationParseResult,
    () => ({
        documentRevisionToken: fixtureRevisionToken,
        pageCount: 1,
        entities: [],
        foreign: [],
    }),
);

const pdfAnnotationParseSessionResult = documentResult<'beginPdfAnnotationParse'>(
    value => {
        const decoded = decodeRequiredObject<{
            sessionId?: unknown;
            documentRef?: unknown;
            documentRevisionToken?: unknown;
            pageCount?: unknown;
            entryCount?: unknown;
            totalBytes?: unknown;
        }>(value, 'annotation parse session');
        if (
            typeof decoded.sessionId !== 'string'
            || decoded.sessionId.length === 0
            || typeof decoded.documentRef !== 'string'
            || decoded.documentRef.length === 0
        ) {
            fail('invalid annotation parse session identifiers');
        }
        const documentRevisionToken = typeof decoded.documentRevisionToken === 'string'
            ? parseDocumentRevisionToken(decoded.documentRevisionToken)
            : null;
        if (documentRevisionToken === null) fail('annotation parse documentRevisionToken is invalid');
        return {
            sessionId: decoded.sessionId,
            documentRef: decoded.documentRef,
            documentRevisionToken,
            pageCount: decodeSafeIntegerValue(decoded.pageCount, 'annotation parse pageCount'),
            entryCount: decodeSafeIntegerValue(decoded.entryCount, 'annotation parse entryCount'),
            totalBytes: decodeSafeIntegerValue(decoded.totalBytes, 'annotation parse totalBytes'),
        } satisfies IPdfAnnotationParseSession;
    },
    () => ({
        sessionId: 'annotation-parse-1',
        documentRef: '/tmp/document.pdf',
        documentRevisionToken: fixtureRevisionToken,
        pageCount: 1,
        entryCount: 1,
        totalBytes: 512,
    }),
);
const pdfAnnotationParseChunkResult = documentResult<'readPdfAnnotationParseChunk'>(
    value => {
        const decoded = decodeRequiredObject<{
            offset?: unknown;
            nextOffset?: unknown;
            byteLength?: unknown;
            done?: unknown;
            entries?: unknown;
        }>(value, 'annotation parse chunk');
        const nextOffset = decoded.nextOffset === undefined || decoded.nextOffset === null
            ? null
            : decodeSafeIntegerValue(decoded.nextOffset, 'annotation parse chunk nextOffset');
        if (typeof decoded.done !== 'boolean' || !Array.isArray(decoded.entries)) {
            fail('invalid annotation parse chunk');
        }
        const byteLength = decodeSafeIntegerValue(decoded.byteLength, 'annotation parse chunk byteLength');
        if (byteLength > PDF_ANNOTATION_PARSE_MAX_LINE_BYTES) {
            fail(`annotation parse chunk exceeds ${PDF_ANNOTATION_PARSE_MAX_LINE_BYTES} bytes`);
        }
        return {
            offset: decodeSafeIntegerValue(decoded.offset, 'annotation parse chunk offset'),
            nextOffset,
            byteLength,
            done: decoded.done,
            entries: decoded.entries.map(decodePdfAnnotationParseEntry),
        } satisfies IPdfAnnotationParseChunk;
    },
    () => ({
        offset: 0,
        nextOffset: null,
        byteLength: 0,
        done: true,
        entries: [],
    }),
);
const pdfAnnotationParseCancelResult = documentResult<'cancelPdfAnnotationParse'>(
    value => {
        if (!isRecord(value) || typeof value.canceled !== 'boolean') {
            fail('invalid annotation parse cancellation result');
        }
        return {canceled: value.canceled};
    },
    () => ({canceled: false}),
);

export {
    beginPdfAnnotationParseArgs,
    cancelPdfAnnotationParseArgs,
    pdfAnnotationParseCancelResult,
    pdfAnnotationParseChunkResult,
    pdfAnnotationParseSessionResult,
    pdfAnnotationParseResult,
    parsePdfAnnotationsArgs,
    readPdfAnnotationParseChunkArgs,
    releasePdfAnnotationParseArgs,
};
