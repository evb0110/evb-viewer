import {
    PDF_ANNOTATION_PARSE_MAX_ENTRIES,
    PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
    type IPdfAnnotationParseResult,
} from '@contracts/pdfAnnotationParseTypes';
import {PDF_ANNOTATION_PARSE_ENTRY_SCHEMA} from '@contracts/pdfAnnotationParseSchemas';
import {isRecord} from '@contracts/runtimeGuards';
import {BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';
import * as v from 'valibot';

const BROWSER_ANNOTATION_PARSE_MAX_OUTPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;

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

export function decodeBrowserPdfAnnotationsOutput(data: Uint8Array): Pick<
    IPdfAnnotationParseResult,
    'pageCount' | 'entities' | 'foreign'
> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error('PDF annotation parse WASM output is empty');
    }
    if (data.byteLength > BROWSER_ANNOTATION_PARSE_MAX_OUTPUT_BYTES) {
        throw new Error(
            `PDF annotation parse browser output exceeds ${BROWSER_ANNOTATION_PARSE_MAX_OUTPUT_BYTES} bytes`,
        );
    }
    let text: string;
    try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(data);
    } catch (error) {
        throw new Error('PDF annotation parse WASM output is not valid UTF-8', {cause: error});
    }
    const rawLines = text.split('\n');
    if (rawLines.at(-1) === '') {
        rawLines.pop();
    }
    if (rawLines.length === 0) {
        throw new Error('PDF annotation parse WASM output is missing its header');
    }
    const encoder = new TextEncoder();
    const lines = rawLines.map((line, index) => {
        const byteLength = encoder.encode(`${line}\n`).byteLength;
        if (byteLength > PDF_ANNOTATION_PARSE_MAX_LINE_BYTES) {
            throw new Error(
                `PDF annotation parse WASM output line ${index + 1} exceeds ${PDF_ANNOTATION_PARSE_MAX_LINE_BYTES} bytes`,
            );
        }
        return line.endsWith('\r') ? line.slice(0, -1) : line;
    });
    const pageCount = decodeHeader(parseJsonLine(lines[0]!, 1));
    const entities: IPdfAnnotationParseResult['entities'] = [];
    const foreign: IPdfAnnotationParseResult['foreign'] = [];
    for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
        const entries = decodeChunk(
            parseJsonLine(lines[lineIndex]!, lineIndex + 1),
            lineIndex - 1,
            lineIndex + 1,
        );
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
    return {
        pageCount,
        entities,
        foreign,
    };
}
