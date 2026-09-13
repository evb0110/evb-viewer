import type { TTabTemperature } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { TViewerResidencyState } from '@app/utils/viewerResidencyPolicy';

export interface ITabTemperatureReclaimCandidateOptions { isSaveProtected?: boolean | undefined; }

export function resolveTabTemperatureResidency(temperature: TTabTemperature): TViewerResidencyState {
    if (temperature === 'hot') {
        return 'active';
    }

    return temperature === 'warm' ? 'warm' : 'hibernated';
}

export function isTabTemperatureReclaimCandidate(
    temperature: TTabTemperature,
    options: ITabTemperatureReclaimCandidateOptions = {},
) {
    return temperature === 'warm' && options.isSaveProtected !== true;
}
