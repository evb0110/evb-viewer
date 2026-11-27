import type {IShellCapability} from '@contracts/shellPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

export function getShellCapability(): IShellCapability {
    return getPlatformAPI().shell;
}
