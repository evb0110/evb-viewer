import {randomUUID} from 'node:crypto';
import {webContents} from 'electron';
import type {WebContents} from 'electron';
import {
    readWorkspaceCheckpoints,
    removeWorkspaceCheckpoint,
    writeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint as IStoredCheckpoint,
} from '@document-store/workspaceCheckpoint';
import {
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointAnnotationRecovery,
    type IWorkspaceCheckpointTab,
} from '@contracts/workspaceCheckpoint';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {isRecord} from '@contracts/runtimeGuards';
import {
    getDocumentStore,
    getWorkingCopyBackingEntry,
    openDocuments,
    reopenStoredDocument,
    setOpenDocumentDrafts,
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
 * each tab the document directory it shows. Unsaved annotations are not copied here; they are the drafts of their
 * document, committed with its manifest. Registrations, grants and dirty state come from the manifests.
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
    return stored && isRecord(stored.layout) ? decodeWorkspaceCheckpoint(stored.layout.checkpoint) : null;
}

function encodeStored(checkpoint: IWorkspaceCheckpoint, directories: ReadonlyMap<string, string>): IStoredCheckpoint {
    return {
        tabs: Object.fromEntries([...directories].map(([tabId, directory]) => [tabId, {directory, view: null}])),
        layout: {checkpoint},
    };
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

function stripPayload(recovery: IWorkspaceCheckpointAnnotationRecovery) {
    const {payload: _payload, ...ref} = recovery;
    return ref;
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

/**
 * Stores this window's workspace: each tab's unsaved annotations become the drafts of its document, bound to the
 * revision they were captured on, and the checkpoint keeps references. Resolves once both are durable; a capture
 * for a revision that is no longer current is refused, since its drafts could not be replayed. A damaged document
 * takes no drafts: its directory stays as it is for a start that can read it.
 */
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
            if (entry) {
                directories.set(tab.tabId, entry.doc.id);
                const recovery = tab.annotationRecovery;
                if (recovery?.payload !== undefined && !entry.doc.damaged) {
                    const drafts: IDrafts = {annotationRecovery: recovery};
                    const status = await setOpenDocumentDrafts(entry, recovery.workingByteRevision, drafts);
                    if (status !== 'stored') throw new Error(`Unsaved annotations for an outdated revision were not stored (${status})`);
                } else if (!tab.isDirty && entry.doc.state().drafts !== undefined) {
                    await setOpenDocumentDrafts(entry, null, undefined);
                }
            }
            const sourceRef = tab.sourceRef && isAdmittedSource(tab.sourceRef, owner, entry?.originalPath) ? tab.sourceRef : null;
            tabs.push({
                ...tab,
                sourceRef,
                ...(tab.annotationRecovery ? {annotationRecovery: stripPayload(tab.annotationRecovery)} : {}),
            });
            // A generated output a tab shows must outlive the scratch sweep until the tab is gone.
            if (sourceRef) void touchScanCleanupGeneratedOutput(sourceRef).catch(() => undefined);
        }
        await writeWorkspaceCheckpoint(getDocumentStore().port, ownerId, encodeStored({...checkpoint, tabs}, directories));
        return true;
    });
}

/** Writes nothing: every save is written before it resolves. Kept for the shutdown order. */
export function flushPendingWorkspaceCheckpointSave() {
    return serialize(() => Promise.resolve());
}

function isClaimable(ownerId: string, claimantId: string) {
    if (discardedOwners.has(ownerId)) return false;
    return ownerId === claimantId ? !claimedInCurrentLoad.has(claimantId) : !isLiveOwner(ownerId);
}

export function hasRecoverableWorkspaceCheckpoints(ownerWebContentsId: number, owner?: number | WebContents) {
    const claimantId = getOwnerId(ownerWebContentsId, owner);
    return serialize(async () => [...(await readCheckpoints()).keys()].some(ownerId => isClaimable(ownerId, claimantId)));
}

/**
 * Hands the newest checkpoint this window may take to it: its own after a reload, or one whose window is gone. Each
 * dirty tab's document reopens through the store's recovery and is registered to this window, with its drafts as
 * the tab's annotation recovery. A damaged document shows its file as last saved, stays unsaved and says its work
 * was not found, which a later start that can read it recovers; a tab whose document cannot be opened reopens its source.
 */
export function claimWorkspaceCheckpoint(ownerWebContentsId: number, owner?: number | WebContents) {
    const claimantId = getOwnerId(ownerWebContentsId, owner);
    return serialize(async () => {
        let newest: {ownerId: string; stored: IStoredCheckpoint; checkpoint: IWorkspaceCheckpoint} | null = null;
        for (const [ownerId, candidate] of await readCheckpoints()) {
            if (isClaimable(ownerId, claimantId) && (!newest || candidate.checkpoint.capturedAt > newest.checkpoint.capturedAt)) {
                newest = {ownerId, ...candidate};
            }
        }
        if (!newest) return null;
        const tabs = await Promise.all(newest.checkpoint.tabs.map(tab => claimTab(tab, newest.stored, ownerWebContentsId)));
        if (newest.ownerId !== claimantId) {
            await writeWorkspaceCheckpoint(getDocumentStore().port, claimantId, newest.stored);
            await removeWorkspaceCheckpoint(getDocumentStore().port, newest.ownerId);
        }
        claimedInCurrentLoad.add(claimantId);
        restoresInFlight.set(claimantId, getRestoreOpenedDocuments(newest.checkpoint));
        return {...newest.checkpoint, tabs};
    });
}

async function claimTab(tab: IWorkspaceCheckpointTab, stored: IStoredCheckpoint, ownerWebContentsId: number): Promise<IWorkspaceCheckpointTab> {
    const keptOriginalPath = tab.sourceRef ? await findKeptOriginal(tab.sourceRef) : undefined;
    const claimed = keptOriginalPath ? {...tab, keptOriginalPath: requireDocumentRef(keptOriginalPath)} : tab;
    const directory = stored.tabs[tab.tabId]?.directory;
    if (!tab.isDirty || !directory) return claimed;
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
            return {...claimed, isDirty: false};
        }
        const drafts = isRecord(state.drafts) ? (state.drafts as unknown as IDrafts).annotationRecovery : undefined;
        const {annotationRecovery: _stale, ...rest} = claimed;
        return {
            ...rest,
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
    const notReopened = [...own.checkpoint.notReopened ?? []];
    let closedTabCount = 0;
    const tabs = own.checkpoint.tabs.map((tab): IWorkspaceCheckpointTab => {
        if (tab.isDirty || !(documents.tabIds.has(tab.tabId) || (tab.sourceRef !== null && documents.sourceRefs.has(tab.sourceRef)))) {
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
    await writeWorkspaceCheckpoint(getDocumentStore().port, ownerId, encodeStored({...own.checkpoint, tabs, notReopened}, directories));
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
        if (own && !own.checkpoint.tabs.some(tab => tab.isDirty)) {
            await removeWorkspaceCheckpoint(getDocumentStore().port, ownerId);
        }
        return own !== undefined;
    });
}

/** A normal quit: no workspace is restored at the next start. */
export function clearWorkspaceCheckpoint() {
    return serialize(async () => {
        for (const ownerId of (await readWorkspaceCheckpoints(getDocumentStore().port)).keys()) {
            await removeWorkspaceCheckpoint(getDocumentStore().port, ownerId);
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
        await serialize(() => removeWorkspaceCheckpoint(getDocumentStore().port, ownerId));
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
