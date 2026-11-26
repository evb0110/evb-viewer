import {randomUUID} from 'node:crypto';
import {
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    decodePdfSearchIndexWasmOutput,
    decodePdfSearchJsonOutput,
    encodePdfSearchWasmRequest,
    PDF_SEARCH_WASM_MAX_INDEX_BYTES,
    type IPdfSearchWasmQueryFields,
} from '@contracts/searchIndexWire';
import {
    PdfSearchNativeError,
    type createPdfSearchWasmRunner,
} from '@electron/features/search/pdfSearchWasmRunner';

export type TPdfSearchWorkerCommand =
    | {
        op: 'index';
        indexPath: string;
        documentRevision: string;
        pageCount?: number;
        maxPageTextBytes: number;
        maxTotalTextBytes: number;
        pagesBuffer: Uint8Array;
    }
    | {
        op: 'stat';
        indexPath: string;
        documentRevision: string;
    }
    | ({
        op: 'search';
        indexPath: string;
        documentRevision: string;
    } & IPdfSearchWasmQueryFields)
    | ({
        op: 'searchPages';
        documentRevision: string;
        pageCount?: number;
        allowRegex?: boolean;
        pagesBuffer: Uint8Array;
    } & IPdfSearchWasmQueryFields);

function isErrnoCode(error: unknown, code: string) {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as {code?: unknown}).code === code;
}

async function readIndexFileOrNull(indexPath: string): Promise<Uint8Array | null> {
    try {
        const buffer = await readFile(indexPath);
        if (buffer.byteLength > PDF_SEARCH_WASM_MAX_INDEX_BYTES) {
            throw new PdfSearchNativeError(
                'too-large',
                `Search index exceeds the ${PDF_SEARCH_WASM_MAX_INDEX_BYTES}-byte admission ceiling`,
            );
        }
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) {
            return null;
        }
        if (error instanceof PdfSearchNativeError) {
            throw error;
        }
        throw new PdfSearchNativeError(
            'io',
            `Search index could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function writeIndexFileAtomic(indexPath: string, bytes: Uint8Array) {
    const tempPath = `${indexPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await writeFile(tempPath, bytes);
        await rename(tempPath, indexPath);
    } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw new PdfSearchNativeError(
            'io',
            `Search index could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export async function executePdfSearchWorkerCommand(
    runner: ReturnType<typeof createPdfSearchWasmRunner>,
    command: TPdfSearchWorkerCommand,
): Promise<unknown> {
    switch (command.op) {
        case 'index': {
            const request = encodePdfSearchWasmRequest({
                op: 'index',
                documentRevision: command.documentRevision,
                ...(command.pageCount === undefined ? {} : {pageCount: command.pageCount}),
                maxPageTextBytes: command.maxPageTextBytes,
                maxTotalTextBytes: command.maxTotalTextBytes,
            }, command.pagesBuffer);
            const output = runner.run(request);
            const {
                coverage,
                indexBytes,
            } = decodePdfSearchIndexWasmOutput(output);
            await writeIndexFileAtomic(command.indexPath, indexBytes);
            return coverage;
        }
        case 'stat': {
            const indexBytes = await readIndexFileOrNull(command.indexPath);
            if (indexBytes === null) {
                return {stale: true};
            }
            const request = encodePdfSearchWasmRequest({
                op: 'stat',
                documentRevision: command.documentRevision,
            }, indexBytes);
            return decodePdfSearchJsonOutput(runner.run(request));
        }
        case 'search': {
            const indexBytes = await readIndexFileOrNull(command.indexPath);
            if (indexBytes === null) {
                return {stale: true};
            }
            const {
                op: _op,
                indexPath: _indexPath,
                ...headerFields
            } = command;
            const request = encodePdfSearchWasmRequest({
                op: 'search',
                ...headerFields,
            }, indexBytes);
            return decodePdfSearchJsonOutput(runner.run(request));
        }
        case 'searchPages': {
            const {
                op: _op,
                pagesBuffer,
                ...headerFields
            } = command;
            const request = encodePdfSearchWasmRequest({
                op: 'searchPages',
                ...headerFields,
            }, pagesBuffer);
            return decodePdfSearchJsonOutput(runner.run(request));
        }
    }
}
