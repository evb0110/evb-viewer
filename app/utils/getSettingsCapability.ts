import type {ISettingsCapability} from '@contracts/settingsPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

export function getSettingsCapability(): ISettingsCapability {
    return getPlatformAPI().settings;
}
