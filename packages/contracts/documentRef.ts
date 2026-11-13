import type {TBrand} from '@contracts/brand';

export type TDocumentBackend = 'electron' | 'browser';

// Remove when every IPC surface in electronApiDocuments.ts accepts only TStructuredDocumentRef and the recent-files store is migrated.
export type TLegacyDocumentRef = TBrand<string, 'DocumentRef'>;

export interface IBrowserDocumentRef {
    kind: 'browser-document-ref';
    backend: 'browser';
    ref: TDocumentRef;
}

export interface INativeDocumentRef {
    kind: 'native-document-ref';
    backend: 'electron';
    path: TDocumentRef;
}

export type TStructuredDocumentRef = IBrowserDocumentRef | INativeDocumentRef;

export type TDocumentRef = TLegacyDocumentRef;

const BROWSER_DOCUMENT_REF_PREFIX = 'browser://documents/';
const POSIX_ABSOLUTE_PATH_PATTERN = /^\//u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/iu;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/u;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBrowserLegacyDocumentRef(value: unknown): value is TDocumentRef {
    return typeof value === 'string' && value.startsWith(BROWSER_DOCUMENT_REF_PREFIX);
}

export function isNativeLegacyDocumentRef(value: unknown): value is TDocumentRef {
    return typeof value === 'string'
        && (
            POSIX_ABSOLUTE_PATH_PATTERN.test(value)
            || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
            || WINDOWS_UNC_PATH_PATTERN.test(value)
        );
}

export function parseDocumentRef(value: unknown): TDocumentRef | null {
    return isBrowserLegacyDocumentRef(value) || isNativeLegacyDocumentRef(value)
        ? value
        : null;
}

export function requireDocumentRef(value: unknown): TDocumentRef {
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        throw new TypeError('Document reference must be a browser reference or absolute path');
    }
    return parsed;
}

export function isBrowserStructuredDocumentRef(value: unknown): value is IBrowserDocumentRef {
    return isRecord(value)
        && value.kind === 'browser-document-ref'
        && value.backend === 'browser'
        && isBrowserLegacyDocumentRef(value.ref);
}

export function isNativeStructuredDocumentRef(value: unknown): value is INativeDocumentRef {
    return isRecord(value)
        && value.kind === 'native-document-ref'
        && value.backend === 'electron'
        && isNativeLegacyDocumentRef(value.path);
}

export function createBrowserDocumentRefValue(ref: string): IBrowserDocumentRef {
    if (!isBrowserLegacyDocumentRef(ref)) {
        throw new TypeError('Browser document refs must start with browser://documents/');
    }

    return {
        kind: 'browser-document-ref',
        backend: 'browser',
        ref,
    };
}

export function createNativeDocumentRefValue(path: string): INativeDocumentRef {
    if (!isNativeLegacyDocumentRef(path)) {
        throw new TypeError('Native document refs must be absolute paths');
    }

    return {
        kind: 'native-document-ref',
        backend: 'electron',
        path,
    };
}

export function inferDocumentRefBackend(ref: TDocumentRef): TDocumentBackend | 'unknown' {
    if (isBrowserLegacyDocumentRef(ref)) {
        return 'browser';
    }

    if (isNativeLegacyDocumentRef(ref)) {
        return 'electron';
    }

    return 'unknown';
}
