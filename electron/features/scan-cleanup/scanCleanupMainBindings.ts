import {app} from 'electron';
import {join} from 'node:path';
import type {IpcMainInvokeEvent} from 'electron';
import type {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import type {TFeatureMainBindings} from '@contracts/platformFeature';
import {SCAN_CLEANUP_SETTINGS_FILE_NAME} from '@contracts/scanCleanupSettings';
import {defaultDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {createScanCleanupMainBindingsDisposer} from '@electron/features/scan-cleanup/createScanCleanupMainBindingsDisposer';
import {createScanCleanupService} from '@electron/features/scan-cleanup/createScanCleanupService';
import {createScanCleanupSettingsStore} from '@electron/features/scan-cleanup/createScanCleanupSettingsStore';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {sweepStaleScanCleanupScratchDirs} from '@evb/scan-cleanup/core/scratchCleanup';

const previewService = scanCleanupPreviewLifecycle(defaultDependencies);
const service = createScanCleanupService();
const settingsStore = createScanCleanupSettingsStore({filePath: join(app.getPath('userData'), SCAN_CLEANUP_SETTINGS_FILE_NAME)});
const logger = createLogger('scan-cleanup-scratch');

void Promise.resolve()
    .then(() => sweepStaleScanCleanupScratchDirs(getAppTempDir(), {log: (level, message) => logger[level](message)}))
    .catch(error => logger.warn(`Could not sweep scan-cleanup scratch directories at startup: ${String(error)}`));

const disposePreviewService = createScanCleanupMainBindingsDisposer(previewService);

export function disposeScanCleanupMainBindings(): Promise<void> {
    return disposePreviewService();
}

const featureBindings = {
    preview: (context, request) => previewService.preview(context.sender, request),
    cancelPreview: (context, request) => previewService.cancel(context.sender, request),
    detectAll: (context, request) => previewService.detectAll(context.sender, request),
    cancelDetection: (context, jobId, owner) =>
        previewService.cancelDetection(context.sender, jobId, owner),
    getDetectionJobState: (context, jobId, owner) =>
        previewService.getDetectionJobState(context.sender, jobId, owner),
    subscribeDetectionJob: (context, jobId, owner) =>
        previewService.subscribeDetectionJob(context.sender, jobId, owner),
    start: (context, request) => service.start(context.sender, request),
    cancel: (context, jobId, owner) => service.cancel(context.sender, jobId, owner),
    getJobState: (context, jobId, owner) => service.getState(context.sender, jobId, owner),
    subscribeJob: (context, jobId, owner) => service.subscribe(context.sender, jobId, owner),
    reconnectJob: (context, jobId, owner) => service.subscribe(context.sender, jobId, owner),
    pruneGeneratedOutputs: () => service.pruneGeneratedOutputs(),
    getSettings: (_context, request) => settingsStore.get(request),
    updateSettings: (_context, request) => settingsStore.update(request),
} satisfies TFeatureMainBindings<typeof SCAN_CLEANUP_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export const scanCleanupMainBindings = Object.assign(featureBindings, {disposeScanCleanupMainBindings});
