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

const PDFJS_RANGE_CHUNK_SIZE = Math.min(1024 * 1024, Math.max(512 * 1024, BROWSER_DOCUMENT_CHUNK_SIZE));

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

interface IBrowserPdfjsRangeSource {
    size: number;
    /** Verifies the backing revision is still current before serving cached bytes. */
    assertCurrent?: () => Promise<void>;
    /** The bytes `begin..end`, whole, or a rejection. */
    read(begin: number, end: number): Promise<Uint8Array>;
}

function isStaleFileBlobError(error: unknown) {
    if (!(error instanceof Error)) {return false;}
    return error.name === 'NotReadableError'
        || Reflect.get(error, 'code') === 'NotReadableError'
        || error.message.includes('NotReadableError');
}

/**
 * A stored document read by path through its revision-pinned Blob when
 * available, refused once the revision changes, rolls back, or closes.
 */
async function storedDocumentRanges(path: string): Promise<IBrowserPdfjsRangeSource> {
    if (
        typeof browserDocumentStore.readableRevision === 'function'
        && typeof browserDocumentStore.assertDocumentRevisionCurrent === 'function'
    ) {
        const {
            blob,
            token,
            byteRevision,
            instance,
        } = await browserDocumentStore.readableRevision(path);
        let currentBlob = blob;
        const assertCurrent = () => browserDocumentStore.assertDocumentRevisionCurrent(path, token, {
            strict: true,
            expectedInstance: instance,
            ...(byteRevision === undefined ? {} : {expectedByteRevision: byteRevision}),
        });
        return {
            size: blob.size,
            assertCurrent,
            read: async (begin, end) => {
                await assertCurrent();
                let bytes: Uint8Array;
                try {
                    bytes = new Uint8Array(await currentBlob.slice(begin, end).arrayBuffer());
                } catch (error) {
                    if (!isStaleFileBlobError(error)) {throw error;}
                    await assertCurrent();
                    const refreshed = await browserDocumentStore.readableRevision(path, {token});
                    if (
                        refreshed.instance !== instance
                        || (byteRevision !== undefined && refreshed.byteRevision !== byteRevision)
                        || refreshed.blob.size !== blob.size
                    ) {
                        await assertCurrent();
                        throw error;
                    }
                    currentBlob = refreshed.blob;
                    bytes = new Uint8Array(await currentBlob.slice(begin, end).arrayBuffer());
                }
                await assertCurrent();
                return bytes;
            },
        };
    }
    const {
        size,
        contentSignature,
    } = await browserDocumentStore.getContentSnapshot(path);
    const assertCurrent = () => assertBrowserDocumentUnchanged(path, size, contentSignature);
    return {
        size,
        assertCurrent,
        read: async (begin, end) => {
            await assertCurrent();
            const bytes = await readCompleteBrowserDocumentRange(path, begin, end);
            await assertCurrent();
            return bytes;
        },
    };
}

/** One revision's Blob: its bytes cannot change, so nothing is checked between reads. */
function blobRanges(blob: Blob): IBrowserPdfjsRangeSource {
    return {
        size: blob.size,
        read: async (begin, end) => new Uint8Array(await blob.slice(begin, end).arrayBuffer()),
    };
}

/**
 * PDF.js reads a stored document, by path or as the Blob of one of its revisions, in ranges: no larger
 * document enters memory whole.
 */
async function createPdfjsDocumentInitFromBrowserDocument(
    pdfjsLib: TPdfjsLib,
    stored: string | Blob,
    options: ICreateBrowserPdfjsDocumentInitOptions = {},
) {
    const source = typeof stored === 'string' ? await storedDocumentRanges(stored) : blobRanges(stored);
    const {size} = source;
    const initialLength = Math.min(size, PDFJS_RANGE_CHUNK_SIZE);

    if (size <= PDFJS_RANGE_CHUNK_SIZE) {
        const initialData = await source.read(0, initialLength);
        if (initialData.byteLength !== initialLength) {
            throw new Error(`Browser PDF source returned ${initialData.byteLength} bytes for initial ${initialLength} byte range`);
        }
        return createPdfjsDocumentInit(pdfjsLib, initialData);
    }

    const tailStart = Math.max(initialLength, size - PDFJS_RANGE_CHUNK_SIZE);
    const tailLength = size - tailStart;
    const [
        initialData,
        initialTailData,
    ] = await Promise.all([
        source.read(0, initialLength),
        source.read(tailStart, size),
    ]);
    if (initialData.byteLength !== initialLength) {
        throw new Error(`Browser PDF source returned ${initialData.byteLength} bytes for initial ${initialLength} byte range`);
    }
    if (initialTailData.byteLength !== tailLength) {
        throw new Error(`Browser PDF source returned ${initialTailData.byteLength} bytes for tail ${tailStart}..${size}`);
    }

    class BrowserDocumentRangeTransport extends pdfjsLib.PDFDataRangeTransport {
        private aborted = false;
        private preloadedTail: Uint8Array | null = initialTailData;
        private rangeReadTail: Promise<void> = Promise.resolve();

        public constructor() {
            super(size, initialData, false);
        }

        public override requestDataRange = (begin: number, end: number) => {
            if (this.aborted || end <= begin) {
                return;
            }

            this.rangeReadTail = this.rangeReadTail.then(() => this.loadRange(begin, end));
        };

        public override abort = () => {
            this.aborted = true;
            this.preloadedTail = null;
        };

        /**
         * Serves a range of any length as chunk-sized reads. Every delivery
         * keeps the request's begin offset and only the last one ends it, so
         * no range needs a buffer of its whole length.
         */
        private async loadRange(begin: number, end: number) {
            if (this.aborted) {
                return;
            }
            try {
                for (let pieceBegin = begin; pieceBegin < end;) {
                    if (this.aborted) {
                        return;
                    }
                    const pieceEnd = Math.min(end, pieceBegin + PDFJS_RANGE_CHUNK_SIZE);
                    let piece: Uint8Array;
                    if (this.preloadedTail !== null && pieceBegin >= tailStart && pieceEnd <= size) {
                        await source.assertCurrent?.();
                        if (this.aborted) {
                            return;
                        }
                        piece = this.preloadedTail.slice(pieceBegin - tailStart, pieceEnd - tailStart);
                    } else {
                        piece = await source.read(pieceBegin, pieceEnd);
                    }
                    if (piece.byteLength !== pieceEnd - pieceBegin) {
                        throw new Error(`Browser PDF source returned ${piece.byteLength} bytes for ${pieceBegin}..${pieceEnd}`);
                    }
                    if (this.aborted) {
                        return;
                    }

                    this.onDataRange(begin, piece, pieceEnd === end);
                    pieceBegin = pieceEnd;
                }
            } catch (error) {
                if (!this.aborted) {
                    this.aborted = true;
                    this.preloadedTail = null;
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
    end: number,
) {
    const length = end - begin;
    if (length === 0) {
        return new Uint8Array(0);
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
