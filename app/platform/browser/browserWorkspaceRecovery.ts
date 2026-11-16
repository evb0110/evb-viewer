import { collectDocuments } from '@document-store/collectDocuments';
import * as v from 'valibot';
import {
    decodeJson,
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
    getBrowserDocumentFileName,
} from '@app/platform/browser/browserDocumentRefs';
import { fileHandleStore } from '@app/platform/browser/browserFileHandleStore';
import {
    destinationFileName,
    handleKeyOf,
} from '@app/platform/browser/browserPublication';
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
    decodeStoredWorkspaceCheckpoint,
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointAnnotationRecovery,
    type IWorkspaceCheckpointTab,
    toStoredWorkspaceCheckpoint,
    workspaceAnnotationRecoveryRefSchema,
} from '@contracts/workspaceCheckpoint';
import { isRecord } from '@contracts/runtimeGuards';
import { BrowserLogger } from '@app/utils/browserLogger';

const WINDOW_LOCK_PREFIX = 'evb-window:';
const LOG_SECTION = 'workspace-recovery';

const isAbsent = (error: unknown) => isRecord(error) && (error.code === 'ENOENT' || error.name === 'NotFoundError');

/** The lock a live window holds; a checkpoint whose window lock is free belongs to a window that is gone. */
export const browserWindowLockName = (windowId: string) => `${WINDOW_LOCK_PREFIX}${windowId}`;

let collection: Promise<{unsaved: string[]; held: string[]} | null> | null = null;
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
 * Once per window, before it restores anything: removes the directories nothing needs that no window holds
 * and no Recent entry names (see `collectDocuments`), each decided while this window holds its lock, and the
 * stored file handles nothing names any more. Returns the unsaved directories no window holds, and those whose
 * manifest it could not read, for the recovery offer, and the ones a window held, which may be unsaved too. `null`
 * when nothing is known: without Web Locks about the other windows, so nothing is removed, or when it failed.
 */
function collectOnce() {
    collection ??= (async () => {
        const {durable} = await browserDocumentStore.stores();
        if (!durable || !await heldBrowserLockNames()) return null;
        const recent = recentFileIds();
        const {unsaved, held, unreadable} = await collectDocuments(durable, id => (recent.has(id) ? Promise.resolve(null) : holdBrowserLock(browserDocumentLockName(id))));
        for (const {path, error} of unreadable) BrowserLogger.warn(LOG_SECTION, 'Kept recovery data that cannot be read', {path, error});
        const reported = new Set(unreadable.map(entry => entry.path));
        const named = new Set(recent);
        for (const id of await durable.port.list(DOCUMENTS_DIR)) {
            const path = `${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`;
            const manifest = await durable.port.read(path).then(decodeManifest).catch((error: unknown) => {
                // A held directory's file handles stay; one this collection could not read was reported above.
                if (!isAbsent(error)) {
                    if (!reported.has(path)) BrowserLogger.warn(LOG_SECTION, 'Kept file handles of a document whose manifest cannot be read', {path, error});
                    reported.add(path);
                }
                return null;
            });
            for (const destination of [manifest?.destination, manifest?.pendingPublish?.destination, ...manifest?.unsettled?.map(record => record.destination) ?? []]) {
                const key = handleKeyOf(destination ?? null);
                if (key !== null) named.add(key);
            }
        }
        // An unreadable manifest may name any retained handle.
        for (const key of reported.size === 0 ? await fileHandleStore.keys().catch(() => []) : []) {
            if (!named.has(key)) await fileHandleStore.delete(key).catch(() => undefined);
        }
        // What Recent names stays for Recent to reopen, as before.
        return {unsaved: [...unsaved, ...unreadable.flatMap(entry => entry.directory ?? [])], held: held.filter(id => !recent.has(id))};
    })().catch((error: unknown) => {
        BrowserLogger.warn(LOG_SECTION, 'Document collection stopped; unsaved documents stay but are not offered', {store: DOCUMENTS_DIR, error});
        return null;
    });
    return collection;
}

/**
 * The tab an unsaved directory its window's checkpoint names, but whose layout never showed, comes back in, named
 * after its destination, under the working reference its drafts were captured with so they replay. One whose
 * manifest cannot be read comes back as a notice that its work was not found.
 */
async function orphanTab(id: string, paneId: IWorkspaceCheckpointTab['paneId']): Promise<IWorkspaceCheckpointTab | null> {
    const {durable} = await browserDocumentStore.stores();
    const path = `${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`;
    const manifest = durable && await durable.port.read(path).then(decodeManifest).catch((error: unknown) => {
        if (isAbsent(error)) return null;
        BrowserLogger.warn(LOG_SECTION, 'Unsaved work no workspace shows cannot be read', {path, error});
        return undefined;
    });
    if (manifest === undefined) {
        return {
            tabId: createTabId(), paneId, fileName: 'Recovered document.pdf', sourceRef: null, workingCopyRef: null,
            isDirty: false, isDjvu: false, currentPage: null, zoom: null, zoomMode: null, workingCopyLost: true,
        };
    }
    if (!durable || manifest?.ext !== 'pdf') return null;
    const draftsRef = manifest.drafts === undefined ? null : await durable.port.read(`${DOCUMENTS_DIR}/${id}/${manifest.drafts}`)
        .then((bytes) => {
            const drafts = v.safeParse(workspaceAnnotationRecoveryRefSchema, decodeJson(bytes));
            return drafts.success && directoryOf(drafts.output.workingCopyRef) === id ? drafts.output.workingCopyRef : null;
        })
        .catch(() => null);
    const key = handleKeyOf(manifest.destination ?? null);
    const stored = key === null ? undefined : await fileHandleStore.get(key).catch(() => undefined);
    const fileName = stored?.name ?? destinationFileName(manifest.destination ?? null)
        ?? (draftsRef && getBrowserDocumentFileName(draftsRef)) ?? 'Recovered document.pdf';
    const workingCopyRef = draftsRef ?? createBrowserDocumentRef(fileName, id);
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

/** Opens a tab's unsaved directory here and puts its drafts back on the tab; `workingCopyLost` when it would not open. */
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
        tabs.push(workingCopyRef && directory !== null && unsaved.has(directory)
            ? await restoreUnsavedTab({...tab, workingCopyRef})
            : tab);
    }
    for (const id of orphans) {
        const tab = await orphanTab(id, paneId);
        const restored = tab?.workingCopyRef ? await restoreUnsavedTab({...tab, workingCopyRef: tab.workingCopyRef}) : tab;
        // One another window opened first stays there; one that cannot be read is reported.
        if (restored && (tab?.workingCopyLost || !restored.workingCopyLost)) tabs.push(restored);
    }
    // Recovered work takes the place of an empty New Tab that was the only tab, and shows.
    const [only, ...recovered] = tabs;
    if (checkpoint?.tabs.length === 1 && recovered.length > 0 && !only!.sourceRef && !only!.workingCopyRef) {
        tabs.shift();
        checkpoint = {...checkpoint, activeTabId: null, tabs: [], panes: checkpoint.panes.map(pane => ({...pane, tabIds: [], activeTabId: null}))};
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
 * is gone and left none is removed, so its clean directories can be collected. A directory the collection did not
 * inspect may be unsaved, so a checkpoint that names one stays. Unsaved directories no
 * checkpoint names come back as tabs of the restored workspace, or of one of their own.
 */
export async function claimBrowserWorkspaceCheckpoint(windowId: string, inheritedWindowId: string | null = null) {
    const collected = await collectOnce();
    const unsaved = new Set(collected?.unsaved);
    const uninspected = (id: string) => !collected || collected.held.includes(id);
    const {durable} = await browserDocumentStore.stores();
    if (!durable) return null;
    const checkpoints = [...await readWorkspaceCheckpoints(durable.port)];
    const named = new Set(checkpoints.flatMap(([, checkpoint]) => namesOf(checkpoint)));
    const unnamed = [...unsaved].filter(id => !named.has(id));
    const candidates = checkpoints.flatMap(([id, checkpoint]) => checkpoint
        ? [{id, names: namesOf(checkpoint), workspace: decodeStoredWorkspaceCheckpoint(checkpoint.layout)}]
        : []).sort((left, right) => Number(right.id === windowId) - Number(left.id === windowId)
        || Number(right.id === inheritedWindowId) - Number(left.id === inheritedWindowId)
        || (right.workspace?.capturedAt ?? 0) - (left.workspace?.capturedAt ?? 0));
    let restored: IWorkspaceCheckpoint | null = null;
    for (const candidate of candidates) {
        const release = candidate.id === windowId ? () => undefined : await holdBrowserLock(browserWindowLockName(candidate.id));
        if (!release) continue;
        if (!candidate.names.some(id => unsaved.has(id))) {
            if (candidate.id !== windowId && !candidate.names.some(uninspected)) await removeWorkspaceCheckpoint(durable.port, candidate.id).catch(() => undefined);
            release();
            continue;
        }
        claimed = {windowId: candidate.id, release};
        const shown = new Set(candidate.workspace?.tabs.map(tab => directoryOf(tab.workingCopyRef)));
        restored = await completeCheckpoint(candidate.workspace, [...candidate.names.filter(id => unsaved.has(id) && !shown.has(id)), ...unnamed], unsaved);
        break;
    }
    if (restored === null && unnamed.length > 0) restored = await completeCheckpoint(null, unnamed, unsaved);
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
    const unsaved = new Set((await collectOnce())?.unsaved);
    const {durable} = await browserDocumentStore.stores();
    return durable !== null && namesOf((await readWorkspaceCheckpoints(durable.port)).get(windowId)).some(id => unsaved.has(id));
}

/** Every store directory this page edited or took with unsaved work. Its window's checkpoint names them all, so a crash cannot leave that work unnamed. */
const namedDirectories = new Set<string>();
/** This window's checkpoint as the page found it, named on until the page has claimed what it restores. */
let startCheckpoint: Promise<ICoreWorkspaceCheckpoint | null | undefined> | null = null;
/** The layout this page recorded last. */
let layout: ReturnType<typeof toStoredWorkspaceCheckpoint> | null = null;
let written = Promise.resolve();

/** Writes this window's checkpoint: the directories it names, then the layout last recorded. One write at a time. */
function writeWindowCheckpoint(windowId: string) {
    written = written.catch(() => undefined).then(async () => {
        const {durable} = await browserDocumentStore.stores();
        if (!durable) return;
        startCheckpoint ??= readWorkspaceCheckpoints(durable.port).then(checkpoints => checkpoints.get(windowId));
        const start = await startCheckpoint;
        const directories = new Set([...namesOf(start), ...namedDirectories]);
        if (directories.size === 0) {
            await removeWorkspaceCheckpoint(durable.port, windowId);
            return;
        }
        await writeWorkspaceCheckpoint(durable.port, windowId, {
            tabs: Object.fromEntries([...directories].map(directory => [directory, {directory, view: null}])),
            layout: layout ?? start?.layout ?? null,
        });
    });
    return written;
}

/** Names a directory in this window's checkpoint before its first edit; a named one waits for the last write, and fails with it. */
export function nameBrowserWorkspaceDirectory(windowId: string, directory: string) {
    if (namedDirectories.has(directory)) return written;
    namedDirectories.add(directory);
    return writeWindowCheckpoint(windowId);
}

/** Records this window's layout. */
export async function saveBrowserWorkspaceCheckpoint(windowId: string, checkpoint: IWorkspaceCheckpoint) {
    // A record that names a working copy this window has closed since was captured before the change; the
    // record after it describes the window, so this one writes nothing.
    const open = new Set(browserDocumentStore.openEntries().map(entry => entry.ref));
    if (checkpoint.tabs.some(tab => tab.isDirty && tab.workingCopyRef && !open.has(tab.workingCopyRef))) return;
    layout = toStoredWorkspaceCheckpoint(checkpoint);
    await writeWindowCheckpoint(windowId);
}

/** Commits a document's drafts, or clears them without a payload. False for an outdated revision: the renderer sends them again. */
export async function setBrowserDocumentDrafts(drafts: IWorkspaceCheckpointAnnotationRecovery) {
    const {workingCopyRef} = drafts;
    const entry = workingCopyRef ? await browserDocumentStore.ensureEntry(workingCopyRef).catch((error: unknown) => {
        BrowserLogger.warn(LOG_SECTION, 'Drafts were not stored: their document could not be looked up', {ref: workingCopyRef, error});
        return undefined;
    }) : null;
    // Unwritten drafts are never acknowledged.
    if (entry === undefined || (entry === null && drafts.payload !== undefined)) return false;
    if (!entry?.doc || entry.memoryOnly || (drafts.payload === undefined && entry.doc.state().drafts === undefined)) return true;
    if (browserDocumentStore.tokenOf(entry) !== drafts.workingByteRevision) return false;
    if (drafts.payload !== undefined) await browserDocumentStore.nameEdited(entry);
    const stored = await entry.doc.setDrafts(entry.doc.state().current?.id ?? null, drafts.payload === undefined ? undefined : drafts);
    if (stored.status === 'conflict') throw new Error('Drafts were not stored');
    return stored.status === 'stored';
}
