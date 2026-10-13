import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import {
    inferDocumentRefBackend,
    isBrowserLegacyDocumentRef,
    isNativeLegacyDocumentRef,
} from '@contracts/documentRef';

export function isBrowserDocumentRef(documentRef: TDocumentRef | null | undefined) {
    return typeof documentRef === 'string' && isBrowserLegacyDocumentRef(documentRef);
}

export function isNativeDocumentRef(documentRef: TDocumentRef | null | undefined) {
    return typeof documentRef === 'string' && isNativeLegacyDocumentRef(documentRef);
}

export function resolveDocumentRefBackend(documentRef: TDocumentRef | null | undefined): TDocumentBackend | undefined {
    if (!documentRef) {
        return undefined;
    }

    const backend = inferDocumentRefBackend(documentRef);
    return backend === 'unknown' ? undefined : backend;
}

export function getDocumentRefBaseName(documentRef: TDocumentRef | null | undefined) {
    if (!documentRef) {
        return null;
    }

    const segment = documentRef.split(/[\\/]/).pop() ?? null;
    if (!segment) {
        return null;
    }

    // Native refs are raw paths, so their basename is literal. Only browser
    // refs carry the single encodeURIComponent pass from browserDocumentRefs.
    return isBrowserDocumentRef(documentRef) ? decodeDocumentRefSegment(segment) : segment;
}

export function getDocumentRefDisplayLabel(documentRef: TDocumentRef | null | undefined) {
    if (!documentRef) {
        return null;
    }

    if (isBrowserDocumentRef(documentRef)) {
        return getDocumentRefBaseName(documentRef) ?? documentRef;
    }

    return documentRef;
}

export function decodeDocumentRefSegment(segment: string) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}
