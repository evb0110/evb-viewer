import { collectDocuments } from '@document-store/collectDocuments';
import {
    decodeManifest,
    DOCUMENTS_DIR,
    MANIFEST_NAME,
} from '@document-store/documentDirectory';
import {
    readWorkspaceCheckpoints,
    removeWorkspaceCheckpoint,
    writeWorkspaceCheckpoint,
} from '@document-store/workspaceCheckpoint';
import {
    browserDocumentLockName,
    browserDocumentStore,
} from '@app/platform/browser/browserDocumentRepository';
import {
    browserDocumentRefId,
    createBrowserDocumentRef,
} from '@app/platform/browser/browserDocumentRefs';
import { fileHandleStore } from '@app/platform/browser/browserFileHandleStore';
import { handleKeyOf } from '@app/platform/browser/browserPublication';
import { tryReadRecentFilesFromStorage } from '@app/platform/browser/browserRecentFilesStore';
import {
    heldBrowserLockNames,
    holdBrowserLock,
} from '@app/platform/browser/runBrowserLock';
import { createPaneId } from '@contracts/editorPanes';
import { createEpochMs } from '@contracts/timestamps';
import { createTabId } from '@contracts/windowTabs';
import {
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointTab,
} from '@contracts/workspaceCheckpoint';

const WINDOW_LOCK_PREFIX = 'evb-window:';

/** The lock a live window holds; a checkpoint whose window lock is free belongs to a window that is gone. */
export const browserWindowLockName = (windowId: string) => `${WINDOW_LOCK_PREFIX}${windowId}`;

let collection: Promise<string[]> | null = null;
let claimed: {windowId: string; release: () => void} | null = null;

function recentFileIds() {
    return new Set((tryReadRecentFilesFromStorage() ?? []).flatMap((file) => {
        try {
            return [browserDocumentRefId(file.originalPath)];
        } catch {
            return [];
        }
    }));
}

/**
 * Once per window, before it restores anything: removes the clean directories no window holds and no
 * checkpoint or Recent entry names, and the stored file handles nothing names any more. Returns the
 * unsaved directories no window holds, for the recovery offer. Without Web Locks nothing is known about
 * the other windows, so nothing is removed.
 */
function collectOnce() {
    collection ??= (async () => {
        const {durable} = await browserDocumentStore.stores();
        if (!durable || !await heldBrowserLockNames()) return [];
        const recent = recentFileIds();
        const {unsaved} = await collectDocuments(durable, async id => recent.has(id) || (await heldBrowserLockNames())?.has(browserDocumentLockName(id)) !== false);
        const named = new Set(recent);
        for (const id of await durable.port.list(DOCUMENTS_DIR)) {
            const manifest = await durable.port.read(`${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`).then(decodeManifest).catch(() => null);
            for (const destination of [manifest?.destination, manifest?.pendingPublish?.destination]) {
                const key = handleKeyOf(destination ?? null);
                if (key !== null) named.add(key);
            }
        }
        for (const key of await fileHandleStore.keys().catch(() => [])) {
            if (!named.has(key)) await fileHandleStore.delete(key).catch(() => undefined);
        }
        return unsaved;
    })().catch(() => []);
    return collection;
}

/**
 * The tab an unsaved directory comes back in when no checkpoint names it. The person's unsaved work is in a
 * checkpoint or in drafts; a directory with neither was changed only by an app step a crash or reload cut
 * short, such as decrypting a PDF while it opened, and is removed.
 */
async function orphanTab(id: string, paneId: IWorkspaceCheckpointTab['paneId']): Promise<IWorkspaceCheckpointTab | null> {
    const {durable} = await browserDocumentStore.stores();
    const manifest = durable && await durable.port.read(`${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`).then(decodeManifest).catch(() => null);
    if (durable && manifest && manifest.drafts === undefined && !manifest.pendingPublish) {
        await durable.port.remove(`${DOCUMENTS_DIR}/${id}`).catch(() => undefined);
        return null;
    }
    if (manifest?.ext !== 'pdf') return null;
    const key = handleKeyOf(manifest.destination ?? null);
    const stored = key === null ? undefined : await fileHandleStore.get(key).catch(() => undefined);
    const fileName = stored?.name ?? 'Recovered document.pdf';
    const workingCopyRef = createBrowserDocumentRef(fileName, id);
    return {
        tabId: createTabId(),
        paneId,
        fileName,
        sourceRef: key !== null && stored ? createBrowserDocumentRef(stored.name, key) : workingCopyRef,
        workingCopyRef,
        requiresSaveAsOnFirstSave: key === null,
        isDirty: true,
        isDjvu: false,
        currentPage: null,
        zoom: null,
        zoomMode: null,
    };
}

/** Puts each restored document's drafts back on its tab, and the unsaved directories no checkpoint names. */
async function completeCheckpoint(checkpoint: IWorkspaceCheckpoint | null, orphans: string[]) {
    const paneId = checkpoint?.activePaneId ?? checkpoint?.panes[0]?.paneId ?? createPaneId();
    const tabs: IWorkspaceCheckpointTab[] = [];
    for (const tab of checkpoint?.tabs ?? []) {
        if (!tab.isDirty || !tab.workingCopyRef) {
            tabs.push(tab);
            continue;
        }
        browserDocumentStore.nameSource(tab.workingCopyRef, tab.sourceRef ?? tab.workingCopyRef);
        const doc = await browserDocumentStore.documentOf(tab.workingCopyRef);
        const drafts = doc?.state().drafts;
        tabs.push(doc ? {...tab, ...(drafts === undefined ? {} : {annotationRecovery: drafts as IWorkspaceCheckpointTab['annotationRecovery']})} : {...tab, workingCopyLost: true});
    }
    for (const id of orphans) {
        const tab = await orphanTab(id, paneId);
        if (!tab?.workingCopyRef) continue;
        browserDocumentStore.nameSource(tab.workingCopyRef, tab.sourceRef ?? tab.workingCopyRef);
        tabs.push(tab);
    }
    if (tabs.length === 0) return null;
    const panes = checkpoint?.panes.length ? [...checkpoint.panes] : [{paneId, tabIds: [], activeTabId: null}];
    const added = tabs.filter(tab => !checkpoint?.tabs.some(existing => existing.tabId === tab.tabId));
    const paneIndex = Math.max(0, panes.findIndex(pane => pane.paneId === paneId));
    const pane = panes[paneIndex]!;
    panes[paneIndex] = {...pane, tabIds: [...pane.tabIds, ...added.map(tab => tab.tabId)], activeTabId: pane.activeTabId ?? added[0]?.tabId ?? null};
    return decodeWorkspaceCheckpoint({
        version: 1,
        capturedAt: checkpoint?.capturedAt ?? createEpochMs(),
        activePaneId: checkpoint?.activePaneId ?? paneId,
        activeTabId: checkpoint?.activeTabId ?? tabs[0]!.tabId,
        layout: checkpoint?.layout ?? {type: 'leaf', paneId},
        panes,
        tabs,
        ...(checkpoint?.notReopened ? {notReopened: checkpoint.notReopened} : {}),
    });
}

/**
 * The workspace this window restores at startup: its own checkpoint after a reload, else the one of the page
 * this page replaced in its tab, else the newest one whose window is gone, taken by holding that window's lock so no other window takes it too. Unsaved
 * directories no checkpoint names come back as tabs of their own.
 */
export async function claimBrowserWorkspaceCheckpoint(windowId: string, inheritedWindowId: string | null = null) {
    const unsaved = await collectOnce();
    const {durable} = await browserDocumentStore.stores();
    if (!durable) return null;
    const checkpoints = [...await readWorkspaceCheckpoints(durable.port)];
    const named = new Set(checkpoints.flatMap(([, checkpoint]) => checkpoint ? Object.values(checkpoint.tabs).map(tab => tab.directory) : []));
    const decoded = checkpoints.flatMap(([id, checkpoint]) => {
        const workspace = checkpoint ? decodeWorkspaceCheckpoint(checkpoint.layout) : null;
        return workspace ? [{id, workspace}] : [];
    }).sort((left, right) => Number(right.id === windowId) - Number(left.id === windowId)
        || Number(right.id === inheritedWindowId) - Number(left.id === inheritedWindowId)
        || right.workspace.capturedAt - left.workspace.capturedAt);
    let chosen: IWorkspaceCheckpoint | null = null;
    for (const {id, workspace} of decoded) {
        const release = id === windowId ? () => undefined : await holdBrowserLock(browserWindowLockName(id));
        if (!release) continue;
        claimed = {windowId: id, release};
        chosen = workspace;
        break;
    }
    return completeCheckpoint(chosen, unsaved.filter(id => !named.has(id)));
}

/** A restore that succeeded makes the claimed checkpoint this window's: its own next checkpoint replaces it. */
export async function acknowledgeBrowserWorkspaceCheckpoint(windowId: string) {
    const taken = claimed;
    claimed = null;
    if (!taken) return;
    const {durable} = await browserDocumentStore.stores();
    if (durable && taken.windowId !== windowId) await removeWorkspaceCheckpoint(durable.port, taken.windowId).catch(() => undefined);
    taken.release();
}

export async function hasBrowserWorkspaceCheckpoint(windowId: string) {
    const {durable} = await browserDocumentStore.stores();
    return durable !== null && (await readWorkspaceCheckpoints(durable.port)).has(windowId);
}

/**
 * Records this window's unsaved work. Each document's unsaved annotations become the drafts of its
 * directory, committed with its bytes; the checkpoint names the directories of the dirty tabs and keeps
 * their views. A window without unsaved work keeps no checkpoint.
 */
export async function saveBrowserWorkspaceCheckpoint(windowId: string, checkpoint: IWorkspaceCheckpoint) {
    const {durable} = await browserDocumentStore.stores();
    if (!durable) return;
    // A record that names a working copy this window has closed since was captured before the change; the
    // record after it describes the window, so this one writes nothing.
    const open = new Set(browserDocumentStore.openEntries().map(entry => entry.ref));
    if (checkpoint.tabs.some(tab => tab.isDirty && tab.workingCopyRef && !open.has(tab.workingCopyRef))) return;
    const withDrafts = new Set<string>();
    for (const tab of checkpoint.tabs) {
        const recovery = tab.annotationRecovery;
        if (!tab.isDirty || !recovery?.workingCopyRef || recovery.payload === undefined) continue;
        const entry = await browserDocumentStore.ensureEntry(recovery.workingCopyRef).catch(() => null);
        if (!entry?.doc || entry.memoryOnly || browserDocumentStore.revisionTokenOf(entry) !== recovery.workingByteRevision) continue;
        const stored = await entry.doc.setDrafts(entry.doc.state().current?.id ?? null, recovery);
        if (stored.status === 'stored') withDrafts.add(entry.ref);
    }
    for (const entry of browserDocumentStore.openEntries()) {
        if (entry.doc && !entry.memoryOnly && !withDrafts.has(entry.ref) && entry.doc.state().drafts !== undefined) {
            await entry.doc.setDrafts(entry.doc.state().current?.id ?? null, undefined);
        }
    }
    const dirtyTabs = checkpoint.tabs.filter(tab => tab.isDirty);
    if (dirtyTabs.length === 0) {
        await removeWorkspaceCheckpoint(durable.port, windowId);
        return;
    }
    const tabs: Record<string, {directory: string; view: null}> = {};
    for (const tab of dirtyTabs) {
        const entry = tab.workingCopyRef ? await browserDocumentStore.ensureEntry(tab.workingCopyRef).catch(() => null) : null;
        if (entry?.doc && !entry.memoryOnly) tabs[tab.tabId] = {directory: entry.doc.id, view: null};
    }
    await writeWorkspaceCheckpoint(durable.port, windowId, {
        tabs,
        // The drafts are in the directories; the checkpoint keeps references and views only.
        layout: {...checkpoint, tabs: checkpoint.tabs.map(({annotationRecovery: _drafts, ...tab}) => tab)},
    });
}
