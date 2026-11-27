import type {IHostCapability} from '@contracts/hostPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

export function getHostCapability(): IHostCapability {
    return getPlatformAPI().host;
}
