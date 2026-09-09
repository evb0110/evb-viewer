import type {IScanCleanupPreviewService} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';

export function createScanCleanupMainBindingsDisposer(
    previewService: Pick<IScanCleanupPreviewService, 'dispose'>,
): () => Promise<void> {
    let disposal: Promise<void> | null = null;
    return () => {
        disposal ??= previewService.dispose();
        return disposal;
    };
}
