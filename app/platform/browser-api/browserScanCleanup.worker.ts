/// <reference lib="webworker" />

import {encode as encodePng} from 'fast-png';
import {
    getBrowserScanCleanupWorkerRequestId,
    parseBrowserScanCleanupWorkerRequest,
    type IBrowserScanCleanupWorkerResultMap,
    type TBrowserScanCleanupWorkerRequest,
} from '@contracts/scan-cleanup/browserScanCleanupWorker';
import {assembleBrowserPdfRasterPpm} from '@app/platform/browser-api/assembleBrowserPdfRasterPpm';
import {
    analyzeBrowserScanCleanupPage,
    deriveBrowserScanCleanupInkContexts,
    finishBrowserScanCleanupPageAnalysis,
    reconcileBrowserScanCleanupDocument,
    renderBrowserScanCleanupPage,
    renderBrowserScanCleanupPreview,
    sampleBrowserScanCleanupPageInk,
} from '@app/platform/browser-api/browserScanCleanupWasm';
import {toTransferableUint8Array} from '@app/platform/browser-api/toTransferableUint8Array';
import {getErrorMessage} from '@app/utils/error';

declare const self: DedicatedWorkerGlobalScope;

/** A binary PPM's size and pixels, as `createPpmRaster` and Poppler write it. */
function readPpm(ppm: Uint8Array) {
    const match = /^P6\s+(\d+)\s+(\d+)\s+255\s/u.exec(new TextDecoder().decode(ppm.subarray(0, 64)));
    if (!match) throw new Error('Scan cleanup page raster is not a binary PPM');
    const width = Number(match[1]);
    const height = Number(match[2]);
    const offset = match[0].length;
    if (ppm.byteLength - offset !== width * height * 3) {
        throw new Error('Scan cleanup page raster has a truncated PPM payload');
    }
    return {
        width,
        height,
        data: ppm.subarray(offset),
    };
}

async function handle(request: TBrowserScanCleanupWorkerRequest): Promise<IBrowserScanCleanupWorkerResultMap[TBrowserScanCleanupWorkerRequest['type']]> {
    switch (request.type) {
        case 'assemble-raster':
            return {ppm: toTransferableUint8Array(assembleBrowserPdfRasterPpm(request.payload.image))};
        case 'encode-png': {
            const {
                width, height, data,
            } = readPpm(request.payload.ppm);
            // The fastest level, as desktop encodes its original page: the
            // copy is for display, and its pixels are the PPM's.
            return {png: toTransferableUint8Array(encodePng({
                width,
                height,
                data,
                channels: 3,
                depth: 8,
            }, {zlib: {level: 1}}))};
        }
        case 'render-preview':
            return renderBrowserScanCleanupPreview(request.payload);
        case 'render-page':
            return renderBrowserScanCleanupPage(request.payload);
        case 'analyze-page':
            return analyzeBrowserScanCleanupPage(request.payload);
        case 'reconcile-document':
            return reconcileBrowserScanCleanupDocument(request.payload);
        case 'finish-page-analysis':
            return finishBrowserScanCleanupPageAnalysis(request.payload);
        case 'sample-page-ink':
            return sampleBrowserScanCleanupPageInk(request.payload);
        case 'derive-ink-contexts':
            return deriveBrowserScanCleanupInkContexts(request.payload);
    }
}

/** Every buffer a result owns, so the reply moves them instead of copying. */
function transferablesOf(value: unknown, found = new Set<ArrayBuffer>()): Set<ArrayBuffer> {
    if (value instanceof Uint8Array) {
        if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
    } else if (Array.isArray(value)) {
        for (const entry of value) transferablesOf(entry, found);
    } else if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value)) transferablesOf(entry, found);
    }
    return found;
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
    const request = parseBrowserScanCleanupWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserScanCleanupWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser scan cleanup worker request',
            });
        }
        return;
    }
    void handle(request).then(data => {
        self.postMessage({
            id: request.id,
            type: request.type,
            ok: true,
            data,
        }, [...transferablesOf(data)]);
    }, (error: unknown) => {
        self.postMessage({
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        });
    });
});
