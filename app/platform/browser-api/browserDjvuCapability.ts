import { getErrorMessage } from '@app/utils/error';
import type { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import type { IDjvuOpenResult } from '@contracts/electronApiDjvu';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    createJobId,
    createRequestId,
    type TJobId,
} from '@contracts/shared';
import type { TFeatureBrowserBindings } from '@contracts/platformFeature';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import {
    releaseBrowserDjvuViewingWorker,
    retainBrowserDjvuViewingWorker,
    getDjvuWorkerPageSizes,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import { browserDjvuTextSearchCapability } from '@app/platform/browser-api/browserDjvuTextSearchCapability';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';
import { browserDurableDjvuJobs } from '@app/platform/browser-api/browserDurableDjvuJobs';
import { assertBrowserDjvuRasterDimensions } from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import {
    cancelBrowserDjvuConversion,
    estimateBrowserDjvuSizes,
    getBrowserDjvuInfo,
    onBrowserDjvuConversionProgress,
    runBrowserDjvuConversion,
    withBrowserDjvuWorker,
} from '@app/platform/browser-api/browserDjvuConversionPipeline';

async function openBrowserDjvuForViewing(djvuPath: TDocumentRef): Promise<IDjvuOpenResult> {
    if (!isBrowserDocumentRef(djvuPath)) {
        return withBrowserDjvuWorker(djvuPath, async (worker) => {
            const pageSizes = await getDjvuWorkerPageSizes(worker);
            return pageSizes.length > 0
                ? {
                    success: true,
                    pageCount: pageSizes.length,
                }
                : {
                    success: false,
                    error: 'DjVu document has no pages',
                };
        }, 'open');
    }
    try {
        const worker = await retainBrowserDjvuViewingWorker(djvuPath);
        const pageSizes = await getDjvuWorkerPageSizes(worker);
        const pageCount = pageSizes.length;

        if (pageCount <= 0) {
            releaseBrowserDjvuViewingWorker(djvuPath);
            return {
                success: false,
                error: 'DjVu document has no pages',
            };
        }
        return {
            success: true,
            pageCount,
        };
    } catch (error: unknown) {
        releaseBrowserDjvuViewingWorker(djvuPath);
        return {
            success: false,
            error: error instanceof Error ? getErrorMessage(error) : 'DjVu viewing failed',
        };
    }
}

export const browserDjvuCapability = {
    startOpenForViewing(djvuPath, requestId) {
        const jobId = createJobId('djvu-open');
        return Promise.resolve(browserDurableDjvuJobs.startOpen(
            jobId,
            requestId,
            () => openBrowserDjvuForViewing(djvuPath),
        ));
    },
    awaitOpenJob(jobId) {
        return browserDurableDjvuJobs.awaitOpen(jobId);
    },
    releaseViewingPath(djvuPath) {
        if (isBrowserDocumentRef(djvuPath)) releaseBrowserDjvuViewingWorker(djvuPath);
        return Promise.resolve();
    },
    cancelPagePreview(_requestId) {
        return Promise.resolve({ canceled: false });
    },
    ...browserDjvuTextSearchCapability,
    startConvertToPdf(djvuPath, outputPath, options) {
        const requestId = options.requestId ?? createRequestId('djvu-convert');
        const jobId: TJobId = options.jobId ?? createJobId('djvu-convert');
        return Promise.resolve(browserDurableDjvuJobs.startConvert(
            jobId,
            requestId,
            () => runBrowserDjvuConversion(djvuPath, outputPath, {
                ...options,
                jobId,
                requestId,
            }),
        ));
    },
    awaitConvertJob(jobId) {
        return browserDurableDjvuJobs.awaitConvert(jobId);
    },
    printDjvuPath() {
        return Promise.resolve({
            success: false,
            error: 'DjVu printing is only available in the desktop app',
        });
    },
    cancel(jobId) {
        return Promise.resolve(cancelBrowserDjvuConversion(jobId));
    },
    getJobState(jobId) {
        return Promise.resolve(browserDurableDjvuJobs.getState(jobId));
    },
    subscribeJob(jobId) {
        return Promise.resolve(browserDurableDjvuJobs.getState(jobId));
    },
    getInfo: getBrowserDjvuInfo,
    getPageSourceInfo(djvuPath, pageNumber) {
        return withBrowserDjvuWorker(djvuPath, async (worker) => {
            const pageSizes = await getDjvuWorkerPageSizes(worker);
            const effectivePageNumber = requirePageNumber(
                Math.min(pageNumber, pageSizes.length),
                pageSizes.length,
            );
            const pageSize = pageSizes[effectivePageNumber - 1];
            if (!pageSize) {
                throw new RangeError(`DjVu page ${pageNumber} is outside 1..${pageSizes.length}`);
            }
            return {
                pageCount: pageSizes.length,
                pageNumber: effectivePageNumber,
                pageSize,
            };
        }, 'page-source-info');
    },
    getPageSizes(djvuPath) {
        return withBrowserDjvuWorker(djvuPath, worker => getDjvuWorkerPageSizes(worker), 'page-sizes');
    },
    renderPagePreview(djvuPath, pageNumber, _options) {
        return withBrowserDjvuWorker(djvuPath, async (worker) => {
            const pageSizes = await getDjvuWorkerPageSizes(worker);
            const requestedPageNumber = requirePageNumber(pageNumber, pageSizes.length);
            const pageSize = pageSizes[requestedPageNumber - 1];
            if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
            assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
            const pageObject = await worker.doc.getPage(requestedPageNumber).createPngObjectUrl().run();
            try {
                const response = await fetch(pageObject.url);
                if (!response.ok) {
                    throw new Error(`Failed to read DjVu page preview: ${response.status}`);
                }
                return {
                    bytes: new Uint8Array(await response.arrayBuffer()),
                    width: pageObject.width,
                    height: pageObject.height,
                };
            } finally {
                worker.revokeObjectURL(pageObject.url);
            }
        }, 'preview');
    },
    estimateSizes: estimateBrowserDjvuSizes,
    async cleanupTemp(tempPdfPath) {
        if (!isBrowserDocumentRef(tempPdfPath)) {
            return;
        }

        if (await browserDocumentStore.exists(tempPdfPath)) {
            await browserDocumentStore.remove(tempPdfPath);
        }
    },
    onProgress: onBrowserDjvuConversionProgress,
    onMenuConvertToPdf: noopUnsubscribe,
} satisfies TFeatureBrowserBindings<typeof DJVU_PLATFORM_FEATURE>;
