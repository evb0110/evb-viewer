import type {IDjvuCapability} from '@contracts/djvuPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

export function getDjvuCapability(): IDjvuCapability {
    return getPlatformAPI().djvu;
}
