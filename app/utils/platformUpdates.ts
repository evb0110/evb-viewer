import type {
    IAppUpdateStatus,
    IUpdatesCapability,
} from '@contracts/updatesPlatformFeature';
import { getPlatformAPI } from '@app/utils/platform';

export function getUpdatesCapability(): IUpdatesCapability | undefined {
    return getPlatformAPI().updates;
}

/** A platform without an updater, such as the hosted web app, has nothing to check. */
export function isUpdatesCapabilitySupported(status: IAppUpdateStatus) {
    return getUpdatesCapability() !== undefined && status.phase !== 'unsupported';
}
