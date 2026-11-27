import {isRecord} from '@contracts/runtimeGuards';
import {parseTabId} from '@contracts/windowTabs';

/**
 * JSON-RPC params arrive untrusted, so every MCP entry point has to narrow them
 * the same way. Sharing the narrowing keeps the capability descriptors and the
 * server core agreeing on which requests carry a usable window or tab.
 */
export function getParamsObject(params: unknown) {
    return isRecord(params) ? params : {};
}

export function getOptionalWindowId(params: unknown) {
    const paramsObject = getParamsObject(params);
    return typeof paramsObject.windowId === 'number' && Number.isFinite(paramsObject.windowId) ? paramsObject.windowId : undefined;
}

export function getOptionalTabId(params: unknown) {
    const paramsObject = getParamsObject(params);
    if (typeof paramsObject.tabId !== 'string' || paramsObject.tabId.trim().length === 0) {
        return undefined;
    }
    return parseTabId(paramsObject.tabId.trim()) ?? undefined;
}
