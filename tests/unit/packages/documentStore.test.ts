import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    truncate,
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
    DamagedDocumentError,
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
const rewrite = (text: string) => ({ kind: 'rewrite' as const, source: (file: IStoreFile) => file.writeAt(0, encode(text)), drafts: 'clear' as const });
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

const store = (port: IStorePort = createNodeStorePort(root), publication = filePublication()): IDocumentStore => ({ port, publication });
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
        move: async (from, target) => (check('move', target), port.move!(from, target)),
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
        // The destination's bytes were not copied in: they stay revision 1, and undo reads them again.
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf']);
        expect(await doc.restore(2, 1)).toEqual({ status: 'committed', revision: null });
    });

    it('refuses to take a file in as the first revision once the destination changed, and drops the file', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        const output = path.join(docDir(doc), '.tool-output.pdf');
        await writeFile(output, 'v2 from a tool');
        await writeFile(destination, 'changed elsewhere');

        expect(await doc.mutate(null, { kind: 'move', file: output, drafts: 'clear' })).toEqual({ status: 'conflict' });
        expect(doc.state()).toMatchObject({ current: null, history: [] });
        expect(await readdir(docDir(doc))).toEqual(['manifest.json']);
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

    it('keeps the revisions the caller retains and the one the latest change replaced, and restores them without copying', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['aaaa']) });
        await doc.mutate(1, rewrite('bbbbbbbb'));
        await doc.mutate(2, rewrite('cccccccc'));
        expect(doc.state().history.map(revision => revision.id)).toEqual([2]);
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf', 'r3.pdf']);
        expect(await doc.restore(3, 1)).toMatchObject({ status: 'stale-revision' });

        await doc.retain([2, 3]);
        await doc.mutate(3, rewrite('dddd'));
        expect(doc.state().history.map(revision => revision.id).sort()).toEqual([2, 3]);
        expect(await doc.restore(2, 2)).toMatchObject({ status: 'stale-revision' });
        await doc.restore(4, 2);
        expect(await currentText(doc)).toBe('bbbbbbbb');
        await doc.restore(2, 4);
        expect(await currentText(doc)).toBe('dddd');
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf', 'r3.pdf', 'r4.pdf']);

        // A new edit after an undo: the caller drops the redo revision, and its file goes.
        await doc.restore(4, 3);
        await doc.retain([2, 3]);
        await doc.mutate(3, rewrite('eeee'));
        expect(doc.state().history.map(revision => revision.id).sort()).toEqual([2, 3]);
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf', 'r3.pdf', 'r5.pdf']);
        await doc.retain([]);
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r5.pdf']);
    });

    it('rewrites a document without bytes of its own without copying it in, and undoes to its destination', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        expect(await doc.mutate(null, rewrite('v2'))).toMatchObject({ status: 'committed', revision: { id: 2, file: 'r2.pdf' } });
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf']);
        expect(doc.state()).toMatchObject({ history: [{ id: 1 }], dirty: true });

        expect(await doc.restore(2, 1)).toEqual({ status: 'committed', revision: null });
        expect(doc.state()).toMatchObject({ current: null, history: [{ id: 2 }], dirty: false });
        await doc.restore(null, 2);
        expect(await currentText(doc)).toBe('v2');

        await writeFile(destination, 'changed elsewhere');
        expect(await doc.restore(2, 1)).toEqual({ status: 'conflict' });
        expect(await currentText(doc)).toBe('v2');
    });

    it('appends after an undo into a new file, so the redo revision keeps its bytes', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await doc.mutate(1, append('+1'));
        await doc.restore(2, 1);
        expect(await doc.mutate(1, append('+2'))).toMatchObject({ revision: { id: 3, file: 'r3.pdf' } });
        await doc.close();

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('base+2');
        await reopened.restore(3, 1);
        expect(await currentText(reopened)).toBe('base');
    });
});

describe('recovery after a crash', () => {
    it.each(['missing', 'cut short'] as const)('leaves a directory whose current revision file is %s as it is until the file is back', async (damage) => {
        const destination = path.join(workDir, 'report.pdf');
        await writeFile(destination, 'saved');
        const doc = await create(store(), { ext: 'pdf', destination });
        await doc.mutate(null, append('-edited'));
        await doc.close();
        const revision = path.join(docDir(doc), 'r1.pdf');
        const bytes = await readFile(revision);
        await (damage === 'missing' ? rm(revision) : truncate(revision, 3));
        const files = async () => Promise.all((await readdir(docDir(doc))).sort().map(async name => [name, await readFile(path.join(docDir(doc), name))]));
        const before = await files();

        const damaged = await open(store(), doc.id);
        expect(damaged.state()).toMatchObject({ current: null, destination, dirty: true, damaged: true, drafts: undefined });
        await expect(damaged.mutate(null, append('-more'))).rejects.toThrow(DamagedDocumentError);
        await expect(damaged.setDrafts(null, { note: 'kept' })).rejects.toThrow(DamagedDocumentError);
        await expect(damaged.restore(null, 1)).rejects.toThrow(DamagedDocumentError);
        await expect(saveDocument(damaged, { expected: null })).rejects.toThrow(DamagedDocumentError);
        await damaged.close();
        expect(await files()).toEqual(before);
        expect(await readFile(destination, 'utf8')).toBe('saved');

        await writeFile(revision, bytes);
        const recovered = await open(store(), doc.id);
        expect(recovered.state()).toMatchObject({ dirty: true, damaged: false });
        expect(await currentText(recovered)).toBe('saved-edited');
    });

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

    it('deletes a file taken in as the first revision when the move crashes before its manifest replace', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        const output = path.join(workDir, 'tool-output.pdf');
        await writeFile(output, 'v2 from a tool');
        await crashDuring(doc, (operation, target) => operation === 'writeAtomic' && target.endsWith('manifest.json'), crashed => crashed.mutate(null, { kind: 'move', file: output, drafts: 'clear' }));
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf']);

        const reopened = await open(store(), doc.id);
        expect(reopened.state()).toMatchObject({ current: null, history: [], dirty: false });
        expect(await readdir(docDir(doc))).toEqual(['manifest.json']);
        expect(await readFile(destination, 'utf8')).toBe('v1');
    });

    it('continues from the manifest a failed replace left on disk, so the next append cannot overwrite committed bytes', async () => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['base']) });
        await doc.close();
        const port = createNodeStorePort(root);
        let manifestWrite: 'lands then fails' | 'fails' | 'unreadable' = 'lands then fails';
        const flaky: IStorePort = {
            ...port,
            async writeAtomic(target, bytes) {
                if (!target.endsWith('manifest.json')) return port.writeAtomic(target, bytes);
                if (manifestWrite === 'lands then fails') await port.writeAtomic(target, bytes);
                throw new Error(`manifest write ${manifestWrite}`);
            },
            read: async target => (manifestWrite === 'unreadable' && target.endsWith('manifest.json') ? Promise.reject(new Error('EIO')) : port.read(target)),
        };
        const live = await open(store(flaky), doc.id);

        // The rename landed and the directory flush failed: the disk names AAA.
        await expect(live.mutate(1, append('AAA'))).rejects.toThrow('lands then fails');
        expect(live.state().current).toMatchObject({ id: 2, length: 7 });
        // The next append starts after AAA; its own manifest write fails before landing.
        manifestWrite = 'fails';
        await expect(live.mutate(2, append('BBB'))).rejects.toThrow('fails');
        expect(live.state().current).toMatchObject({ id: 2, length: 7 });
        manifestWrite = 'unreadable';
        await expect(live.mutate(2, append('CCC'))).rejects.toThrow('unreadable');
        await expect(live.mutate(2, append('DDD'))).rejects.toThrow('open it again');
        await live.close();

        expect(await currentText(await open(store(), doc.id))).toBe('baseAAA');
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
        ['before', false, 'three', ['manifest.json', 'r1.pdf', 'r2.pdf', 'r3.pdf']],
        ['right after', true, 'one', ['manifest.json', 'r1.pdf', 'r3.pdf']],
    ])('leaves the old or the restored revision when an undo crashes %s its manifest replace', async (_label, afterReplace, text, files) => {
        const doc = await create(store(), { ext: 'pdf', source: new Blob(['one']) });
        await doc.mutate(1, rewrite('two'));
        await doc.retain([1]);
        await doc.mutate(2, rewrite('three'));
        let replaced = false;
        await crashDuring(doc, (operation, target) => {
            const manifest = operation === 'writeAtomic' && target.endsWith('manifest.json');
            if (!afterReplace || replaced) return manifest || replaced;
            replaced = manifest;
            return false;
        }, async crashed => {
            await crashed.restore(3, 1);
            await crashed.setDrafts(1, { note: 'lost' });
        });

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe(text);
        expect((await readdir(docDir(doc))).sort()).toEqual(files);
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

        await doc.restore(2, 1);
        expect(doc.state().dirty).toBe(true);
        await doc.restore(1, 2);
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

    it('saves a document undone to its destination\'s bytes as those bytes, with nothing to write in place', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        await doc.mutate(null, rewrite('v2'));
        await doc.restore(2, 1);
        expect(await saveDocument(doc, { expected: null })).toEqual({ status: 'saved', revision: null });

        const copy = path.join(workDir, 'copy.pdf');
        const saved = await saveDocument(doc, { expected: null, saveAs: copy });
        expect(saved).toMatchObject({ status: 'saved', revision: { id: 1, witness: await witnessOf(encode('v1')) } });
        expect(await readFile(copy, 'utf8')).toBe('v1');
        expect(doc.state()).toMatchObject({ current: { id: 1 }, destination: copy, dirty: false, history: [{ id: 2 }] });
        await doc.restore(1, 2);
        expect(await currentText(doc)).toBe('v2');
    });

    it.each([false, true])('keeps the destination\'s bytes for undo when a Save replaces it or a Save As rebinds it (Save As: %s)', async (saveAs) => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), { ext: 'pdf', destination });
        await doc.mutate(null, rewrite('v2'));
        await doc.retain([1]);
        const copy = path.join(workDir, 'copy.pdf');
        expect(await saveDocument(doc, { expected: 2, ...(saveAs ? { saveAs: copy } : {}) })).toMatchObject({ status: 'saved' });
        expect(await readFile(saveAs ? copy : destination, 'utf8')).toBe('v2');
        await doc.close();

        const reopened = await open(store(), doc.id);
        expect(await reopened.restore(2, 1)).toMatchObject({ status: 'committed', revision: { id: 1 } });
        expect(await currentText(reopened)).toBe('v1');
        expect(reopened.state().dirty).toBe(true);
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
        await source.restore(3, 2);
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
