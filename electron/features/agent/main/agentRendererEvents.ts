import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import {
    AGENT_PLATFORM_FEATURE,
    type IAgentEventMap,
} from '@contracts/agentPlatformFeature';

type TAgentRendererEventChannel = Extract<keyof IAgentEventMap, string>;
const eventChannels = AGENT_PLATFORM_FEATURE.eventChannels;

function sendAgentRendererEvent<TChannel extends TAgentRendererEventChannel>(
    webContents: Pick<WebContents, 'send'>,
    channel: TChannel,
    payload: IAgentEventMap[TChannel],
) {
    webContents.send(channel, payload);
}

export function sendAgentWorkspaceSnapshotRequest(
    targetWindow: BrowserWindow,
    request: IAgentEventMap[typeof eventChannels.onWorkspaceSnapshotRequest],
) {
    sendAgentRendererEvent(targetWindow.webContents, eventChannels.onWorkspaceSnapshotRequest, request);
}

export function sendAgentCommandRequest(
    targetWindow: BrowserWindow,
    request: IAgentEventMap[typeof eventChannels.onCommandRequest],
) {
    sendAgentRendererEvent(targetWindow.webContents, eventChannels.onCommandRequest, request);
}

export function sendAgentCommandCancelRequest(
    targetWindow: BrowserWindow,
    request: IAgentEventMap[typeof eventChannels.onCommandCancelRequest],
) {
    sendAgentRendererEvent(targetWindow.webContents, eventChannels.onCommandCancelRequest, request);
}
