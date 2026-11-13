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

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

/** The repository over a store in a temporary directory, through the core's Node port: Node has no origin private file system. */
async function repository() {
    const repo = new BrowserDocumentStore();
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

    await expect(repo.save(ref, repo.tokenOf(entry), {commit: encode('committed save edits'), saveAs: 'download:test.pdf'})).rejects.toThrow('publication failed');
    expect(events).toEqual([`save-sync ${repo.tokenOf(entry)}`]);
    await repo.retainRevisions(ref, []);
    await doc.close();

    const reopened = await openDocument(store, doc.id);
    expect(decode(await reopened.read(0, 100))).toBe('committed save edits');
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

    expect(await repo.save(working, token, {commit: encode('new save bytes')})).toEqual({status: 'conflict'});
    const committed = repo.tokenOf(entry);
    expect(committed).not.toBe(token);
    expect(events).toEqual([committed]);
    expect(decode(picked.disk.bytes)).toBe('changed elsewhere');

    const copy = pickedFile('copy.pdf', '');
    rememberFileHandle('copy', copy.handle);
    expect(await repo.save(working, committed, {saveAs: 'handle:copy'})).toMatchObject({status: 'saved'});
    expect(decode(copy.disk.bytes)).toBe('new save bytes');
});

it('leaves an edit committed before a stale Save in place', async () => {
    const {repo} = await repository();
    const {ref, entry, doc} = await workingDocument(repo, 'old bytes');
    const token = repo.tokenOf(entry);
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

    const save = repo.save(ref, token, {commit: encode('stale save'), saveAs: 'download:test.pdf'}).catch(() => undefined);
    await queued.promise;
    resume.resolve();
    await edit;
    await save;
    await repo.retainRevisions(ref, []);

    expect(decode(await repo.read(ref))).toBe('other committed edit');
});
