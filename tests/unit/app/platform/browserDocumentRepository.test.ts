import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    expect,
    it,
    vi,
} from 'vitest';
import { BrowserDocumentStore } from '@app/platform/browser/browserDocumentRepository';
import {
    browserPublication,
    rememberFileHandle,
} from '@app/platform/browser/browserPublication';
import { openDocument } from '@document-store/documentDirectory';
import { createNodeStorePort } from '@document-store/nodeStorePort';
import { createFileSystemFileHandle } from '@tests/unit/app/platform/browserPlatformTestDoubles';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const roots: string[] = [];
const repositories: BrowserDocumentStore[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(repositories.splice(0).flatMap(repo => repo.openEntries().map(entry => entry.doc?.close())));
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

/** The repository over a store in a temporary directory, through the core's Node port: Node has no origin private file system. */
async function repository() {
    const repo = new BrowserDocumentStore();
    repositories.push(repo);
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'browser-repository-'));
    roots.push(root);
    const store = {port: createNodeStorePort(root), publication: browserPublication};
    vi.spyOn(repo, 'stores').mockResolvedValue({durable: store, memory: store});
    return {repo, store};
}

/** A file the person picked, which another program may write too: `disk` holds its bytes and modification time. */
function pickedFile(name: string, text: string) {
    const disk = {bytes: encode(text), lastModified: 100, afterClose: () => {}};
    const file = () => new File([disk.bytes], name, {lastModified: disk.lastModified});
    const handle: FileSystemFileHandle = {
        ...createFileSystemFileHandle({name, getFile: async () => file()}),
        createWritable: async () => {
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            return Object.assign(new WritableStream(), {
                write: async (chunk: FileSystemWriteChunkType) => {
                    if (!(chunk instanceof ArrayBuffer)) throw new TypeError('The fixture takes ArrayBuffer chunks');
                    chunks.push(new Uint8Array(chunk));
                },
                close: async () => {
                    disk.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
                    disk.lastModified += 1;
                    disk.afterClose();
                },
                abort: async () => {},
                seek: async () => {},
                truncate: async () => {},
            }) satisfies FileSystemWritableFileStream;
        },
    };
    return {disk, handle, file};
}

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return {promise, resolve};
}

/** Appends `text` past the revision `token` names, uncommitted, as a native edit does. */
async function stageText(repo: BrowserDocumentStore, ref: string, token: Parameters<BrowserDocumentStore['stageAppend']>[1], text: string) {
    const lease = await repo.stageAppend(ref, token, async (file, base) => {
        await file.writeAt(base, encode(text));
        return base + encode(text).byteLength;
    });
    if (lease === null) throw new Error('Nothing was staged');
    return lease;
}

async function workingDocument(repo: BrowserDocumentStore, text: string) {
    const ref = await repo.createStoredDocument('test.pdf', encode(text), {mimeType: 'application/pdf', kind: 'working'});
    const entry = await repo.requireEntry(ref);
    return {ref, entry, doc: entry.doc!};
}

it('keeps the edits a failed Save committed as the current work and tells every window, through pruning and reopening', async () => {
    const {repo, store} = await repository();
    const {ref, entry, doc} = await workingDocument(repo, 'old bytes');
    await doc.setDrafts(1, {note: 'unsaved note'});
    const events: string[] = [];
    repo.onDocumentRevisionChanged(event => events.push(`${event.reason} ${event.token}`));
    vi.spyOn(browserPublication, 'publish').mockRejectedValue(new Error('publication failed'));

    const lease = await stageText(repo, ref, repo.tokenOf(entry), ' committed save edits');
    await expect(repo.save(ref, repo.tokenOf(entry), {commit: lease, saveAs: 'download:test.pdf'})).rejects.toThrow('publication failed');
    expect(events).toEqual([`save-sync ${repo.tokenOf(entry)}`]);
    await repo.retainRevisions(ref, []);
    await doc.close();

    const reopened = await openDocument(store, doc.id);
    expect(decode(await reopened.read(0, 100))).toBe('old bytes committed save edits');
    expect(reopened.state().dirty).toBe(true);
    await reopened.close();
});

it('leaves a Save its file\'s change refused on the revision it committed, so Save As writes the edits once', async () => {
    const {repo} = await repository();
    const picked = pickedFile('picked.pdf', 'base');
    const working = await repo.cloneAsWorkingCopy(await repo.registerFile(picked.file(), {saveHandle: picked.handle}));
    const entry = await repo.requireEntry(working);
    const token = repo.tokenOf(entry);
    const events: string[] = [];
    repo.onDocumentRevisionChanged(event => events.push(event.token));
    const publish = browserPublication.publish.bind(browserPublication);
    vi.spyOn(browserPublication, 'publish').mockImplementationOnce(async (...args) => {
        picked.disk.bytes = encode('changed elsewhere');
        picked.disk.lastModified = 200;
        return publish(...args);
    });

    const lease = await stageText(repo, working, token, ' new save bytes');
    expect(await repo.save(working, token, {commit: lease})).toEqual({status: 'conflict'});
    const committed = repo.tokenOf(entry);
    expect(committed).not.toBe(token);
    expect(events).toEqual([committed]);
    expect(decode(picked.disk.bytes)).toBe('changed elsewhere');

    const copy = pickedFile('copy.pdf', '');
    rememberFileHandle('copy', copy.handle);
    expect(await repo.save(working, committed, {saveAs: 'handle:copy'})).toMatchObject({status: 'saved'});
    expect(decode(copy.disk.bytes)).toBe('base new save bytes');
});

it('leaves an edit committed before a stale Save in place', async () => {
    const {repo} = await repository();
    const {ref, entry, doc} = await workingDocument(repo, 'old bytes');
    const token = repo.tokenOf(entry);
    const lease = await stageText(repo, ref, token, ' stale save');
    const entered = gate();
    const resume = gate();
    const edit = doc.run(async () => {
        entered.resolve();
        await resume.promise;
        return doc.applyMutation(1, {kind: 'rewrite', source: new Blob(['other committed edit']), drafts: 'keep'});
    });
    await entered.promise;
    const queued = gate();
    const run = doc.run.bind(doc);
    vi.spyOn(doc, 'run').mockImplementation(task => {
        queued.resolve();
        return run(task);
    });

    const save = repo.save(ref, token, {commit: lease, saveAs: 'download:test.pdf'}).catch(() => undefined);
    await queued.promise;
    resume.resolve();
    await edit;
    await save;
    await repo.retainRevisions(ref, []);

    expect(decode(await repo.read(ref))).toBe('other committed edit');
});

it('refuses to acknowledge a Save when another program wrote the file right after it, so the next Save keeps that write', async () => {
    const {repo} = await repository();
    const picked = pickedFile('picked.pdf', 'base');
    const working = await repo.cloneAsWorkingCopy(await repo.registerFile(picked.file(), {saveHandle: picked.handle}));
    const entry = await repo.requireEntry(working);
    picked.disk.afterClose = () => {
        picked.disk.afterClose = () => {};
        picked.disk.bytes = encode('FOREIGN distinct length edit');
        picked.disk.lastModified += 1;
    };

    const first = await stageText(repo, working, repo.tokenOf(entry), ' EVB B');
    expect(await repo.save(working, repo.tokenOf(entry), {commit: first})).toEqual({status: 'conflict'});
    const next = await stageText(repo, working, repo.tokenOf(entry), ' EVB D next save');
    expect(await repo.save(working, repo.tokenOf(entry), {commit: next})).toEqual({status: 'conflict'});
    expect(decode(picked.disk.bytes)).toBe('FOREIGN distinct length edit');
    expect(decode(await repo.read(working))).toBe('base EVB B EVB D next save');
});

it('leaves the document openable with its old bytes when replacing its content fails, and replaces it cleanly otherwise', async () => {
    const {repo, store} = await repository();
    const {ref, doc} = await workingDocument(repo, 'old bytes');
    const source = await repo.createStoredDocument('source.pdf', encode('replacement'), {mimeType: 'application/pdf'});
    const writeAtomic = store.port.writeAtomic.bind(store.port);
    const full = vi.spyOn(store.port, 'writeAtomic').mockImplementation(async (path, bytes) => {
        if (path === doc.path('manifest.json')) throw new DOMException('The store is full', 'QuotaExceededError');
        return writeAtomic(path, bytes);
    });

    await expect(repo.replaceContent(ref, source)).rejects.toThrow('full');
    full.mockRestore();
    await doc.close();
    const reopened = await openDocument(store, doc.id);
    expect(decode(await reopened.read(0, 100))).toBe('old bytes');
    await reopened.close();

    const {ref: other, doc: otherDoc} = await workingDocument(repo, 'other old bytes');
    await repo.replaceContent(other, source);
    expect(decode(await repo.read(other))).toBe('replacement');
    expect(otherDoc.state()).toMatchObject({dirty: false, history: []});
});
