import {
    PDF_ANNOTATION_PARSE_MAX_ENTRIES,
    PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
    type IPdfAnnotationForeignEntry,
    type IPdfAnnotationParseResult,
    type TPdfAnnotationParseEntity,
} from '@contracts/pdfAnnotationParseTypes';
import {decodePdfAnnotationParseEntry} from '@contracts/pdfAnnotationParseSchemas';
import {isRecord} from '@contracts/runtimeGuards';
import {BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';

const BROWSER_ANNOTATION_PARSE_MAX_OUTPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;

function rejectUnknownFields(value: Record<string, unknown>, label: string, allowed: readonly string[]) {
    const unknown = Object.keys(value).find(key => !allowed.includes(key));
    if (unknown !== undefined) {
        throw new Error(`${label} contains unsupported field ${unknown}`);
    }
}

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
    rejectUnknownFields(value, 'PDF annotation parse WASM header', [
        'format',
        'schemaVersion',
        'pageCount',
        'chunkBytes',
    ]);
    if (
        value.format !== 'evb-pdf-annotation-parse'
        || value.schemaVersion !== 1
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
        || typeof value.chunkBytes !== 'number'
        || !Number.isSafeInteger(value.chunkBytes)
        || value.chunkBytes < 64
        || value.chunkBytes > PDF_ANNOTATION_PARSE_MAX_LINE_BYTES
    ) {
        throw new Error('PDF annotation parse WASM output has an unsupported header');
    }
    return value.pageCount;
}

function decodeChunk(value: unknown, expectedChunkIndex: number, lineNumber: number) {
    if (!isRecord(value)) {
        throw new Error(`PDF annotation parse WASM output line ${lineNumber} is not an object`);
    }
    rejectUnknownFields(value, `PDF annotation parse WASM chunk ${lineNumber}`, [
        'chunkIndex',
        'entries',
    ]);
    if (
        typeof value.chunkIndex !== 'number'
        || !Number.isSafeInteger(value.chunkIndex)
        || value.chunkIndex !== expectedChunkIndex
        || !Array.isArray(value.entries)
    ) {
        throw new Error(`PDF annotation parse WASM output line ${lineNumber} has an invalid chunk`);
    }
    return value.entries.map(decodePdfAnnotationParseEntry);
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
    const entities: TPdfAnnotationParseEntity[] = [];
    const foreign: IPdfAnnotationForeignEntry[] = [];
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
