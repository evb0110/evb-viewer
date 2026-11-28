import {parseDocumentRef} from '@contracts/documentRef';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {isRecord} from '@contracts/runtimeGuards';
import {requireRequestId} from '@contracts/shared';

type TPreloadArgMapper = (...args: unknown[]) => readonly unknown[];

const SEARCH_REQUEST_ID_MAX_LENGTH = 128;
const SEARCH_PDF_PATH_MAX_LENGTH = 4_096;
const SEARCH_QUERY_MAX_LENGTH = 2_048;
const SEARCH_REGEX_QUERY_MAX_LENGTH = 512;
const SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH = 8_192;

function fixedArityMapper(arity: number): TPreloadArgMapper {
    return (...args: unknown[]) => Array.from({length: arity}, (_entry, index) => args[index]);
}

function normalizeOptionalSearchRequestId(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== 'string') {
        throw new Error('requestId must be a string');
    }
    const requestId = raw.trim();
    if (!requestId) {
        return undefined;
    }
    if (requestId.length > SEARCH_REQUEST_ID_MAX_LENGTH) {
        throw new Error(`requestId exceeds maximum length (${SEARCH_REQUEST_ID_MAX_LENGTH})`);
    }
    return requireRequestId(requestId);
}

function normalizeOptionalSearchPageCount(raw: unknown) {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
        throw new Error('Invalid pageCount: must be a positive safe integer');
    }
    return raw;
}

function normalizeSearchPdfPath(raw: unknown) {
    const pdfPath = typeof raw === 'string' ? raw.trim() : '';
    if (!pdfPath) {
        throw new Error('Invalid PDF path');
    }
    if (pdfPath.length > SEARCH_PDF_PATH_MAX_LENGTH) {
        throw new Error(`Invalid PDF path: maximum length is ${SEARCH_PDF_PATH_MAX_LENGTH} characters`);
    }
    const documentRef = parseDocumentRef(pdfPath);
    if (documentRef === null) {
        throw new Error('Invalid PDF path');
    }
    return documentRef;
}

function normalizeOptionalSearchDocumentRevision(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length === 0) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length > SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH) {
        throw new Error(`documentRevision exceeds maximum length (${SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH})`);
    }
    const documentRevision = parseDocumentRevisionToken(raw);
    if (documentRevision === null) {
        throw new Error('documentRevision must be a valid document revision token');
    }
    return documentRevision;
}

function normalizeSearchResultOffset(raw: unknown) {
    if (raw === undefined) {
        return undefined;
    }
    if (raw === 'last' || (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0)) {
        return raw;
    }
    throw new Error('Invalid search request payload');
}

function mapWarmIndexSearchRequest(pdfPath: unknown, options: unknown) {
    const opts = isRecord(options) ? options : {};
    const pageCount = normalizeOptionalSearchPageCount(opts.pageCount);
    const requestId = normalizeOptionalSearchRequestId(opts.requestId);
    const documentRevision = normalizeOptionalSearchDocumentRevision(opts.documentRevision);
    return {
        pdfPath: normalizeSearchPdfPath(pdfPath),
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}

function mapPdfSearchRequest(pdfPath: unknown, query: unknown, options: unknown) {
    if (typeof query !== 'string') {
        throw new Error('Invalid search query');
    }
    const opts = isRecord(options) ? options : {};
    const resultOffset = normalizeSearchResultOffset(opts.resultOffset);
    const matchCase = typeof opts.matchCase === 'boolean' ? opts.matchCase : undefined;
    const wholeWord = typeof opts.wholeWord === 'boolean' ? opts.wholeWord : undefined;
    const useRegex = typeof opts.useRegex === 'boolean' ? opts.useRegex : undefined;
    const maxLength = useRegex === true ? SEARCH_REGEX_QUERY_MAX_LENGTH : SEARCH_QUERY_MAX_LENGTH;
    if (query.length > maxLength) {
        throw new Error(`Invalid search query: maximum length is ${maxLength} characters`);
    }
    return {
        ...mapWarmIndexSearchRequest(pdfPath, opts),
        query,
        ...(resultOffset === undefined ? {} : {resultOffset}),
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    };
}

/**
 * Preload-side client argument mappers for platform feature methods that declare
 * `client.mapArgs`. Main-process IPC validation still runs the canonical Valibot
 * schemas on every call; keeping these pure mappers separate lets `preload.cjs`
 * drop all main-side request schemas while preserving exact wire argument shapes.
 *
 * `scripts/build-electron.mjs` fails the build if any platform feature method
 * with `client.mapArgs` is missing from this table.
 */
export const PRELOAD_METHOD_ARG_MAPPERS: Readonly<Record<string, TPreloadArgMapper>> = {
    // djvu
    'djvu:open:start': fixedArityMapper(2),
    'djvu:convert:start': fixedArityMapper(3),
    'djvu:printDjvuPath': fixedArityMapper(2),
    'djvu:cancelPagePreview': fixedArityMapper(1),
    'djvu:text:search': (path, query, options) => [
        path,
        query,
        isRecord(options)
            ? {
                  ...options,
                  matchCase: options.matchCase ?? false,
                  wholeWord: options.wholeWord ?? false,
                  useRegex: options.useRegex ?? false,
              }
            : options,
    ],
    'djvu:text:cancel': fixedArityMapper(1),
    'djvu:renderPagePreview': fixedArityMapper(3),

    // imageExport
    'pdfExport:region': (region) => [region],
    'pdfExport:images': fixedArityMapper(4),
    'pdfExport:multipage-tiff': fixedArityMapper(4),

    // pageOps
    'page-ops:text-box-appearance': (workingCopyPath, request) => [workingCopyPath, request],
    'page-ops:delete': fixedArityMapper(4),
    'page-ops:delete-ranges': fixedArityMapper(4),
    'page-ops:extract': fixedArityMapper(2),
    'page-ops:reorder': fixedArityMapper(3),
    'page-ops:move': fixedArityMapper(6),
    'page-ops:move-ranges': fixedArityMapper(5),
    'page-ops:insert': fixedArityMapper(4),
    'page-ops:insert-file': fixedArityMapper(6),
    'page-ops:rotate': fixedArityMapper(5),
    'page-ops:crop': fixedArityMapper(5),
    'page-ops:remove-crop': fixedArityMapper(4),
    'page-ops:cancel-active': fixedArityMapper(1),
    'page-ops:get-page-geometry': fixedArityMapper(2),
    'page-ops:read-outline': fixedArityMapper(1),

    // search
    'pdf:search': (pdfPath, query, options) => [mapPdfSearchRequest(pdfPath, query, options)],
    'pdf:search:warmIndex': (pdfPath, options) => [mapWarmIndexSearchRequest(pdfPath, options)],
    'pdf:search:cancel': (requestId) => [normalizeOptionalSearchRequestId(requestId)],
};

/**
 * Strips reactive Vue Proxy wrappers into plain structured-cloneable IPC values
 * for scan-cleanup requests, without pulling main-side Valibot request schemas
 * into `preload.cjs`.
 */
export function toPlainIpcValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Date) {
        return value;
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (Array.isArray(value)) {
        const plain: unknown[] = [];
        seen.set(value, plain);
        for (const item of value) {
            plain.push(toPlainIpcValue(item, seen));
        }
        return plain;
    }
    const plain: Record<string, unknown> = {};
    seen.set(value, plain);
    for (const [key, entry] of Object.entries(value)) {
        plain[key] = toPlainIpcValue(entry, seen);
    }
    return plain;
}
