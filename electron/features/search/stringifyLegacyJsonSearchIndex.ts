import type { IPdfSearchIndex } from '@electron/features/search/searchIndexTypes';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';

const log = createLogger('indexBuilder');

const SEARCH_LEGACY_JSON_INDEX_MAX_BYTES = parseIntegerEnv(
    'EVB_SEARCH_LEGACY_JSON_MAX_BYTES',
    128 * 1024 * 1024,
    16 * 1024 * 1024,
    512 * 1024 * 1024,
);
const SEARCH_LEGACY_JSON_MAX_GEOMETRY_WORDS = parseIntegerEnv(
    'EVB_SEARCH_LEGACY_JSON_MAX_GEOMETRY_WORDS',
    250_000,
    1_000,
    5_000_000,
);
const SEARCH_LEGACY_JSON_WORD_RECORD_ESTIMATE_BYTES = 96;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function pageHasSearchGeometry(page: IPdfSearchIndex['pages'][number]) {
    return Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && typeof page.pageHeight === 'number';
}

function stripSearchIndexGeometry(index: IPdfSearchIndex): IPdfSearchIndex {
    return {
        ...index,
        pages: index.pages.map(page => ({
            pageNumber: page.pageNumber,
            text: page.text,
        })),
    };
}

function estimateLegacyJsonIndexFootprint(
    index: IPdfSearchIndex,
    signal?: AbortSignal,
) {
    let estimatedBytes = 1024
        + Buffer.byteLength(index.pdfPath, 'utf8')
        + Buffer.byteLength(index.documentRevision.token, 'utf8');
    let geometryWordCount = 0;
    let hasGeometry = false;

    for (const page of index.pages) {
        throwIfAborted(signal);
        estimatedBytes += 96 + Buffer.byteLength(page.text, 'utf8');
        if (!pageHasSearchGeometry(page)) {
            continue;
        }

        hasGeometry = true;
        estimatedBytes += 96;
        for (const word of page.words ?? []) {
            throwIfAborted(signal);
            geometryWordCount += 1;
            estimatedBytes += SEARCH_LEGACY_JSON_WORD_RECORD_ESTIMATE_BYTES
                + Buffer.byteLength(word.text, 'utf8');
        }
    }

    return {
        estimatedBytes,
        geometryWordCount,
        hasGeometry,
    };
}

function shouldStripLegacyJsonGeometry(
    index: IPdfSearchIndex,
    signal?: AbortSignal,
) {
    const footprint = estimateLegacyJsonIndexFootprint(index, signal);
    return footprint.hasGeometry
        && (
            footprint.geometryWordCount > SEARCH_LEGACY_JSON_MAX_GEOMETRY_WORDS
            || footprint.estimatedBytes > SEARCH_LEGACY_JSON_INDEX_MAX_BYTES
        );
}

function isInvalidStringLengthError(error: unknown) {
    return error instanceof RangeError
        && getErrorMessage(error).includes('Invalid string length');
}

export function stringifyLegacyJsonSearchIndex(
    index: IPdfSearchIndex,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const persistableIndex = shouldStripLegacyJsonGeometry(index, signal)
        ? stripSearchIndexGeometry(index)
        : index;

    try {
        const content = JSON.stringify(persistableIndex);
        if (persistableIndex !== index) {
            log.debug(`Persisting text-only legacy search index because geometry would exceed ${SEARCH_LEGACY_JSON_INDEX_MAX_BYTES} bytes`);
        }
        return content;
    } catch (error) {
        if (persistableIndex !== index || !isInvalidStringLengthError(error)) {
            throw error;
        }
        log.debug('Retrying legacy search index persistence without word geometry after string allocation failure');
        return JSON.stringify(stripSearchIndexGeometry(index));
    }
}
