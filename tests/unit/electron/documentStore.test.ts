import {existsSync} from 'node:fs';
import {
    chmod,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {requirePaneId} from '@contracts/editorPanes';
import {requireEpochMs} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import type {IWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

let tempRoot = '';

vi.mock('electron', () => ({
    app: {getPath: vi.fn(() => tempRoot)},
    webContents: {fromId: vi.fn(() => undefined)},
}));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => ({touchScanCleanupGeneratedOutput: vi.fn(async () => undefined)}));

const store = await import('@electron/file-access/documentStore');
const checkpoints = await import('@electron/workspaceCheckpointStore');
const {findKeptOriginal} = await import('@electron/file-access/keptOriginalNotices');
const {registerMainOperation} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
const {handleFileReadRange} = await import('@electron/features/documents/main/documentFileReadHandlers');
const {clearWorkingCopyQuarantinesForTests, quarantineWorkingCopy} = await import('@electron/file-access/workingCopyQuarantine');

const ORIGINAL = new TextEncoder().encode('%PDF-1.7\noriginal bytes\n%%EOF\n');
const EDITED = new TextEncoder().encode('%PDF-1.7\nedited bytes\n%%EOF\n');

async function writeTemp(name: string, bytes: Uint8Array) {
    const path = join(tempRoot, name);
    await writeFile(path, bytes);
    return path;
}

async function openPdf(owner = 7) {
    const pdf = await writeTemp('report.pdf', ORIGINAL);
    const entry = await store.openDocumentFromFile(pdf, {ownerWebContentsId: owner});
    return {pdf, entry};
}

async function readAll(entry: Awaited<ReturnType<typeof store.openDocumentFromFile>>) {
    return store.readOpenDocument(entry, 0, store.statOpenDocument(entry).size);
}

/** A restart: the store's registry is gone, the disk stays. */
function restart() {
    return store.setDocumentStoreRootForTests(join(tempRoot, 'store'));
}

const displaced = (pdf: string) => join(dirname(pdf), `.${basename(pdf)}.evb-replaced`);

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return {promise, resolve};
}

/** Leaves the document as a crash during its Save's publish would: the witness about to be published is recorded. */
/**
 * A Save that crashed after staging its publish: the edits are committed and the copy that would replace the PDF lies
 * beside it, its metadata staged as `pendingPublish`, as Save stages it. Returns that copy, which a test renames over
 * the PDF to model a replace that finished.
 */
async function crashDuringPublish(entry: Awaited<ReturnType<typeof store.openDocumentFromFile>>, edited: string) {
    await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: edited}, 'write');
    const {doc} = entry;
    const destination = doc.state().destination!;
    const copy = join(dirname(destination), '.publishing.tmp');
    await writeFile(copy, await readAll(entry));
    const witness = (await doc.store.publication.witness(copy))!;
    await doc.run(async () => {
        const current = (await doc.ensureCurrent())!;
        await doc.commit({...doc.snapshot(), current: {...current, witness}, pendingPublish: {destination, witness}});
    });
    return copy;
}

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'evb-document-store-'));
    await store.setDocumentStoreRootForTests(join(tempRoot, 'store'));
});

afterEach(async () => {
    clearWorkingCopyQuarantinesForTests();
    await store.setDocumentStoreRootForTests(null);
    await rm(tempRoot, {recursive: true, force: true});
});

describe('desktop document store', () => {
    it('opens a PDF without copying or reading it, and reads the PDF itself', async () => {
        const pdf = await writeTemp('report.pdf', ORIGINAL);
        // Opening reads the file's metadata only, so a PDF no one may read still opens.
        await chmod(pdf, 0o200);
        const entry = await store.openDocumentFromFile(pdf, {ownerWebContentsId: 7});
        await chmod(pdf, 0o600);

        expect(await readAll(entry)).toEqual(ORIGINAL);
        expect(entry.doc.state()).toMatchObject({current: null, dirty: false});
        expect((await readdir(dirname(entry.ref))).filter(name => name.startsWith('r'))).toEqual([]);
    });

    it('keeps an edit in the working copy and leaves the PDF alone until Save', async () => {
        const {pdf, entry} = await openPdf();
        const edited = await writeTemp('edited.pdf', EDITED);

        const event = await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: edited}, 'write');

        expect(event.token).not.toBe(event.previousToken);
        expect(await readAll(entry)).toEqual(EDITED);
        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
        expect(entry.doc.state().dirty).toBe(true);
    });

    it('saves by committing, checking, publishing and acknowledging, leaving nothing beside the PDF', async () => {
        const {pdf, entry} = await openPdf();
        const edited = await writeTemp('edited.pdf', EDITED);

        const result = await store.saveOpenDocument(entry, '1' as never, {commit: {kind: 'rewrite', source: edited}});

        expect(result).toMatchObject({status: 'saved'});
        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(entry.doc.state()).toMatchObject({dirty: false, destination: pdf});
        expect((await readdir(dirname(pdf))).filter(name => name.includes('report'))).toEqual(['report.pdf']);
    });

    it('refuses a Save when the PDF changed elsewhere, keeping both the outside bytes and the work', async () => {
        const {pdf, entry} = await openPdf();
        const edited = await writeTemp('edited.pdf', EDITED);
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: edited}, 'write');
        const outside = new TextEncoder().encode('%PDF-1.7\nchanged by another program\n%%EOF\n');
        await writeFile(pdf, outside);

        const result = await store.saveOpenDocument(entry, store.documentRevisionToken(entry));

        expect(result).toEqual({status: 'conflict'});
        expect(await readFile(pdf)).toEqual(Buffer.from(outside));
        expect(await readAll(entry)).toEqual(EDITED);
        expect(existsSync(displaced(pdf))).toBe(false);
    });

    it('refuses a Save when another program put a file of the same size and modification time in place of the PDF', async () => {
        const pdf = await writeTemp('report.pdf', ORIGINAL);
        await utimes(pdf, 1_700_000_000, 1_700_000_000);
        const entry = await store.openDocumentFromFile(pdf, {ownerWebContentsId: 7});
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}, 'write');
        const foreign = new TextEncoder().encode('%PDF-1.7\nforeign! bytes\n%%EOF\n');
        const replacement = await writeTemp('replacement.pdf', foreign);
        await utimes(replacement, 1_700_000_000, 1_700_000_000);
        const before = await stat(pdf, {bigint: true});
        await rename(replacement, pdf);
        const after = await stat(pdf, {bigint: true});
        expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);

        expect(await store.saveOpenDocument(entry, store.documentRevisionToken(entry))).toEqual({status: 'conflict'});
        expect(await readFile(pdf)).toEqual(Buffer.from(foreign));
        expect(await readAll(entry)).toEqual(EDITED);
    });

    it('commits the edits a refused Save carried and tells every window, so Save As publishes them elsewhere', async () => {
        const {pdf, entry} = await openPdf();
        const edited = await writeTemp('edited.pdf', EDITED);
        // Unsaved annotations give the document its own copy of the PDF as the person saw it.
        await store.setOpenDocumentDrafts(entry, '1', {annotationRecovery: {}});
        await writeFile(pdf, new TextEncoder().encode('%PDF-1.7\nchanged elsewhere\n%%EOF\n'));
        const events: string[] = [];
        const stop = store.onDocumentRevisionChanged(event => events.push(event.token));

        expect(await store.saveOpenDocument(entry, '1' as never, {commit: {kind: 'rewrite', source: edited}})).toEqual({status: 'conflict'});
        stop();
        const committed = store.documentRevisionToken(entry);
        expect(events).toEqual([committed]);
        expect(entry.doc.state()).toMatchObject({dirty: true, drafts: undefined});
        const elsewhere = join(tempRoot, 'elsewhere.pdf');
        expect(await store.saveOpenDocument(entry, committed, {saveAs: elsewhere})).toMatchObject({status: 'saved'});
        expect(await readFile(elsewhere)).toEqual(Buffer.from(EDITED));
    });

    it.each([false, true])('undoes to the PDF as opened after a Save and a restart (Save As: %s)', async (saveAs) => {
        const {pdf, entry} = await openPdf();
        await store.rewriteDocument(entry, async (_input, output) => writeFile(output, EDITED), 'page-ops');
        await store.retainOpenDocumentRevisions(entry, ['1' as never]);
        const copy = join(tempRoot, 'copy.pdf');
        expect(await store.saveOpenDocument(entry, store.documentRevisionToken(entry), saveAs ? {saveAs: copy} : {})).toMatchObject({status: 'saved'});
        expect(await readFile(saveAs ? copy : pdf)).toEqual(Buffer.from(EDITED));
        const id = entry.doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {ownerWebContentsId: 7});
        await store.restoreOpenDocumentRevision(reopened, '1' as never, store.documentRevisionToken(reopened));
        expect(await readAll(reopened)).toEqual(ORIGINAL);
    });

    it('refuses a Save as a stale revision without writing anything', async () => {
        const {pdf, entry} = await openPdf();
        const edited = await writeTemp('edited.pdf', EDITED);
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: edited}, 'write');

        expect(await store.saveOpenDocument(entry, '1' as never)).toMatchObject({status: 'stale-revision'});
        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
    });

    it('puts the PDF back when a crash left it displaced and the new bytes not yet installed', async () => {
        const {pdf, entry} = await openPdf();
        await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        await rename(pdf, displaced(pdf));
        const id = entry.doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {ownerWebContentsId: 8});

        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
        expect(existsSync(displaced(pdf))).toBe(false);
        expect(reopened.doc.state().dirty).toBe(true);
        expect(await readAll(reopened)).toEqual(EDITED);
    });

    it('keeps a save that finished installing before the crash and acknowledges it', async () => {
        const {pdf, entry} = await openPdf();
        const copy = await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        await rename(pdf, displaced(pdf));
        await rename(copy, pdf);
        const id = entry.doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {});

        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(existsSync(displaced(pdf))).toBe(false);
        expect(reopened.doc.state().dirty).toBe(false);
        expect(await findKeptOriginal(pdf)).toBeUndefined();
    });

    it('keeps bytes another program wrote before a crashed save displaced them, and names them on the next open', async () => {
        const {pdf, entry} = await openPdf();
        const copy = await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        const outside = new TextEncoder().encode('%PDF-1.7\nwritten elsewhere\n%%EOF\n');
        await writeFile(pdf, outside);
        await rename(pdf, displaced(pdf));
        await rename(copy, pdf);
        const id = entry.doc.id;
        await restart();

        await store.reopenStoredDocument(id, {});

        const kept = join(dirname(pdf), 'report (original).pdf');
        expect(await readFile(kept)).toEqual(Buffer.from(outside));
        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(await findKeptOriginal(pdf)).toBe(kept);
    });

    it('keeps the original beside the PDF when another program changed it after a crashed save installed its bytes', async () => {
        const {pdf, entry} = await openPdf();
        await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        await rename(pdf, displaced(pdf));
        const outside = new TextEncoder().encode(`${new TextDecoder().decode(EDITED)}% appended elsewhere\n`);
        await writeFile(pdf, outside);
        const id = entry.doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {});

        const kept = join(dirname(pdf), 'report (original).pdf');
        expect(await readFile(kept)).toEqual(Buffer.from(ORIGINAL));
        expect(await readFile(pdf)).toEqual(Buffer.from(outside));
        expect(await findKeptOriginal(pdf)).toBe(kept);
        expect(reopened.doc.state().dirty).toBe(true);
        expect(await readAll(reopened)).toEqual(EDITED);
    });

    it.each([true, false])('settles an interrupted Save before a Save As elsewhere, or keeps it to settle later (PDF readable: %s)', async (readable) => {
        const {pdf, entry} = await openPdf();
        await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        // The Save moved the PDF aside and stopped before installing its bytes.
        await rename(pdf, displaced(pdf));
        const {publication} = entry.doc.store;
        const real = {...publication};
        const unreadable = (destination: string) => !readable && destination === pdf;
        publication.witness = (destination, content) => (unreadable(destination) ? Promise.reject(new Error('EACCES')) : real.witness(destination, content));
        if (real.settle) publication.settle = (destination, ...rest) => (unreadable(destination) ? Promise.reject(new Error('EACCES')) : real.settle!(destination, ...rest));
        const copy = join(tempRoot, 'copy.pdf');
        try {
            expect(await store.saveOpenDocument(entry, store.documentRevisionToken(entry), {saveAs: copy})).toMatchObject({status: 'saved'});
        } finally {
            Object.assign(publication, real);
        }
        expect(await readFile(copy)).toEqual(Buffer.from(EDITED));
        expect(existsSync(pdf)).toBe(readable);
        expect(entry.doc.snapshot().unsettled?.map(record => record.destination)).toEqual(readable ? undefined : [pdf]);
        const id = entry.doc.id;
        await restart();

        expect((await store.reopenStoredDocument(id, {ownerWebContentsId: 8})).doc.snapshot().unsettled).toBeUndefined();
        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
        expect(existsSync(displaced(pdf))).toBe(false);
        expect(await findKeptOriginal(pdf)).toBeUndefined();
    });

    it('commits a native tool\'s output as the next revision without copying the document first, and drops it when the tool fails', async () => {
        const {pdf, entry} = await openPdf();
        const before = store.documentRevisionToken(entry);
        const appendLine = (line: string) => async (input: string, output: string) => {
            await writeFile(output, Buffer.concat([await readFile(input), Buffer.from(line)]));
        };

        let failedOutput = '';
        await expect(store.rewriteDocument(entry, async (input, output) => {
            failedOutput = output;
            await writeFile(output, 'partial');
            throw new Error('native tool failed');
        }, 'page-ops')).rejects.toThrow('native tool failed');
        expect(existsSync(failedOutput)).toBe(false);
        expect(store.documentRevisionToken(entry)).toBe(before);

        const inputs: string[] = [];
        await store.rewriteDocument(entry, async (input, output) => {
            inputs.push(input);
            await appendLine('% first\n')(input, output);
        }, 'page-ops');
        await store.rewriteDocument(entry, async (input, output) => {
            inputs.push(input);
            await appendLine('% second\n')(input, output);
        }, 'page-ops');

        expect(Buffer.from(await readAll(entry)).toString()).toBe(`${Buffer.from(ORIGINAL).toString()}% first\n% second\n`);
        expect(store.documentRevisionToken(entry)).not.toBe(before);
        // The first rewrite read the person's file itself; the second read the revision the first wrote.
        expect(inputs[0]).toBe(pdf);
        expect(dirname(inputs[1]!)).toBe(dirname(entry.ref));
        // The current revision and the one it replaced, kept for its undo; nothing else is copied or kept.
        expect((await readdir(dirname(entry.ref))).filter(name => name.startsWith('r')).sort()).toEqual(['r2.pdf', 'r3.pdf']);
        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
    });

    // The drafts commit when the edit is accepted; the window's layout may still describe the document as clean.
    it.each([true, false])('offers unsaved annotations again after a restart, bound to the revision they were captured on (layout dirty: %s)', async (layoutDirty) => {
        const {pdf, entry} = await openPdf();
        const paneId = requirePaneId('pane-1');
        const tabId = requireTabId('tab-1');
        const token = store.documentRevisionToken(entry);
        const drafts = {
            artifactId: 'artifact-1',
            documentInstanceId: 'instance-1',
            workingCopyRef: entry.ref as never,
            workingByteRevision: token,
            annotationMutationGeneration: 4,
            payload: {entities: [{kind: 'note', text: 'unsaved'}]},
        };
        const checkpoint: IWorkspaceCheckpoint = {
            version: 1,
            capturedAt: requireEpochMs(Date.now()),
            activePaneId: paneId,
            activeTabId: tabId,
            layout: {type: 'leaf', paneId},
            panes: [{paneId, tabIds: [tabId], activeTabId: tabId}],
            tabs: [{
                tabId,
                paneId,
                fileName: 'report.pdf',
                sourceRef: pdf as never,
                workingCopyRef: entry.ref as never,
                isDirty: layoutDirty,
                isDjvu: false,
                currentPage: 3,
                zoom: 1.5,
                zoomMode: null,
            }],
        };

        expect(await checkpoints.saveWorkspaceCheckpoint(checkpoint, 7)).toBe(true);
        expect(await checkpoints.setWorkspaceDocumentDrafts(drafts, 7)).toBe(true);
        await restart();
        const claimed = await checkpoints.claimWorkspaceCheckpoint(9);

        const tab = claimed?.tabs[0];
        expect(tab).toMatchObject({workingCopyRef: entry.ref, sourceRef: pdf, isDirty: true, currentPage: 3});
        expect(tab?.annotationRecovery).toMatchObject({
            workingByteRevision: token,
            payload: {entities: [{kind: 'note', text: 'unsaved'}]},
        });
        const reopened = store.getWorkingCopyBackingEntry(entry.ref, 9);
        expect(reopened && store.documentRevisionToken(reopened)).toBe(token);
        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
    });

    it('clears a document\'s drafts when the working bytes hold everything, and refuses drafts of an outdated revision', async () => {
        const {entry} = await openPdf();
        const drafts = {
            artifactId: 'artifact-1', documentInstanceId: 'instance-1', workingCopyRef: entry.ref as never,
            workingByteRevision: store.documentRevisionToken(entry), annotationMutationGeneration: 1,
        };
        expect(await checkpoints.setWorkspaceDocumentDrafts({...drafts, payload: {entities: []}}, 7)).toBe(true);
        expect(entry.doc.state()).toMatchObject({dirty: true});
        expect(await checkpoints.setWorkspaceDocumentDrafts(drafts, 7)).toBe(true);
        expect(entry.doc.state()).toMatchObject({drafts: undefined, dirty: false});
        expect(await checkpoints.setWorkspaceDocumentDrafts({...drafts, workingByteRevision: '2' as never, payload: {}}, 7)).toBe(false);
        expect(entry.doc.state().drafts).toBeUndefined();
    });

    it('restores a tab whose unsaved bytes are missing as unsaved, showing the PDF as saved, until a start finds them', async () => {
        const {pdf, entry} = await openPdf();
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}, 'write');
        const paneId = requirePaneId('pane-1');
        const tabId = requireTabId('tab-1');
        const checkpoint: IWorkspaceCheckpoint = {
            version: 1,
            capturedAt: requireEpochMs(Date.now()),
            activePaneId: paneId,
            activeTabId: tabId,
            layout: {type: 'leaf', paneId},
            panes: [{paneId, tabIds: [tabId], activeTabId: tabId}],
            tabs: [{
                tabId, paneId, fileName: 'report.pdf', sourceRef: pdf as never, workingCopyRef: entry.ref as never,
                isDirty: true, isDjvu: false, currentPage: null, zoom: null, zoomMode: null,
            }],
        };
        await checkpoints.saveWorkspaceCheckpoint(checkpoint, 7);
        const revision = join(dirname(entry.ref), entry.doc.state().current!.file);
        await restart();
        await rename(revision, `${revision}.away`);

        const claimed = await checkpoints.claimWorkspaceCheckpoint(9);
        expect(claimed?.tabs[0]).toMatchObject({workingCopyRef: entry.ref, sourceRef: pdf, isDirty: true, workingCopyLost: true});
        const standIn = store.requireOpenDocument(entry.ref, 9);
        expect(await readAll(standIn)).toEqual(ORIGINAL);
        await expect(store.saveOpenDocument(standIn, '1' as never)).rejects.toThrow('missing or cut short');
        // The damaged document takes no drafts: its directory stays as it is for a start that can read it.
        expect(await checkpoints.setWorkspaceDocumentDrafts({
            artifactId: 'artifact-1', documentInstanceId: 'instance-1', workingCopyRef: entry.ref as never,
            workingByteRevision: '1', annotationMutationGeneration: 1, payload: {entities: []},
        }, 9)).toBe(true);
        expect(existsSync(revision)).toBe(false);

        await restart();
        await rename(`${revision}.away`, revision);
        expect((await checkpoints.claimWorkspaceCheckpoint(11))?.tabs[0]).toMatchObject({workingCopyRef: entry.ref, isDirty: true});
        expect(await readAll(store.requireOpenDocument(entry.ref, 11))).toEqual(EDITED);
        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
    });

    it('collects documents no window holds and no checkpoint names, keeping the ones a checkpoint names', async () => {
        const {entry} = await openPdf();
        const snapshot = await store.forkOpenDocument(entry, 7);
        await store.setOpenDocumentDrafts(entry, store.documentRevisionToken(entry), {annotationRecovery: {}});
        const paneId = requirePaneId('pane-1');
        const tabId = requireTabId('tab-1');
        await checkpoints.saveWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(Date.now()),
            activePaneId: paneId,
            activeTabId: tabId,
            layout: {type: 'leaf', paneId},
            panes: [{paneId, tabIds: [tabId], activeTabId: tabId}],
            tabs: [{
                tabId, paneId, fileName: 'report.pdf', sourceRef: null, workingCopyRef: entry.ref as never,
                isDirty: true, isDjvu: false, currentPage: null, zoom: null, zoomMode: null,
            }],
        }, 7);
        await restart();

        expect(await store.collectStaleDocuments()).toBe(1);
        expect(existsSync(dirname(snapshot.ref))).toBe(false);
        expect(existsSync(dirname(entry.ref))).toBe(true);
    });

    it('keeps unsaved work no checkpoint names and offers it at the next claim', async () => {
        const entry = await store.createDocumentFromSource(new TextEncoder().encode('UNSAVED'), {ext: 'pdf', ownerWebContentsId: 7});
        await entry.doc.setDrafts(1, {note: 'committed before any checkpoint named it'});
        await restart();

        expect(await store.collectStaleDocuments()).toBe(0);
        const claimed = await checkpoints.claimWorkspaceCheckpoint(9);
        expect(claimed?.tabs).toMatchObject([{workingCopyRef: entry.ref, isDirty: true, requiresSaveAsOnFirstSave: true}]);
        expect(claimed?.panes[0]?.tabIds).toEqual([claimed?.tabs[0]?.tabId]);
        expect(store.requireOpenDocument(entry.ref, 9).doc.state().drafts).toEqual({note: 'committed before any checkpoint named it'});
    });

    it('names a document in its window\'s checkpoint before its first edit, so a crash before the next checkpoint loses nothing', async () => {
        const {pdf, entry} = await openPdf();
        await store.rewriteDocument(entry, async (_input, output) => writeFile(output, EDITED), 'page-ops');
        await restart();

        const claimed = await checkpoints.claimWorkspaceCheckpoint(9);
        expect(claimed?.tabs).toMatchObject([{workingCopyRef: entry.ref, sourceRef: pdf, fileName: 'report.pdf', isDirty: true}]);
        expect(await readAll(store.requireOpenDocument(entry.ref, 9))).toEqual(EDITED);
        expect(await checkpoints.hasRecoverableWorkspaceCheckpoints(10)).toBe(false);
    });

    it('removes what an open a crash cut short made, and a discarded document whose files a reader kept', async () => {
        const {entry} = await openPdf();
        await store.rewriteDocument(entry, async (_input, output) => writeFile(output, EDITED), 'open');
        const kept = await store.openDocumentFromFile(await writeTemp('kept.pdf', ORIGINAL), {ownerWebContentsId: 7});
        await store.commitDocumentMutation(kept, '1' as never, {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}, 'write');
        quarantineWorkingCopy(kept.ref, 'a reader would not stop');
        await store.discardOpenDocument(kept);
        expect(existsSync(dirname(kept.ref))).toBe(true);
        await restart();

        expect(await store.collectStaleDocuments()).toBe(2);
        expect(existsSync(dirname(entry.ref))).toBe(false);
        expect(existsSync(dirname(kept.ref))).toBe(false);
        expect(await checkpoints.claimWorkspaceCheckpoint(9)).toBeNull();
    });

    it('opens nothing while the startup collection runs, so it never removes a directory changing owner', async () => {
        const {entry} = await openPdf();
        const id = entry.doc.id;
        await restart();
        const docStore = store.getDocumentStore();
        const {port} = docStore;
        const removing = gate();
        const go = gate();
        docStore.port = {...port, remove: async (target) => {
            if (target === `documents/${id}`) {
                removing.resolve();
                await go.promise;
            }
            return port.remove(target);
        }};
        const collecting = store.collectStaleDocuments();
        await removing.promise;
        let reopened = false;
        const reopening = store.reopenStoredDocument(id, {ownerWebContentsId: 7}).then(() => {
            reopened = true;
        }, () => undefined);
        await new Promise(resolve => setImmediate(resolve));
        expect(reopened).toBe(false);

        go.resolve();
        expect(await collecting).toBe(1);
        await reopening;
        expect(reopened).toBe(false);
        expect(existsSync(dirname(entry.ref))).toBe(false);
    });

    it('stops an operation reading a closing document before its files go', async () => {
        const {entry} = await openPdf();
        let stopped = false;
        const reader = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: 7,
            workingCopyPath: entry.ref,
            cancel: () => {
                stopped = true;
                reader.complete();
            },
        });

        expect(await store.cleanupWorkingCopy(entry.ref, 8)).toBe(false);
        expect(await store.cleanupWorkingCopy(entry.ref, 7)).toBe(true);

        expect(stopped).toBe(true);
        expect(existsSync(dirname(entry.ref))).toBe(false);
    });

    it('reads a document only for the window that owns it', async () => {
        const {entry} = await openPdf();

        expect(await handleFileReadRange({senderId: 7}, entry.ref, 0, 8)).toEqual(ORIGINAL.subarray(0, 8));
        await expect(handleFileReadRange({senderId: 8}, entry.ref, 0, 8)).rejects.toThrow('reads only allowed');
    });
});
