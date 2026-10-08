import type * as PdfjsLibNamespace from 'pdfjs-dist';
import pdfjsLib, {
    createPdfjsDocumentOptions,
    preparePdfjsBrowserRuntime,
} from '@app/services/pdfjs/runtimeLib';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import { toUint8Array } from '@app/platform/browser-api/browserBytes';
import {PDF_COMBINE_MAX_OUTPUT_BYTES} from '@contracts/pdfCombineOutputPolicy';

const PDFJS_RANGE_CHUNK_SIZE = Math.max(512 * 1024, BROWSER_DOCUMENT_CHUNK_SIZE);
const PDFJS_MAX_RANGE_REQUEST_BYTES = PDF_COMBINE_MAX_OUTPUT_BYTES;

type TPdfjsLib = typeof PdfjsLibNamespace;
type TPdfjsDocumentInit = Parameters<TPdfjsLib['getDocument']>[0];

interface ICreateBrowserPdfjsDocumentInitOptions { onRangeReadFailure?: (error: Error) => void; }

async function getPdfjsLib() {
    await preparePdfjsBrowserRuntime(pdfjsLib);
    return pdfjsLib;
}

function createPdfjsDocumentInit(pdfjsLib: TPdfjsLib, data: Uint8Array) {
    const init = {
        data: toUint8Array(data),
        ...createPdfjsDocumentOptions(pdfjsLib),
    } satisfies TPdfjsDocumentInit;
    return init;
}

async function createPdfjsDocumentInitFromBrowserDocument(
    pdfjsLib: TPdfjsLib,
    path: string,
    options: ICreateBrowserPdfjsDocumentInitOptions = {},
) {
    const {
        size,
        contentSignature,
    } = await browserDocumentStore.getContentSnapshot(path);
    const initialData = await browserDocumentStore.readRange(
        path,
        0,
        Math.min(size, PDFJS_RANGE_CHUNK_SIZE),
    );
    await assertBrowserDocumentUnchanged(path, size, contentSignature);
    if (initialData.byteLength !== Math.min(size, PDFJS_RANGE_CHUNK_SIZE)) {
        throw new Error(`Browser PDF source returned ${initialData.byteLength} bytes for initial ${Math.min(size, PDFJS_RANGE_CHUNK_SIZE)} byte range`);
    }

    if (size <= PDFJS_RANGE_CHUNK_SIZE) {
        return createPdfjsDocumentInit(pdfjsLib, initialData);
    }

    class BrowserDocumentRangeTransport extends pdfjsLib.PDFDataRangeTransport {
        private aborted = false;

        public constructor() {
            super(size, initialData, false);
        }

        public override requestDataRange = (begin: number, end: number) => {
            if (this.aborted || end <= begin) {
                return;
            }

            void this.loadRange(begin, end);
        };

        public override abort = () => {
            this.aborted = true;
        };

        private async loadRange(begin: number, end: number) {
            try {
                const length = end - begin;
                await assertBrowserDocumentUnchanged(path, size, contentSignature);
                const chunk = await readCompleteBrowserDocumentRange(
                    path,
                    begin,
                    Math.max(0, length),
                    end,
                );
                await assertBrowserDocumentUnchanged(path, size, contentSignature);
                if (this.aborted) {
                    return;
                }

                this.onDataRange(begin, chunk);
            } catch (error) {
                if (!this.aborted) {
                    this.aborted = true;
                    options.onRangeReadFailure?.(error instanceof Error ? error : new Error(String(error)));
                    this.abort();
                }
            }
        }
    }

    const init = {
        range: new BrowserDocumentRangeTransport(),
        rangeChunkSize: PDFJS_RANGE_CHUNK_SIZE,
        disableAutoFetch: true,
        disableStream: true,
        ...createPdfjsDocumentOptions(pdfjsLib),
    } satisfies TPdfjsDocumentInit;
    return init;
}

async function assertBrowserDocumentUnchanged(
    path: string,
    expectedSize: number,
    expectedContentSignature: string,
) {
    const {
        size,
        contentSignature,
    } = await browserDocumentStore.getContentSnapshot(path);
    if (size !== expectedSize || contentSignature !== expectedContentSignature) {
        throw new Error('Browser PDF source changed while PDF.js range transport was active');
    }
}

async function readCompleteBrowserDocumentRange(
    path: string,
    begin: number,
    length: number,
    end: number,
) {
    if (length <= 0) {
        return new Uint8Array();
    }
    if (length > PDFJS_MAX_RANGE_REQUEST_BYTES) {
        throw new Error(
            `Browser PDF range request exceeds the safe ${PDFJS_MAX_RANGE_REQUEST_BYTES} byte capacity`,
        );
    }

    let cursor = begin;
    let output: Uint8Array | null = null;
    let outputOffset = 0;
    while (cursor < end) {
        const chunk = await browserDocumentStore.readRange(path, cursor, end - cursor);
        if (chunk.byteLength === 0) {
            throw new Error(`Browser PDF range read returned no bytes at ${cursor} before requested end ${end}`);
        }
        if (cursor === begin && chunk.byteLength === length) {
            return chunk;
        }
        output ??= new Uint8Array(length);
        if (chunk.byteLength > output.byteLength - outputOffset) {
            throw new Error(`Browser PDF range read returned ${chunk.byteLength} bytes for ${output.byteLength - outputOffset} remaining bytes`);
        }
        output.set(chunk, outputOffset);
        outputOffset += chunk.byteLength;
        cursor += chunk.byteLength;
    }

    if (!output) {
        throw new Error(`Browser PDF range read produced no output for ${begin}..${end}`);
    }
    return output;
}

export {
    createPdfjsDocumentInit,
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
};
