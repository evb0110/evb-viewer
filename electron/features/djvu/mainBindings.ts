import type { IpcMainInvokeEvent } from 'electron';
import type { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { createLogger } from '@electron/utils/createLogger';
import { pruneStaleDjvuArtifactJobs } from '@electron/features/djvu/main/djvuArtifactManifest';
import {
    getDjvuOutputJobState,
    subscribeDjvuOutputJob,
    subscribeDjvuProgress,
} from '@electron/features/djvu/main/pdfExport';
import {
    handleDjvuAwaitOpenJobOperation,
    handleDjvuCancelOperation,
    handleDjvuCancelPagePreview,
    handleDjvuCancelTextSearch,
    handleDjvuCleanupTemp,
    handleDjvuEstimateSizes,
    handleDjvuGetInfo,
    handleDjvuGetOutline,
    handleDjvuGetPageSizes,
    handleDjvuGetPageSourceInfo,
    handleDjvuGetPageText,
    handleDjvuPrintPathOperation,
    handleDjvuReleaseViewingPath,
    handleDjvuRenderPagePreview,
    handleDjvuSearchText,
    handleDjvuStartConvertToPdfOperation,
    handleDjvuStartOpenForViewingOperation,
} from '@electron/features/djvu/main/djvuOperations';

const logger = createLogger('djvu-main-bindings');

// fallow-ignore-next-line unused-export
export const djvuMainBindings = {
    startOpenForViewing: handleDjvuStartOpenForViewingOperation,
    awaitOpenJob: handleDjvuAwaitOpenJobOperation,
    releaseViewingPath: handleDjvuReleaseViewingPath,
    startConvertToPdf: handleDjvuStartConvertToPdfOperation,
    printDjvuPath: handleDjvuPrintPathOperation,
    cancel: handleDjvuCancelOperation,
    getJobState: getDjvuOutputJobState,
    subscribeJob: subscribeDjvuOutputJob,
    cancelPagePreview: handleDjvuCancelPagePreview,
    searchText: handleDjvuSearchText,
    cancelTextSearch: handleDjvuCancelTextSearch,
    getInfo: handleDjvuGetInfo,
    getPageSourceInfo: handleDjvuGetPageSourceInfo,
    getPageSizes: handleDjvuGetPageSizes,
    getPageText: handleDjvuGetPageText,
    getOutline: handleDjvuGetOutline,
    renderPagePreview: handleDjvuRenderPagePreview,
    estimateSizes: handleDjvuEstimateSizes,
    cleanupTemp: handleDjvuCleanupTemp,
    subscribeProgress: subscribeDjvuProgress,
} satisfies TFeatureMainBindings<typeof DJVU_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export function prepareDjvuMainBindings() {
    if (process.env.EVB_DJVU_SWEEP_STALE_TEMP !== '0') {
        void pruneStaleDjvuArtifactJobs().catch((error: unknown) => {
            logger.warn(`DjVu artifact job cleanup failed: ${String(error)}`);
        });
    }
    return djvuMainBindings;
}
