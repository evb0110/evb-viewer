import {decodeJson, encodeJson, isRecord, STORE_ID_PATTERN} from './documentDirectory';
import type {IStorePort} from './storePort';

export const WORKSPACES_DIR = 'workspaces';
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
    if (!STORE_ID_PATTERN.test(windowId)) {
        throw new Error(`Invalid window id: ${windowId}`);
    }
    return `${WORKSPACES_DIR}/${windowId}${CHECKPOINT_SUFFIX}`;
}

/** The window whose checkpoint `name` is; `null` for anything else, such as a crashed write's temporary file. */
export function checkpointWindowId(name: string) {
    const windowId = name.slice(0, -CHECKPOINT_SUFFIX.length);
    return name.endsWith(CHECKPOINT_SUFFIX) && STORE_ID_PATTERN.test(windowId) ? windowId : null;
}

function decodeCheckpoint(bytes: Uint8Array): IWorkspaceCheckpoint | null {
    const value = decodeJson(bytes);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.tabs)) {
        return null;
    }
    const tabs: Record<string, ICheckpointTab> = {};
    for (const [tabId, tab] of Object.entries(value.tabs)) {
        if (!isRecord(tab) || typeof tab.directory !== 'string' || !STORE_ID_PATTERN.test(tab.directory)) {
            return null;
        }
        tabs[tabId] = {directory: tab.directory, view: tab.view};
    }
    return {tabs, layout: value.layout};
}

export function writeWorkspaceCheckpoint(port: IStorePort, windowId: string, checkpoint: IWorkspaceCheckpoint) {
    return port.writeAtomic(checkpointPath(windowId), encodeJson({version: 1, ...checkpoint}));
}

/** Recovery data that exists but cannot be read: kept as it is, for the host to report. */
export interface IUnreadableEntry {
    /** The store path that could not be read. */
    path: string;
    /** The document directory, when `path` is its manifest. */
    directory?: string;
    error: unknown;
}

/** Every window's checkpoint by window id; `null` marks one that cannot be read, which `unreadable` receives. */
export async function readWorkspaceCheckpoints(port: IStorePort, unreadable: IUnreadableEntry[] = []) {
    const checkpoints = new Map<string, IWorkspaceCheckpoint | null>();
    for (const name of await port.list(WORKSPACES_DIR)) {
        const windowId = checkpointWindowId(name);
        if (windowId === null) {
            continue;
        }
        const path = `${WORKSPACES_DIR}/${name}`;
        checkpoints.set(
            windowId,
            await port
                .read(path)
                .then(decodeCheckpoint)
                .then((checkpoint) => checkpoint ?? Promise.reject(new Error('Not a workspace checkpoint')))
                .catch((error: unknown) => {
                    unreadable.push({path, error});
                    return null;
                }),
        );
    }
    return checkpoints;
}

export function removeWorkspaceCheckpoint(port: IStorePort, windowId: string) {
    return port.remove(checkpointPath(windowId));
}
