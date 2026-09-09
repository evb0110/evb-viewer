import type {
    IScanCleanupDetectionRequest,
    IScanCleanupOwnerContext,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    TScanCleanupDetectionJobState,
    TScanCleanupDetectionStartResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import type {
    IScanCleanupDetectionSubscriber,
    IScanCleanupDetectionOwnerDependencies,
    IScanCleanupPreviewDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    scanCleanupDetectionOwner,
    type IScanCleanupDetectionOwner,
} from '@electron/features/scan-cleanup/scanCleanupDetectionLifecycle';
import {
    scanCleanupPreviewRenderingOwner,
    type IScanCleanupPreviewRenderingOwner,
} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderingOwner';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';

export interface IScanCleanupPreviewService
    extends IScanCleanupPreviewRenderingOwner, IScanCleanupDetectionOwner {
    preview: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewRequest,
    ) => Promise<TScanCleanupPreviewWireResult>;
    cancel: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewCancelRequest,
    ) => boolean;
    detectAll: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupDetectionRequest,
    ) => Promise<TScanCleanupDetectionStartResult>;
    cancelDetection: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => boolean;
    getDetectionJobState: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => TScanCleanupDetectionJobState | null;
    subscribeDetectionJob: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => TScanCleanupDetectionJobState | null;
}

export function scanCleanupPreviewLifecycle(
    dependencies: IScanCleanupPreviewDependencies,
): IScanCleanupPreviewService {
    const detectionDependencies: IScanCleanupDetectionOwnerDependencies = dependencies;
    const rawRasterRetention = scanCleanupRasterRetention(dependencies);
    const detection = scanCleanupDetectionOwner(detectionDependencies, rawRasterRetention);
    const rendering = scanCleanupPreviewRenderingOwner(dependencies, rawRasterRetention);

    return {
        ...rendering,
        ...detection,
        async dispose() {
            await rendering.dispose();
            await detection.dispose();
            await rawRasterRetention.dispose();
        },
    };
}
