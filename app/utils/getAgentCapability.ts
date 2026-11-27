import type {IAgentCapability} from '@contracts/agentPlatformFeature';
import {getPlatformAPI} from '@app/utils/platform';

export function getAgentCapability(): IAgentCapability {
    return getPlatformAPI().agent;
}
