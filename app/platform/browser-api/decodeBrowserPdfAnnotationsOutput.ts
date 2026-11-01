import {
    PDF_ANNOTATION_PARSE_MAX_ENTRIES,
    PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
    type IPdfAnnotationParseResult,
} from '@contracts/pdfAnnotationParseTypes';
import {PDF_ANNOTATION_PARSE_ENTRY_SCHEMA} from '@contracts/pdfAnnotationParseSchemas';
import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';

const headerSchema = v.strictObject({
    format: v.literal('evb-pdf-annotation-parse'),
    schemaVersion: v.literal(1),
    pageCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    chunkBytes: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(64),
        v.maxValue(PDF_ANNOTATION_PARSE_MAX_LINE_BYTES),
    ),
});

const chunkSchema = v.strictObject({
    chunkIndex: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    entries: v.array(PDF_ANNOTATION_PARSE_ENTRY_SCHEMA),
});

function parseJsonLine(line: string, lineNumber: number) {
    try {
        return JSON.parse(line) as unknown;
    } catch (error) {
        throw new Error(`PDF annotation parse WASM output contains invalid JSON on line ${lineNumber}`, {cause: error});
    }
}

function decodeHeader(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('PDF annotation parse WASM output is missing its header');
    }
    const result = v.safeParse(headerSchema, value, {abortEarly: true});
    if (!result.success) {
        throw new Error('PDF annotation parse WASM output has an unsupported header');
    }
    return result.output.pageCount;
}

function decodeChunk(value: unknown, expectedChunkIndex: number, lineNumber: number) {
    if (!isRecord(value)) {
        throw new Error(`PDF annotation parse WASM output line ${lineNumber} is not an object`);
    }
    const result = v.safeParse(chunkSchema, value, {abortEarly: true});
    if (!result.success || result.output.chunkIndex !== expectedChunkIndex) {
        throw new Error(`PDF annotation parse WASM output line ${lineNumber} has an invalid chunk`);
    }
    return result.output.entries;
}

/**
 * Reads the parse output one JSONL line at a time, as desktop reads its parse
 * session chunk by chunk, so the output's total size is not a limit. Each line
 * and the entry count keep the shared parse limits.
 */
export function decodeBrowserPdfAnnotationsOutput(data: Uint8Array): Pick<
    IPdfAnnotationParseResult,
    'pageCount' | 'entities' | 'foreign'
> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('PDF annotation parse WASM output is empty');
    }
    // A UTF-8 multi-byte sequence never contains 0x0A, so lines split on bytes.
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let pageCount: number | null = null;
    const entities: IPdfAnnotationParseResult['entities'] = [];
    const foreign: IPdfAnnotationParseResult['foreign'] = [];
    for (let start = 0, lineNumber = 1; start < data.byteLength; lineNumber += 1) {
        const newline = data.indexOf(0x0a, start);
        const end = newline === -1 ? data.byteLength : newline;
        if (end + 1 - start > PDF_ANNOTATION_PARSE_MAX_LINE_BYTES) {
            throw new Error(
                `PDF annotation parse WASM output line ${lineNumber} exceeds ${PDF_ANNOTATION_PARSE_MAX_LINE_BYTES} bytes`,
            );
        }
        let line: string;
        try {
            line = decoder.decode(data.subarray(start, end));
        } catch (error) {
            throw new Error('PDF annotation parse WASM output is not valid UTF-8', {cause: error});
        }
        start = end + 1;
        const value = parseJsonLine(line.endsWith('\r') ? line.slice(0, -1) : line, lineNumber);
        if (pageCount === null) {
            pageCount = decodeHeader(value);
            continue;
        }
        const entries = decodeChunk(value, lineNumber - 2, lineNumber);
        if (entities.length + foreign.length + entries.length > PDF_ANNOTATION_PARSE_MAX_ENTRIES) {
            throw new Error(
                `PDF annotation parse WASM output contains more than ${PDF_ANNOTATION_PARSE_MAX_ENTRIES} entries`,
            );
        }
        for (const entry of entries) {
            if (entry.kind === 'foreign') {
                foreign.push(entry);
            } else {
                entities.push(entry);
            }
        }
    }
    if (pageCount === null) {
        throw new Error('PDF annotation parse WASM output is missing its header');
    }
    return {
        pageCount,
        entities,
        foreign,
    };
}
