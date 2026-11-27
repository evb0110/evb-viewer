import type {ISearchCapability} from '@contracts/searchPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

export function getSearchCapability(): ISearchCapability {
    return getPlatformAPI().search;
}
