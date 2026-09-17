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
import {
    RENDERER_DESTROYED_CANCELLATION_REASON,
    RENDER_PROCESS_GONE_CANCELLATION_REASON,
} from '@electron/operation-lifecycle/createMainJobRegistry';

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
    interface IWatchedSender {
        sender: IScanCleanupDetectionSubscriber;
        handleGone: () => void;
    }
    const watchedSenders = new Map<number, IWatchedSender>();
    const pendingPreviews = new Map<number, Set<Promise<unknown>>>();
    let disposed = false;
    const isRendererGoneError = (error: unknown) => error instanceof Error
        && (error.message === RENDERER_DESTROYED_CANCELLATION_REASON
            || error.message === RENDER_PROCESS_GONE_CANCELLATION_REASON);
    const watchSender = (sender: IScanCleanupDetectionSubscriber) => {
        if (disposed) return;
        const previous = watchedSenders.get(sender.id);
        if (previous?.sender === sender) return;
        previous?.sender.removeListener('destroyed', previous.handleGone);
        previous?.sender.removeListener('render-process-gone', previous.handleGone);
        const handleGone = () => {
            if (watchedSenders.get(sender.id)?.handleGone !== handleGone) return;
            watchedSenders.delete(sender.id);
            sender.removeListener('destroyed', handleGone);
            sender.removeListener('render-process-gone', handleGone);
            rendering.invalidateSender?.(sender.id);
            rawRasterRetention.invalidateSender(sender.id);
        };
        watchedSenders.set(sender.id, {
            sender,
            handleGone,
        });
        sender.once('destroyed', handleGone);
        sender.once('render-process-gone', handleGone);
        if (sender.isDestroyed()) handleGone();
    };
    const watchSenderAfterPreviewsSettle = (
        sender: IScanCleanupDetectionSubscriber,
        preview: Promise<unknown>,
    ) => {
        const previews = pendingPreviews.get(sender.id) ?? new Set<Promise<unknown>>();
        previews.add(preview);
        pendingPreviews.set(sender.id, previews);
        const settle = (watch: boolean) => {
            const current = pendingPreviews.get(sender.id);
            if (current === undefined) return;
            current.delete(preview);
            if (current.size > 0) return;
            pendingPreviews.delete(sender.id);
            if (watch) watchSender(sender);
        };
        void preview.then(
            () => settle(true),
            error => settle(!isRendererGoneError(error)),
        ).catch(() => undefined);
    };

    return {
        ...rendering,
        ...detection,
        preview(sender, request) {
            const preview = rendering.preview(sender, request);
            watchSenderAfterPreviewsSettle(sender, preview);
            return preview;
        },
        detectAll(sender, request) {
            watchSender(sender);
            return detection.detectAll(sender, request);
        },
        async dispose() {
            disposed = true;
            pendingPreviews.clear();
            for (const {
                sender,
                handleGone,
            } of watchedSenders.values()) {
                sender.removeListener('destroyed', handleGone);
                sender.removeListener('render-process-gone', handleGone);
            }
            watchedSenders.clear();
            await rendering.dispose();
            await detection.dispose();
            await rawRasterRetention.dispose();
        },
    };
}
