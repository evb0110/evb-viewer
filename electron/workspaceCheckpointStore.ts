import {randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {webContents} from 'electron';
import type {WebContents} from 'electron';
import {
    decodeManifest,
    DOCUMENTS_DIR,
    isDirty,
    MANIFEST_NAME,
} from '@document-store/documentDirectory';
import {
    readWorkspaceCheckpoints,
    removeWorkspaceCheckpoint,
    writeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint as IStoredCheckpoint,
} from '@document-store/workspaceCheckpoint';
import {
    decodeStoredWorkspaceCheckpoint,
    toStoredWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointAnnotationRecovery,
    type IWorkspaceCheckpointTab,
} from '@contracts/workspaceCheckpoint';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {createPaneId} from '@contracts/editorPanes';
import {createEpochMs} from '@contracts/timestamps';
import {createTabId} from '@contracts/windowTabs';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    getDocumentStore,
    getWorkingCopyBackingEntry,
    type IOpenDocument,
    openDocuments,
    reopenStoredDocument,
    setDocumentDirectoryNaming,
    setOpenDocumentDrafts,
    unheldUnsavedDocuments,
} from '@electron/file-access/documentStore';
import {findKeptOriginal} from '@electron/file-access/keptOriginalNotices';
import {requireOpenPath} from '@electron/file-access/openPathCapabilities';
import {touchScanCleanupGeneratedOutput} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {onSenderLifetimeEnd} from '@electron/utils/onSenderLifetimeEnd';

const log = createLogger('workspace-checkpoint-store');

/**
 * Each window's workspace is one checkpoint in the document store: the renderer's tabs, panes and views, and for
 * each tab the document directory it shows. It keeps references only: unsaved annotations are the drafts of their
 * document, committed with its manifest, and whether a tab holds unsaved work and its drafts come from that
 * manifest when the workspace is claimed.
 */
interface IDrafts {annotationRecovery: IWorkspaceCheckpointAnnotationRecovery}

const ownerIdsByWebContents = new WeakMap<WebContents, string>();
const liveOwners = new Map<string, WebContents>();
const claimedInCurrentLoad = new Set<string>();
const discardedOwners = new Map<string, string>();
/** The clean documents a claimed restore shows at once; if the renderer dies before it acknowledges, they stay closed. */
const restoresInFlight = new Map<string, {tabIds: Set<string>; sourceRefs: Set<string>}>();
let nextDiscardToken = 1;
let queue: Promise<unknown> = Promise.resolve();
/** The directories each owner's checkpoint on disk names, as this process last wrote it. */
const namedDirectories = new Map<string, ReadonlySet<string>>();
/** Directories a window edited or recovered: its checkpoint names those it holds, as well as its tabs'. */
const editedDirectories = new Set<string>();

function serialize<T>(operation: () => Promise<T>) {
    const run = queue.then(operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
}

const legacyOwnerId = (ownerWebContentsId: number) => `legacy-webcontents-${ownerWebContentsId}`;

function getOwnerId(ownerWebContentsId: number, owner?: number | WebContents) {
    if (owner === undefined || typeof owner === 'number') return legacyOwnerId(ownerWebContentsId);
    // A closed window is retired after its contents are destroyed, under the id its checkpoint was written with.
    const known = ownerIdsByWebContents.get(owner);
    if (known || owner.isDestroyed()) return known ?? legacyOwnerId(ownerWebContentsId);
    const ownerId = randomUUID();
    ownerIdsByWebContents.set(owner, ownerId);
    liveOwners.set(ownerId, owner);
    const stopWatching = onSenderLifetimeEnd(owner, (end) => {
        claimedInCurrentLoad.delete(ownerId);
        const interrupted = restoresInFlight.get(ownerId);
        restoresInFlight.delete(ownerId);
        if (end === 'render-process-gone' && interrupted) {
            void serialize(() => closeRestoreDocuments(ownerId, interrupted)).catch((error: unknown) => {
                log.warn(`Could not close the documents of a restore that ended the renderer: ${getErrorMessage(error)}`);
            });
        }
        if (end === 'destroyed') {
            stopWatching();
            liveOwners.delete(ownerId);
        }
    }, {navigation: true});
    return ownerId;
}

function isLiveOwner(ownerId: string) {
    const owner = liveOwners.get(ownerId);
    if (owner) return !owner.isDestroyed();
    const legacy = /^legacy-webcontents-(\d+)$/u.exec(ownerId);
    const contents = legacy ? webContents.fromId(Number(legacy[1])) : undefined;
    return contents !== undefined && !contents.isDestroyed() && !ownerIdsByWebContents.has(contents);
}

function decodeStored(stored: IStoredCheckpoint | null) {
    return stored && isRecord(stored.layout) ? decodeStoredWorkspaceCheckpoint(stored.layout.checkpoint) : null;
}

function encodeStored(checkpoint: IWorkspaceCheckpoint, directories: ReadonlyMap<string, string>): IStoredCheckpoint {
    return {
        tabs: Object.fromEntries([...directories].map(([tabId, directory]) => [tabId, {directory, view: null}])),
        layout: {checkpoint: toStoredWorkspaceCheckpoint(checkpoint)},
    };
}

/** Writes `ownerId`'s checkpoint, which also names each edited directory a document of window `ownerWebContentsId` holds. */
async function writeOwnerCheckpoint(ownerId: string, ownerWebContentsId: number | undefined, stored: IStoredCheckpoint) {
    const tabs = {...stored.tabs};
    const named = new Set(Object.values(tabs).map(tab => tab.directory));
    for (const {doc, ownerWebContentsId: holder} of openDocuments.values()) {
        if (holder === ownerWebContentsId && holder !== undefined && editedDirectories.has(doc.id) && !named.has(doc.id)) {
            tabs[doc.id] = {directory: doc.id, view: null};
            named.add(doc.id);
        }
    }
    await writeWorkspaceCheckpoint(getDocumentStore().port, ownerId, {...stored, tabs});
    namedDirectories.set(ownerId, named);
}

async function removeOwnerCheckpoint(ownerId: string) {
    namedDirectories.delete(ownerId);
    await removeWorkspaceCheckpoint(getDocumentStore().port, ownerId);
}

/**
 * Names `entry`'s directory in its window's checkpoint before its first edit, keeping the layout that window last
 * stored. A directory no checkpoint names then holds at most what an open made, which collection may remove.
 */
function nameEditedDirectory(entry: IOpenDocument) {
    editedDirectories.add(entry.doc.id);
    const {ownerWebContentsId} = entry;
    if (ownerWebContentsId === undefined) return Promise.resolve();
    const ownerId = getOwnerId(ownerWebContentsId, webContents.fromId(ownerWebContentsId) ?? ownerWebContentsId);
    if (namedDirectories.get(ownerId)?.has(entry.doc.id)) return Promise.resolve();
    return serialize(async () => {
        if (discardedOwners.has(ownerId)) return;
        const own = (await readWorkspaceCheckpoints(getDocumentStore().port)).get(ownerId);
        await writeOwnerCheckpoint(ownerId, ownerWebContentsId, own ?? {tabs: {}, layout: null});
    });
}

setDocumentDirectoryNaming(nameEditedDirectory);

/** Whether the document in `directory` holds unsaved work, by its manifest. A directory that is gone holds none; one that cannot be read may. */
async function holdsUnsavedWork(directory: string) {
    try {
        return isDirty(decodeManifest(await getDocumentStore().port.read(`${DOCUMENTS_DIR}/${directory}/${MANIFEST_NAME}`)));
    } catch (error) {
        return !(isErrnoException(error) && error.code === 'ENOENT');
    }
}

async function unsavedTabIds(stored: IStoredCheckpoint) {
    const unsaved = new Set<string>();
    for (const [tabId, {directory}] of Object.entries(stored.tabs)) {
        if (await holdsUnsavedWork(directory)) unsaved.add(tabId);
    }
    return unsaved;
}

async function readCheckpoints() {
    const decoded = new Map<string, {stored: IStoredCheckpoint; checkpoint: IWorkspaceCheckpoint}>();
    for (const [ownerId, stored] of await readWorkspaceCheckpoints(getDocumentStore().port)) {
        const checkpoint = decodeStored(stored);
        // An unreadable checkpoint stays on disk: collection then keeps every document it might name.
        if (stored && checkpoint) decoded.set(ownerId, {stored, checkpoint});
    }
    return decoded;
}

function isAdmittedSource(sourceRef: TDocumentRef, owner: number | WebContents, documentOriginal: string | undefined) {
    if (sourceRef === documentOriginal) return true;
    try {
        requireOpenPath(sourceRef, owner);
        return true;
    } catch {
        return false;
    }
}

/** Stores this window's tabs, panes and views and the directory each tab shows; resolves once durable. */
export function saveWorkspaceCheckpoint(
    checkpoint: IWorkspaceCheckpoint,
    ownerWebContentsId: number,
    owner: number | WebContents = ownerWebContentsId,
) {
    const ownerId = getOwnerId(ownerWebContentsId, owner);
    return serialize(async () => {
        if (discardedOwners.has(ownerId)) return false;
        const directories = new Map<string, string>();
        const tabs: IWorkspaceCheckpointTab[] = [];
        for (const tab of checkpoint.tabs) {
            const entry = tab.workingCopyRef ? getWorkingCopyBackingEntry(tab.workingCopyRef, ownerWebContentsId) : null;
            if (tab.workingCopyRef && (!entry || entry.ownerWebContentsId !== ownerWebContentsId)) {
                throw new Error('Workspace checkpoint contains an unowned working copy');
            }
            if (entry) directories.set(tab.tabId, entry.doc.id);
            const sourceRef = tab.sourceRef && isAdmittedSource(tab.sourceRef, owner, entry?.originalPath) ? tab.sourceRef : null;
            tabs.push({...tab, sourceRef});
            // A generated output a tab shows must outlive the scratch sweep until the tab is gone.
            if (sourceRef) void touchScanCleanupGeneratedOutput(sourceRef).catch(() => undefined);
        }
        await writeOwnerCheckpoint(ownerId, ownerWebContentsId, encodeStored({...checkpoint, tabs}, directories));
        return true;
    });
}

/** Commits a document's drafts for their revision, or clears them without a payload; false for an outdated revision. */
export async function setWorkspaceDocumentDrafts(drafts: IWorkspaceCheckpointAnnotationRecovery, ownerWebContentsId: number) {
    const entry = drafts.workingCopyRef ? getWorkingCopyBackingEntry(drafts.workingCopyRef, ownerWebContentsId) : null;
    if (entry?.ownerWebContentsId !== ownerWebContentsId) throw new Error('Drafts of an unowned working copy');
    // A damaged document's directory waits for a start that reads it.
    if (entry.doc.damaged || (drafts.payload === undefined && entry.doc.state().drafts === undefined)) return true;
    if (drafts.payload !== undefined) await nameEditedDirectory(entry);
    const status = await setOpenDocumentDrafts(entry, drafts.workingByteRevision, drafts.payload === undefined ? undefined : {annotationRecovery: drafts});
    if (status === 'conflict') throw new Error('Drafts were not stored');
    return status === 'stored';
}

/** Writes nothing: every save is written before it resolves. Kept for the shutdown order. */
export function flushPendingWorkspaceCheckpointSave() {
    return serialize(() => Promise.resolve());
}

function isClaimable(ownerId: string, claimantId: string) {
    if (discardedOwners.has(ownerId)) return false;
    return ownerId === claimantId ? !claimedInCurrentLoad.has(claimantId) : !isLiveOwner(ownerId);
}

/**
 * The unsaved directories no window holds and no workspace in `checkpoints` shows: work an edit named before its
 * window's next checkpoint, or that no checkpoint names. The next claim offers them as tabs of their own.
 */
async function unshownUnsavedDirectories(checkpoints: ReadonlyMap<string, IStoredCheckpoint | null>) {
    const shown = new Set<string>();
    for (const stored of checkpoints.values()) {
        if (!stored) continue;
        for (const tab of decodeStored(stored)?.tabs ?? []) {
            const directory = stored.tabs[tab.tabId]?.directory;
            if (directory) shown.add(directory);
        }
    }
    return (await unheldUnsavedDocuments()).filter(directory => !shown.has(directory));
}

/** A tab for an unsaved directory no workspace shows. Only a PDF is offered; another kind stays in the store. */
async function unshownTab(directory: string, paneId: IWorkspaceCheckpointTab['paneId']): Promise<IWorkspaceCheckpointTab | null> {
    const manifest = await getDocumentStore().port.read(`${DOCUMENTS_DIR}/${directory}/${MANIFEST_NAME}`).then(decodeManifest).catch(() => null);
    if (manifest?.ext !== 'pdf') return null;
    const {destination} = manifest;
    return {
        tabId: createTabId(),
        paneId,
        fileName: destination === undefined ? 'Recovered document.pdf' : basename(destination),
        sourceRef: destination === undefined ? null : requireDocumentRef(destination),
        workingCopyRef: null,
        ...(destination === undefined ? {requiresSaveAsOnFirstSave: true} : {}),
        isDirty: true,
        isDjvu: false,
        currentPage: null,
        zoom: null,
        zoomMode: null,
    };
}

export function hasRecoverableWorkspaceCheckpoints(ownerWebContentsId: number, owner?: number | WebContents) {
    const claimantId = getOwnerId(ownerWebContentsId, owner);
    return serialize(async () => {
        const checkpoints = await readWorkspaceCheckpoints(getDocumentStore().port);
        return [...(await readCheckpoints()).keys()].some(ownerId => isClaimable(ownerId, claimantId))
            || (await unshownUnsavedDirectories(checkpoints)).length > 0;
    });
}

/**
 * Hands the newest checkpoint this window may take to it: its own after a reload, or one whose window is gone. Each
 * dirty tab's document reopens through the store's recovery and is registered to this window, with its drafts as
 * the tab's annotation recovery. A damaged document shows its file as last saved, stays unsaved and says its work
 * was not found, which a later start that can read it recovers; a tab whose document cannot be opened reopens its source.
 * Unsaved directories no workspace shows come back as tabs of their own, in a workspace of their own when there is
 * no checkpoint to take; the checkpoints of windows that are gone and stored no workspace go once they are taken.
 */
export function claimWorkspaceCheckpoint(ownerWebContentsId: number, owner?: number | WebContents) {
    const claimantId = getOwnerId(ownerWebContentsId, owner);
    return serialize(async () => {
        const checkpoints = await readWorkspaceCheckpoints(getDocumentStore().port);
        let newest: {ownerId: string; stored: IStoredCheckpoint; checkpoint: IWorkspaceCheckpoint} | null = null;
        for (const [ownerId, candidate] of await readCheckpoints()) {
            if (isClaimable(ownerId, claimantId) && (!newest || candidate.checkpoint.capturedAt > newest.checkpoint.capturedAt)) {
                newest = {ownerId, ...candidate};
            }
        }
        const unshown = await unshownUnsavedDirectories(checkpoints);
        if (!newest && unshown.length === 0) return null;
        const paneId = createPaneId();
        const workspace: IWorkspaceCheckpoint = newest?.checkpoint ?? {
            version: 1, capturedAt: createEpochMs(), activePaneId: paneId, activeTabId: null,
            layout: {type: 'leaf', paneId}, panes: [{paneId, tabIds: [], activeTabId: null}], tabs: [],
        };
        const target = workspace.activePaneId ?? workspace.panes[0]?.paneId ?? paneId;
        // This window's checkpoint names every unshown directory, offered or not, before the ones that named it go.
        const stored: IStoredCheckpoint = {tabs: {...newest?.stored.tabs}, layout: newest?.stored.layout ?? null};
        const offered: IWorkspaceCheckpointTab[] = [];
        for (const directory of unshown) {
            const tab = await unshownTab(directory, target);
            if (tab) offered.push(tab);
            stored.tabs[tab?.tabId ?? directory] = {directory, view: null};
        }
        const reopened = await Promise.all([...workspace.tabs, ...offered].map(tab => claimTab(tab, stored, ownerWebContentsId)));
        // An offered directory whose document did not open, or turned out saved, adds no tab.
        const added = reopened.slice(workspace.tabs.length).filter(tab => tab.workingCopyRef !== null);
        const tabs = [...reopened.slice(0, workspace.tabs.length), ...added];
        for (const {workingCopyRef} of tabs) {
            const entry = workingCopyRef ? getWorkingCopyBackingEntry(workingCopyRef, ownerWebContentsId) : null;
            if (entry) editedDirectories.add(entry.doc.id);
        }
        await writeOwnerCheckpoint(claimantId, ownerWebContentsId, stored);
        for (const [ownerId, candidate] of checkpoints) {
            const taken = ownerId === newest?.ownerId || (candidate !== null && decodeStored(candidate) === null);
            if (taken && ownerId !== claimantId && isClaimable(ownerId, claimantId)) await removeOwnerCheckpoint(ownerId);
        }
        const firstAdded = added[0]?.tabId ?? null;
        const claimed: IWorkspaceCheckpoint = {
            ...workspace,
            activeTabId: workspace.activeTabId ?? firstAdded,
            panes: workspace.panes.map(pane => (pane.paneId === target
                ? {...pane, tabIds: [...pane.tabIds, ...added.map(tab => tab.tabId)], activeTabId: pane.activeTabId ?? firstAdded}
                : pane)),
            tabs,
        };
        claimedInCurrentLoad.add(claimantId);
        restoresInFlight.set(claimantId, getRestoreOpenedDocuments(claimed));
        return claimed;
    });
}

async function claimTab(tab: IWorkspaceCheckpointTab, stored: IStoredCheckpoint, ownerWebContentsId: number): Promise<IWorkspaceCheckpointTab> {
    const keptOriginalPath = tab.sourceRef ? await findKeptOriginal(tab.sourceRef) : undefined;
    const claimed = keptOriginalPath ? {...tab, keptOriginalPath: requireDocumentRef(keptOriginalPath)} : tab;
    const directory = stored.tabs[tab.tabId]?.directory;
    if (!directory || !await holdsUnsavedWork(directory)) return claimed;
    try {
        const entry = await reopenStoredDocument(directory, {
            ownerWebContentsId,
            ...(tab.sourceRef ? {originalPath: tab.sourceRef} : {}),
        });
        const state = entry.doc.state();
        if (!state.dirty) {
            // The work was saved after this checkpoint: the tab reopens its file.
            openDocuments.delete(entry.ref);
            await entry.doc.close();
            return claimed;
        }
        const drafts = isRecord(state.drafts) ? (state.drafts as unknown as IDrafts).annotationRecovery : undefined;
        const {annotationRecovery: _stale, ...rest} = claimed;
        return {
            ...rest,
            isDirty: true,
            workingCopyRef: requireDocumentRef(entry.ref),
            sourceRef: requireDocumentRef(state.destination ?? entry.originalPath ?? tab.sourceRef ?? entry.ref),
            ...(drafts ? {annotationRecovery: {...drafts, workingCopyRef: requireDocumentRef(entry.ref)}} : {}),
            ...(state.damaged ? {workingCopyLost: true as const} : {}),
        };
    } catch (error) {
        log.warn(`Unsaved work of a restored tab is unavailable: ${getErrorMessage(error)}`);
        const {annotationRecovery: _lost, ...rest} = claimed;
        return {...rest, isDirty: false, workingCopyRef: null, workingCopyLost: true};
    }
}

// A restore opens the documents of shown tabs at once. Those without unsaved changes can stay closed without
// losing work; a dirty tab reopens from its working copy and is never closed here.
function getRestoreOpenedDocuments(checkpoint: IWorkspaceCheckpoint) {
    const shownTabIds = new Set(checkpoint.panes.map(pane => pane.activeTabId));
    const tabs = checkpoint.tabs.filter(tab => shownTabIds.has(tab.tabId) && !tab.isDirty
        && (tab.sourceRef !== null || tab.workingCopyRef !== null));
    return {
        tabIds: new Set<string>(tabs.map(tab => tab.tabId)),
        sourceRefs: new Set(tabs.flatMap(tab => (tab.sourceRef === null ? [] : [tab.sourceRef]))),
    };
}

// Keeps those tabs as empty ones, so the next claim restores the rest of the workspace without reopening a document
// that ended the renderer, and names it so the person is told why. The file stays in Recent Files.
async function closeRestoreDocuments(ownerId: string, documents: {tabIds: Set<string>; sourceRefs: Set<string>}) {
    const own = (await readCheckpoints()).get(ownerId);
    if (!own) return;
    const unsaved = await unsavedTabIds(own.stored);
    const notReopened = [...own.checkpoint.notReopened ?? []];
    let closedTabCount = 0;
    const tabs = own.checkpoint.tabs.map((tab): IWorkspaceCheckpointTab => {
        if (unsaved.has(tab.tabId) || !(documents.tabIds.has(tab.tabId) || (tab.sourceRef !== null && documents.sourceRefs.has(tab.sourceRef)))) {
            return tab;
        }
        closedTabCount += 1;
        if (!notReopened.some(document => document.sourceRef === tab.sourceRef && document.fileName === tab.fileName)) {
            notReopened.push({fileName: tab.fileName, sourceRef: tab.sourceRef});
        }
        return {
            tabId: tab.tabId,
            paneId: tab.paneId,
            fileName: null,
            sourceRef: null,
            workingCopyRef: null,
            isDirty: false,
            isDjvu: false,
            currentPage: null,
            zoom: null,
            zoomMode: null,
        };
    });
    if (closedTabCount === 0) return;
    log.warn(`Renderer ended while restoring; ${String(closedTabCount)} document tab(s) will not reopen`);
    const directories = new Map(Object.entries(own.stored.tabs)
        .filter(([tabId]) => tabs.some(tab => tab.tabId === tabId && tab.workingCopyRef !== null))
        .map(([tabId, tab]) => [tabId, tab.directory]));
    await writeOwnerCheckpoint(ownerId, undefined, encodeStored({...own.checkpoint, tabs, notReopened}, directories));
}

/** The renderer finished restoring: a workspace without unsaved work needs no checkpoint until it writes its next one. */
export function acknowledgeWorkspaceCheckpoint(ownerWebContentsId: number, owner?: number | WebContents) {
    const ownerId = getOwnerId(ownerWebContentsId, owner);
    return serialize(async () => {
        if (!claimedInCurrentLoad.has(ownerId)) {
            throw new Error('Workspace checkpoint acknowledgement is not owned by this renderer');
        }
        restoresInFlight.delete(ownerId);
        const own = (await readCheckpoints()).get(ownerId);
        if (own && (await unsavedTabIds(own.stored)).size === 0) {
            await removeOwnerCheckpoint(ownerId);
        }
        return own !== undefined;
    });
}

/** A normal quit: no workspace is restored at the next start. */
export function clearWorkspaceCheckpoint() {
    return serialize(async () => {
        for (const ownerId of (await readWorkspaceCheckpoints(getDocumentStore().port)).keys()) {
            await removeOwnerCheckpoint(ownerId);
        }
        claimedInCurrentLoad.clear();
        restoresInFlight.clear();
    });
}

/** A window closed normally; `resumeWorkspaceCheckpoint` with the returned token undoes it while the window lives. */
export async function discardWorkspaceCheckpoint(ownerWebContentsId: number, owner?: number | WebContents) {
    const ownerId = getOwnerId(ownerWebContentsId, owner);
    const token = String(nextDiscardToken);
    nextDiscardToken += 1;
    discardedOwners.set(ownerId, token);
    restoresInFlight.delete(ownerId);
    try {
        await serialize(() => removeOwnerCheckpoint(ownerId));
    } catch (error) {
        if (discardedOwners.get(ownerId) === token) discardedOwners.delete(ownerId);
        throw error;
    }
    return token;
}

export function resumeWorkspaceCheckpoint(ownerWebContentsId: number, discardToken: string, owner?: number | WebContents) {
    const ownerId = getOwnerId(ownerWebContentsId, owner);
    if (discardedOwners.get(ownerId) !== discardToken) {
        throw new Error('Workspace checkpoint discard token is stale or invalid');
    }
    discardedOwners.delete(ownerId);
}
