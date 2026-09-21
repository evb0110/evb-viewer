import { getErrorMessage } from '@contracts/getErrorMessage';
import type {
    PDFContext,
    PDFObject,
    PDFPage,
} from 'pdf-lib';
import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFStream,
    UnexpectedObjectTypeError,
} from 'pdf-lib';

const UNEXPECTED_OBJECT_TYPE_MESSAGE_PREFIX = 'Expected instance of ';
const MAX_INHERITABLE_LOOKUP_DEPTH = 64;

type TPdfRecord = Record<string, unknown>;

function isRecord(value: unknown): value is TPdfRecord {
    return typeof value === 'object' && value !== null;
}

// pdf-lib objects can cross a workspace boundary with distinct constructor
// identities (for example, when two worktrees provide the same dependency).
// Keep the lookup helpers compatible with those equivalent object graphs
// instead of treating a valid dictionary as absent and silently replacing it.
function isPdfDictLike(value: unknown): value is PDFDict {
    return value instanceof PDFDict || (
        isRecord(value)
        && typeof value.get === 'function'
        && typeof value.keys === 'function'
        && typeof value.lookupMaybe === 'function'
    );
}

function isPdfArrayLike(value: unknown): value is PDFArray {
    return value instanceof PDFArray || (
        isRecord(value)
        && typeof value.get === 'function'
        && typeof value.size === 'function'
        && typeof value.set === 'function'
    );
}

function isPdfStreamLike(value: unknown): value is PDFStream {
    return value instanceof PDFStream || (
        isRecord(value)
        && typeof value.getContents === 'function'
        && typeof value.getContentsString === 'function'
    );
}

function isPdfNameLike(value: unknown): value is PDFName {
    return value instanceof PDFName || (
        isRecord(value)
        && typeof value.asString === 'function'
        && typeof value.value === 'function'
    );
}

function isPdfNumberLike(value: unknown): value is PDFNumber {
    return value instanceof PDFNumber || (
        isRecord(value)
        && typeof value.asNumber === 'function'
    );
}

function isPdfRefLike(value: unknown): value is PDFRef {
    if (value instanceof PDFRef) {
        return true;
    }
    if (!isRecord(value)) {
        return false;
    }
    const objectNumber = value.objectNumber;
    const generationNumber = value.generationNumber;
    const tag = value.tag;
    return typeof objectNumber === 'number'
        && Number.isSafeInteger(objectNumber)
        && typeof generationNumber === 'number'
        && Number.isSafeInteger(generationNumber)
        && typeof tag === 'string'
        && tag === `${objectNumber} ${generationNumber} R`;
}

function lookupPdfObject(context: PDFContext, value: PDFObject | PDFRef | undefined) {
    let result = context.lookup(value);
    // A foreign PDFRef is not recognized by PDFContext's instanceof check.
    // Recreate the ref with this copy's constructor before giving up.
    if (isPdfRefLike(value) && result === value) {
        result = context.lookup(PDFRef.of(value.objectNumber, value.generationNumber));
    }
    return result;
}

function lookupNamedPdfObject(dict: PDFDict, key: PDFName) {
    const directValue = dict.get(key);
    if (directValue !== undefined) {
        return lookupPdfObject(dict.context, directValue);
    }

    const keyText = key.asString();
    const actualKey = dict.keys().find(candidate => isPdfNameLike(candidate) && candidate.asString() === keyText);
    if (actualKey === undefined) {
        return undefined;
    }
    return lookupPdfObject(dict.context, dict.get(actualKey));
}

export function isPdfUnexpectedObjectTypeError(error: unknown) {
    return error instanceof UnexpectedObjectTypeError
        || (error instanceof Error && getErrorMessage(error).startsWith(UNEXPECTED_OBJECT_TYPE_MESSAGE_PREFIX));
}

function handleOptionalPdfLookupError(error: unknown) {
    if (isPdfUnexpectedObjectTypeError(error)) {
        return null;
    }
    throw error;
}

export function safePdfContextLookupArray(context: PDFContext, value: unknown) {
    try {
        const resolved = lookupPdfObject(context, value as PDFObject | PDFRef | undefined);
        return isPdfArrayLike(resolved) ? resolved : null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfContextLookupDict(context: PDFContext, value: unknown) {
    try {
        const resolved = lookupPdfObject(context, value as PDFObject | PDFRef | undefined);
        return isPdfDictLike(resolved) ? resolved : null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfContextLookupStream(context: PDFContext, value: unknown) {
    try {
        const resolved = lookupPdfObject(context, value as PDFObject | PDFRef | undefined);
        return isPdfStreamLike(resolved) ? resolved : null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupArray(dict: PDFDict, key: PDFName) {
    try {
        const resolved = lookupNamedPdfObject(dict, key);
        return isPdfArrayLike(resolved) ? resolved : null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupDict(dict: PDFDict, key: PDFName) {
    try {
        const resolved = lookupNamedPdfObject(dict, key);
        return isPdfDictLike(resolved) ? resolved : null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupName(dict: PDFDict, key: PDFName) {
    try {
        const resolved = lookupNamedPdfObject(dict, key);
        return isPdfNameLike(resolved) ? resolved : null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupNumber(dict: PDFDict, key: PDFName) {
    try {
        const resolved = lookupNamedPdfObject(dict, key);
        return isPdfNumberLike(resolved) ? resolved : null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfPageAnnots(page: PDFPage) {
    return safePdfDictLookupArray(page.node, PDFName.of('Annots'));
}

export function safePdfPageInheritableDict(page: PDFPage, key: PDFName) {
    let node: PDFDict | null = page.node;
    const visitedNodes = new Set<PDFDict>();

    for (let depth = 0; node && depth < MAX_INHERITABLE_LOOKUP_DEPTH; depth += 1) {
        if (visitedNodes.has(node)) {
            return null;
        }
        visitedNodes.add(node);

        const value = lookupNamedPdfObject(node, key);
        if (value !== undefined) {
            if (isPdfDictLike(value)) {
                return value;
            }
            return null;
        }

        const parentValue = lookupNamedPdfObject(node, PDFName.of('Parent'));
        if (isPdfDictLike(parentValue)) {
            node = parentValue;
            continue;
        }
        return null;
    }

    return null;
}
