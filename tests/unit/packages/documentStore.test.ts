import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import { collectDocuments } from '@document-store/collectDocuments';
import { contentWitness } from '@document-store/contentWitness';
import {
    createDocument,
    type DocumentDirectory,
    forkDocument,
    type IDocumentStore,
    type IPublicationPort,
    openDocument,
    type TDocumentInit,
    type TDraftsAfter,
} from '@document-store/documentDirectory';
import { createNodeStorePort } from '@document-store/nodeStorePort';
import { saveDocument } from '@document-store/saveDocument';
import type {
    IStoreFile,
    IStorePort,
} from '@document-store/storePort';
import {
    readWorkspaceCheckpoints,
    removeWorkspaceCheckpoint,
    writeWorkspaceCheckpoint,
} from '@document-store/workspaceCheckpoint';

const TWO_GIB = 2 ** 31;
const encode = (text: string) => new TextEncoder().encode(text);
const append = (text: string, drafts: TDraftsAfter = 'clear') => ({ kind: 'append' as const, bytes: encode(text), drafts });
const witnessOf = (bytes: Uint8Array) => contentWitness(bytes.byteLength, async (offset, length) => bytes.subarray(offset, offset + length));

let workDir = '';
let root = '';
const live: DocumentDirectory[] = [];
beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'document-store-'));
    root = path.join(workDir, 'store');
});
afterEach(async () => {
    await Promise.all(live.splice(0).map(doc => doc.close()));
    await rm(workDir, { recursive: true, force: true });
});

/** Destinations are files in the work directory; `onPublished` runs after the bytes are written. */
function filePublication(onPublished = () => {}): IPublicationPort {
    const witness = async (destination: string) => {
        const content = await readFile(destination).catch(() => null);
        return content && witnessOf(content);
    };
    return {
        witness,
        source: async destination => destination,
        async publish(destination, source, expected, stage) {
            if (expected !== null && await witness(destination) !== expected) return { status: 'conflict' };
            const bytes = await source.file.readAt(0, source.length);
            const published = await witnessOf(bytes);
            await stage(published);
            await writeFile(destination, bytes);
            onPublished();
            return { status: 'published', witness: published };
        },
    };
}

const store = (port: IStorePort = createNodeStorePort(root), publication = filePublication(), historyBudget = 1 << 20): IDocumentStore => ({ port, publication, historyBudget });
const keep = (doc: DocumentDirectory) => (live.push(doc), doc);
const create = async (into: IDocumentStore, init: TDocumentInit) => keep(await createDocument(into, init));
const open = async (from: IDocumentStore, id: string) => keep(await openDocument(from, id));

/**
 * A port that dies at the first operation `at` matches, as the process would: that operation fails (a write
 * after landing half its bytes), and so does every later one. `kill` releases the handles the dead
 * process held.
 */
function crashingPort(port: IStorePort, at: (operation: string, target: string) => boolean) {
    let crashed = false;
    const opened: IStoreFile[] = [];
    const check = (operation: string, target: string) => {
        if (crashed || at(operation, target)) {
            crashed = true;
            throw new Error(`crashed at ${operation} ${target}`);
        }
    };
    const wrap = (file: IStoreFile, target: string): IStoreFile => ({
        size: async () => (check('size', target), file.size()),
        readAt: async (offset, length) => (check('readAt', target), file.readAt(offset, length)),
        async writeAt(offset, bytes) {
            if (!crashed && at('writeAt', target)) await file.writeAt(offset, bytes.subarray(0, bytes.byteLength >> 1));
            check('writeAt', target);
            await file.writeAt(offset, bytes);
        },
        truncate: async length => (check('truncate', target), file.truncate(length)),
        flush: async () => (check('flush', target), file.flush()),
        close: () => file.close(),
    });
    const crashing: IStorePort = {
        list: async dir => (check('list', dir), port.list(dir)),
        read: async target => (check('read', target), port.read(target)),
        writeAtomic: async (target, bytes) => (check('writeAtomic', target), port.writeAtomic(target, bytes)),
        async open(target) {
            check('open', target);
            const file = await port.open(target);
            opened.push(file);
            return wrap(file, target);
        },
        copyIn: async (source, target) => (check('copyIn', target), port.copyIn(source, target)),
        copy: async (from, target) => (check('copy', target), port.copy(from, target)),
        remove: async target => (check('remove', target), port.remove(target)),
    };
    return { port: crashing, kill: () => Promise.all(opened.map(file => file.close().catch(() => undefined))) };
}

const docDir = (doc: DocumentDirectory) => path.join(root, 'documents', doc.id);
const fileSize = async (doc: DocumentDirectory, name: string) => (await stat(path.join(docDir(doc), name))).size;
const currentText = async (doc: DocumentDirectory) => new TextDecoder().decode(await doc.read(0, doc.state().current?.length ?? 0));

async function crashDuring(doc: DocumentDirectory, at: (operation: string, target: string) => boolean, action: (crashed: DocumentDirectory) => Promise<unknown>, publication?: IPublicationPort) {
    await doc.close();
    const crash = crashingPort(createNodeStorePort(root), at);
    const crashed = await openDocument(store(crash.port, publication), doc.id);
    await expect(action(crashed)).rejects.toThrow('crashed at');
    await crash.kill();
}

describe('document directory', () => {
    it('reads the destination until the first edit copies it in, and reopens what was committed', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        expect(doc.state()).toMatchObject({ current: null, baseline: await witnessOf(encode('v1')), dirty: false });
        expect(await readdir(docDir(doc))).toEqual(['manifest.json']);

        const appended = await doc.mutate(null, append(' +a'));
        expect(appended).toMatchObject({ status: 'committed', revision: { id: 2, file: 'r1.pdf', length: 5 } });
        expect(doc.state()).toMatchObject({ history: [{ id: 1, length: 2 }], dirty: true });
        await doc.close();

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('v1 +a');
        expect(await readFile(destination, 'utf8')).toBe('v1');
    });

    it('takes a file the caller wrote in as the next revision without copying it', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        const output = path.join(docDir(doc), '.tool-output.pdf');
        await writeFile(output, 'v2 from a tool');
        const { ino } = await stat(output);

        expect(await doc.mutate(null, { kind: 'move', file: output, drafts: 'clear' })).toMatchObject({ status: 'committed' });
        expect(await currentText(doc)).toBe('v2 from a tool');
        expect((await stat(path.join(docDir(doc), doc.state().current!.file))).ino).toBe(ino);
        await expect(stat(output)).rejects.toThrow();
    });

    it('returns stale revisions and a changed destination as results', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        expect(await doc.mutate(7, append('x'))).toEqual({ status: 'stale-revision', current: null });

        await writeFile(destination, 'changed elsewhere');
        expect(await doc.mutate(null, append('x'))).toEqual({ status: 'conflict' });
        expect(await readdir(docDir(doc))).toEqual(['manifest.json']);
    });

    it('keeps history within its budget and undoes and redoes across revisions', async () => {
        const doc = await create(store(undefined, undefined, 10), { ext: 'pdf', source: new Blob(['aaaa']) });
        const rewrite = (text: string) => ({ kind: 'rewrite' as const, source: (file: IStoreFile) => file.writeAt(0, encode(text)), drafts: 'clear' as const });
        await doc.mutate(1, rewrite('bbbbbbbb'));
        await doc.mutate(2, rewrite('cccccccc'));
        expect(doc.state().history.map(revision => revision.id)).toEqual([2]);
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf', 'r3.pdf']);
        expect(await doc.restore(1)).toMatchObject({ status: 'stale-revision' });

        await doc.restore(2);
        expect(await currentText(doc)).toBe('bbbbbbbb');
        await doc.restore(3);
        expect(await currentText(doc)).toBe('cccccccc');
    });

    it('appends after an undo into a new file, so the redo revision keeps its bytes', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await doc.mutate(1, append('+1'));
        await doc.restore(1);
        expect(await doc.mutate(1, append('+2'))).toMatchObject({ revision: { id: 3, file: 'r3.pdf' } });
        await doc.close();

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('base+2');
        await reopened.restore(2);
        expect(await currentText(reopened)).toBe('base+1');
    });
});

describe('recovery after a crash', () => {
    it('cuts an append that crashed while writing', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await crashDuring(doc, (operation, target) => operation === 'writeAt' && target.endsWith('r1.pdf'), crashed => crashed.mutate(1, append('-appended')));
        expect(await fileSize(doc, 'r1.pdf')).toBe(8);

        const reopened = await open(store(), doc.id);
        expect(reopened.state().current).toMatchObject({ id: 1, length: 4 });
        expect(await fileSize(doc, 'r1.pdf')).toBe(4);
    });

    it('cuts an append that was flushed but not yet named by the manifest', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await crashDuring(doc, (operation, target) => operation === 'writeAtomic' && target.endsWith('manifest.json'), crashed => crashed.mutate(1, append('-appended')));
        expect(await fileSize(doc, 'r1.pdf')).toBe(13);

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('base');
        expect(await fileSize(doc, 'r1.pdf')).toBe(4);
    });

    it('deletes the file of a rewrite that crashed while writing', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await crashDuring(doc, (operation, target) => operation === 'writeAt' && target.endsWith('r2.pdf'), crashed => crashed.mutate(1, {
            kind: 'rewrite',
            source: file => file.writeAt(0, encode('rewritten')),
            drafts: 'clear',
        }));
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r1.pdf', 'r2.pdf']);

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('base');
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r1.pdf']);
    });

    it('keeps the drafts a mutation keeps when it crashes right after its manifest replace', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await doc.setDrafts(1, { note: 'first' });
        let committed = false;
        await crashDuring(doc, (operation, target) => committed || ((committed = operation === 'writeAtomic' && target.endsWith('manifest.json')), false), async crashed => {
            await crashed.mutate(1, append('+bytes', 'keep'));
            await crashed.setDrafts(2, { note: 'lost' });
        });

        const reopened = await open(store(), doc.id);
        expect(reopened.state()).toMatchObject({ current: { id: 2 }, drafts: { note: 'first' }, dirty: true });
        expect(await currentText(reopened)).toBe('base+bytes');
        expect((await readdir(docDir(doc))).filter(name => name.startsWith('drafts-'))).toHaveLength(1);
    });

    it('commits the drafts a mutation replaces or clears with its bytes, and only those', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await doc.setDrafts(1, { note: 'first' });
        await crashDuring(doc, (operation, target) => operation === 'writeAtomic' && target.endsWith('manifest.json'), crashed => crashed.mutate(1, append('+note', { replace: { note: 'second' } })));
        expect((await readdir(docDir(doc))).filter(name => name.startsWith('drafts-'))).toHaveLength(2);

        const reopened = await open(store(), doc.id);
        expect(reopened.state()).toMatchObject({ current: { id: 1 }, drafts: { note: 'first' } });
        expect((await readdir(docDir(doc))).filter(name => name.startsWith('drafts-'))).toHaveLength(1);
        await reopened.mutate(1, append('+note', { replace: { note: 'second' } }));
        expect(reopened.state()).toMatchObject({ current: { id: 2 }, drafts: { note: 'second' } });
        await reopened.mutate(2, append('+more'));
        expect(reopened.state().drafts).toBeUndefined();
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r1.pdf']);
    });

    it.each([
        ['the new bytes', 'old new', true],
        ['the old bytes', 'old', false],
        ['foreign bytes', 'foreign', false],
    ])('settles a publish that crashed before its acknowledgement, with the destination holding %s', async (_label, onDisk, adopted) => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'old');
        const doc = await create(store(), { ext: 'pdf', destination });
        await doc.mutate(null, append(' new'));

        let published = false;
        await crashDuring(
            doc,
            (operation, target) => published && operation === 'writeAtomic' && target.endsWith('manifest.json'),
            crashed => saveDocument(crashed, { expected: 2 }),
            filePublication(() => { published = true; }),
        );
        expect(await readFile(destination, 'utf8')).toBe('old new');
        await writeFile(destination, onDisk);

        const reopened = await open(store(), doc.id);
        expect(reopened.snapshot().pendingPublish).toBeUndefined();
        expect(reopened.state()).toMatchObject({
            baseline: await witnessOf(encode(adopted ? 'old new' : 'old')),
            dirty: !adopted,
        });
        const saved = await saveDocument(reopened, { expected: 2 });
        expect(saved.status).toBe(onDisk === 'foreign' ? 'conflict' : 'saved');
        expect(await readFile(destination, 'utf8')).toBe(onDisk === 'foreign' ? 'foreign' : 'old new');
    });

    it('recovers a 2 GiB sparse revision after a crashed append without reading it', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['head']) });
        await doc.mutate(1, {
            kind: 'rewrite',
            async source(file) {
                await file.truncate(TWO_GIB);
                await file.writeAt(TWO_GIB - 4, encode('tail'));
            },
            drafts: 'clear',
        });
        await crashDuring(doc, (operation, target) => operation === 'writeAt' && target.endsWith('r2.pdf'), crashed => crashed.mutate(2, append('-appended')));
        expect(await fileSize(doc, 'r2.pdf')).toBe(TWO_GIB + 4);

        let bytesRead = 0;
        const port = createNodeStorePort(root);
        const counting: IStorePort = {
            ...port,
            read: async target => {
                const bytes = await port.read(target);
                bytesRead += bytes.byteLength;
                return bytes;
            },
            open: async target => {
                const file = await port.open(target);
                return {
                    ...file,
                    readAt: async (offset, length) => {
                        const bytes = await file.readAt(offset, length);
                        bytesRead += bytes.byteLength;
                        return bytes;
                    },
                };
            },
        };
        const reopened = await open(store(counting), doc.id);
        expect(reopened.state().current).toMatchObject({ id: 2, length: TWO_GIB });
        expect(await fileSize(doc, 'r2.pdf')).toBe(TWO_GIB);
        expect(bytesRead).toBeLessThan(4096);
        expect(new TextDecoder().decode(await reopened.read(TWO_GIB - 4, 100))).toBe('tail');
        await reopened.close();
    });
});

describe('save', () => {
    it('commits pending edits, publishes them, and is clean until the next edit', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        await doc.setDrafts(null, { note: 'unsaved' });

        const saved = await saveDocument(doc, { expected: 1, commit: append('+note') });
        expect(saved).toMatchObject({ status: 'saved', revision: { id: 2 } });
        expect(await readFile(destination, 'utf8')).toBe('v1+note');
        expect(doc.state()).toMatchObject({ drafts: undefined, dirty: false });
        expect(await saveDocument(doc, { expected: 2 })).toMatchObject({ status: 'saved' });

        await doc.restore(1);
        expect(doc.state().dirty).toBe(true);
        await doc.restore(2);
        expect(doc.state().dirty).toBe(false);
    });

    it('refuses a destination changed elsewhere and keeps the committed work', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        await doc.mutate(null, append('+mine'));
        await writeFile(destination, 'theirs');

        expect(await saveDocument(doc, { expected: 2, commit: append('+more') })).toEqual({ status: 'conflict' });
        expect(await readFile(destination, 'utf8')).toBe('theirs');
        expect(await currentText(doc)).toBe('v1+mine+more');
        expect(doc.state()).toMatchObject({ dirty: true, current: { id: 3 } });
        expect(await saveDocument(doc, { expected: 2 })).toMatchObject({ status: 'stale-revision', current: { id: 3 } });

        const copy = path.join(workDir, 'copy.pdf');
        expect(await saveDocument(doc, { expected: 3, saveAs: copy })).toMatchObject({ status: 'saved' });
        expect(await readFile(copy, 'utf8')).toBe('v1+mine+more');
        expect(doc.state()).toMatchObject({ destination: copy, dirty: false });
    });

    it('starts an imported document clean and sends it to Save As', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['dropped']), imported: true });
        expect(doc.state()).toMatchObject({ destination: null, baseline: await witnessOf(encode('dropped')), dirty: false });
        expect(await saveDocument(doc, { expected: 1 })).toEqual({ status: 'needs-save-as' });
        await doc.mutate(1, append('+edit'));
        expect(doc.state().dirty).toBe(true);
    });

    it('sends a document without a destination to Save As', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['scanned']) });
        expect(doc.state().dirty).toBe(true);
        expect(await saveDocument(doc, { expected: 1 })).toEqual({ status: 'needs-save-as' });
        const destination = path.join(workDir, 'scan.pdf');
        expect(await saveDocument(doc, { expected: 1, saveAs: destination })).toMatchObject({ status: 'saved' });
        expect(await readFile(destination, 'utf8')).toBe('scanned');
        expect(doc.state().dirty).toBe(false);
    });
});

describe('fork', () => {
    it('clones the current bytes, destination, baseline and drafts into an independent directory', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const source = await create(store(), { ext: 'pdf', destination });
        await source.mutate(null, append('+a'));
        await source.mutate(2, append('+redo'));
        await source.restore(2);
        await source.setDrafts(2, { note: 'unsaved' });

        const fork = keep(await forkDocument(store(), source.id));
        expect(fork.id).not.toBe(source.id);
        expect(fork.state()).toMatchObject({
            current: { id: 2, length: 4 },
            history: [],
            destination,
            baseline: await witnessOf(encode('v1')),
            drafts: { note: 'unsaved' },
            dirty: true,
        });
        expect(await currentText(fork)).toBe('v1+a');

        await fork.mutate(2, append('+fork'));
        expect(await currentText(fork)).toBe('v1+a+fork');
        expect(await currentText(source)).toBe('v1+a');
        expect(source.state()).toMatchObject({ current: { id: 2 }, drafts: { note: 'unsaved' } });
        await fork.close();
        expect(await currentText(await open(store(), fork.id))).toBe('v1+a+fork');
        expect(await saveDocument(source, { expected: 2 })).toMatchObject({ status: 'saved' });
        expect(await readFile(destination, 'utf8')).toBe('v1+a');
    });

    it('creates and forks into the directory the caller names, so it can lock it before it exists', async () => {
        const named = keep(await create(store(), { ext: 'pdf', source: new Blob([encode('v1')]), imported: true, id: 'chosen-id' }));
        expect(named.id).toBe('chosen-id');
        const fork = keep(await forkDocument(store(), named.id, 'fork-id'));
        expect(fork.id).toBe('fork-id');
        expect(await currentText(fork)).toBe('v1');
        await expect(create(store(), { ext: 'pdf', source: new Blob([encode('v1')]), id: '../escape' })).rejects.toThrow('Invalid document directory id');
    });
});

describe('workspace checkpoints and collection', () => {
    it('removes clean, unreferenced, unheld directories and reports unsaved ones', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const [unreferenced, referenced, held, unsaved] = await Promise.all([
            create(store(), { ext: 'pdf', destination }),
            create(store(), { ext: 'pdf', destination }),
            create(store(), { ext: 'pdf', destination }),
            create(store(), { ext: 'pdf', source: new Blob(['new']) }),
        ]);
        const port = createNodeStorePort(root);
        await writeWorkspaceCheckpoint(port, 'window-1', {
            tabs: { a: { directory: referenced.id, view: { page: 3 } }, b: { directory: referenced.id, view: { page: 9 } } },
            layout: { panes: [['a', 'b']] },
        });
        expect((await readWorkspaceCheckpoints(port)).get('window-1')?.tabs.b).toEqual({ directory: referenced.id, view: { page: 9 } });

        await writeFile(path.join(root, 'workspaces', 'window-2.json'), '{"version":1,"tabs":{"a":{}}}');
        await writeFile(path.join(root, 'workspaces', 'window-1.json.crashed.tmp'), '{"version":1');
        const isHeld = async (id: string) => id === held.id;
        expect(await collectDocuments(store(port), isHeld)).toEqual({ removed: [], unsaved: [unsaved.id] });

        await removeWorkspaceCheckpoint(port, 'window-2');
        expect(await collectDocuments(store(port), isHeld)).toEqual({ removed: [unreferenced.id], unsaved: [unsaved.id] });
        expect((await readdir(path.join(root, 'documents'))).sort()).toEqual([referenced.id, held.id, unsaved.id].sort());
        expect(await readdir(path.join(root, 'workspaces'))).toEqual(['window-1.json']);
    });
});
