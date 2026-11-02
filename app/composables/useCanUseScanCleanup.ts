import { getScanCleanupCapability } from '@app/utils/getScanCleanupCapability';
import { resolveScanCleanupSupport } from '@contracts/scan-cleanup/scanCleanupPlatformFeature';

/**
 * Whether the workspace offers Scan Cleanup: wherever the platform can preview
 * it. Read after mount, since the server render cannot test the browser.
 */
export const useCanUseScanCleanup = () => {
    const canPreview = ref(false);
    onMounted(() => {
        canPreview.value = resolveScanCleanupSupport(getScanCleanupCapability()).preview;
    });
    return computed(() => canPreview.value);
};
