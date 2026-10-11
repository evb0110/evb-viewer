import {
    app,
    BrowserWindow,
} from 'electron';
import {join} from 'node:path';
import type {IpcMainInvokeEvent} from 'electron';
import {
    SCAN_CLEANUP_PLATFORM_FEATURE,
    type IScanCleanupEventMap,
} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import type {TFeatureMainBindings} from '@contracts/platformFeature';
import {
    SCAN_CLEANUP_SETTINGS_FILE_NAME,
    type IScanCleanupSettingsChange,
} from '@contracts/scan-cleanup/scanCleanupSettings';
import {
    defaultDependencies,
    scanCleanupPreviewLifecycle,
} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {createScanCleanupService} from '@electron/features/scan-cleanup/createScanCleanupService';
import {createScanCleanupSettingsStore} from '@electron/features/scan-cleanup/createScanCleanupSettingsStore';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {sendPlatformEvent} from '@electron/utils/sendPlatformEvent';
import {sweepStaleScanCleanupScratchDirs} from '@evb/scan-cleanup/core/scratchCleanup';

const previewService = scanCleanupPreviewLifecycle(defaultDependencies);
const service = createScanCleanupService();
const settingsStore = createScanCleanupSettingsStore({
    filePath: join(app.getPath('userData'), SCAN_CLEANUP_SETTINGS_FILE_NAME),
    onSettingsChanged: broadcastGlobalPreferences,
});
const logger = createLogger('scan-cleanup-scratch');
const settingsLogger = createLogger('scan-cleanup-settings');

// A committed global write reaches every trusted window, the writer's included.
// Each renderer store rebases the fields it has no pending local edit for.
function broadcastGlobalPreferences(change: IScanCleanupSettingsChange) {
    for (const window of BrowserWindow.getAllWindows()) {
        sendPlatformEvent<IScanCleanupEventMap, 'scan-cleanup:settings:changed'>(
            window,
            SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onSettingsChanged,
            change,
            error => settingsLogger.debug(`Failed to send scan-cleanup settings change: ${String(error)}`),
        );
    }
}

void Promise.resolve()
    .then(() => sweepStaleScanCleanupScratchDirs(getAppTempDir(), {log: (level, message) => logger[level](message)}))
    .catch(error => logger.warn(`Could not sweep scan-cleanup scratch directories at startup: ${String(error)}`));

let disposePreviewServicePromise: Promise<void> | null = null;

export function disposeScanCleanupMainBindings(): Promise<void> {
    disposePreviewServicePromise ??= previewService.dispose();
    return disposePreviewServicePromise;
}

const featureBindings = {
    preview: (context, request) => previewService.preview(context.sender, request),
    resolvePlacementAnchorCalibration: (context, request) =>
        previewService.resolvePlacementAnchorCalibration(context.sender, request),
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
    // Settings are process-scoped, and feature registration already rejects
    // untrusted senders before these bindings are reached. Keep one owner for
    // the store instead of adding a renderer-id namespace with no isolation
    // boundary behind it.
    getSettings: (_context, request) => settingsStore.get(request),
    updateSettings: (_context, request) => settingsStore.update(request),
    getPendingCompletedOutputs: async context => [...await service.getPendingCompletedOutputs(context.sender)],
    acknowledgeCompletedOutputs: outputPaths => service.acknowledgeCompletedOutputs(outputPaths),
} satisfies TFeatureMainBindings<typeof SCAN_CLEANUP_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export const scanCleanupMainBindings = Object.assign(featureBindings, {disposeScanCleanupMainBindings});
