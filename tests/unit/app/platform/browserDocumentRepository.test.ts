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
import { contentWitness } from '@document-store/contentWitness';
import { openDocument } from '@document-store/documentDirectory';
import { createNodeStorePort } from '@document-store/nodeStorePort';
import { BROWSER_DOCUMENT_CHUNK_SIZE } from '@app/platform/browser/browserDocumentConstants';
import { createMemoryStorePort } from '@app/platform/browser/browserStorePort';
import { createFileSystemFileHandle } from '@tests/unit/app/platform/browserPlatformTestDoubles';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const roots: string[] = [];
const repositories: BrowserDocumentStore[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    try {
        // Releasing ends a stream a failed test left open before the entry's directory closes.
        await Promise.all(repositories.splice(0).flatMap(repo => repo.openEntries().map(entry => repo.release(entry.ref))));
    } finally {
        await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
    }
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

it('hashes the file a Save wrote while it holds the origin\'s publication lock, so no other Save writes the file meanwhile', async () => {
    const {repo} = await repository();
    const picked = pickedFile('locked.pdf', 'base');
    const working = await repo.cloneAsWorkingCopy(await repo.registerFile(picked.file(), {saveHandle: picked.handle}));
    const entry = await repo.requireEntry(working);
    const publishLockHeld: boolean[] = [];
    let written = false;
    picked.disk.afterClose = () => {
        written = true;
    };
    // Each range read of the written file asks the origin's locks first, while its read is still pending.
    const getFile = picked.handle.getFile.bind(picked.handle);
    picked.handle.getFile = async () => {
        const file = await getFile();
        if (!written) return file;
        const slice = file.slice.bind(file);
        return Object.assign(file, {
            slice: (...range: Parameters<Blob['slice']>) => Object.assign(slice(...range), {
                async arrayBuffer() {
                    const {held = []} = await navigator.locks.query();
                    publishLockHeld.push(held.some(lock => lock.name === 'evb-viewer:browser-publish'));
                    return Blob.prototype.arrayBuffer.call(slice(...range));
                },
            }),
        });
    };

    const lease = await stageText(repo, working, repo.tokenOf(entry), ' saved');
    expect(await repo.save(working, repo.tokenOf(entry), {commit: lease})).toMatchObject({status: 'saved'});
    expect(decode(picked.disk.bytes)).toBe('base saved');
    expect(publishLockHeld).toEqual([true]);
    // The witness recorded for the file is its content's, the same one the revision file itself hashes to.
    expect(entry.doc!.snapshot().baseline).toContain(await contentWitness(picked.disk.bytes.byteLength, async (offset, length) => picked.disk.bytes.subarray(offset, offset + length)));
});

it('refuses a streamed document the full browser store cut short, rather than keeping what was left of the stream in memory', async () => {
    const {repo, store} = await repository();
    const memory = {port: createMemoryStorePort(), publication: browserPublication};
    const open = store.port.open.bind(store.port);
    // The browser's store fills up after the first batch reached it.
    const full = {...store.port, open: async (path: string) => {
        const file = await open(path);
        let batches = 0;
        return {...file, writeAt: async (offset: number, bytes: Uint8Array) => {
            if (++batches > 1) throw new DOMException('The browser\'s storage is full', 'QuotaExceededError');
            await file.writeAt(offset, bytes);
        }};
    }};
    vi.spyOn(repo, 'stores').mockResolvedValue({durable: {port: full, publication: browserPublication}, memory});
    const bytes = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE * 2 + 5).fill(7);
    const stream = new Blob([bytes]).stream();

    await expect(repo.createStoredDocument('streamed.pdf', stream, {mimeType: 'application/pdf'})).rejects.toThrow('A streamed document can be stored only once');
    expect(await memory.port.list('documents')).toEqual([]);
    expect(repo.openEntries()).toEqual([]);
});

it('leaves the document openable with its old bytes when replacing its content fails, and replaces it cleanly otherwise, a file or not', async () => {
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

    // A stored copy can have a destination, such as a working copy a tab names as its source after a download.
    const picked = pickedFile('picked.pdf', 'picked bytes');
    const withFile = await repo.cloneAsWorkingCopy(await repo.registerFile(picked.file(), {saveHandle: picked.handle}));
    await repo.replaceContent(withFile, source);
    expect(decode(await repo.read(withFile))).toBe('replacement');
    expect((await repo.requireEntry(withFile)).doc!.state()).toMatchObject({destination: expect.any(String), dirty: false, history: []});
});

it('#1609 reports a failed IndexedDB handle write while keeping the current session binding', async () => {
    const {fileHandleStore} = await import('@app/platform/browser/browserFileHandleStore');
    const {storeFileHandle, resolveFileHandle} = await import('@app/platform/browser/browserPublication');
    const {BrowserLogger} = await import('@app/utils/browserLogger');
    const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(BrowserLogger, 'error');
    vi.spyOn(fileHandleStore, 'put').mockRejectedValue(new Error('QuotaExceededError injected handle write'));
    const {handle} = pickedFile('handle-write.pdf', 'saved bytes');
    await storeFileHandle('saved-handle-key', handle);
    expect(await resolveFileHandle('saved-handle-key')).toBe(handle);
    const diagnostics = [...warn.mock.calls, ...error.mock.calls].map(args => JSON.stringify(args, (_key, value: unknown) => value instanceof Error ? value.message : value)).join('\n');
    expect.soft(diagnostics).toContain('saved-handle-key');
    expect(diagnostics).toContain('QuotaExceededError injected handle write');
});


it('pairs a readable Blob only with the revision whose bytes it holds, even across an edit undone while it was read', async () => {
    const {repo} = await repository();
    const {ref, entry, doc} = await workingDocument(repo, 'revision A');
    const revisionA = repo.tokenOf(entry);
    const blobText = async (blob: Blob) => decode(new Uint8Array(await blob.arrayBuffer()));
    // An edit lands as the Blob is read, and is undone before the Blob is handed over.
    const read = doc.read.bind(doc);
    vi.spyOn(doc, 'read').mockImplementationOnce(async (offset, length) => {
        await repo.write(ref, encode('revision B'), {expectedDocumentRevisionToken: revisionA});
        const bytes = await read(offset, length);
        await repo.restoreRevision(ref, revisionA, repo.tokenOf(entry));
        return bytes;
    });

    await expect(repo.readableRevision(ref)).rejects.toMatchObject({code: 'STALE_REVISION'});
    expect(repo.tokenOf(entry)).toBe(revisionA);
    const {blob, token} = await repo.readableRevision(ref);
    expect([await blobText(blob), token]).toEqual(['revision A', revisionA]);
    // Read for a revision the document has left, it refuses too.
    await repo.write(ref, encode('revision C'), {expectedDocumentRevisionToken: revisionA});
    await expect(repo.readableRevision(ref, {token: revisionA})).rejects.toMatchObject({code: 'STALE_REVISION'});
});

it('#1609 explains browser undo refusal when Save could not retain the opened bytes', async () => {
    const {repo, store} = await repository();
    const picked = pickedFile('picked.pdf', 'opened bytes');
    const ref = await repo.cloneAsWorkingCopy(await repo.registerFile(picked.file(), {saveHandle: picked.handle}));
    const entry = await repo.requireEntry(ref);
    const opened = repo.tokenOf(entry);
    await repo.write(ref, encode('edited bytes'), {expectedDocumentRevisionToken: opened});
    const copyIn = store.port.copyIn.bind(store.port);
    vi.spyOn(store.port, 'copyIn').mockImplementation((source, target) => target.endsWith('/r1.pdf')
        ? Promise.reject(new Error('NotReadableError injected opened-byte retention')) : copyIn(source, target));
    expect(await repo.save(ref, repo.tokenOf(entry))).toMatchObject({status: 'saved'});
    expect(decode(picked.disk.bytes)).toBe('edited bytes');
    await expect(repo.restoreRevision(ref, opened, repo.tokenOf(entry))).rejects.toMatchObject({
        code: 'SOURCE_BACKING_UNAVAILABLE',
        message: expect.stringMatching(/opened.*retained.*saved/iu),
    });
});

async function outputDocument(repo: BrowserDocumentStore, text: string) {
    const ref = await repo.createStoredDocument('out.pdf', encode(text), {mimeType: 'application/pdf', kind: 'output'});
    return {ref, doc: (await repo.requireEntry(ref)).doc!};
}

it('stores the bytes the app streams as the document\'s clean baseline, names no work for recovery, and keeps no buffer it was given', async () => {
    const {repo} = await repository();
    const named = vi.spyOn(repo, 'onDirectoryEdited');
    const {ref, doc} = await outputDocument(repo, '');
    const stream = await repo.writeStream(ref);
    // One buffer longer than a store chunk, refilled by the caller as soon as each write resolves.
    const buffer = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE + 3);
    for (const fill of [1, 2]) {
        await stream.write(buffer.fill(fill));
    }
    buffer.fill(9);
    await stream.close();

    const bytes = await repo.read(ref);
    expect(bytes.byteLength).toBe(2 * buffer.byteLength);
    expect(bytes.findIndex((byte, index) => byte !== (index < buffer.byteLength ? 1 : 2))).toBe(-1);
    expect(doc.state()).toMatchObject({dirty: false, history: []});
    expect(named).not.toHaveBeenCalled();
});

it('keeps the bytes a document had when its stream is aborted or the store fails to take it, and fails the writer with why', async () => {
    const {repo, store} = await repository();
    const {ref, doc} = await outputDocument(repo, 'earlier');
    const aborted = await repo.writeStream(ref);
    await aborted.write(encode('partial'));
    await aborted.abort();
    await expect(aborted.write(encode('more'))).rejects.toMatchObject({name: 'AbortError'});
    await expect(aborted.close()).rejects.toMatchObject({name: 'AbortError'});
    expect(decode(await repo.read(ref))).toBe('earlier');

    const open = store.port.open.bind(store.port);
    const full = vi.spyOn(store.port, 'open').mockImplementation(async (path) => {
        const file = await open(path);
        return {...file, writeAt: async () => {
            throw new DOMException('The browser\'s storage is full', 'QuotaExceededError');
        }};
    });
    const failed = await repo.writeStream(ref);
    await expect(failed.write(new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE + 1))).rejects.toMatchObject({name: 'QuotaExceededError'});
    await expect(failed.close()).rejects.toMatchObject({name: 'QuotaExceededError'});
    full.mockRestore();
    expect(decode(await repo.read(ref))).toBe('earlier');
    expect(doc.state()).toMatchObject({dirty: false});
});

it('commits a stream whose close began before an abort, and lets the abort wait for the commit', async () => {
    const {repo} = await repository();
    const {ref, doc} = await outputDocument(repo, 'earlier');
    const stream = await repo.writeStream(ref);
    await stream.write(encode('replacement'));
    const closed = stream.close();
    await stream.abort();

    await expect(closed).resolves.toBeUndefined();
    expect(decode(await repo.read(ref))).toBe('replacement');
    expect(doc.state()).toMatchObject({dirty: false});
});

it('removes a document whose stream is still open, ending the stream first', async () => {
    const {repo, store} = await repository();
    const {ref, doc} = await outputDocument(repo, 'earlier');
    const stream = await repo.writeStream(ref);
    await stream.write(encode('partial'));
    // Node has no localStorage for the Recent list `remove` also updates.
    vi.spyOn(repo, 'removeRecentFile').mockResolvedValue(true);

    await repo.remove(ref);
    await expect(stream.close()).rejects.toMatchObject({name: 'AbortError'});
    expect(await store.port.list('documents')).not.toContain(doc.id);
});

it('ends the earlier of two streams started together on one document, so the later one owns it', async () => {
    const {repo} = await repository();
    const {ref, doc} = await outputDocument(repo, 'earlier');
    const [first, second] = await Promise.all([repo.writeStream(ref), repo.writeStream(ref)]);

    await expect(first.write(encode('first'))).rejects.toMatchObject({name: 'AbortError'});
    await second.write(encode('second'));
    await second.close();
    expect(decode(await repo.read(ref))).toBe('second');
    expect(doc.state()).toMatchObject({dirty: false});
});
