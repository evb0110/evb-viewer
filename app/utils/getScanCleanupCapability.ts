import type { IScanCleanupCapability } from '@contracts/scan-cleanup/electronApiScanCleanup';
import { getPlatformAPI } from '@app/utils/platform';

export function getScanCleanupCapability(): IScanCleanupCapability | null {
    return getPlatformAPI().scanCleanup ?? null;
}
