import {
    decodeJson,
    encodeJson,
    isRecord,
    STORE_ID_PATTERN,
} from './documentDirectory';
import type { IStorePort } from './storePort';

const WORKSPACES_DIR = 'workspaces';
const CHECKPOINT_SUFFIX = '.json';

export interface ICheckpointTab<TView = unknown> {
    directory: string;
    view: TView;
}

/**
 * One window's tabs and panes. Each tab names its document directory and its own view state; registrations,
 * grants and dirty state come from the directories' manifests. Tabs naming one directory are linked views.
 * The core checks this envelope; the application validates `view` and `layout`.
 */
export interface IWorkspaceCheckpoint<TView = unknown, TLayout = unknown> {
    tabs: Record<string, ICheckpointTab<TView>>;
    layout: TLayout;
}

function checkpointPath(windowId: string) {
    if (!STORE_ID_PATTERN.test(windowId)) throw new Error(`Invalid window id: ${windowId}`);
    return `${WORKSPACES_DIR}/${windowId}${CHECKPOINT_SUFFIX}`;
}

function decodeCheckpoint(bytes: Uint8Array): IWorkspaceCheckpoint | null {
    const value = decodeJson(bytes);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.tabs)) return null;
    const tabs: Record<string, ICheckpointTab> = {};
    for (const [tabId, tab] of Object.entries(value.tabs)) {
        if (!isRecord(tab) || typeof tab.directory !== 'string' || !STORE_ID_PATTERN.test(tab.directory)) return null;
        tabs[tabId] = { directory: tab.directory, view: tab.view };
    }
    return { tabs, layout: value.layout };
}

export function writeWorkspaceCheckpoint(port: IStorePort, windowId: string, checkpoint: IWorkspaceCheckpoint) {
    return port.writeAtomic(checkpointPath(windowId), encodeJson({ version: 1, ...checkpoint }));
}

/** Every window's checkpoint by window id; `null` marks one that cannot be read. */
export async function readWorkspaceCheckpoints(port: IStorePort) {
    const checkpoints = new Map<string, IWorkspaceCheckpoint | null>();
    for (const name of await port.list(WORKSPACES_DIR)) {
        const windowId = name.slice(0, -CHECKPOINT_SUFFIX.length);
        if (!name.endsWith(CHECKPOINT_SUFFIX) || !STORE_ID_PATTERN.test(windowId)) continue;
        checkpoints.set(windowId, await port.read(`${WORKSPACES_DIR}/${name}`).then(decodeCheckpoint).catch(() => null));
    }
    return checkpoints;
}

export function removeWorkspaceCheckpoint(port: IStorePort, windowId: string) {
    return port.remove(checkpointPath(windowId));
}
