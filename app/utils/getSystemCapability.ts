import type {ISystemCapability} from '@contracts/systemPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

const fallbackSystemCapability: ISystemCapability = {
    getMemoryInfo: () => null,
    onShutdownSaveFlushRequest: () => () => {},
};

export function getSystemCapability(): ISystemCapability {
    const platform = getPlatformAPI() as {system?: ISystemCapability};
    return platform.system ?? fallbackSystemCapability;
}
