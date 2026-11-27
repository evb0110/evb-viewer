import {randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {webContents, type WebContents} from 'electron';
import {decodeManifest, type DocumentDirectory, DOCUMENTS_DIR, isDirty, MANIFEST_NAME} from '@document-store/documentDirectory';
import {
    readWorkspaceCheckpoints,
    removeWorkspaceCheckpoint,
    writeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint as IStoredCheckpoint,
} from '@document-store/workspaceCheckpoint';
import {
    createBlankWorkspaceCheckpointTab as blankTab,
    decodeStoredWorkspaceCheckpoint,
    decodeWorkspaceAnnotationRecovery,
    decodeWorkspaceTabDrafts,
    toStoredWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
    type IWorkspaceCheckpointAnnotationRecovery,
    type IWorkspaceCheckpointTab,
} from '@contracts/workspaceCheckpoint';
import {requireDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import {createPaneId} from '@contracts/editorPanes';
import {createEpochMs} from '@contracts/timestamps';
import {createTabId} from '@contracts/windowTabs';
import {isErrnoException, isRecord} from '@contracts/runtimeGuards';
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
 * Each window's workspace is one checkpoint in the document store: tabs, panes, views and document directories.
 * Unsaved annotations live as document drafts in each manifest and are attached on claim.
 */
type TCheckpointOwnerPhase = 'live' | 'claimed' | 'restoring' | 'discarded';
interface IRestoreInFlight {
    readonly tabIds: Set<string>;
    readonly sourceRefs: Set<string>;
}

interface ICheckpointOwnerRecord {
    phase: TCheckpointOwnerPhase;
    webContents?: WebContents | undefined;
    discardToken?: string | undefined;
    restoreInFlight?: IRestoreInFlight | undefined;
    namedDirectories?: ReadonlySet<string> | undefined;
}

const ownerIdsByWebContents = new WeakMap<WebContents, string>();
const owners = new Map<string, ICheckpointOwnerRecord>();
const editedDocuments = new WeakSet<DocumentDirectory>();
let nextDiscardToken = 1;
let queue: Promise<unknown> = Promise.resolve();

const port = () => getDocumentStore().port;
const readRawCheckpoints = () => readWorkspaceCheckpoints(port());

function serialize<T>(operation: () => Promise<T>) {
    const run = queue.then(operation);
    queue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

const isActiveOwner = (ownerId: string, record?: ICheckpointOwnerRecord): record is ICheckpointOwnerRecord =>
    record !== undefined && owners.get(ownerId) === record && record.phase !== 'discarded' && !record.webContents?.isDestroyed();

function watchOwner(ownerId: string, owner: WebContents, record: ICheckpointOwnerRecord) {
    const stop = onSenderLifetimeEnd(
        owner,
        (end) => {
            const interrupted = record.restoreInFlight;
            record.restoreInFlight = undefined;
            if (record.phase !== 'discarded') {
                record.phase = 'live';
            }
            if (end === 'render-process-gone' && interrupted) {
                void serialize(() => closeRestoreDocuments(ownerId, interrupted)).catch((error: unknown) => {
                    log.warn(`Could not close the documents of a restore that ended the renderer: ${getErrorMessage(error)}`);
                });
            }
            if (end !== 'destroyed') {
                return;
            }
            stop();
            record.webContents = undefined;
            const token = record.discardToken;
            if (record.phase !== 'discarded') {
                owners.delete(ownerId);
            } else {
                void serialize(async () => {
                    if (owners.get(ownerId) === record && record.discardToken === token) {
                        owners.delete(ownerId);
                    }
                });
            }
        },
        {navigation: true},
    );
}

function getOwner(senderId: number, owner?: WebContents, includeDestroyed = false) {
    // A closed window retires under the UUID its checkpoint was written with; never-registered destroyed windows have none.
    const ownerId = owner
        ? (ownerIdsByWebContents.get(owner) ?? (owner.isDestroyed() ? undefined : randomUUID()))
        : `webcontents-${senderId}`;
    if (!ownerId) {
        return {ownerId: undefined, record: undefined};
    }
    let record = owners.get(ownerId);
    if (!record && (includeDestroyed || !owner || !owner.isDestroyed())) {
        const live = owner !== undefined && !owner.isDestroyed();
        if (live) {
            ownerIdsByWebContents.set(owner, ownerId);
        }
        record = {phase: 'live', ...(live ? {webContents: owner} : {})};
        owners.set(ownerId, record);
        if (live) {
            watchOwner(ownerId, owner, record);
        }
    }
    return {ownerId, record};
}

function ownedDocument(ref: TDocumentRef | null | undefined, senderId: number) {
    const entry = ref ? getWorkingCopyBackingEntry(ref, senderId) : null;
    return entry?.ownerWebContentsId === senderId ? entry : null;
}

const decodeStored = (stored: IStoredCheckpoint | null) =>
    stored && isRecord(stored.layout) ? decodeStoredWorkspaceCheckpoint(stored.layout.checkpoint) : null;

async function readOwnerCheckpoint(ownerId: string) {
    const stored = (await readRawCheckpoints()).get(ownerId) ?? null;
    const checkpoint = decodeStored(stored);
    return stored && checkpoint ? {stored, checkpoint} : null;
}

const encodeStored = (checkpoint: IWorkspaceCheckpoint, directories: ReadonlyMap<string, string>): IStoredCheckpoint => ({
    tabs: Object.fromEntries([...directories].map(([tabId, directory]) => [tabId, {directory, view: null}])),
    layout: {checkpoint: toStoredWorkspaceCheckpoint(checkpoint)},
});

async function writeOwnerCheckpoint(ownerId: string, senderId: number | undefined, stored: IStoredCheckpoint) {
    const tabs = {...stored.tabs};
    const named = new Set(Object.values(tabs).map((tab) => tab.directory));
    for (const {doc, ownerWebContentsId: holder} of openDocuments.values()) {
        if (holder === senderId && holder !== undefined && editedDocuments.has(doc) && !named.has(doc.id)) {
            tabs[doc.id] = {directory: doc.id, view: null};
            named.add(doc.id);
        }
    }
    await writeWorkspaceCheckpoint(port(), ownerId, {...stored, tabs});
    const record = owners.get(ownerId);
    if (record) {
        record.namedDirectories = named;
    }
}

async function removeOwnerCheckpoint(ownerId: string) {
    const record = owners.get(ownerId);
    if (record) {
        record.namedDirectories = undefined;
    }
    await removeWorkspaceCheckpoint(port(), ownerId);
}

/** Names `entry`'s directory in its window's checkpoint before its first edit, keeping the stored layout. */
function nameEditedDirectory(entry: IOpenDocument) {
    editedDocuments.add(entry.doc);
    const {ownerWebContentsId: senderId} = entry;
    if (senderId === undefined) {
        return Promise.resolve();
    }
    const {ownerId, record} = getOwner(senderId, webContents.fromId(senderId) ?? undefined);
    if (!ownerId || record?.namedDirectories?.has(entry.doc.id)) {
        return Promise.resolve();
    }
    return serialize(async () => {
        if (owners.get(ownerId)?.phase === 'discarded') {
            return;
        }
        const own = (await readRawCheckpoints()).get(ownerId);
        await writeOwnerCheckpoint(ownerId, senderId, own ?? {tabs: {}, layout: null});
    });
}

setDocumentDirectoryNaming(nameEditedDirectory);

async function holdsUnsavedWork(directory: string, expectedSourceRef?: string | null) {
    try {
        const manifest = decodeManifest(await port().read(`${DOCUMENTS_DIR}/${directory}/${MANIFEST_NAME}`));
        if (isDirty(manifest)) {
            return true;
        }
        return expectedSourceRef != null && manifest.destination !== undefined && manifest.destination !== expectedSourceRef;
    } catch (error) {
        return !(isErrnoException(error) && error.code === 'ENOENT');
    }
}

async function unsavedTabIds(stored: IStoredCheckpoint) {
    const unsaved = new Set<string>();
    for (const [tabId, {directory}] of Object.entries(stored.tabs)) {
        if (await holdsUnsavedWork(directory)) {
            unsaved.add(tabId);
        }
    }
    return unsaved;
}

function isAdmittedOpenPath(sourceRef: TDocumentRef, owner: number | WebContents) {
    try {
        requireOpenPath(sourceRef, owner);
        return true;
    } catch {
        return false;
    }
}

/** Stores this window's tabs, panes and views and the directory each tab shows; resolves once durable. */
export function saveWorkspaceCheckpoint(checkpoint: IWorkspaceCheckpoint, senderId: number, owner?: WebContents) {
    const {ownerId} = getOwner(senderId, owner);
    if (!ownerId) {
        return Promise.resolve(false);
    }
    const admissionOwner = owner ?? senderId;
    // Capture source admission synchronously at IPC entry before a reload navigation clears open-path grants.
    const admittedOpenPath = new Map<TDocumentRef, boolean>();
    const admittedAtEntry = checkpoint.tabs.map((tab) => {
        if (!tab.sourceRef) {
            return false;
        }
        if (tab.sourceRef === ownedDocument(tab.workingCopyRef, senderId)?.originalPath) {
            return true;
        }
        if (!admittedOpenPath.has(tab.sourceRef)) {
            admittedOpenPath.set(tab.sourceRef, isAdmittedOpenPath(tab.sourceRef, admissionOwner));
        }
        return admittedOpenPath.get(tab.sourceRef)!;
    });
    return serialize(async () => {
        if (owners.get(ownerId)?.phase === 'discarded') {
            return false;
        }
        const directories = new Map<string, string>();
        const tabs: IWorkspaceCheckpointTab[] = [];
        for (const [index, tab] of checkpoint.tabs.entries()) {
            const entry = ownedDocument(tab.workingCopyRef, senderId);
            if (tab.workingCopyRef && !entry) {
                throw new Error('Workspace checkpoint contains an unowned working copy');
            }
            if (entry) {
                directories.set(tab.tabId, entry.doc.id);
            }
            const sourceRef =
                tab.sourceRef &&
                (admittedAtEntry[index] || tab.sourceRef === entry?.originalPath || isAdmittedOpenPath(tab.sourceRef, admissionOwner))
                    ? tab.sourceRef
                    : null;
            // Never persist a ghost tab with a dangling file name when it has no working copy and no admitted source.
            tabs.push(
                !entry && sourceRef === null && (tab.sourceRef !== null || tab.fileName !== null || tab.linkedToTabId !== undefined)
                    ? blankTab(tab.tabId, tab.paneId)
                    : {...tab, sourceRef},
            );
            // A generated output a tab shows must outlive the scratch sweep until the tab is gone.
            if (sourceRef) {
                void touchScanCleanupGeneratedOutput(sourceRef).catch(() => undefined);
            }
        }
        await writeOwnerCheckpoint(ownerId, senderId, encodeStored({...checkpoint, tabs}, directories));
        return true;
    });
}

/** Commits a document's drafts for their revision, or clears them without a payload; false for an outdated revision. */
export async function setWorkspaceDocumentDrafts(drafts: IWorkspaceCheckpointAnnotationRecovery, senderId: number) {
    const entry = ownedDocument(drafts.workingCopyRef, senderId);
    if (!entry) {
        throw new Error('Drafts of an unowned working copy');
    }
    // A damaged document's directory waits for a start that reads it.
    if (entry.doc.damaged) {
        return true;
    }
    const storedDrafts = entry.doc.state().drafts;
    // Unrecognized persisted drafts stay on disk untouched: refuse clears and overwrites so commitDrafts blocks destructive edits.
    if (
        storedDrafts !== undefined &&
        !decodeWorkspaceAnnotationRecovery(isRecord(storedDrafts) ? storedDrafts.annotationRecovery : undefined).success
    ) {
        return false;
    }
    if (drafts.payload === undefined && storedDrafts === undefined) {
        return true;
    }
    if (drafts.payload !== undefined) {
        await nameEditedDirectory(entry);
    }
    const status = await setOpenDocumentDrafts(
        entry,
        drafts.workingByteRevision,
        drafts.payload === undefined ? undefined : {annotationRecovery: drafts},
    );
    if (status === 'conflict') {
        throw new Error('Drafts were not stored');
    }
    return status === 'stored';
}

/** Drains queued checkpoint writes for the shutdown order. */
export const flushPendingWorkspaceCheckpointSave = () => serialize(() => Promise.resolve());

function isClaimable(ownerId: string, claimantId: string, allowSelfClaim?: boolean) {
    const record = owners.get(ownerId);
    if (record?.phase === 'discarded') {
        return false;
    }
    if (ownerId === claimantId) {
        return allowSelfClaim ?? (record?.phase !== 'claimed' && record?.phase !== 'restoring');
    }
    return !record?.webContents || record.webContents.isDestroyed();
}

async function unshownUnsavedDirectories(checkpoints: ReadonlyMap<string, IStoredCheckpoint | null>) {
    const shown = new Set<string>();
    for (const stored of checkpoints.values()) {
        for (const tab of decodeStored(stored)?.tabs ?? []) {
            const directory = stored?.tabs[tab.tabId]?.directory;
            if (directory) {
                shown.add(directory);
            }
        }
    }
    return (await unheldUnsavedDocuments()).filter((directory) => !shown.has(directory));
}

async function unshownTab(directory: string, paneId: IWorkspaceCheckpointTab['paneId']): Promise<IWorkspaceCheckpointTab | null> {
    const path = `${DOCUMENTS_DIR}/${directory}/${MANIFEST_NAME}`;
    const manifest = await port()
        .read(path)
        .then(decodeManifest)
        .catch((error: unknown) => {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return null;
            }
            log.warn(`Unsaved work no workspace shows cannot be read: ${path}: ${getErrorMessage(error)}`);
            return undefined;
        });
    if (manifest === null || (manifest && manifest.ext !== 'pdf')) {
        return null;
    }
    const destination = manifest?.destination;
    return {
        ...blankTab(createTabId(), paneId),
        fileName: destination === undefined ? 'Recovered document.pdf' : basename(destination),
        sourceRef: destination === undefined ? null : requireDocumentRef(destination),
        ...(destination === undefined ? {requiresSaveAsOnFirstSave: true} : {}),
        isDirty: true,
    };
}

export function hasRecoverableWorkspaceCheckpoints(senderId: number, owner?: WebContents) {
    const {ownerId: claimantId, record: claimant} = getOwner(senderId, owner);
    return serialize(async () => {
        if (!claimantId || !isActiveOwner(claimantId, claimant)) {
            return false;
        }
        const checkpoints = await readRawCheckpoints();
        return (
            [...checkpoints].some(([ownerId, stored]) => decodeStored(stored) !== null && isClaimable(ownerId, claimantId)) ||
            (await unshownUnsavedDirectories(checkpoints)).length > 0
        );
    });
}

async function releaseDocument(ref: string) {
    const entry = openDocuments.get(ref);
    if (!entry) {
        return;
    }
    openDocuments.delete(ref);
    await entry.doc.close();
}

/**
 * Hands the newest claimable checkpoint to this window (its own after a reload, or an orphaned one), reopening
 * dirty documents and offering any unshown unsaved directories as tabs.
 */
export function claimWorkspaceCheckpoint(senderId: number, owner?: WebContents) {
    const {ownerId: claimantId, record: claimant} = getOwner(senderId, owner);
    return serialize(async () => {
        if (!claimantId || !isActiveOwner(claimantId, claimant)) {
            return null;
        }
        const previousPhase = claimant.phase;
        const canSelfClaim = previousPhase === 'live';
        if (canSelfClaim) {
            claimant.phase = 'restoring';
        }
        let settled = false;
        let wroteClaimant = false;
        let newest: {ownerId: string; stored: IStoredCheckpoint; checkpoint: IWorkspaceCheckpoint} | null = null;
        let priorClaimant: IStoredCheckpoint | null = null;
        const priorOwners = new Map([...openDocuments].map(([ref, entry]) => [ref, entry.ownerWebContentsId]));
        const touchedRefs = new Set<string>();
        const removedOwners: Array<readonly [string, IStoredCheckpoint]> = [];
        const abort = async () => {
            for (const [id, candidate] of removedOwners) {
                await writeWorkspaceCheckpoint(port(), id, candidate).catch(() => undefined);
            }
            if (wroteClaimant && newest?.ownerId !== claimantId) {
                claimant.namedDirectories = undefined;
                await (
                    priorClaimant ? writeWorkspaceCheckpoint(port(), claimantId, priorClaimant) : removeOwnerCheckpoint(claimantId)
                ).catch(() => undefined);
            }
            for (const ref of touchedRefs) {
                const entry = openDocuments.get(ref);
                if (!entry) {
                    continue;
                }
                const prior = priorOwners.get(ref);
                if (!priorOwners.has(ref)) {
                    await releaseDocument(ref);
                } else if (prior === undefined) {
                    delete entry.ownerWebContentsId;
                } else {
                    entry.ownerWebContentsId = prior;
                }
            }
            return null;
        };
        try {
            const checkpoints = await readRawCheckpoints();
            priorClaimant = checkpoints.get(claimantId) ?? null;
            for (const [ownerId, stored] of checkpoints) {
                const checkpoint = decodeStored(stored);
                if (
                    stored &&
                    checkpoint &&
                    isClaimable(ownerId, claimantId, canSelfClaim) &&
                    (!newest || checkpoint.capturedAt > newest.checkpoint.capturedAt)
                ) {
                    newest = {ownerId, stored, checkpoint};
                }
            }
            const unshown = await unshownUnsavedDirectories(checkpoints);
            if ((!newest && unshown.length === 0) || !isActiveOwner(claimantId, claimant)) {
                return null;
            }
            const paneId = createPaneId();
            const workspace: IWorkspaceCheckpoint = newest?.checkpoint ?? {
                version: 1,
                capturedAt: createEpochMs(),
                activePaneId: paneId,
                activeTabId: null,
                layout: {type: 'leaf', paneId},
                panes: [{paneId, tabIds: [], activeTabId: null}],
                tabs: [],
            };
            const target = workspace.activePaneId ?? workspace.panes[0]?.paneId ?? paneId;
            const stored = {tabs: {...newest?.stored.tabs}, layout: newest?.stored.layout ?? null};
            const offered: IWorkspaceCheckpointTab[] = [];
            for (const directory of unshown) {
                const tab = await unshownTab(directory, target);
                if (tab) {
                    offered.push(tab);
                }
                stored.tabs[tab?.tabId ?? directory] = {directory, view: null};
            }
            if (!isActiveOwner(claimantId, claimant)) {
                return null;
            }
            const results = await Promise.allSettled(
                [...workspace.tabs, ...offered].map((tab) => claimTab(tab, stored, senderId, touchedRefs)),
            );
            const reopened: IWorkspaceCheckpointTab[] = [];
            for (const result of results) {
                if (result.status === 'rejected') {
                    throw result.reason;
                }
                reopened.push(result.value);
            }
            if (!isActiveOwner(claimantId, claimant)) {
                return abort();
            }
            const added = reopened.slice(workspace.tabs.length).filter((tab) => tab.workingCopyRef !== null || tab.workingCopyLost);
            const tabs = [...reopened.slice(0, workspace.tabs.length), ...added];
            for (const {workingCopyRef} of tabs) {
                const entry = ownedDocument(workingCopyRef, senderId);
                if (entry) {
                    editedDocuments.add(entry.doc);
                }
            }
            await writeOwnerCheckpoint(claimantId, senderId, stored);
            wroteClaimant = true;
            for (const [ownerId, candidate] of checkpoints) {
                if (!isActiveOwner(claimantId, claimant)) {
                    return abort();
                }
                const taken = ownerId === newest?.ownerId || (candidate !== null && decodeStored(candidate) === null);
                if (taken && ownerId !== claimantId && isClaimable(ownerId, claimantId)) {
                    await removeOwnerCheckpoint(ownerId);
                    if (candidate) {
                        removedOwners.push([ownerId, candidate]);
                    }
                }
            }
            if (!isActiveOwner(claimantId, claimant)) {
                return abort();
            }
            const firstAdded = added[0]?.tabId ?? null;
            const claimed: IWorkspaceCheckpoint = {
                ...workspace,
                activeTabId: workspace.activeTabId ?? firstAdded,
                panes: workspace.panes.map((pane) =>
                    pane.paneId === target
                        ? {...pane, tabIds: [...pane.tabIds, ...added.map((tab) => tab.tabId)], activeTabId: pane.activeTabId ?? firstAdded}
                        : pane,
                ),
                tabs,
            };
            settled = true;
            if (claimant.phase === (canSelfClaim ? 'restoring' : previousPhase)) {
                claimant.phase = 'restoring';
                claimant.restoreInFlight = getRestoreOpenedDocuments(claimed);
            }
            return claimed;
        } catch (error) {
            await abort();
            throw error;
        } finally {
            if (!settled && canSelfClaim && claimant.phase === 'restoring') {
                claimant.phase = 'live';
            }
        }
    });
}

async function claimTab(tab: IWorkspaceCheckpointTab, stored: IStoredCheckpoint, senderId: number, touchedRefs: Set<string>) {
    const claimed = await reopenTab(tab, stored, senderId, touchedRefs);
    const kept = claimed.sourceRef ? await findKeptOriginal(claimed.sourceRef) : undefined;
    return kept ? {...claimed, keptOriginalPath: requireDocumentRef(kept)} : claimed;
}

async function reopenTab(
    tab: IWorkspaceCheckpointTab,
    stored: IStoredCheckpoint,
    senderId: number,
    touchedRefs: Set<string>,
): Promise<IWorkspaceCheckpointTab> {
    const directory = stored.tabs[tab.tabId]?.directory;
    if (!directory || !(await holdsUnsavedWork(directory, tab.sourceRef))) {
        return tab;
    }
    const {annotationRecovery: _stale, annotationRecoveryInvalid: _staleInvalid, ...rest} = tab;
    try {
        const entry = await reopenStoredDocument(directory, {
            ownerWebContentsId: senderId,
            ...(tab.sourceRef ? {originalPath: tab.sourceRef} : {}),
        });
        touchedRefs.add(entry.ref);
        const state = entry.doc.state();
        if (!state.dirty) {
            await releaseDocument(entry.ref);
            if (state.destination && state.destination !== tab.sourceRef) {
                return {
                    ...rest,
                    isDirty: false,
                    workingCopyRef: null,
                    sourceRef: requireDocumentRef(state.destination),
                    fileName: basename(state.destination),
                };
            }
            return tab;
        }
        const ref = requireDocumentRef(entry.ref);
        const rawDrafts =
            state.drafts === undefined
                ? undefined
                : isRecord(state.drafts) && state.drafts.annotationRecovery !== undefined
                  ? state.drafts.annotationRecovery
                  : null;
        const draftFields = decodeWorkspaceTabDrafts(
            rawDrafts,
            (issue) =>
                log.warn(
                    `Ignored malformed persisted workspace drafts in ${DOCUMENTS_DIR}/${directory}; kept reopened document and draft file on disk: ${issue}`,
                ),
            ref,
        );
        return {
            ...rest,
            isDirty: true,
            workingCopyRef: ref,
            sourceRef: requireDocumentRef(state.destination ?? entry.originalPath ?? tab.sourceRef ?? entry.ref),
            ...draftFields,
            ...(state.damaged ? {workingCopyLost: true as const} : {}),
        };
    } catch (error) {
        log.warn(`Unsaved work of a restored tab is unavailable: ${getErrorMessage(error)}`);
        return {...rest, isDirty: false, workingCopyRef: null, workingCopyLost: true};
    }
}

function getRestoreOpenedDocuments(checkpoint: IWorkspaceCheckpoint) {
    const shown = new Set(checkpoint.panes.map((pane) => pane.activeTabId));
    const tabs = checkpoint.tabs.filter(
        (tab) => shown.has(tab.tabId) && !tab.isDirty && (tab.sourceRef !== null || tab.workingCopyRef !== null),
    );
    return {
        tabIds: new Set<string>(tabs.map((tab) => tab.tabId)),
        sourceRefs: new Set(tabs.flatMap((tab) => (tab.sourceRef === null ? [] : [tab.sourceRef]))),
    };
}

async function closeRestoreDocuments(ownerId: string, documents: IRestoreInFlight) {
    if (owners.get(ownerId)?.phase === 'discarded') {
        return;
    }
    const own = await readOwnerCheckpoint(ownerId);
    if (!own) {
        return;
    }
    const unsaved = await unsavedTabIds(own.stored);
    const notReopened = [...(own.checkpoint.notReopened ?? [])];
    let closedTabCount = 0;
    const tabs = own.checkpoint.tabs.map((tab) => {
        if (
            unsaved.has(tab.tabId) ||
            !(documents.tabIds.has(tab.tabId) || (tab.sourceRef !== null && documents.sourceRefs.has(tab.sourceRef)))
        ) {
            return tab;
        }
        closedTabCount += 1;
        if (!notReopened.some((doc) => doc.sourceRef === tab.sourceRef && doc.fileName === tab.fileName)) {
            notReopened.push({fileName: tab.fileName, sourceRef: tab.sourceRef});
        }
        return blankTab(tab.tabId, tab.paneId);
    });
    if (closedTabCount === 0) {
        return;
    }
    log.warn(`Renderer ended while restoring; ${String(closedTabCount)} document tab(s) will not reopen`);
    const directories = new Map(
        Object.entries(own.stored.tabs)
            .filter(([tabId]) => tabs.some((tab) => tab.tabId === tabId && tab.workingCopyRef !== null))
            .map(([tabId, tab]) => [tabId, tab.directory]),
    );
    await writeOwnerCheckpoint(ownerId, undefined, encodeStored({...own.checkpoint, tabs, notReopened}, directories));
}

/** The renderer finished restoring: a workspace without unsaved work needs no checkpoint until its next save. */
export function acknowledgeWorkspaceCheckpoint(senderId: number, owner?: WebContents) {
    const {ownerId, record} = getOwner(senderId, owner);
    return serialize(async () => {
        if (!ownerId || !record || (record.phase !== 'restoring' && record.phase !== 'claimed')) {
            throw new Error('Workspace checkpoint acknowledgement is not owned by this renderer');
        }
        record.phase = 'claimed';
        record.restoreInFlight = undefined;
        const own = await readOwnerCheckpoint(ownerId);
        if (own && (await unsavedTabIds(own.stored)).size === 0) {
            await removeOwnerCheckpoint(ownerId);
        }
        return own !== null;
    });
}

/** Clears checkpoints on normal quit. */
export function clearWorkspaceCheckpoint() {
    return serialize(async () => {
        for (const ownerId of (await readRawCheckpoints()).keys()) {
            await removeOwnerCheckpoint(ownerId);
        }
        for (const [ownerId, record] of [...owners]) {
            record.restoreInFlight = undefined;
            record.namedDirectories = undefined;
            if (record.phase !== 'discarded') {
                record.phase = 'live';
            }
            if (record.webContents?.isDestroyed()) {
                owners.delete(ownerId);
            }
        }
    });
}

/** A window closed normally; `resumeWorkspaceCheckpoint` with the returned token undoes it while the window lives. */
export async function discardWorkspaceCheckpoint(senderId: number, owner?: WebContents) {
    const token = String(nextDiscardToken++);
    const {ownerId, record} = getOwner(senderId, owner, true);
    if (!ownerId || !record) {
        return token;
    }
    const previousPhase = record.phase === 'restoring' ? (record.restoreInFlight ? 'claimed' : 'live') : record.phase;
    const previousToken = record.discardToken;
    record.phase = 'discarded';
    record.discardToken = token;
    record.restoreInFlight = undefined;
    try {
        await serialize(() => removeOwnerCheckpoint(ownerId));
    } catch (error) {
        if (record.phase === 'discarded' && record.discardToken === token) {
            record.phase = previousPhase;
            record.discardToken = previousToken;
        }
        throw error;
    } finally {
        if (
            owner !== undefined &&
            (!record.webContents || record.webContents.isDestroyed()) &&
            owners.get(ownerId) === record &&
            (record.discardToken === token || record.phase !== 'discarded')
        ) {
            owners.delete(ownerId);
        }
    }
    return token;
}

export function resumeWorkspaceCheckpoint(senderId: number, discardToken: string, owner?: WebContents) {
    const {record} = getOwner(senderId, owner);
    if (!record || record.phase !== 'discarded' || record.discardToken !== discardToken) {
        throw new Error('Workspace checkpoint discard token is stale or invalid');
    }
    record.phase = 'live';
    record.discardToken = undefined;
}
