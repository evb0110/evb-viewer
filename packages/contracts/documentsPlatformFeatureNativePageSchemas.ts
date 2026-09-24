import type {
    IPdfNativePageGeometry,
    IPdfNativePageGeometryPage,
    IPdfNativePageSizesExactOptions,
} from '@contracts/electronApiDocuments';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import {parseEpochMs} from '@contracts/timestamps';

function fail(message: string): never {
    throw new Error(message);
}

function decodeSafeIntegerValue(value: unknown, fieldName: string, min = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        fail(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodeUint8ArrayValue(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        fail(`${fieldName} must be a Uint8Array`);
    }
    return value;
}

const PDF_ROTATIONS = [
    0,
    90,
    180,
    270,
] as const;

function isPdfRotation(value: unknown): value is typeof PDF_ROTATIONS[number] {
    return PDF_ROTATIONS.some(rotation => rotation === value);
}

function decodeOpeningGeometry(value: unknown) {
    if (
        !isRecord(value)
        || value.pageNumber !== 1
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 1
        || !isFiniteNumber(value.width)
        || value.width <= 0
        || !isFiniteNumber(value.height)
        || value.height <= 0
        || !isPdfRotation(value.rotation)
        || !isFiniteNumber(value.widestPageWidth)
        || value.widestPageWidth < value.width
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || parseEpochMs(value.modifiedAt) === null
    ) {
        fail('invalid PDF opening geometry result');
    }
    return {
        pageNumber: requirePageNumber(1),
        pageCount: value.pageCount,
        width: value.width,
        height: value.height,
        rotation: value.rotation,
        widestPageWidth: value.widestPageWidth,
        size: value.size,
        modifiedAt: parseEpochMs(value.modifiedAt) ?? fail('invalid PDF modification time'),
    };
}

function decodeNativePageSizesOptions(value: unknown): IPdfNativePageSizesExactOptions {
    if (!isRecord(value) || value.mode !== 'exact') {
        fail('native page sizes options.mode must be exact');
    }
    const expectedDocumentRevisionToken = parseDocumentRevisionToken(value.expectedDocumentRevisionToken);
    if (expectedDocumentRevisionToken === null) {
        fail('exact native page sizes require expectedDocumentRevisionToken');
    }
    return {
        mode: 'exact',
        expectedDocumentRevisionToken,
    };
}

function decodeNativePageGeometryPage(
    value: unknown,
    index: number,
    pageCount: number,
): IPdfNativePageGeometryPage {
    if (!isRecord(value)) {
        fail(`invalid exact native page geometry ${String(index)}`);
    }
    const pageNumber = decodeSafeIntegerValue(
        value.pageNumber,
        `exact native page geometry ${String(index)}.pageNumber`,
        1,
    );
    if (pageNumber > pageCount || pageNumber !== index + 1) {
        fail(`exact native page geometry ${String(index)}.pageNumber is out of order`);
    }
    const xPoints = value.xPoints;
    const yPoints = value.yPoints;
    const widthPoints = value.widthPoints;
    const heightPoints = value.heightPoints;
    const userUnit = value.userUnit;
    if (
        !isFiniteNumber(xPoints)
        || !isFiniteNumber(yPoints)
        || !isFiniteNumber(widthPoints)
        || widthPoints <= 0
        || !isFiniteNumber(heightPoints)
        || heightPoints <= 0
        || !isPdfRotation(value.rotation)
        || !isFiniteNumber(userUnit)
        || userUnit <= 0
    ) {
        fail(`invalid exact native page geometry ${String(index)}`);
    }
    return {
        pageNumber: requirePageNumber(pageNumber, pageCount),
        xPoints,
        yPoints,
        widthPoints,
        heightPoints,
        rotation: value.rotation,
        userUnit,
    };
}

function decodeNativePageGeometry(value: unknown): IPdfNativePageGeometry {
    if (
        !isRecord(value)
        || value.kind !== 'exact'
        || parseDocumentRef(value.documentRef) === null
        || parseDocumentRevisionToken(value.documentRevisionToken) === null
    ) {
        fail('invalid exact native page geometry result');
    }
    const pageCount = decodeSafeIntegerValue(value.pageCount, 'exact native page geometry pageCount', 1);
    if (!Array.isArray(value.pages) || value.pages.length !== pageCount) {
        fail('exact native page geometry pages must cover the document');
    }
    return {
        kind: 'exact',
        documentRef: parseDocumentRef(value.documentRef) ?? fail('invalid exact native documentRef'),
        documentRevisionToken: parseDocumentRevisionToken(value.documentRevisionToken)
            ?? fail('invalid exact native documentRevisionToken'),
        pageCount,
        pages: value.pages.map((page, index) => decodeNativePageGeometryPage(page, index, pageCount)),
    };
}

export {
    decodeOpeningGeometry,
    decodeNativePageSizesOptions,
    decodeNativePageGeometry,
    decodeSafeIntegerValue,
    decodeUint8ArrayValue,
    fail,
};
