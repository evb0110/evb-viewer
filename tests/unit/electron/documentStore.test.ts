import {EventEmitter} from 'node:events';
import {
    existsSync,
    renameSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
    chmod,
    link,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    symlink,
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

const diagnosticLog = vi.hoisted(() => ({warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn()}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => diagnosticLog}));

let tempRoot = '';
const originalAppStateDir = process.env.EVB_APP_STATE_DIR;

/**
 * FAT32 under Windows numbers a file by where its directory entry lies: a rename gives the same file a new id and
 * keeps its size, time and volume (#353). While `dir` is set, files directly in it report such an id, by path and
 * through a handle opened at that path.
 */
const fat32 = vi.hoisted(() => ({
    dir: '',
    names: new Map<string, bigint>(),
    afterCheck: undefined as undefined | (() => void),
    renumber: <T>(_path: unknown, stats: T) => stats,
}));

/** Runs around each look at a file's metadata, by path or through a handle opened at that path. */
const fileChecks = vi.hoisted(() => ({
    before: undefined as undefined | ((path: unknown) => Promise<void>),
    after: undefined as undefined | ((path: unknown) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof fsPromises>();
    const checked = async <T>(path: unknown, look: () => Promise<T>) => {
        await fileChecks.before?.(path);
        const stats = await look();
        await fileChecks.after?.(path);
        return stats;
    };
    const open = (async (path, flags, mode) => {
        const handle = await original.open(path, flags, mode);
        const stat = handle.stat.bind(handle);
        handle.stat = (async (options?: {bigint?: boolean}) => checked(path, async () => fat32.renumber(path, await stat(options)))) as typeof handle.stat;
        return handle;
    }) as typeof original.open;
    const stat = ((path, options) => checked(path, () => original.stat(path, options))) as typeof original.stat;
    return {...original, open: vi.fn(open), stat};
});

vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    const {basename: nameOf, dirname: folderOf} = await import('node:path');
    fat32.renumber = (path, stats) => {
        const ino = (stats as {ino?: unknown} | undefined)?.ino;
        if (!fat32.dir || typeof path !== 'string' || folderOf(path) !== fat32.dir || typeof ino !== 'bigint') return stats;
        const name = nameOf(path);
        if (!fat32.names.has(name)) fat32.names.set(name, BigInt(fat32.names.size + 1));
        (stats as {ino: bigint}).ino = (ino << 16n) + fat32.names.get(name)!;
        return stats;
    };
    const statSync = ((path: string, options?: {bigint?: boolean}) => {
        const stats = fat32.renumber(path, original.statSync(path, options));
        // A Save's check is the first look at the PDF while its staged copy lies beside it.
        if (fat32.afterCheck && typeof path === 'string' && folderOf(path) === fat32.dir && nameOf(path) === 'report.pdf'
            && original.readdirSync(fat32.dir).some(entry => /^\.[0-9a-f]{16}\.tmp$/u.test(entry))) {
            const act = fat32.afterCheck;
            fat32.afterCheck = undefined;
            act();
        }
        return stats;
    }) as typeof original.statSync;
    return {...original, statSync};
});

vi.mock('electron', () => ({
    app: {getPath: vi.fn(() => tempRoot)},
    webContents: {fromId: vi.fn(() => undefined)},
}));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => ({touchScanCleanupGeneratedOutput: vi.fn(async () => undefined)}));
/** A native writer that a test names without one being built: the writes it covers end before the tool would run. */
const nativeWriter = vi.hoisted(() => ({path: undefined as string | undefined}));
vi.mock('@electron/features/page-ops/public', async (importOriginal) => {
    const original = await importOriginal<typeof import('@electron/features/page-ops/public')>();
    return {...original, resolveNativePageOpsPath: () => nativeWriter.path ?? original.resolveNativePageOpsPath()};
});

const store = await import('@electron/file-access/documentStore');
const checkpoints = await import('@electron/workspaceCheckpointStore');
const {findKeptOriginal} = await import('@electron/file-access/keptOriginalNotices');
const {cancelMainOperationsForOwner, registerMainOperation, runWithMainOperationCancellationSignal} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
const {allowOpenPath, removeAllowedOpenPath, requireOpenPath} = await import('@electron/file-access/openPathCapabilities');
const {handleFileReadRange, withContentReadLease} = await import('@electron/features/documents/main/documentFileReadHandlers');
const {handleNativePdfMutationsApplyToWorkingCopy} = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');
const {getAppTempDirPath} = await import('@electron/utils/appTempDir');
const {markUnprovenNativeTermination} = await import('@contracts/nativeErrors');
const {normalizePdfNativeMutationSet} = await import('@contracts/nativePdfMutations');
const {clearWorkingCopyQuarantinesForTests, quarantineWorkingCopy} = await import('@electron/file-access/workingCopyQuarantine');
const {resolveNativeProcessSupervisorPath} = await import('@electron/native-tools/resolveNativeToolsBase');
const {
    isAllowedReadPath,
    isAllowedWritePath,
    resetPathValidatorCachesForTests,
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} = await import('@electron/utils/pathValidator');

const ORIGINAL = new TextEncoder().encode('%PDF-1.7\noriginal bytes\n%%EOF\n');
const EDITED = new TextEncoder().encode('%PDF-1.7\nedited bytes\n%%EOF\n');
/** Other bytes of `ORIGINAL`'s length, such as another program's edit. */
const SAME_SIZE_OTHER = new TextEncoder().encode('%PDF-1.7\nORIGINAL BYTES\n%%EOF\n');

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
    const copy = join(dirname(destination), '.0123456789abcdef.tmp');
    await writeFile(copy, await readAll(entry));
    const witness = (await doc.store.publication.witness(copy))!;
    await doc.run(async () => {
        const current = (await doc.ensureCurrent())!;
        await doc.commit({...doc.snapshot(), current: {...current, witness}, pendingPublish: {destination, witness, temp: copy}});
    });
    return copy;
}

beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'evb-document-store-'));
    await store.setDocumentStoreRootForTests(join(tempRoot, 'store'));
});

afterEach(async () => {
    vi.restoreAllMocks();
    fileChecks.before = undefined;
    fileChecks.after = undefined;
    nativeWriter.path = undefined;
    if (originalAppStateDir === undefined) {
        delete process.env.EVB_APP_STATE_DIR;
    } else {
        process.env.EVB_APP_STATE_DIR = originalAppStateDir;
    }
    clearWorkingCopyQuarantinesForTests();
    await store.setDocumentStoreRootForTests(null);
    await rm(tempRoot, {recursive: true, force: true});
});

describe('desktop document store', () => {
    it('removes the copy a crashed Save staged beside the PDF, which its record names, and nothing else there', async () => {
        const {pdf, entry} = await openPdf();
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}, 'write');
        const staged = join(dirname(pdf), '.0123456789abcdef.tmp');
        const unnamed = join(dirname(pdf), '.fedcba9876543210.tmp');
        await writeFile(staged, EDITED);
        await writeFile(unnamed, EDITED);
        const {doc} = entry;
        await doc.run(() => doc.commit({...doc.snapshot(), pendingPublish: {destination: pdf, temp: staged}}));
        const id = doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {ownerWebContentsId: 7});
        expect(existsSync(staged)).toBe(false);
        expect(existsSync(unnamed)).toBe(true);
        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
        expect(reopened.doc.snapshot().pendingPublish).toBeUndefined();
    });

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

    it.runIf(process.platform !== 'win32' && resolveNativeProcessSupervisorPath(import.meta.dirname) !== null)('keeps the PDF at its path throughout a Save on a volume that can exchange', async () => {
        const {pdf, entry} = await openPdf();
        const edited = await writeTemp('edited.pdf', EDITED);
        let missing = 0;
        let watching = true;
        const watch = () => {
            if (!existsSync(pdf)) missing += 1;
            if (watching) setImmediate(watch);
        };
        watch();
        try {
            expect(await store.saveOpenDocument(entry, '1' as never, {commit: {kind: 'rewrite', source: edited}})).toMatchObject({status: 'saved'});
        } finally {
            watching = false;
        }

        expect(missing).toBe(0);
        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect((await readdir(dirname(pdf))).filter(name => name.startsWith('.') || name.includes('report'))).toEqual(['report.pdf']);
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

    it.each([
        ['the PDF it replaced', 'baseline'],
        ['the PDF it replaced, already linked at its displaced name', 'linked'],
        ["a file another program put in the PDF's place", 'foreign'],
    ] as const)('settles a Save a crash cut right after its exchange, the staging name holding %s', async (_holding, state) => {
        const {pdf, entry} = await openPdf();
        const copy = await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        const outside = new TextEncoder().encode('%PDF-1.7\nwritten elsewhere\n%%EOF\n');
        if (state === 'foreign') await rename(await writeTemp('outside.pdf', outside), pdf);
        // What the exchange leaves: the PDF's name holds the staged copy, the staging name the file it displaced.
        const aside = join(tempRoot, 'exchanging');
        await rename(pdf, aside);
        await rename(copy, pdf);
        await rename(aside, copy);
        if (state === 'linked') await link(copy, displaced(pdf));
        const id = entry.doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {});

        const kept = join(dirname(pdf), 'report (original).pdf');
        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(reopened.doc.state().dirty).toBe(false);
        expect((await readdir(dirname(pdf))).filter(name => name.startsWith('.') || name.includes('report')).sort())
            .toEqual(state === 'foreign' ? ['report (original).pdf', 'report.pdf'] : ['report.pdf']);
        expect(await findKeptOriginal(pdf)).toBe(state === 'foreign' ? kept : undefined);
        if (state === 'foreign') expect(await readFile(kept)).toEqual(Buffer.from(outside));
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
        if (real.settle) publication.settle = (record, baseline) => (unreadable(record.destination) ? Promise.reject(new Error('EACCES')) : real.settle!(record, baseline));
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

    it('ignores a malformed persisted draft envelope without losing the reopened document, draft file, or healthy sibling tab', async () => {
        const healthyPdf = await writeTemp('healthy.pdf', ORIGINAL);
        const healthyEntry = await store.openDocumentFromFile(healthyPdf, {ownerWebContentsId: 7});
        const malformedPdf = await writeTemp('malformed.pdf', EDITED);
        const malformedEntry = await store.openDocumentFromFile(malformedPdf, {ownerWebContentsId: 7});

        const paneId = requirePaneId('pane-1');
        const healthyTabId = requireTabId('tab-healthy');
        const malformedTabId = requireTabId('tab-malformed');
        const healthyToken = store.documentRevisionToken(healthyEntry);
        const healthyDrafts = {
            artifactId: 'artifact-healthy',
            documentInstanceId: 'instance-healthy',
            workingCopyRef: healthyEntry.ref as never,
            workingByteRevision: healthyToken,
            annotationMutationGeneration: 2,
            payload: {entities: [{kind: 'note', text: 'healthy note'}]},
        };
        const checkpoint: IWorkspaceCheckpoint = {
            version: 1,
            capturedAt: requireEpochMs(Date.now()),
            activePaneId: paneId,
            activeTabId: healthyTabId,
            layout: {type: 'leaf', paneId},
            panes: [{paneId, tabIds: [healthyTabId, malformedTabId], activeTabId: healthyTabId}],
            tabs: [
                {
                    tabId: healthyTabId,
                    paneId,
                    fileName: 'healthy.pdf',
                    sourceRef: healthyPdf as never,
                    workingCopyRef: healthyEntry.ref as never,
                    isDirty: true,
                    isDjvu: false,
                    currentPage: 1,
                    zoom: 1,
                    zoomMode: null,
                },
                {
                    tabId: malformedTabId,
                    paneId,
                    fileName: 'malformed.pdf',
                    sourceRef: malformedPdf as never,
                    workingCopyRef: malformedEntry.ref as never,
                    isDirty: true,
                    isDjvu: false,
                    currentPage: 2,
                    zoom: 1,
                    zoomMode: null,
                },
            ],
        };

        expect(await checkpoints.saveWorkspaceCheckpoint(checkpoint, 7)).toBe(true);
        expect(await checkpoints.setWorkspaceDocumentDrafts(healthyDrafts, 7)).toBe(true);
        const malformedDraftEnvelope = {
            annotationRecovery: {
                artifactId: 'invalid artifact id with spaces',
                documentInstanceId: '',
                workingCopyRef: 123,
                workingByteRevision: '',
                annotationMutationGeneration: -1,
                payload: {entities: [{kind: 'note', text: 'kept on disk'}]},
            },
        };
        expect(await store.setOpenDocumentDrafts(malformedEntry, store.documentRevisionToken(malformedEntry), malformedDraftEnvelope)).toBe('stored');

        const malformedManifest = JSON.parse(await readFile(join(tempRoot, 'store', 'documents', malformedEntry.doc.id, 'manifest.json'), 'utf8')) as {drafts?: string};
        expect(malformedManifest.drafts).toBeDefined();
        const malformedDraftPath = join(tempRoot, 'store', 'documents', malformedEntry.doc.id, malformedManifest.drafts!);
        const draftBytesBefore = await readFile(malformedDraftPath);

        await restart();
        diagnosticLog.warn.mockClear();
        const claimed = await checkpoints.claimWorkspaceCheckpoint(9);

        expect(claimed).not.toBeNull();
        expect(claimed?.tabs).toHaveLength(2);

        const claimedHealthy = claimed?.tabs.find(tab => tab.tabId === healthyTabId);
        expect(claimedHealthy).toMatchObject({
            workingCopyRef: healthyEntry.ref,
            sourceRef: healthyPdf,
            isDirty: true,
            annotationRecovery: {
                artifactId: 'artifact-healthy',
                workingCopyRef: healthyEntry.ref,
                workingByteRevision: healthyToken,
                payload: {entities: [{kind: 'note', text: 'healthy note'}]},
            },
        });
        expect(claimedHealthy?.workingCopyLost).toBeUndefined();
        expect(claimedHealthy?.annotationRecoveryInvalid).toBeUndefined();

        const claimedMalformed = claimed?.tabs.find(tab => tab.tabId === malformedTabId);
        expect(claimedMalformed).toMatchObject({
            workingCopyRef: malformedEntry.ref,
            sourceRef: malformedPdf,
            isDirty: true,
            annotationRecoveryInvalid: true,
        });
        expect(claimedMalformed?.annotationRecovery).toBeUndefined();
        expect(claimedMalformed?.workingCopyLost).toBeUndefined();

        const reopenedMalformed = store.requireOpenDocument(malformedEntry.ref, 9);
        expect(await readAll(reopenedMalformed)).toEqual(EDITED);
        expect(await readFile(malformedDraftPath)).toEqual(draftBytesBefore);
        expect(retainedDiagnostics()).toContain(`documents/${malformedEntry.doc.id}`);

        // Renderer startup finishes opening the tab and sends a payload-free clear;
        // both clears and overwrites must be refused (false) so commitDrafts blocks
        // subsequent page mutations from deleting the rejected draft file on disk.
        const reopenedRevision = store.documentRevisionToken(reopenedMalformed);
        expect(await checkpoints.setWorkspaceDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-reopened',
            workingCopyRef: malformedEntry.ref as never,
            workingByteRevision: reopenedRevision,
            annotationMutationGeneration: 0,
        }, 9)).toBe(false);
        expect(await readFile(malformedDraftPath)).toEqual(draftBytesBefore);
        expect(reopenedMalformed.doc.state().drafts).toEqual(malformedDraftEnvelope);

        expect(await checkpoints.setWorkspaceDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-reopened',
            workingCopyRef: malformedEntry.ref as never,
            workingByteRevision: reopenedRevision,
            annotationMutationGeneration: 1,
            payload: {entities: [{kind: 'note', text: 'must not overwrite'}]},
        }, 9)).toBe(false);
        expect(await readFile(malformedDraftPath)).toEqual(draftBytesBefore);
        expect(reopenedMalformed.doc.state().drafts).toEqual(malformedDraftEnvelope);
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

    it('rejects a queued range read when its invoke owner gives up, without reading after capacity returns', async () => {
        const {pdf, entry} = await openPdf();
        const started = gate();
        const unblock = gate();
        const controller = new AbortController();
        let readAfterCancellation = false;
        const realOpen = vi.mocked(fsPromises.open).getMockImplementation()!;
        const open = vi.mocked(fsPromises.open).mockImplementation(async (path, flags, mode) => {
            if (path === pdf) {
                readAfterCancellation ||= controller.signal.aborted;
                started.resolve();
                await unblock.promise;
            }
            return realOpen(path, flags, mode);
        });
        // One 8 MiB request occupies the document's full admission budget.
        const active = handleFileReadRange({senderId: 7}, entry.ref, 0, 8 * 1024 * 1024);
        let queued: Promise<unknown> | undefined;
        try {
            await started.promise;
            queued = runWithMainOperationCancellationSignal(controller.signal, () =>
                handleFileReadRange({senderId: 7}, entry.ref, 8, 8));
            const outcome = queued.then(
                bytes => ({status: 'fulfilled', bytes}),
                error => ({status: 'rejected', error}),
            );
            // Let path resolution finish while the first read still owns capacity.
            await new Promise<void>(resolve => setImmediate(resolve));
            controller.abort(new Error('The range-read caller closed'));
            unblock.resolve();
            await active;

            expect.soft(await outcome).toMatchObject({status: 'rejected'});
            expect(readAfterCancellation).toBe(false);
        } finally {
            unblock.resolve();
            await Promise.allSettled([active, ...(queued ? [queued] : [])]);
            open.mockImplementation(realOpen);
        }
    });
    it("keeps another sender's identical queued range read alive when the first invoke is canceled", async () => {
        const source = await writeTemp('shared.pdf', ORIGINAL);
        const pdf = allowOpenPath(source, 7)!;
        allowOpenPath(source, 8);
        const started = gate();
        const unblock = gate();
        const controller = new AbortController();
        const realOpen = vi.mocked(fsPromises.open).getMockImplementation()!;
        const open = vi.mocked(fsPromises.open).mockImplementation(async (path, flags, mode) => {
            if (path === pdf) {
                started.resolve();
                await unblock.promise;
            }
            return realOpen(path, flags, mode);
        });
        // Plain files have no document registration to distinguish the two windows.
        const active = handleFileReadRange({senderId: 7}, pdf, 0, 8 * 1024 * 1024);
        const queued: Array<Promise<unknown>> = [];
        try {
            await started.promise;
            const first = runWithMainOperationCancellationSignal(controller.signal, () =>
                handleFileReadRange({senderId: 7}, pdf, 8, 8));
            queued.push(first);
            const firstOutcome = first.then(
                bytes => ({status: 'fulfilled', bytes}),
                error => ({status: 'rejected', error}),
            );
            await new Promise<void>(resolve => setImmediate(resolve));
            const second = runWithMainOperationCancellationSignal(new AbortController().signal, () =>
                handleFileReadRange({senderId: 8}, pdf, 8, 8));
            queued.push(second);
            const secondOutcome = second.then(
                bytes => ({status: 'fulfilled', bytes}),
                error => ({status: 'rejected', error}),
            );
            await new Promise<void>(resolve => setImmediate(resolve));
            controller.abort(new Error('The first range-read caller closed'));
            unblock.resolve();
            await active;

            expect(await firstOutcome).toMatchObject({status: 'rejected'});
            expect(await secondOutcome).toEqual({status: 'fulfilled', bytes: ORIGINAL.subarray(8, 16)});
        } finally {
            unblock.resolve();
            await Promise.allSettled([active, ...queued]);
            open.mockImplementation(realOpen);
            removeAllowedOpenPath(pdf);
        }
    });
});

describe('#353 Save on a volume whose renames renumber files (FAT32 under Windows)', () => {
    // FAT32 keeps modification times to two seconds; the PDF and another program's file share this one.
    const WRITTEN = new Date('2026-11-20T10:00:00Z');
    const SAME_SIZE = new TextEncoder().encode('%PDF-1.7\nforeign! bytes\n%%EOF\n');

    beforeEach(() => {
        fat32.dir = tempRoot;
        fat32.names.clear();
    });

    afterEach(() => {
        fat32.dir = '';
        fat32.afterCheck = undefined;
    });

    async function openOnFat32() {
        const pdf = await writeTemp('report.pdf', ORIGINAL);
        await utimes(pdf, WRITTEN, WRITTEN);
        return {pdf, entry: await store.openDocumentFromFile(pdf, {ownerWebContentsId: 7})};
    }

    const besidePdf = async (pdf: string) => (await readdir(dirname(pdf))).filter(name => name.startsWith('.') || name.includes('report')).sort();

    it('saves twice, keeping nothing beside the PDF', async () => {
        const {pdf, entry} = await openOnFat32();
        const twice = new TextEncoder().encode('%PDF-1.7\nedited twice\n%%EOF\n');

        const first = await store.saveOpenDocument(entry, '1' as never, {commit: {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}});
        expect(first).toMatchObject({status: 'saved'});
        expect(first).not.toHaveProperty('keptOriginal');
        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(await besidePdf(pdf)).toEqual(['report.pdf']);

        // The baseline is the renamed PDF's own id, so the next Save's check accepts the file the first one wrote.
        const second = await store.saveOpenDocument(entry, store.documentRevisionToken(entry), {commit: {kind: 'rewrite', source: await writeTemp('twice.pdf', twice)}});
        expect(second).toMatchObject({status: 'saved'});
        expect(second).not.toHaveProperty('keptOriginal');
        expect(await readFile(pdf)).toEqual(Buffer.from(twice));
        expect(await besidePdf(pdf)).toEqual(['report.pdf']);
        expect(entry.doc.state().dirty).toBe(false);
        expect(await findKeptOriginal(pdf)).toBeUndefined();
    });

    it('keeps a file of the same size and time that another program put in the PDF\'s place after the check', async () => {
        const {pdf, entry} = await openOnFat32();
        fat32.afterCheck = () => {
            const outside = join(tempRoot, 'outside.pdf');
            const displacedByOther = join(tempRoot, 'displaced-by-other.pdf');
            writeFileSync(outside, SAME_SIZE);
            utimesSync(outside, WRITTEN, WRITTEN);
            // Windows refuses MoveFileExW(REPLACE_EXISTING) onto an open target,
            // while moving the open file aside first (permitted by FILE_SHARE_DELETE) succeeds.
            renameSync(pdf, displacedByOther);
            renameSync(outside, pdf);
        };

        const result = await store.saveOpenDocument(entry, '1' as never, {commit: {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}});

        const kept = join(dirname(pdf), 'report (original).pdf');
        expect(fat32.afterCheck).toBeUndefined();
        expect(result).toMatchObject({status: 'saved', keptOriginal: kept});
        expect(await readFile(kept)).toEqual(Buffer.from(SAME_SIZE));
        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(await besidePdf(pdf)).toEqual(['report (original).pdf', 'report.pdf']);
        expect(await findKeptOriginal(pdf)).toBe(kept);
    });

    it('puts the PDF back after a crash between moving it aside and installing the save', async () => {
        const {pdf, entry} = await openOnFat32();
        await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        await rename(pdf, displaced(pdf));
        const id = entry.doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {});

        expect(await readFile(pdf)).toEqual(Buffer.from(ORIGINAL));
        expect(await besidePdf(pdf)).toEqual(['report.pdf']);
        expect(reopened.doc.state().dirty).toBe(true);
        expect(await readAll(reopened)).toEqual(EDITED);
    });

    it('loses nothing after a crash once the save installed, keeping the moved-aside PDF it cannot prove unchanged', async () => {
        const {pdf, entry} = await openOnFat32();
        const copy = await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        await rename(pdf, displaced(pdf));
        await rename(copy, pdf);
        const id = entry.doc.id;
        await restart();

        const reopened = await store.reopenStoredDocument(id, {});

        const kept = join(dirname(pdf), 'report (original).pdf');
        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(await readFile(kept)).toEqual(Buffer.from(ORIGINAL));
        expect(await besidePdf(pdf)).toEqual(['report (original).pdf', 'report.pdf']);
        expect(await readAll(reopened)).toEqual(EDITED);
    });
});

// #1609: warnings are retained by packaged diagnostics; debug messages are not.
const retainedDiagnostics = () => [...diagnosticLog.info.mock.calls, ...diagnosticLog.warn.mock.calls, ...diagnosticLog.error.mock.calls]
    .map(args => JSON.stringify(args, (_key, value: unknown) => value instanceof Error ? value.message : value)).join('\n');

describe('#1609 recovery diagnostics', () => {
    it('reports an unreadable manifest and offers the existing recovery notice without altering its bytes', async () => {
        const {entry} = await openPdf();
        const manifest = join(tempRoot, 'store', 'documents', entry.doc.id, 'manifest.json');
        await restart();
        await writeFile(manifest, '{corrupt');
        const claimed = await checkpoints.claimWorkspaceCheckpoint(160901);
        expect.soft(await readFile(manifest, 'utf8')).toBe('{corrupt');
        expect.soft(retainedDiagnostics()).toContain(`documents/${entry.doc.id}/manifest.json`);
        expect.soft(retainedDiagnostics()).toMatch(/(?:SyntaxError|Expected property name|Unexpected token|not valid JSON|Unreadable document manifest|parsing|parse error)/iu);
        expect(claimed?.tabs.some(tab => tab.workingCopyLost)).toBe(true);
    });

    it('names an unreadable workspace checkpoint and its read error in retained diagnostics', async () => {
        const port = store.getDocumentStore().port;
        await port.writeAtomic('workspaces/unreadable-window.json', new TextEncoder().encode('{corrupt'));
        const read = port.read.bind(port);
        vi.spyOn(port, 'read').mockImplementation(target => target === 'workspaces/unreadable-window.json'
            ? Promise.reject(new Error('EACCES injected checkpoint read')) : read(target));
        await checkpoints.claimWorkspaceCheckpoint(160902);
        expect.soft(retainedDiagnostics()).toContain('workspaces/unreadable-window.json');
        expect(retainedDiagnostics()).toContain('EACCES injected checkpoint read');
    });

    it('reports an orphan manifest that becomes unreadable after collection through the recovery notice', async () => {
        const {entry} = await openPdf();
        await entry.doc.setDrafts(null, {note: 'recover me'});
        await restart();
        await store.collectStaleDocuments();
        const port = store.getDocumentStore().port;
        const target = `documents/${entry.doc.id}/manifest.json`;
        const before = await port.read(target);
        const read = port.read.bind(port);
        vi.spyOn(port, 'read').mockImplementation(name => name === target
            ? Promise.reject(new Error('EACCES injected orphan read')) : read(name));
        const claimed = await checkpoints.claimWorkspaceCheckpoint(160903);
        expect.soft(retainedDiagnostics()).toContain(target);
        expect.soft(retainedDiagnostics()).toContain('EACCES injected orphan read');
        expect.soft(claimed?.tabs.some(tab => tab.workingCopyLost)).toBe(true);
        expect(await read(target)).toEqual(before);
    });

    it('retains an interrupted save and logs why settlement failed at a retained level', async () => {
        const {entry} = await openPdf();
        await crashDuringPublish(entry, await writeTemp('edited.pdf', EDITED));
        const id = entry.doc.id;
        await restart();
        const publication = store.getDocumentStore().publication;
        vi.spyOn(publication, 'settle').mockRejectedValue(new Error('EACCES injected settlement'));
        await store.collectStaleDocuments();
        expect.soft(retainedDiagnostics()).toContain(id);
        expect(retainedDiagnostics()).toContain('EACCES injected settlement');
        const manifest = JSON.parse(await readFile(join(tempRoot, 'store', 'documents', id, 'manifest.json'), 'utf8'));
        expect(manifest.pendingPublish).toBeDefined();
    });

    it('keeps ENOENT absence silent with no recovery notice or log at any level', async () => {
        await store.getDocumentStore().port.writeAtomic('documents/aborted-open/uncommitted', new Uint8Array());
        expect(await checkpoints.claimWorkspaceCheckpoint(160904)).toBeNull();
        expect(await findKeptOriginal(join(tempRoot, 'missing.pdf'))).toBeUndefined();
        expect(diagnosticLog.warn).not.toHaveBeenCalled();
        expect(diagnosticLog.error).not.toHaveBeenCalled();
        expect(diagnosticLog.info).not.toHaveBeenCalled();
        expect(diagnosticLog.debug).not.toHaveBeenCalled();
    });
});

describe('#1609 kept original diagnostics', () => {
    it.each(['unreadable', 'invalid JSON'])('reports %s notices file without replacing it', async damage => {
        const notices = join(tempRoot, 'kept-original-notices.json');
        if (damage === 'unreadable') await mkdir(notices);
        else await writeFile(notices, '{broken');
        expect(await findKeptOriginal(join(tempRoot, 'report.pdf'))).toBeUndefined();
        expect.soft(retainedDiagnostics()).toContain(JSON.stringify(notices));
        expect(retainedDiagnostics()).toMatch(damage === 'unreadable' ? /EISDIR|directory/iu : /SyntaxError|Expected property name|Unexpected token|invalid JSON|parse/iu);
        if (damage === 'invalid JSON') expect(await readFile(notices, 'utf8')).toBe('{broken');
    });

    it('reports a failed dismissal write with the notices file, original PDF and error', async () => {
        const noticesModule = await import('@electron/file-access/keptOriginalNotices');
        const atomic = await import('@electron/utils/atomicReplace');
        const original = join(tempRoot, 'report.pdf');
        const kept = await writeTemp('report (original).pdf', ORIGINAL);
        await noticesModule.rememberKeptOriginal(original, kept);
        vi.spyOn(atomic, 'writeJsonAtomic').mockRejectedValueOnce(new Error('ENOSPC injected dismissal write'));
        await noticesModule.forgetKeptOriginal(original);
        expect.soft(await findKeptOriginal(original)).toBe(kept);
        expect.soft(retainedDiagnostics()).toContain('kept-original-notices.json');
        expect.soft(retainedDiagnostics()).toContain(JSON.stringify(original));
        expect(retainedDiagnostics()).toContain('ENOSPC injected dismissal write');
    });
});

it('#1609 explains at undo time that opened bytes could not be retained, while Save still succeeds', async () => {
    const {pdf, entry} = await openPdf();
    const opened = store.documentRevisionToken(entry);
    await store.commitDocumentMutation(entry, opened, {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}, 'write');
    const port = entry.doc.store.port;
    const copyIn = port.copyIn.bind(port);
    vi.spyOn(port, 'copyIn').mockImplementation((source, target) => target.endsWith('/r1.pdf')
        ? Promise.reject(new Error('EACCES injected opened-byte retention')) : copyIn(source, target));
    expect(await store.saveOpenDocument(entry, store.documentRevisionToken(entry))).toMatchObject({status: 'saved'});
    expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
    await expect(store.restoreOpenDocumentRevision(entry, opened, store.documentRevisionToken(entry)))
        .rejects.toThrow(/opened.*(?:retain|keep|available)|(?:retain|keep).*opened/iu);
});

it('saves an unchanged revision when a concurrent reader queues materialization before or during Save staging cleanup', async () => {
    const {entry} = await openPdf();
    const token = store.documentRevisionToken(entry);
    expect(token).toBe('1');
    expect(entry.doc.state().current).toBeNull();

    // Queue a reader's materialize() while clearNextRevision() is executing inside doc.run,
    // so Save resolves expectedId before materialize() finishes and enters doc.run behind it.
    const realRun = entry.doc.run.bind(entry.doc);
    let materializing: ReturnType<typeof entry.doc.materialize> | null = null;
    let injected = false;
    const runSpy = vi.spyOn(entry.doc, 'run').mockImplementation(task => realRun(async () => {
        if (!injected) {
            injected = true;
            materializing = entry.doc.materialize();
        }
        return task();
    }));
    try {
        const saving = store.saveOpenDocument(entry, token);
        expect(await saving).toMatchObject({status: 'saved', revision: {id: 1}});
        expect(await materializing).toMatchObject({id: 1});
    } finally {
        runSpy.mockRestore();
    }
});

describe('pinned document revisions', () => {
    const APPENDED = new TextEncoder().encode('1 0 obj\n<< /Appended true >>\nendobj\n%%EOF\n');
    const REDONE = new TextEncoder().encode('1 0 obj\n<< /Other append >>\nendobj\n%%EOF\n');
    const pinsDirectory = () => join(tempRoot, 'pinned-revisions');
    const pinnedCopies = () => readdir(pinsDirectory()).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return [];
        }
        throw error;
    });
    const readPin = (ref: string, owner = 7) => store.runWithWorkingCopyReadBacking(ref, path => readFile(path), {ownerWebContentsId: owner});
    const append = (entry: Awaited<ReturnType<typeof store.openDocumentFromFile>>, bytes: Uint8Array) =>
        store.appendToDocument(entry, async (_input, output) => fsPromises.appendFile(output, bytes), 'write');

    it('pins the PDF as opened without copying it, and copies it only for a reader', async () => {
        const {entry} = await openPdf();

        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);

        expect(dirname(pinned)).toBe(pinsDirectory());
        expect(await readdir(pinsDirectory())).toEqual([]);
        expect(entry.doc.state().current).toBeNull();
        expect(store.getPinnedRevisionStateForTests(pinned)).toBe('pinned');
        expect(await readPin(pinned)).toEqual(Buffer.from(ORIGINAL));
        expect(store.getPinnedRevisionStateForTests(pinned)).toBe('materialized');
    });

    it('keeps the opened bytes when a Save replaces the PDF', async () => {
        const {pdf, entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);

        expect(await store.saveOpenDocument(entry, '1' as never, {commit: {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}}))
            .toMatchObject({status: 'saved'});

        expect(await readFile(pdf)).toEqual(Buffer.from(EDITED));
        expect(await readPin(pinned)).toEqual(Buffer.from(ORIGINAL));
    });

    it('keeps a pinned revision whose file an undo cuts and a later append overwrites', async () => {
        const {entry} = await openPdf();
        await append(entry, APPENDED);
        const appendedToken = store.documentRevisionToken(entry);
        const pinned = await store.pinOpenDocumentRevision(entry.ref, appendedToken, 7);
        expect(await readdir(pinsDirectory())).toEqual([]);

        await store.restoreOpenDocumentRevision(entry, '1' as never, appendedToken);
        await append(entry, REDONE);

        expect(await readAll(entry)).toEqual(new Uint8Array([...ORIGINAL, ...REDONE]));
        expect(await readPin(pinned)).toEqual(Buffer.from([...ORIGINAL, ...APPENDED]));
    });

    it('never gives a reader of a pin the file a native tool appends to', async () => {
        const {entry} = await openPdf();
        await append(entry, APPENDED);
        const pinned = await store.pinOpenDocumentRevision(entry.ref, store.documentRevisionToken(entry), 7);

        const target = await store.prepareDocumentAppend(entry, true);
        await fsPromises.appendFile(target, REDONE);
        const readPath = await store.runWithWorkingCopyReadBacking(pinned, path => Promise.resolve(path), {ownerWebContentsId: 7});

        expect(readPath).not.toBe(target);
        expect(await readFile(readPath)).toEqual(Buffer.from([...ORIGINAL, ...APPENDED]));
        await store.discardDocumentAppend(entry);
    });

    it('marks a pin of a PDF another program changed unavailable without blocking the Save As that rescues the edits', async () => {
        const {pdf, entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        const replacement = await writeTemp('replacement.pdf', new TextEncoder().encode('%PDF-1.7\nchanged elsewhere\n%%EOF\n'));
        await rename(replacement, pdf);

        await expect(store.prepareDocumentAppend(entry, true)).resolves.toEqual(expect.any(String));

        expect(store.getPinnedRevisionStateForTests(pinned)).toBe('unavailable');
        await expect(readPin(pinned)).rejects.toMatchObject({code: 'SOURCE_BACKING_UNAVAILABLE'});
        expect(await readdir(pinsDirectory())).toEqual([]);
    });

    it('refuses to pin a revision that is no longer current', async () => {
        const {entry} = await openPdf();
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}, 'write');

        await expect(store.pinOpenDocumentRevision(entry.ref, '1' as never, 7)).rejects.toMatchObject({code: 'STALE_REVISION'});
        expect(await pinnedCopies()).toEqual([]);
    });

    it('lets only the window that pinned a revision read or release it, through a tab move', async () => {
        const {entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        await expect(store.pinOpenDocumentRevision(entry.ref, '1' as never, 8)).rejects.toThrow('not managed by this owner');
        const registration = store.grantWorkingCopyTransferAccess(entry.ref, 7, 9);
        expect(registration).not.toBe(false);

        await expect(readPin(pinned, 9)).rejects.toThrow('not managed by this owner');
        expect(await store.releasePinnedDocumentRevision(pinned, 9)).toBe(false);
        expect(await readPin(pinned, 7)).toEqual(Buffer.from(ORIGINAL));
        expect(await store.releasePinnedDocumentRevision(pinned, 7)).toBe(true);

        expect(existsSync(pinned)).toBe(false);
        await expect(readPin(pinned, 7)).rejects.toThrow('missing or was released');
        expect(store.commitWorkingCopyTransferAccess(entry.ref, 7, 9, registration as number)).toBe(true);
    });

    it.each([
        ['the document closes', (entry: Awaited<ReturnType<typeof store.openDocumentFromFile>>) => store.discardOpenDocument(entry)],
        ['its window goes away', () => store.releasePinnedDocumentRevisionsForSender(7)],
        ['the app quits', () => store.clearAllWorkingCopies()],
    ])('ends a pin and its copy when %s', async (_when, end) => {
        const {entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        await readPin(pinned);
        expect(existsSync(pinned)).toBe(true);

        await end(entry);

        expect(existsSync(pinned)).toBe(false);
        expect(store.getPinnedRevisionStateForTests(pinned)).toBeNull();
    });

    it('removes the copies an earlier run left when the next run starts', async () => {
        await mkdir(pinsDirectory(), {recursive: true});
        const stale = join(pinsDirectory(), 'stale.pdf');
        await writeFile(stale, ORIGINAL);
        await restart();

        await store.collectStaleDocuments();

        expect(existsSync(stale)).toBe(false);
    });

    it('keeps a copy whose reader did not provably stop, even when the pin ended during the read, until the next start', async () => {
        const {entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);

        const reading = withContentReadLease(pinned, () => store.runWithWorkingCopyReadBacking(pinned, async () => {
            await store.releasePinnedDocumentRevision(pinned, 7);
            throw markUnprovenNativeTermination(new Error('The reader outlived its kill'), 'its process group survived');
        }, {ownerWebContentsId: 7}));

        await expect(reading).rejects.toThrow('The reader outlived its kill');
        expect(store.getPinnedRevisionStateForTests(pinned)).toBeNull();
        expect(existsSync(pinned)).toBe(true);
        await restart();
        await store.collectStaleDocuments();
        expect(existsSync(pinned)).toBe(false);
    });

    it('records no pin for a window that went away while the pin was being made', async () => {
        const {pdf, entry} = await openPdf();
        const reached = gate();
        const held = gate();
        fileChecks.before = async (path) => {
            if (path !== pdf) return;
            reached.resolve();
            await held.promise;
        };
        const pinning = store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        await reached.promise;
        fileChecks.before = undefined;

        // What the window's end does (see `registerDocumentsSenderCleanup`).
        cancelMainOperationsForOwner(7, 'Renderer destroyed', 'destroyed');
        await store.releasePinnedDocumentRevisionsForSender(7);
        held.resolve();

        await expect(pinning).rejects.toThrow('Renderer destroyed');
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: await writeTemp('edited.pdf', EDITED)}, 'write');
        expect(await pinnedCopies()).toEqual([]);
    });

    it('refuses to pin revision 1 when a Save built it from a PDF another program changed', async () => {
        const {pdf, entry} = await openPdf();
        await rename(await writeTemp('replacement.pdf', SAME_SIZE_OTHER), pdf);
        await store.prepareDocumentAppend(entry, true);
        await store.discardDocumentAppend(entry);
        expect(store.documentRevisionToken(entry)).toBe('1');

        await expect(store.pinOpenDocumentRevision(entry.ref, '1' as never, 7)).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
    });

    it('copies the PDF as opened even while its path names other bytes of the same size during the copy', async () => {
        const {pdf, entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        const other = await writeTemp('other.pdf', SAME_SIZE_OTHER);
        const aside = join(tempRoot, 'aside.pdf');
        let checks = 0;
        let swapBlockedOnWindows = false;
        // Another program points the path at other bytes right after the first check and back right before the last.
        // On Windows, the open read handle in `copyAdmittedFile` itself blocks renaming over the file (`EPERM`/`EBUSY`).
        fileChecks.after = async (path) => {
            if (path !== pdf || ++checks !== 1) return;
            await link(pdf, aside);
            try {
                await rename(other, pdf);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) {
                    swapBlockedOnWindows = true;
                    await rm(aside, {force: true});
                    return;
                }
                throw error;
            }
        };
        fileChecks.before = async (path) => {
            if (path !== pdf || checks !== 1) return;
            checks += 1;
            if (!swapBlockedOnWindows) {
                await rename(aside, pdf);
            }
        };

        const read = await readPin(pinned);

        expect(checks).toBeGreaterThan(1);
        expect(read).toEqual(Buffer.from(ORIGINAL));
    });

    it('refuses every window a generic read of a pin, which only the pin-aware reader may open', async () => {
        process.env.EVB_APP_STATE_DIR = tempRoot;
        await store.setDocumentStoreRootForTests(join(getAppTempDirPath(), 'document-store'));
        const {entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        expect(await readPin(pinned)).toEqual(Buffer.from(ORIGINAL));

        await expect(handleFileReadRange({senderId: 8}, pinned, 0, 8)).rejects.toThrow('reads only allowed');
        await expect(handleFileReadRange({senderId: 7}, pinned, 0, 8)).rejects.toThrow('reads only allowed');
    });

    it('tells a Save that the PDF as opened is gone, as its own refusal, when a text box restores its original appearance', async () => {
        process.env.EVB_APP_STATE_DIR = tempRoot;
        nativeWriter.path = join(tempRoot, 'evb-pdf-page-ops');
        const {pdf, entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        await rename(await writeTemp('replacement.pdf', SAME_SIZE_OTHER), pdf);
        const textBox = {
            stableKey: 'original-box',
            annotationId: '5 0 R',
            pageIndex: 0,
            text: 'Original',
            rect: [10, 40, 130, 70],
            rotation: 0,
            fontSize: 12,
            color: [0, 0, 0],
            originalAppearance: {sourceAnnotationId: '5 0 R'},
        };
        const mutations = normalizePdfNativeMutationSet({originalAppearanceSource: pinned, textBoxes: [textBox]}, 'restore');

        const result = await handleNativePdfMutationsApplyToWorkingCopy({senderId: 7}, entry.ref, mutations, 'D:20261123000000Z', {
            expectedDocumentRevisionToken: '1' as never,
        });

        expect(result).toMatchObject({applied: false, reason: 'source-unavailable'});
    });

    it('reports source-unavailable when the original is deleted while a destination-backed pin is active', async () => {
        process.env.EVB_APP_STATE_DIR = tempRoot;
        nativeWriter.path = join(tempRoot, 'evb-pdf-page-ops');
        const {pdf, entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        await rm(pdf);
        const textBox = {
            stableKey: 'original-box',
            annotationId: '5 0 R',
            pageIndex: 0,
            text: 'Original',
            rect: [10, 40, 130, 70],
            rotation: 0,
            fontSize: 12,
            color: [0, 0, 0],
            originalAppearance: {sourceAnnotationId: '5 0 R'},
        };
        const mutations = normalizePdfNativeMutationSet({originalAppearanceSource: pinned, textBoxes: [textBox]}, 'restore');

        const result = await handleNativePdfMutationsApplyToWorkingCopy({senderId: 7}, entry.ref, mutations, 'D:20261123000000Z', {
            expectedDocumentRevisionToken: '1' as never,
        });

        expect(result).toMatchObject({applied: false, reason: 'source-unavailable'});
    });

    it('refuses generic validators and range reads on real-filesystem case spellings and symlink aliases of pinned-revisions', async () => {
        process.env.EVB_APP_STATE_DIR = tempRoot;
        resetPathValidatorCachesForTests();
        const appTempRoot = getAppTempDirPath();
        await store.setDocumentStoreRootForTests(join(appTempRoot, 'document-store'));
        const {entry} = await openPdf();
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        try {
            expect(await readPin(pinned)).toEqual(Buffer.from(ORIGINAL));

            const pinnedDir = dirname(pinned);
            const pinBaseRoot = dirname(pinnedDir);
            const regularSibling = join(appTempRoot, 'regular.pdf');
            await writeFile(regularSibling, ORIGINAL);
            expect(isAllowedReadPath(regularSibling)).toBe(true);
            expect(isAllowedWritePath(regularSibling)).toBe(true);
            await expect(resolveAllowedReadPath(regularSibling)).resolves.toBeTruthy();
            await expect(resolveAllowedWritePath(regularSibling)).resolves.toBe(regularSibling);

            const upperPinned = join(pinBaseRoot, 'PINNED-REVISIONS', basename(pinned));
            const upperNew = join(pinBaseRoot, 'PINNED-REVISIONS', 'new.pdf');
            const pinnedStat = await stat(pinned, {bigint: true});
            const upperStat = await stat(upperPinned, {bigint: true}).catch(() => null);
            if (upperStat) {
                expect(upperStat.dev).toBe(pinnedStat.dev);
                expect(upperStat.ino).toBe(pinnedStat.ino);
            }

            for (const candidate of [
                upperPinned,
                upperNew,
            ]) {
                expect(isAllowedReadPath(candidate)).toBe(false);
                expect(isAllowedWritePath(candidate)).toBe(false);
                await expect(resolveAllowedReadPath(candidate)).resolves.toBeNull();
                await expect(resolveAllowedWritePath(candidate)).resolves.toBeNull();
            }
            await expect(handleFileReadRange({senderId: 8}, upperPinned, 0, 8)).rejects.toThrow('reads only allowed');

            if (process.platform !== 'win32') {
                const aliasDir = join(pinBaseRoot, 'pin-alias-dir');
                await symlink(pinnedDir, aliasDir);
                for (const candidate of [
                    join(aliasDir, basename(pinned)),
                    join(aliasDir, 'new.pdf'),
                ]) {
                    expect(isAllowedReadPath(candidate)).toBe(false);
                    expect(isAllowedWritePath(candidate)).toBe(false);
                    await expect(resolveAllowedReadPath(candidate)).resolves.toBeNull();
                    await expect(resolveAllowedWritePath(candidate)).resolves.toBeNull();
                }
            }
        } finally {
            resetPathValidatorCachesForTests();
        }
    });

    it('blocks another window from opening, granting, reading, or saving over a materialized pin', async () => {
        process.env.EVB_APP_STATE_DIR = tempRoot;
        resetPathValidatorCachesForTests();
        const appTempRoot = getAppTempDirPath();
        await store.setDocumentStoreRootForTests(join(appTempRoot, 'document-store'));
        const {entry} = await openPdf(7);
        const pinned = await store.pinOpenDocumentRevision(entry.ref, '1' as never, 7);
        try {
            expect(await readPin(pinned, 7)).toEqual(Buffer.from(ORIGINAL));

            const {
                allowOpenPath,
                requireOpenPath,
            } = await import('@electron/file-access/openPathCapabilities');
            const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');
            const {
                resolveExistingReadableDocumentOrImagePath,
                resolveExistingReadablePdfPath,
            } = await import('@electron/features/documents/main/documentFilePathResolution');
            const {isAllowedOriginalSavePath} = await import('@electron/file-access/isAllowedOriginalSavePath');
            const {savePdfAs} = await import('@electron/features/documents/main/documentSave.service');

            const candidates: string[] = [pinned];
            if (process.platform !== 'win32') {
                const outsideLink = join(tempRoot, 'window8-pin-open-link.pdf');
                await symlink(pinned, outsideLink);
                candidates.push(outsideLink);
            }

            for (const candidate of candidates) {
                expect(allowOpenPath(candidate, 8)).toBeNull();
                expect(() => requireOpenPath(candidate, 8)).toThrow('Path not allowed');
                await expect(openInputPaths([candidate], {}, 8)).rejects.toThrow();
                await expect(resolveExistingReadablePdfPath(candidate, 8)).rejects.toThrow('reads only allowed');
                await expect(resolveExistingReadableDocumentOrImagePath(candidate, 8)).rejects.toThrow('reads only allowed');
                expect(isAllowedOriginalSavePath(candidate)).toBe(false);
                await expect(savePdfAs(
                    {
                        parentWindow: null,
                        sender: {id: 7} as never,
                        senderId: 7,
                    },
                    entry.ref,
                    undefined,
                    async () => candidate,
                )).rejects.toThrow('reserved application directory');
            }

            expect(await readFile(pinned)).toEqual(Buffer.from(ORIGINAL));
        } finally {
            resetPathValidatorCachesForTests();
        }
    });
});

describe('#1761 workspace checkpoint reload race and ghost-tab prevention', () => {
    function createFakeWebContents(id: number) {
        const emitter = new EventEmitter();
        return Object.assign(emitter, {
            id,
            isDestroyed: () => false,
        });
    }

    it('preserves an admitted sourceRef when main-frame navigation clears capabilities while saveWorkspaceCheckpoint is queued', async () => {
        const readerPdf = await writeTemp('reader.pdf', ORIGINAL);
        const outputPdf = await writeTemp('recovered — cleaned.pdf', EDITED);
        const sender = createFakeWebContents(176101);
        expect(allowOpenPath(readerPdf, sender as never)).toBeTruthy();
        expect(allowOpenPath(outputPdf, sender as never)).toBeTruthy();

        const paneId = requirePaneId('pane-1');
        const readerTabId = requireTabId('tab-reader');
        const outputTabId = requireTabId('tab-output');
        const baseCheckpoint: IWorkspaceCheckpoint = {
            version: 1,
            capturedAt: requireEpochMs(Date.now()),
            activePaneId: paneId,
            activeTabId: readerTabId,
            layout: {type: 'leaf', paneId},
            panes: [{paneId, tabIds: [readerTabId], activeTabId: readerTabId}],
            tabs: [{
                tabId: readerTabId,
                paneId,
                fileName: 'reader.pdf',
                sourceRef: readerPdf as never,
                workingCopyRef: null,
                isDirty: false,
                isDjvu: false,
                currentPage: 4,
                zoom: 1.25,
                zoomMode: 'custom',
            }],
        };
        const checkpointWithRecoveredOutput: IWorkspaceCheckpoint = {
            ...baseCheckpoint,
            capturedAt: requireEpochMs(Date.now() + 1),
            panes: [{paneId, tabIds: [readerTabId, outputTabId], activeTabId: readerTabId}],
            tabs: [
                ...baseCheckpoint.tabs,
                {
                    tabId: outputTabId,
                    paneId,
                    fileName: 'recovered — cleaned.pdf',
                    sourceRef: outputPdf as never,
                    workingCopyRef: null,
                    isDirty: false,
                    isDjvu: false,
                    currentPage: null,
                    zoom: null,
                    zoomMode: null,
                },
            ],
        };

        const docStore = store.getDocumentStore();
        const {port} = docStore;
        const firstWriteStarted = gate();
        const releaseFirstWrite = gate();
        let blockedOnce = false;
        docStore.port = {
            ...port,
            writeAtomic: async (path, bytes) => {
                if (!blockedOnce && path.startsWith('workspaces/')) {
                    blockedOnce = true;
                    firstWriteStarted.resolve();
                    await releaseFirstWrite.promise;
                }
                return port.writeAtomic(path, bytes);
            },
        };

        let firstSave: Promise<boolean> | undefined;
        let queuedSave: Promise<boolean> | undefined;
        try {
            firstSave = checkpoints.saveWorkspaceCheckpoint(baseCheckpoint, sender.id, sender as never);
            await firstWriteStarted.promise;

            // Reload 1 queues the checkpoint carrying the admitted background output tab.
            queuedSave = checkpoints.saveWorkspaceCheckpoint(checkpointWithRecoveredOutput, sender.id, sender as never);

            // Reload 2 begins before serialize() runs the queued save, clearing open-path grants.
            sender.emit('did-start-navigation', {}, 'http://localhost/', false, true);
            expect(() => requireOpenPath(outputPdf, sender as never)).toThrow('Path not allowed');

            releaseFirstWrite.resolve();
            expect(await firstSave).toBe(true);
            expect(await queuedSave).toBe(true);
        } finally {
            releaseFirstWrite.resolve();
            await Promise.allSettled([firstSave, queuedSave]);
            docStore.port = port;
        }

        const claimed = await checkpoints.claimWorkspaceCheckpoint(sender.id, sender as never);
        expect(claimed?.tabs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                tabId: readerTabId,
                fileName: 'reader.pdf',
                sourceRef: readerPdf,
                workingCopyRef: null,
            }),
            expect.objectContaining({
                tabId: outputTabId,
                fileName: 'recovered — cleaned.pdf',
                sourceRef: outputPdf,
                workingCopyRef: null,
            }),
        ]));
    });

    it('sanitizes an unadmitted sourceless tab to an empty tab instead of persisting a ghost tab, while keeping admitted and working-copy tabs', async () => {
        const {pdf: ownedPdf, entry} = await openPdf(176102);
        const admittedPdf = await writeTemp('admitted.pdf', ORIGINAL);
        const unadmittedPdf = await writeTemp('unadmitted.pdf', EDITED);
        expect(allowOpenPath(admittedPdf, 176102)).toBeTruthy();

        const paneId = requirePaneId('pane-1');
        const admittedTabId = requireTabId('tab-admitted');
        const ghostCandidateTabId = requireTabId('tab-ghost');
        const workingCopyTabId = requireTabId('tab-working');
        const workingCopyUnadmittedSourceTabId = requireTabId('tab-working-unadmitted');
        const secondOwned = await store.openDocumentFromFile(await writeTemp('owned-2.pdf', ORIGINAL), {ownerWebContentsId: 176102});

        const checkpoint: IWorkspaceCheckpoint = {
            version: 1,
            capturedAt: requireEpochMs(Date.now()),
            activePaneId: paneId,
            activeTabId: admittedTabId,
            layout: {type: 'leaf', paneId},
            panes: [{
                paneId,
                tabIds: [admittedTabId, ghostCandidateTabId, workingCopyTabId, workingCopyUnadmittedSourceTabId],
                activeTabId: admittedTabId,
            }],
            tabs: [
                {
                    tabId: admittedTabId,
                    paneId,
                    fileName: 'admitted.pdf',
                    sourceRef: admittedPdf as never,
                    workingCopyRef: null,
                    isDirty: false,
                    isDjvu: false,
                    currentPage: 2,
                    zoom: 1.5,
                    zoomMode: 'custom',
                },
                {
                    tabId: ghostCandidateTabId,
                    paneId,
                    fileName: 'unadmitted.pdf',
                    sourceRef: unadmittedPdf as never,
                    workingCopyRef: null,
                    isDirty: false,
                    isDjvu: true,
                    currentPage: 5,
                    zoom: 2,
                    zoomMode: 'custom',
                },
                {
                    tabId: workingCopyTabId,
                    paneId,
                    fileName: 'report.pdf',
                    sourceRef: ownedPdf as never,
                    workingCopyRef: entry.ref as never,
                    isDirty: false,
                    isDjvu: false,
                    currentPage: 1,
                    zoom: 1,
                    zoomMode: 'fit-width',
                },
                {
                    tabId: workingCopyUnadmittedSourceTabId,
                    paneId,
                    fileName: 'owned-2.pdf',
                    sourceRef: unadmittedPdf as never,
                    workingCopyRef: secondOwned.ref as never,
                    isDirty: false,
                    isDjvu: false,
                    currentPage: 3,
                    zoom: 1.25,
                    zoomMode: 'custom',
                },
            ],
        };

        expect(await checkpoints.saveWorkspaceCheckpoint(checkpoint, 176102)).toBe(true);
        const claimed = await checkpoints.claimWorkspaceCheckpoint(176103);

        expect(claimed?.tabs.find(tab => tab.tabId === admittedTabId)).toMatchObject({
            fileName: 'admitted.pdf',
            sourceRef: admittedPdf,
            workingCopyRef: null,
            currentPage: 2,
            zoom: 1.5,
            zoomMode: 'custom',
        });
        expect(claimed?.tabs.find(tab => tab.tabId === ghostCandidateTabId)).toEqual({
            tabId: ghostCandidateTabId,
            paneId,
            fileName: null,
            sourceRef: null,
            workingCopyRef: null,
            isDirty: false,
            isDjvu: false,
            currentPage: null,
            zoom: null,
            zoomMode: null,
        });
        expect(claimed?.tabs.find(tab => tab.tabId === workingCopyTabId)).toMatchObject({
            fileName: 'report.pdf',
            sourceRef: ownedPdf,
            workingCopyRef: entry.ref,
        });
        expect(claimed?.tabs.find(tab => tab.tabId === workingCopyUnadmittedSourceTabId)).toMatchObject({
            fileName: 'owned-2.pdf',
            sourceRef: null,
            workingCopyRef: secondOwned.ref,
            currentPage: 3,
        });
    });
});

describe('workspace checkpoint owner lifecycle', () => {
    function createLifecycleWebContents(id: number) {
        let destroyed = false;
        const emitter = new EventEmitter();
        return Object.assign(emitter, {
            id,
            isDestroyed: () => destroyed,
            destroy: () => {
                destroyed = true;
                emitter.emit('destroyed');
            },
        });
    }

    function makeCheckpoint(options: {
        fileName: string;
        sourceRef: string | null;
        workingCopyRef?: string | null;
        isDirty?: boolean;
        capturedAt?: number;
    }): IWorkspaceCheckpoint {
        const paneId = requirePaneId('pane-1');
        const tabId = requireTabId('tab-1');
        return {
            version: 1,
            capturedAt: requireEpochMs(options.capturedAt ?? Date.now()),
            activePaneId: paneId,
            activeTabId: tabId,
            layout: {type: 'leaf', paneId},
            panes: [{paneId, tabIds: [tabId], activeTabId: tabId}],
            tabs: [{
                tabId,
                paneId,
                fileName: options.fileName,
                sourceRef: options.sourceRef as never,
                workingCopyRef: (options.workingCopyRef ?? null) as never,
                isDirty: options.isDirty ?? false,
                isDjvu: false,
                currentPage: 1,
                zoom: 1,
                zoomMode: 'fit-width',
            }],
        };
    }

    it('clears owner state on destroyed so another window can recover and stale acknowledgements reject', async () => {
        const pdf = await writeTemp('owner-destroyed.pdf', ORIGINAL);
        const ownerA = createLifecycleWebContents(200101);
        const ownerB = createLifecycleWebContents(200102);
        expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();

        expect(await checkpoints.saveWorkspaceCheckpoint(makeCheckpoint({fileName: 'owner-destroyed.pdf', sourceRef: pdf}), ownerA.id, ownerA as never)).toBe(true);
        ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).not.toBeNull();

        expect(await checkpoints.hasRecoverableWorkspaceCheckpoints(ownerB.id, ownerB as never)).toBe(false);
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerB.id, ownerB as never)).toBeNull();

        ownerA.destroy();

        await expect(checkpoints.acknowledgeWorkspaceCheckpoint(ownerA.id, ownerA as never)).rejects.toThrow('not owned by this renderer');
        expect(await checkpoints.hasRecoverableWorkspaceCheckpoints(ownerB.id, ownerB as never)).toBe(true);
        const claimed = await checkpoints.claimWorkspaceCheckpoint(ownerB.id, ownerB as never);
        expect(claimed?.tabs[0]).toMatchObject({fileName: 'owner-destroyed.pdf', sourceRef: pdf});
        ownerB.destroy();
    });

    it('fences queued saves and concurrent claims when a closing window discards before destroyed, and rolls back if removal fails', async () => {
        const pdf = await writeTemp('close-fence.pdf', ORIGINAL);
        const ownerA = createLifecycleWebContents(200201);
        const ownerB = createLifecycleWebContents(200202);
        expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();
        const cp = makeCheckpoint({fileName: 'close-fence.pdf', sourceRef: pdf});
        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never)).toBe(true);

        const docStore = store.getDocumentStore();
        const {port} = docStore;
        const firstWriteStarted = gate();
        const releaseFirstWrite = gate();
        let blocked = false;
        docStore.port = {
            ...port,
            writeAtomic: async (path, bytes) => {
                if (!blocked && path.startsWith('workspaces/')) {
                    blocked = true;
                    firstWriteStarted.resolve();
                    await releaseFirstWrite.promise;
                }
                return port.writeAtomic(path, bytes);
            },
        };
        let inFlightSave: Promise<boolean> | undefined;
        let queuedSave: Promise<boolean> | undefined;
        let discardPromise: Promise<string> | undefined;
        let claimPromise: Promise<IWorkspaceCheckpoint | null> | undefined;
        try {
            inFlightSave = checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never);
            await firstWriteStarted.promise;
            queuedSave = checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never);
            discardPromise = checkpoints.discardWorkspaceCheckpoint(ownerA.id, ownerA as never);
            ownerA.destroy();
            claimPromise = checkpoints.claimWorkspaceCheckpoint(ownerB.id, ownerB as never);
            releaseFirstWrite.resolve();

            expect(await inFlightSave).toBe(true);
            expect(await queuedSave).toBe(false);
            expect(await discardPromise).toBeTruthy();
            expect(await claimPromise).toBeNull();
            expect(await port.list('workspaces')).toEqual([]);
        } finally {
            releaseFirstWrite.resolve();
            await Promise.allSettled([inFlightSave, queuedSave, discardPromise, claimPromise]);
            docStore.port = port;
        }

        // If checkpoint removal fails on close, rollback keeps recovery evidence claimable by another window.
        const ownerA2 = createLifecycleWebContents(200203);
        const ownerC = createLifecycleWebContents(200204);
        expect(allowOpenPath(pdf, ownerA2 as never)).toBeTruthy();
        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA2.id, ownerA2 as never)).toBe(true);
        docStore.port = {
            ...port,
            remove: target => (target.startsWith('workspaces/') ? Promise.reject(new Error('EACCES injected remove')) : port.remove(target)),
        };
        try {
            const failedDiscard = checkpoints.discardWorkspaceCheckpoint(ownerA2.id, ownerA2 as never);
            ownerA2.destroy();
            await expect(failedDiscard).rejects.toThrow('EACCES injected remove');
        } finally {
            docStore.port = port;
        }
        const recovered = await checkpoints.claimWorkspaceCheckpoint(ownerC.id, ownerC as never);
        expect(recovered?.tabs[0]).toMatchObject({fileName: 'close-fence.pdf', sourceRef: pdf});
        ownerB.destroy();
        ownerC.destroy();
    });

    it('handles restore-in-flight vs discard races and closes clean shown tabs only when not discarded', async () => {
        const pdf = await writeTemp('restore-race.pdf', ORIGINAL);
        const ownerA = createLifecycleWebContents(200301);
        expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();
        const cp = makeCheckpoint({fileName: 'restore-race.pdf', sourceRef: pdf});

        // 1. render-process-gone during restoring (without discard) blanks the clean shown tab and records notReopened.
        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never)).toBe(true);
        ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).not.toBeNull();
        ownerA.emit('render-process-gone');
        const reclaimed = await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never);
        expect(reclaimed?.tabs[0]).toMatchObject({fileName: null, sourceRef: null});
        expect(reclaimed?.notReopened).toEqual([{fileName: 'restore-race.pdf', sourceRef: pdf}]);
        expect(await checkpoints.acknowledgeWorkspaceCheckpoint(ownerA.id, ownerA as never)).toBe(true);

        // 2. discard before render-process-gone suppresses closeRestoreDocuments and keeps the checkpoint removed.
        expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();
        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never)).toBe(true);
        ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).not.toBeNull();
        const token = await checkpoints.discardWorkspaceCheckpoint(ownerA.id, ownerA as never);
        ownerA.emit('render-process-gone');
        await checkpoints.flushPendingWorkspaceCheckpointSave();
        expect(await store.getDocumentStore().port.list('workspaces')).toEqual([]);
        checkpoints.resumeWorkspaceCheckpoint(ownerA.id, token, ownerA as never);

        // 3. render-process-gone queued behind slow work, then discard before closeRestoreDocuments executes.
        expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();
        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never)).toBe(true);
        ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).not.toBeNull();
        const docStore = store.getDocumentStore();
        const {port} = docStore;
        const writeStarted = gate();
        const releaseWrite = gate();
        let blocked = false;
        docStore.port = {
            ...port,
            writeAtomic: async (path, bytes) => {
                if (!blocked && path.startsWith('workspaces/')) {
                    blocked = true;
                    writeStarted.resolve();
                    await releaseWrite.promise;
                }
                return port.writeAtomic(path, bytes);
            },
        };
        let blocker: Promise<boolean> | undefined;
        let discardPromise: Promise<string> | undefined;
        try {
            blocker = checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never);
            await writeStarted.promise;
            ownerA.emit('render-process-gone');
            discardPromise = checkpoints.discardWorkspaceCheckpoint(ownerA.id, ownerA as never);
            releaseWrite.resolve();
            await blocker;
            await discardPromise;
            await checkpoints.flushPendingWorkspaceCheckpointSave();
            expect(await port.list('workspaces')).toEqual([]);
        } finally {
            releaseWrite.resolve();
            await Promise.allSettled([blocker, discardPromise]);
            docStore.port = port;
        }
        ownerA.destroy();
    });

    it.each(['reopen', 'source-remove'] as const)('aborts a mid-flight claim during %s when the claimant discards and preserves another window\'s dirty checkpoint', async (pauseStage) => {
        const ownerB = createLifecycleWebContents(pauseStage === 'reopen' ? 200401 : 200411);
        const ownerA = createLifecycleWebContents(pauseStage === 'reopen' ? 200402 : 200412);
        const ownerC = createLifecycleWebContents(pauseStage === 'reopen' ? 200403 : 200413);
        const {pdf, entry} = await openPdf(ownerB.id);
        await store.commitDocumentMutation(entry, '1' as never, {kind: 'rewrite', source: await writeTemp(`dirty-mid-claim-${pauseStage}.pdf`, EDITED)}, 'write');
        const cp = makeCheckpoint({
            fileName: 'report.pdf',
            sourceRef: pdf,
            workingCopyRef: entry.ref,
            isDirty: true,
        });
        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerB.id, ownerB as never)).toBe(true);
        ownerB.destroy();
        await restart();

        const docStore = store.getDocumentStore();
        const {port} = docStore;
        const pausedAtStage = gate();
        const releaseStage = gate();
        const manifestPath = `documents/${entry.doc.id}/manifest.json`;
        let pausedOnce = false;
        let reads = 0;
        docStore.port = pauseStage === 'reopen'
            ? {
                ...port,
                read: async (path) => {
                    if (path === manifestPath) {
                        reads += 1;
                        // First read is holdsUnsavedWork; pause on reopenStoredDocument's read.
                        if (!pausedOnce && reads >= 2) {
                            pausedOnce = true;
                            pausedAtStage.resolve();
                            await releaseStage.promise;
                        }
                    }
                    return port.read(path);
                },
            }
            : {
                ...port,
                remove: async (target) => {
                    if (!pausedOnce && target.startsWith('workspaces/')) {
                        pausedOnce = true;
                        pausedAtStage.resolve();
                        await releaseStage.promise;
                    }
                    return port.remove(target);
                },
            };
        let claimA: Promise<IWorkspaceCheckpoint | null> | undefined;
        let discardA: Promise<string> | undefined;
        try {
            claimA = checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never);
            await pausedAtStage.promise;
            discardA = checkpoints.discardWorkspaceCheckpoint(ownerA.id, ownerA as never);
            ownerA.destroy();
            releaseStage.resolve();

            expect(await claimA).toBeNull();
            await discardA;
            // Neither working copy nor bytes should be left owned by the closing window A.
            expect(store.getWorkingCopyBackingEntry(entry.ref, ownerA.id)).toBeNull();
            expect(await store.cleanupWorkingCopy(entry.ref, ownerA.id)).toBe(false);
        } finally {
            releaseStage.resolve();
            await Promise.allSettled([claimA, discardA]);
            docStore.port = port;
        }

        const recovered = await checkpoints.claimWorkspaceCheckpoint(ownerC.id, ownerC as never);
        expect(recovered?.tabs[0]).toMatchObject({workingCopyRef: entry.ref, sourceRef: pdf, isDirty: true});
        expect(await readAll(store.requireOpenDocument(entry.ref, ownerC.id))).toEqual(EDITED);
        ownerC.destroy();
    });

    it('enforces single-claim per load, reload re-claim, mid-claim reload, and discard/resume token validation', async () => {
        const pdf = await writeTemp('reclaim-lifecycle.pdf', ORIGINAL);
        const ownerA = createLifecycleWebContents(200501);
        expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();
        const cp = makeCheckpoint({fileName: 'reclaim-lifecycle.pdf', sourceRef: pdf});

        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never)).toBe(true);
        ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).not.toBeNull();
        // Already claimed in current load.
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).toBeNull();
        expect(await checkpoints.acknowledgeWorkspaceCheckpoint(ownerA.id, ownerA as never)).toBe(true);
        // Clean checkpoint was removed on acknowledge; second acknowledge in the same load stays valid and returns false.
        expect(await checkpoints.acknowledgeWorkspaceCheckpoint(ownerA.id, ownerA as never)).toBe(false);

        // Reload resets claim state so stale acknowledge rejects and a saved checkpoint can be re-claimed.
        expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();
        expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never)).toBe(true);
        ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        await expect(checkpoints.acknowledgeWorkspaceCheckpoint(ownerA.id, ownerA as never)).rejects.toThrow('not owned by this renderer');
        expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).not.toBeNull();

        // Discard token supersedes earlier tokens and resumes cleanly.
        const token1 = await checkpoints.discardWorkspaceCheckpoint(ownerA.id, ownerA as never);
        const token2 = await checkpoints.discardWorkspaceCheckpoint(ownerA.id, ownerA as never);
        expect(() => checkpoints.resumeWorkspaceCheckpoint(ownerA.id, token1, ownerA as never)).toThrow('stale or invalid');
        checkpoints.resumeWorkspaceCheckpoint(ownerA.id, token2, ownerA as never);
        expect(() => checkpoints.resumeWorkspaceCheckpoint(ownerA.id, token2, ownerA as never)).toThrow('stale or invalid');

        // A main-frame navigation arriving while claimWorkspaceCheckpoint is reading or writing does not block the reloaded page from re-claiming.
        for (const pauseOn of ['read', 'write'] as const) {
            expect(allowOpenPath(pdf, ownerA as never)).toBeTruthy();
            expect(await checkpoints.saveWorkspaceCheckpoint(cp, ownerA.id, ownerA as never)).toBe(true);
            ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
            const docStore = store.getDocumentStore();
            const {port} = docStore;
            const reached = gate();
            const release = gate();
            let paused = false;
            docStore.port = pauseOn === 'read'
                ? {
                    ...port,
                    list: async (path) => {
                        if (!paused && path === 'workspaces') {
                            paused = true;
                            reached.resolve();
                            await release.promise;
                        }
                        return port.list(path);
                    },
                }
                : {
                    ...port,
                    writeAtomic: async (path, bytes) => {
                        if (!paused && path.startsWith('workspaces/')) {
                            paused = true;
                            reached.resolve();
                            await release.promise;
                        }
                        return port.writeAtomic(path, bytes);
                    },
                };
            let firstClaim: Promise<IWorkspaceCheckpoint | null> | undefined;
            try {
                firstClaim = checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never);
                await reached.promise;
                ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
                release.resolve();
                expect(await firstClaim).not.toBeNull();
            } finally {
                release.resolve();
                await Promise.allSettled([firstClaim]);
                docStore.port = port;
            }
            expect(await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).not.toBeNull();
            expect(await checkpoints.acknowledgeWorkspaceCheckpoint(ownerA.id, ownerA as never)).toBe(true);
        }
        ownerA.destroy();
    });

    it('restores a claimant\'s prior checkpoint on source-removal failure, rolls back failed mid-read discard to live, and releases working copies on tab-claim error', async () => {
        // 1. Live window claiming a newer orphan restores its own prior checkpoint when removing the orphan fails.
        const ownPdf = await writeTemp('own-layout.pdf', ORIGINAL);
        const orphanPdf = await writeTemp('orphan-layout.pdf', EDITED);
        const ownerA = createLifecycleWebContents(200601);
        const ownerB = createLifecycleWebContents(200602);
        expect(allowOpenPath(ownPdf, ownerA as never)).toBeTruthy();
        expect(allowOpenPath(orphanPdf, ownerB as never)).toBeTruthy();
        const now = Date.now();
        expect(await checkpoints.saveWorkspaceCheckpoint(makeCheckpoint({fileName: 'own-layout.pdf', sourceRef: ownPdf, capturedAt: now}), ownerA.id, ownerA as never)).toBe(true);
        expect(await checkpoints.saveWorkspaceCheckpoint(makeCheckpoint({fileName: 'orphan-layout.pdf', sourceRef: orphanPdf, capturedAt: now + 100}), ownerB.id, ownerB as never)).toBe(true);
        ownerB.destroy();

        const docStore = store.getDocumentStore();
        const {port} = docStore;
        const removeSpy = vi.spyOn(port, 'remove').mockRejectedValueOnce(new Error('EACCES remove orphan'));
        await expect(checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never)).rejects.toThrow('EACCES remove orphan');
        removeSpy.mockRestore();

        // Both the orphan and ownerA's prior layout survive intact.
        const ownerC = createLifecycleWebContents(200603);
        const claimedOrphan = await checkpoints.claimWorkspaceCheckpoint(ownerC.id, ownerC as never);
        expect(claimedOrphan?.tabs[0]).toMatchObject({fileName: 'orphan-layout.pdf', sourceRef: orphanPdf});
        ownerA.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        const claimedOwn = await checkpoints.claimWorkspaceCheckpoint(ownerA.id, ownerA as never);
        expect(claimedOwn?.tabs[0]).toMatchObject({fileName: 'own-layout.pdf', sourceRef: ownPdf});
        expect(await checkpoints.acknowledgeWorkspaceCheckpoint(ownerA.id, ownerA as never)).toBe(true);
        expect(await checkpoints.acknowledgeWorkspaceCheckpoint(ownerC.id, ownerC as never)).toBe(true);
        ownerA.destroy();
        ownerC.destroy();

        // 2. A discard that starts while an initial claim is paused on read and then fails rolls back to live (not claimed).
        const ownerD = createLifecycleWebContents(200604);
        expect(allowOpenPath(ownPdf, ownerD as never)).toBeTruthy();
        expect(await checkpoints.saveWorkspaceCheckpoint(makeCheckpoint({fileName: 'own-layout.pdf', sourceRef: ownPdf}), ownerD.id, ownerD as never)).toBe(true);
        ownerD.emit('did-start-navigation', {}, 'http://localhost/', false, true);
        const listReached = gate();
        const releaseList = gate();
        let paused = false;
        docStore.port = {
            ...port,
            list: async (path) => {
                if (!paused && path === 'workspaces') {
                    paused = true;
                    listReached.resolve();
                    await releaseList.promise;
                }
                return port.list(path);
            },
            remove: target => (target.startsWith('workspaces/') ? Promise.reject(new Error('EACCES discard')) : port.remove(target)),
        };
        let pausedClaim: Promise<IWorkspaceCheckpoint | null> | undefined;
        let failedDiscard: Promise<string> | undefined;
        try {
            pausedClaim = checkpoints.claimWorkspaceCheckpoint(ownerD.id, ownerD as never);
            await listReached.promise;
            failedDiscard = checkpoints.discardWorkspaceCheckpoint(ownerD.id, ownerD as never);
            releaseList.resolve();
            expect(await pausedClaim).toBeNull();
            await expect(failedDiscard).rejects.toThrow('EACCES discard');
        } finally {
            releaseList.resolve();
            await Promise.allSettled([pausedClaim, failedDiscard]);
            docStore.port = port;
        }
        await expect(checkpoints.acknowledgeWorkspaceCheckpoint(ownerD.id, ownerD as never)).rejects.toThrow('not owned by this renderer');
        const retried = await checkpoints.claimWorkspaceCheckpoint(ownerD.id, ownerD as never);
        expect(retried?.tabs[0]).toMatchObject({fileName: 'own-layout.pdf', sourceRef: ownPdf});
        expect(await checkpoints.acknowledgeWorkspaceCheckpoint(ownerD.id, ownerD as never)).toBe(true);
        ownerD.destroy();

        // 3. A multi-tab claim error waits for slower sibling reopens before rolling back all working copies.
        const ownerE = createLifecycleWebContents(200605);
        const ownerF = createLifecycleWebContents(200606);
        const ownerG = createLifecycleWebContents(200607);
        const {pdf: dirtyPdf1, entry: dirtyEntry1} = await openPdf(ownerE.id);
        const dirtyPdf2 = await writeTemp('second-dirty.pdf', ORIGINAL);
        const dirtyEntry2 = await store.openDocumentFromFile(dirtyPdf2, {ownerWebContentsId: ownerE.id});
        await store.commitDocumentMutation(dirtyEntry1, '1' as never, {kind: 'rewrite', source: await writeTemp('tab-error-1.pdf', EDITED)}, 'write');
        await store.commitDocumentMutation(dirtyEntry2, '1' as never, {kind: 'rewrite', source: await writeTemp('tab-error-2.pdf', EDITED)}, 'write');
        const paneId = requirePaneId('pane-1');
        const tab1Id = requireTabId('tab-1');
        const tab2Id = requireTabId('tab-2');
        expect(await checkpoints.saveWorkspaceCheckpoint({
            version: 1,
            capturedAt: requireEpochMs(Date.now()),
            activePaneId: paneId,
            activeTabId: tab1Id,
            layout: {type: 'leaf', paneId},
            panes: [{paneId, tabIds: [tab1Id, tab2Id], activeTabId: tab1Id}],
            tabs: [
                {
                    tabId: tab1Id, paneId, fileName: 'report.pdf', sourceRef: dirtyPdf1 as never,
                    workingCopyRef: dirtyEntry1.ref as never, isDirty: true, isDjvu: false, currentPage: 1, zoom: 1, zoomMode: 'fit-width',
                },
                {
                    tabId: tab2Id, paneId, fileName: 'second-dirty.pdf', sourceRef: dirtyPdf2 as never,
                    workingCopyRef: dirtyEntry2.ref as never, isDirty: true, isDjvu: false, currentPage: 1, zoom: 1, zoomMode: 'fit-width',
                },
            ],
        }, ownerE.id, ownerE as never)).toBe(true);
        ownerE.destroy();
        await restart();
        await store.collectStaleDocuments();

        const reopenStore = store.getDocumentStore();
        const realPort = reopenStore.port;
        const slowManifest = `documents/${dirtyEntry2.doc.id}/manifest.json`;
        const slowReached = gate();
        const releaseSlow = gate();
        let slowReads = 0;
        reopenStore.port = {
            ...realPort,
            read: async (path) => {
                if (path === slowManifest && ++slowReads === 2) {
                    slowReached.resolve();
                    await releaseSlow.promise;
                }
                return realPort.read(path);
            },
        };
        const noticesModule = await import('@electron/file-access/keptOriginalNotices');
        const noticeSpy = vi.spyOn(noticesModule, 'findKeptOriginal').mockImplementationOnce(async () => {
            await slowReached.promise;
            setTimeout(() => releaseSlow.resolve(), 10);
            throw new Error('EIO kept-original lookup');
        });
        try {
            await expect(checkpoints.claimWorkspaceCheckpoint(ownerF.id, ownerF as never)).rejects.toThrow('EIO kept-original lookup');
        } finally {
            releaseSlow.resolve();
            noticeSpy.mockRestore();
            reopenStore.port = realPort;
        }
        expect(store.getWorkingCopyBackingEntry(dirtyEntry1.ref, ownerF.id)).toBeNull();
        expect(store.getWorkingCopyBackingEntry(dirtyEntry2.ref, ownerF.id)).toBeNull();
        expect(await store.cleanupWorkingCopy(dirtyEntry1.ref, ownerF.id)).toBe(false);
        expect(await store.cleanupWorkingCopy(dirtyEntry2.ref, ownerF.id)).toBe(false);
        ownerF.destroy();

        const recoveredAfterTabError = await checkpoints.claimWorkspaceCheckpoint(ownerG.id, ownerG as never);
        expect(recoveredAfterTabError?.tabs).toEqual(expect.arrayContaining([
            expect.objectContaining({workingCopyRef: dirtyEntry1.ref, sourceRef: dirtyPdf1, isDirty: true}),
            expect.objectContaining({workingCopyRef: dirtyEntry2.ref, sourceRef: dirtyPdf2, isDirty: true}),
        ]));
        expect(await readAll(store.requireOpenDocument(dirtyEntry1.ref, ownerG.id))).toEqual(EDITED);
        expect(await readAll(store.requireOpenDocument(dirtyEntry2.ref, ownerG.id))).toEqual(EDITED);
        ownerG.destroy();
    });

    it('restores the adopted Save As destination on restart when Save As wrote copy.pdf but manifest acknowledgement failed', async () => {
        const originalPdf = await writeTemp('restart-saveas-original.pdf', ORIGINAL);
        const copyPdf = join(tempRoot, 'restart-saveas-copy.pdf');
        const editedSrc = await writeTemp('restart-saveas-edited.pdf', EDITED);

        const ownerA = createLifecycleWebContents(200901);
        const ownerB = createLifecycleWebContents(200902);
        const entry = await store.openDocumentFromFile(originalPdf, {ownerWebContentsId: ownerA.id});
        await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: editedSrc}, 'write');

        await checkpoints.saveWorkspaceCheckpoint(makeCheckpoint({
            fileName: 'restart-saveas-original.pdf',
            sourceRef: originalPdf,
            workingCopyRef: entry.ref,
            isDirty: true,
        }), ownerA.id, ownerA as never);

        const docStore = store.getDocumentStore();
        const realWriteAtomic = docStore.port.writeAtomic.bind(docStore.port);
        let sawStagedPending = false;
        let injected = false;
        vi.spyOn(docStore.port, 'writeAtomic').mockImplementation(async (target, bytes) => {
            if (target.endsWith('manifest.json')) {
                const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {pendingPublish?: {witness?: string}};
                if (parsed.pendingPublish?.witness !== undefined) {
                    sawStagedPending = true;
                } else if (sawStagedPending && !injected) {
                    injected = true;
                    throw new Error('ENOSPC: Save As manifest ack failed');
                }
            }
            return realWriteAtomic(target, bytes);
        });

        await expect(store.saveOpenDocument(entry, store.documentRevisionToken(entry), {saveAs: copyPdf})).rejects.toThrow('ENOSPC');
        expect(injected).toBe(true);
        expect(await readFile(copyPdf)).toEqual(Buffer.from(EDITED));
        vi.restoreAllMocks();

        // Simulate immediate restart: close open handles, reset store state on the same root, and claim checkpoint.
        ownerA.destroy();
        await restart();

        const claimed = await checkpoints.claimWorkspaceCheckpoint(ownerB.id, ownerB as never);
        expect(claimed?.tabs[0]).toMatchObject({
            isDirty: false,
            workingCopyRef: null,
            sourceRef: copyPdf,
            fileName: 'restart-saveas-copy.pdf',
        });
        ownerB.destroy();
    });
});
