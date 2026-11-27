import type {IWindowTabsCapability} from '@contracts/windowTabsPlatformFeature';
import {getPlatformAPI, hasElectronAPI} from '@app/utils/platform';

export function getWindowTabsCapability(): IWindowTabsCapability {
    return getPlatformAPI().windowTabs;
}

export function canUseNativeWindowTabTransfers() {
    return hasElectronAPI();
}
