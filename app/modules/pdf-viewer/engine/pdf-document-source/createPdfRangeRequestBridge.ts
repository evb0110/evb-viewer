import {getErrorMessage} from '@app/utils/error';
import type {PDFDataRangeTransport} from 'pdfjs-dist';
import type {TPdfSource} from '@app/types/pdfUi';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {logPdfRenderTrace} from '@app/utils/pdfRenderTrace';

const PDF_RANGE_SUBREAD_BYTES = 8 * 1024 * 1024;
const PDF_RANGE_DELIVERY_BYTES = 1024 * 1024;

interface IPdfChunkedRangeTransport extends PDFDataRangeTransport {
    onDataRange(begin: number, chunk: Uint8Array, isLast?: boolean): void;
}

export interface IPdfPreloadedRange {
    begin: number;
    data: Uint8Array;
}

interface IPdfRangeReadFailureHandler {
    rangeReadFailure: Promise<never>;
    failRangeRead: (error: unknown) => void;
    hasFailed: () => boolean;
    complete: () => void;
}

interface IPdfRangeRequestBridgeOptions {
    getRenderVersion: () => number;
    onRangeReadFailure: (error: unknown, version: number) => void;
}

export function createPdfRangeRequestBridge({getRenderVersion, onRangeReadFailure}: IPdfRangeRequestBridgeOptions) {
    function createRangeReadFailureHandler(): IPdfRangeReadFailureHandler {
        let rejectRangeReadFailure: ((error: Error) => void) | null = null;
        let failed = false;
        const rangeReadFailure = new Promise<never>((_resolve, reject) => {
            rejectRangeReadFailure = reject;
        });

        const failRangeRead = (error: unknown) => {
            failed = true;
            if (!rejectRangeReadFailure) {
                return;
            }

            const reject = rejectRangeReadFailure;
            rejectRangeReadFailure = null;
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        return {
            rangeReadFailure,
            failRangeRead,
            hasFailed: () => failed,
            complete: () => {
                rejectRangeReadFailure = null;
            },
        };
    }

    /**
     * Fulfill a PDF.js range request with bounded reads and deliveries.
     *
     * PDF.js keys a range reader by its original begin offset. The patched
     * transport keeps that key for every delivery and marks only the last
     * delivery, so one large worker request can be streamed without creating a
     * buffer for the whole interval.
     */
    async function fulfillPdfRangeRequest(
        transport: IPdfChunkedRangeTransport,
        src: Extract<TPdfSource, {kind: 'path'}>,
        begin: number,
        end: number,
        version: number,
        isAbandoned: () => boolean,
        preloadedRanges: readonly IPdfPreloadedRange[],
    ) {
        const totalLength = end - begin;
        if (!Number.isSafeInteger(totalLength) || totalLength <= 0) {
            throw new Error(`Invalid PDF range request ${begin}..${end}`);
        }
        if (isAbandoned()) {
            return;
        }

        const preloadedRange = preloadedRanges.find((range) => {
            const relativeBegin = begin - range.begin;
            const relativeEnd = end - range.begin;
            return relativeBegin >= 0 && relativeEnd <= range.data.byteLength;
        });
        if (preloadedRange) {
            const relativeBegin = begin - preloadedRange.begin;
            const relativeEnd = end - preloadedRange.begin;
            const output = preloadedRange.data.slice(relativeBegin, relativeEnd);
            transport.onDataRange(begin, output);
            logPdfRenderTrace('pdf-document-range-fulfilled-from-cache', {
                begin,
                end,
                byteLength: output.byteLength,
                version,
            });
            return;
        }

        const documentFiles = getDocumentFilesCapability();
        let cursor = begin;
        let deliveryBegin = begin;
        let deliveryBuffer: Uint8Array | null = null;
        let deliveryLength = 0;

        const deliver = (chunk: Uint8Array, isLast: boolean) => {
            if (isAbandoned()) {
                return false;
            }
            if (isLast) {
                transport.onDataRange(begin, chunk);
            } else {
                transport.onDataRange(begin, chunk, false);
            }
            logPdfRenderTrace('pdf-document-range-delivery', {
                begin: deliveryBegin,
                end: deliveryBegin + chunk.byteLength,
                requestedBegin: begin,
                requestedEnd: end,
                byteLength: chunk.byteLength,
                isLast,
                version,
            });
            deliveryBegin += chunk.byteLength;
            return true;
        };

        const flushDeliveryBuffer = (isLast: boolean) => {
            if (!deliveryBuffer || deliveryLength === 0) {
                return true;
            }
            const chunk = deliveryBuffer.subarray(0, deliveryLength);
            const delivered = deliver(chunk, isLast);
            deliveryBuffer = null;
            deliveryLength = 0;
            return delivered;
        };

        while (cursor < end) {
            if (isAbandoned()) {
                logPdfRenderTrace('pdf-document-range-request-stale-before-read', {
                    begin,
                    end,
                    cursor,
                    version,
                    renderVersion: getRenderVersion(),
                });
                return;
            }

            const requestedLength = Math.min(PDF_RANGE_SUBREAD_BYTES, end - cursor);
            const chunk = await documentFiles.readFileRange(src.path, cursor, requestedLength);
            if (isAbandoned()) {
                logPdfRenderTrace('pdf-document-range-request-stale-after-read', {
                    begin,
                    end,
                    cursor,
                    version,
                    renderVersion: getRenderVersion(),
                });
                return;
            }
            if (chunk.byteLength === 0) {
                throw new Error(`Range read returned no bytes at ${cursor} before requested end ${end}`);
            }

            if (chunk.byteLength > requestedLength) {
                throw new Error(`Range read returned ${chunk.byteLength} bytes for ${requestedLength} requested bytes`);
            }

            let sourceOffset = 0;
            while (sourceOffset < chunk.byteLength) {
                if (!deliveryBuffer && deliveryLength === 0) {
                    const remaining = chunk.byteLength - sourceOffset;
                    const canDeliverDirectly =
                        remaining >= PDF_RANGE_DELIVERY_BYTES &&
                        (remaining % PDF_RANGE_DELIVERY_BYTES === 0 || cursor + chunk.byteLength === end);
                    if (canDeliverDirectly) {
                        let directOffset = sourceOffset;
                        while (directOffset < chunk.byteLength) {
                            const directLength = Math.min(PDF_RANGE_DELIVERY_BYTES, chunk.byteLength - directOffset);
                            const directEnd = cursor + directOffset + directLength;
                            if (!deliver(chunk.subarray(directOffset, directOffset + directLength), directEnd === end)) {
                                return;
                            }
                            directOffset += directLength;
                        }
                        sourceOffset = chunk.byteLength;
                        continue;
                    }
                    deliveryBuffer = new Uint8Array(PDF_RANGE_DELIVERY_BYTES);
                }

                const copyLength = Math.min(chunk.byteLength - sourceOffset, PDF_RANGE_DELIVERY_BYTES - deliveryLength);
                if (!deliveryBuffer) {
                    throw new Error('PDF range delivery buffer was not allocated');
                }
                deliveryBuffer.set(chunk.subarray(sourceOffset, sourceOffset + copyLength), deliveryLength);
                sourceOffset += copyLength;
                deliveryLength += copyLength;
                if (deliveryLength === PDF_RANGE_DELIVERY_BYTES) {
                    const isLast = cursor + sourceOffset === end;
                    if (!flushDeliveryBuffer(isLast)) {
                        return;
                    }
                }
            }
            logPdfRenderTrace('pdf-document-range-subread', {
                begin: cursor,
                end: cursor + chunk.byteLength,
                requestedEnd: end,
                byteLength: chunk.byteLength,
                requestedLength,
                version,
            });
            cursor += chunk.byteLength;
        }

        if (deliveryLength > 0 && !flushDeliveryBuffer(true)) {
            return;
        }
        logPdfRenderTrace('pdf-document-range-fulfilled', {
            begin,
            end,
            byteLength: totalLength,
            version,
        });
    }

    function attachRangeRequestHandler(
        transport: PDFDataRangeTransport,
        src: Extract<TPdfSource, {kind: 'path'}>,
        version: number,
        rangeFailure: IPdfRangeReadFailureHandler,
        preloadedRanges: readonly IPdfPreloadedRange[],
    ) {
        const isAbandoned = () => version !== getRenderVersion() || rangeFailure.hasFailed();

        // Serialize this transport's range reads so overlapping intervals never
        // interleave onDataRange deliveries. The queue is scoped to this handler
        // so a stale document whose read hangs (transport.abort() is a no-op in
        // the bundled PDF.js and readFileRange has no cancel signal) cannot block
        // the next document's transport, which gets its own fresh chain.
        let rangeReadTail = Promise.resolve();

        // PDF.js will call this to request additional chunks.
        transport.requestDataRange = (begin, end: number) => {
            void (async () => {
                logPdfRenderTrace('pdf-document-range-request', {
                    begin,
                    end,
                    length: end - begin,
                    version,
                });
                const predecessor = rangeReadTail;
                let releaseQueueSlot!: () => void;
                rangeReadTail = new Promise<void>((resolve) => {
                    releaseQueueSlot = resolve;
                });
                try {
                    await predecessor;
                    await fulfillPdfRangeRequest(transport, src, begin, end, version, isAbandoned, preloadedRanges);
                } catch (error) {
                    if (isAbandoned()) {
                        return;
                    }

                    logPdfRenderTrace('pdf-document-range-error', {
                        begin,
                        end,
                        version,
                        error: getErrorMessage(error),
                    });
                    rangeFailure.failRangeRead(error);
                    onRangeReadFailure(error, version);
                } finally {
                    releaseQueueSlot();
                }
            })();
        };
    }

    return {
        createRangeReadFailureHandler,
        attachRangeRequestHandler,
    };
}
