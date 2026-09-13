import type {IScanCleanupPreviewService} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';

export type IScanCleanupPreviewIpcOwners = Pick<
    IScanCleanupPreviewService,
    | 'preview'
    | 'resolvePlacementAnchorCalibration'
    | 'cancel'
    | 'detectAll'
    | 'cancelDetection'
    | 'getDetectionJobState'
    | 'subscribeDetectionJob'
    | 'dispose'
>;

export type IScanCleanupPreviewIpcAdapter = IScanCleanupPreviewIpcOwners;

/** Bind the already-composed owners to the validated platform registration. */
export function createScanCleanupPreviewIpcAdapter(
    owners: IScanCleanupPreviewIpcOwners,
): IScanCleanupPreviewIpcAdapter {
    return {
        preview: owners.preview,
        resolvePlacementAnchorCalibration: owners.resolvePlacementAnchorCalibration,
        cancel: owners.cancel,
        detectAll: owners.detectAll,
        cancelDetection: owners.cancelDetection,
        getDetectionJobState: owners.getDetectionJobState,
        subscribeDetectionJob: owners.subscribeDetectionJob,
        dispose: owners.dispose,
    };
}
