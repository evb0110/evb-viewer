import { collectDocuments } from '@document-store/collectDocuments';
import {
    decodeManifest,
    DOCUMENTS_DIR,
    MANIFEST_NAME,
} from '@document-store/documentDirectory';
import {
    type IWorkspaceCheckpoint as ICoreWorkspaceCheckpoint,
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
import type { TDocumentRef } from '@contracts/documentRef';
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

/** The tab an unsaved directory its window's checkpoint names, but whose layout never showed, comes back in. */
async function orphanTab(id: string, paneId: IWorkspaceCheckpointTab['paneId']): Promise<IWorkspaceCheckpointTab | null> {
    const {durable} = await browserDocumentStore.stores();
    const manifest = durable && await durable.port.read(`${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`).then(decodeManifest).catch(() => null);
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

function directoryOf(ref: string | null) {
    try {
        return ref ? browserDocumentRefId(ref) : null;
    } catch {
        return null;
    }
}

/** Opens a tab's unsaved directory here and puts its drafts back on the tab. */
async function restoreUnsavedTab(tab: IWorkspaceCheckpointTab & {workingCopyRef: TDocumentRef}): Promise<IWorkspaceCheckpointTab> {
    browserDocumentStore.nameSource(tab.workingCopyRef, tab.sourceRef ?? tab.workingCopyRef);
    const doc = await browserDocumentStore.documentOf(tab.workingCopyRef);
    const drafts = doc?.state().drafts;
    return doc
        ? {...tab, isDirty: true, ...(drafts === undefined ? {} : {annotationRecovery: drafts as IWorkspaceCheckpointTab['annotationRecovery']})}
        : {...tab, workingCopyLost: true};
}

/**
 * Restores a tab's unsaved directory, and the unsaved directories the checkpoint names that its layout does
 * not show. Whether a directory is unsaved comes from its manifest, so an edit the layout recorded no tab
 * change for yet comes back too.
 */
async function completeCheckpoint(checkpoint: IWorkspaceCheckpoint | null, orphans: string[], unsaved: Set<string>) {
    const paneId = checkpoint?.activePaneId ?? checkpoint?.panes[0]?.paneId ?? createPaneId();
    const tabs: IWorkspaceCheckpointTab[] = [];
    for (const tab of checkpoint?.tabs ?? []) {
        const {workingCopyRef} = tab;
        const directory = directoryOf(workingCopyRef);
        tabs.push(workingCopyRef && (tab.isDirty || (directory !== null && unsaved.has(directory)))
            ? await restoreUnsavedTab({...tab, workingCopyRef})
            : tab);
    }
    for (const id of orphans) {
        const tab = await orphanTab(id, paneId);
        if (tab?.workingCopyRef) tabs.push(await restoreUnsavedTab({...tab, workingCopyRef: tab.workingCopyRef}));
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

const namesOf = (checkpoint: ICoreWorkspaceCheckpoint | null | undefined) => Object.values(checkpoint?.tabs ?? {}).map(tab => tab.directory);

/**
 * The workspace this window restores at startup: its own checkpoint after a reload, else the one of the page
 * this page replaced in its tab, else the newest one whose window is gone, taken by holding that window's lock
 * so no other window takes it too. Only a checkpoint that names unsaved work is restored; one of a window that
 * is gone and left none is removed, so its clean directories can be collected.
 */
export async function claimBrowserWorkspaceCheckpoint(windowId: string, inheritedWindowId: string | null = null) {
    const unsaved = new Set(await collectOnce());
    const {durable} = await browserDocumentStore.stores();
    if (!durable) return null;
    const checkpoints = [...await readWorkspaceCheckpoints(durable.port)];
    // Every window names a directory as soon as it holds it, so an unsaved one no checkpoint names was left by
    // an open a crash cut short, before anyone could change it.
    if (checkpoints.every(([, checkpoint]) => checkpoint !== null)) {
        const named = new Set(checkpoints.flatMap(([, checkpoint]) => namesOf(checkpoint)));
        for (const id of [...unsaved].filter(id => !named.has(id))) {
            unsaved.delete(id);
            await durable.port.remove(`${DOCUMENTS_DIR}/${id}`).catch(() => undefined);
        }
    }
    const candidates = checkpoints.flatMap(([id, checkpoint]) => checkpoint
        ? [{id, names: namesOf(checkpoint), workspace: decodeWorkspaceCheckpoint(checkpoint.layout)}]
        : []).sort((left, right) => Number(right.id === windowId) - Number(left.id === windowId)
        || Number(right.id === inheritedWindowId) - Number(left.id === inheritedWindowId)
        || (right.workspace?.capturedAt ?? 0) - (left.workspace?.capturedAt ?? 0));
    let restored: IWorkspaceCheckpoint | null = null;
    for (const candidate of candidates) {
        const release = candidate.id === windowId ? () => undefined : await holdBrowserLock(browserWindowLockName(candidate.id));
        if (!release) continue;
        if (!candidate.names.some(id => unsaved.has(id))) {
            if (candidate.id !== windowId) await removeWorkspaceCheckpoint(durable.port, candidate.id).catch(() => undefined);
            release();
            continue;
        }
        claimed = {windowId: candidate.id, release};
        const shown = new Set(candidate.workspace?.tabs.map(tab => directoryOf(tab.workingCopyRef)));
        restored = await completeCheckpoint(candidate.workspace, candidate.names.filter(id => unsaved.has(id) && !shown.has(id)), unsaved);
        break;
    }
    // What this window's checkpoint named before is restored and held now, or was clean.
    startCheckpoint = Promise.resolve(null);
    await writeWindowCheckpoint(windowId);
    return restored;
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

/** Whether this window's checkpoint names unsaved work it restores. */
export async function hasBrowserWorkspaceCheckpoint(windowId: string) {
    const unsaved = new Set(await collectOnce());
    const {durable} = await browserDocumentStore.stores();
    return durable !== null && namesOf((await readWorkspaceCheckpoints(durable.port)).get(windowId)).some(id => unsaved.has(id));
}

/** Every store directory this page has held. Its window's checkpoint names them all, so a crash cannot leave unsaved work unnamed. */
const heldDirectories = new Set<string>();
/** This window's checkpoint as the page found it, named on until the page has claimed what it restores. */
let startCheckpoint: Promise<ICoreWorkspaceCheckpoint | null | undefined> | null = null;
/** The layout this page recorded last. */
let layout: IWorkspaceCheckpoint | null = null;
let writing = Promise.resolve();

/** Writes this window's checkpoint: the directories it names, then the layout last recorded. One write at a time. */
function writeWindowCheckpoint(windowId: string) {
    const write = writing.then(async () => {
        const {durable} = await browserDocumentStore.stores();
        if (!durable) return;
        startCheckpoint ??= readWorkspaceCheckpoints(durable.port).then(checkpoints => checkpoints.get(windowId));
        const start = await startCheckpoint;
        const directories = new Set([...namesOf(start), ...heldDirectories]);
        if (directories.size === 0) {
            await removeWorkspaceCheckpoint(durable.port, windowId);
            return;
        }
        await writeWorkspaceCheckpoint(durable.port, windowId, {
            tabs: Object.fromEntries([...directories].map(directory => [directory, {directory, view: null}])),
            layout: layout ?? start?.layout ?? null,
        });
    });
    writing = write.catch(() => undefined);
    return write;
}

/** Names a directory this window has started to hold in its checkpoint, before it is used. */
export function nameBrowserWorkspaceDirectory(windowId: string, directory: string) {
    heldDirectories.add(directory);
    return writeWindowCheckpoint(windowId);
}

/**
 * Records this window's layout and unsaved annotations. Each document's unsaved annotations become the drafts
 * of its directory, committed with its bytes; the checkpoint keeps references and views only.
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
        if (!entry?.doc || entry.memoryOnly || browserDocumentStore.tokenOf(entry) !== recovery.workingByteRevision) continue;
        const stored = await entry.doc.setDrafts(entry.doc.state().current?.id ?? null, recovery);
        if (stored.status === 'stored') withDrafts.add(entry.ref);
    }
    for (const entry of browserDocumentStore.openEntries()) {
        if (entry.doc && !entry.memoryOnly && !withDrafts.has(entry.ref) && entry.doc.state().drafts !== undefined) {
            await entry.doc.setDrafts(entry.doc.state().current?.id ?? null, undefined);
        }
    }
    layout = {...checkpoint, tabs: checkpoint.tabs.map(({annotationRecovery: _drafts, ...tab}) => tab)};
    await writeWindowCheckpoint(windowId);
}
