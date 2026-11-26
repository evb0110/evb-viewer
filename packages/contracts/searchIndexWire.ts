import {isRecord} from '@contracts/runtimeGuards';
import {
    pdfSearchResultSchema,
    SEARCH_INDEX_COVERAGE_SCHEMA,
    SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES,
    type ISearchIndexCoverage,
    type TSearchResultOffset,
} from '@contracts/search';
import * as v from 'valibot';

/**
 * The text budget of one document's index, in UTF-8 bytes of normalized page
 * text. A page above the page budget, or one that would take the index above
 * the total, ends the index there and its coverage reports it truncated.
 * Every shell's search uses the same page budget.
 */
export const SEARCH_INDEX_TEXT_BUDGET = {
    maxPageTextBytes: SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES,
    maxTotalTextBytes: 256 * 1024 * 1024,
} as const;

export const PDF_SEARCH_WASM_MAX_INDEX_BYTES = 320 * 1024 * 1024;
export const PDF_SEARCH_WASM_MAX_REQUEST_BYTES = PDF_SEARCH_WASM_MAX_INDEX_BYTES + (16 * 1024);
export const PDF_SEARCH_WASM_MAX_OUTPUT_BYTES = PDF_SEARCH_WASM_MAX_INDEX_BYTES + (64 * 1024);
export const PDF_SEARCH_WASM_EXPORT_PREFIX = 'evb_pdf_search';

const PDF_SEARCH_WASM_MAGIC = new Uint8Array([
    0x45,
    0x50,
    0x53,
    0x52,
]); // "EPSR"
const PDF_SEARCH_WASM_VERSION = 1;
const PDF_SEARCH_WASM_PREFIX_BYTES = 12;
const PAGE_RECORD_HEADER_BYTES = 12;
const PAGE_RECORD_FLAG_TEXT = 0;
const PAGE_RECORD_FLAG_OVER_BUDGET = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * One page entry for `evb-pdf-search` indexing or provisional page search:
 * a page's text, in increasing page order, or the page where the producer
 * stopped because its text is over the budget, which must be the last entry.
 */
export type TSearchIndexInputLine =
    | {
        pageNumber: number;
        text: string;
    }
    | {
        pageNumber: number;
        overBudget: true;
    };

export interface IPdfSearchWasmQueryFields {
    query: string;
    limit?: number;
    contextChars?: number;
    resultOffset?: TSearchResultOffset;
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
    pages?: readonly number[];
}

export type TPdfSearchWasmHeader =
    | {
        op: 'index';
        documentRevision: string;
        pageCount?: number;
        maxPageTextBytes?: number;
        maxTotalTextBytes?: number;
    }
    | {
        op: 'stat';
        documentRevision: string;
    }
    | ({
        op: 'search';
        documentRevision: string;
    } & IPdfSearchWasmQueryFields)
    | ({
        op: 'searchPages';
        documentRevision: string;
        pageCount?: number;
        maxPageTextBytes?: number;
        maxTotalTextBytes?: number;
        allowRegex?: boolean;
    } & IPdfSearchWasmQueryFields)
    | {
        op: 'matchPage';
        query: string;
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
        maxMatches: number;
        resultOffset?: TSearchResultOffset;
    };

export function encodePdfSearchPageRecord(line: TSearchIndexInputLine): Uint8Array {
    if ('overBudget' in line) {
        const record = new Uint8Array(PAGE_RECORD_HEADER_BYTES);
        const view = new DataView(record.buffer);
        view.setUint32(0, line.pageNumber, true);
        view.setUint32(4, PAGE_RECORD_FLAG_OVER_BUDGET, true);
        view.setUint32(8, 0, true);
        return record;
    }
    const textBytes = textEncoder.encode(line.text);
    const record = new Uint8Array(PAGE_RECORD_HEADER_BYTES + textBytes.byteLength);
    const view = new DataView(record.buffer);
    view.setUint32(0, line.pageNumber, true);
    view.setUint32(4, PAGE_RECORD_FLAG_TEXT, true);
    view.setUint32(8, textBytes.byteLength, true);
    record.set(textBytes, PAGE_RECORD_HEADER_BYTES);
    return record;
}

export function concatUint8Arrays(chunks: readonly Uint8Array[], totalBytes?: number): Uint8Array<ArrayBuffer> {
    const length = totalBytes ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(new ArrayBuffer(length));
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

export function encodePdfSearchPagesPayload(pages: Iterable<TSearchIndexInputLine>): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (const page of pages) {
        const encoded = encodePdfSearchPageRecord(page);
        chunks.push(encoded);
        totalBytes += encoded.byteLength;
    }
    return concatUint8Arrays(chunks, totalBytes);
}

export function encodePdfSearchWasmRequest(
    header: TPdfSearchWasmHeader,
    payload: Uint8Array = new Uint8Array(0),
): Uint8Array<ArrayBuffer> {
    const headerBytes = textEncoder.encode(JSON.stringify(header));
    const request = new Uint8Array(new ArrayBuffer(
        PDF_SEARCH_WASM_PREFIX_BYTES + headerBytes.byteLength + payload.byteLength,
    ));
    request.set(PDF_SEARCH_WASM_MAGIC, 0);
    const view = new DataView(request.buffer);
    view.setUint32(4, PDF_SEARCH_WASM_VERSION, true);
    view.setUint32(8, headerBytes.byteLength, true);
    request.set(headerBytes, PDF_SEARCH_WASM_PREFIX_BYTES);
    if (payload.byteLength > 0) {
        request.set(payload, PDF_SEARCH_WASM_PREFIX_BYTES + headerBytes.byteLength);
    }
    return request;
}

export function decodePdfSearchJsonOutput(output: Uint8Array): unknown {
    return JSON.parse(textDecoder.decode(output)) as unknown;
}

export function decodePdfSearchIndexWasmOutput(output: Uint8Array): {
    coverage: ISearchIndexCoverage;
    indexBytes: Uint8Array<ArrayBuffer>;
} {
    if (output.byteLength < 4) {
        throw new Error('evb-pdf-search index returned a truncated response');
    }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const coverageLen = view.getUint32(0, true);
    if (4 + coverageLen > output.byteLength) {
        throw new Error('evb-pdf-search index returned a truncated coverage report');
    }
    const rawCoverage: unknown = JSON.parse(textDecoder.decode(output.subarray(4, 4 + coverageLen)));
    const parsed = v.safeParse(SEARCH_INDEX_COVERAGE_SCHEMA, rawCoverage, {abortEarly: true});
    if (!parsed.success) {
        throw new Error('evb-pdf-search index returned an invalid coverage report');
    }
    const indexSlice = output.subarray(4 + coverageLen);
    const indexBytes = new Uint8Array(new ArrayBuffer(indexSlice.byteLength));
    indexBytes.set(indexSlice);
    return {
        coverage: parsed.output,
        indexBytes,
    };
}

export {
    SEARCH_INDEX_COVERAGE_SCHEMA, type ISearchIndexCoverage,
} from '@contracts/search';

/** `evb-pdf-search` search output; the page count also appears at the top level. */
export const SEARCH_INDEX_RESPONSE_SCHEMA = v.pipe(v.object({
    results: v.array(pdfSearchResultSchema),
    truncated: v.boolean(),
    coverage: SEARCH_INDEX_COVERAGE_SCHEMA,
}), v.transform(({
    results,
    truncated,
    coverage,
}) => ({
    results,
    truncated,
    pageCount: coverage.pageCount,
    coverage,
})));

export type ISearchIndexResponse = v.InferOutput<typeof SEARCH_INDEX_RESPONSE_SCHEMA>;

const nonNegativeSafeInt = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const PDF_SEARCH_MATCH_PAGE_RESPONSE_SCHEMA = v.object({
    matches: v.array(v.pipe(
        v.object({
            pageMatchIndex: nonNegativeSafeInt,
            startOffset: nonNegativeSafeInt,
            endOffset: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        }),
        v.check(value => value.endOffset > value.startOffset),
    )),
    truncated: v.boolean(),
    matchCount: nonNegativeSafeInt,
});

export type IPdfSearchMatchPageResponse = v.InferOutput<typeof PDF_SEARCH_MATCH_PAGE_RESPONSE_SCHEMA>;

/**
 * Every `evb-pdf-search` index read answers `{"stale":true}` when the index is
 * missing, unreadable, or describes another revision or format.
 */
export function isStaleSearchIndexAnswer(value: unknown): value is {stale: true} {
    return isRecord(value) && value.stale === true;
}
