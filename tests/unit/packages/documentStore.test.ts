import {execFileSync} from 'node:child_process';
import {promises} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {collectDocuments} from '@document-store/collectDocuments';
import {contentWitness} from '@document-store/contentWitness';
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
import {copyNewFile, createNodeStorePort} from '@document-store/nodeStorePort';
import {createRevisionTokenCodec, OpenDocument} from '@document-store/openDocument';
import {SavePublicationError, saveDocument} from '@document-store/saveDocument';
import type {IStoreFile, IStorePort} from '@document-store/storePort';
import {readWorkspaceCheckpoints, removeWorkspaceCheckpoint, writeWorkspaceCheckpoint} from '@document-store/workspaceCheckpoint';

const TWO_GIB = 2 ** 31;
const encode = (text: string) => new TextEncoder().encode(text);
const append = (text: string, drafts: TDraftsAfter = 'clear') => ({kind: 'append' as const, bytes: encode(text), drafts});
const rewrite = (text: string) => ({
    kind: 'rewrite' as const,
    source: (file: IStoreFile) => file.writeAt(0, encode(text)),
    drafts: 'clear' as const,
});
const witnessOf = (bytes: Uint8Array) =>
    contentWitness(bytes.byteLength, async (offset, length) => bytes.subarray(offset, offset + length));

let workDir = '';
let root = '';
const live: DocumentDirectory[] = [];
beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'document-store-'));
    root = path.join(workDir, 'store');
});
afterEach(async () => {
    await Promise.all(live.splice(0).map((doc) => doc.close()));
    await rm(workDir, {recursive: true, force: true});
});

/** Destinations are files in the work directory; `onPublished` runs after the bytes are written. */
function filePublication(onPublished = () => {}): IPublicationPort {
    const witness = async (destination: string) => {
        const content = await readFile(destination).catch(() => null);
        return content && witnessOf(content);
    };
    return {
        witness,
        source: async (destination) => destination,
        async publish(destination, source, expected, stage) {
            if (expected !== null && (await witness(destination)) !== expected) {
                return {status: 'conflict'};
            }
            const bytes = await source.file.readAt(0, source.length);
            const published = await witnessOf(bytes);
            await stage(published);
            await writeFile(destination, bytes);
            onPublished();
            return {status: 'published', witness: published};
        },
    };
}

const store = (port: IStorePort = createNodeStorePort(root), publication = filePublication()): IDocumentStore => ({port, publication});
const keep = (doc: DocumentDirectory) => (live.push(doc), doc);
const create = async (into: IDocumentStore, init: TDocumentInit) => keep(await createDocument(into, init));
const open = async (from: IDocumentStore, id: string) => keep(await openDocument(from, id));

/**
 * A port that dies at the first operation `at` matches, as the process would: that operation fails (a write
 * after landing half its bytes), and so does every later one. `kill` releases the handles the dead
 * process held. With `fatal: false`, only the matching operation fails, so cleanup can still run.
 */
function crashingPort(port: IStorePort, at: (operation: string, target: string) => boolean, fatal = true) {
    let crashed = false;
    const opened = new Set<IStoreFile>();
    const check = (operation: string, target: string) => {
        if (crashed || at(operation, target)) {
            crashed = fatal;
            throw new Error(`${fatal ? 'crashed' : 'fault'} at ${operation} ${target}`);
        }
    };
    const wrap = (file: IStoreFile, target: string): IStoreFile => ({
        size: async () => (check('size', target), file.size()),
        readAt: async (offset, length) => (check('readAt', target), file.readAt(offset, length)),
        witness: async (length) => (check('witness', target), file.witness(length)),
        async writeAt(offset, bytes) {
            if (!crashed && at('writeAt', target)) {
                await file.writeAt(offset, bytes.subarray(0, bytes.byteLength >> 1));
            }
            check('writeAt', target);
            await file.writeAt(offset, bytes);
        },
        truncate: async (length) => (check('truncate', target), file.truncate(length)),
        flush: async () => (check('flush', target), file.flush()),
        async close() {
            await file.close();
            opened.delete(file);
        },
    });
    const crashing: IStorePort = {
        list: async (dir) => (check('list', dir), port.list(dir)),
        read: async (target) => (check('read', target), port.read(target)),
        writeAtomic: async (target, bytes) => (check('writeAtomic', target), port.writeAtomic(target, bytes)),
        async open(target) {
            check('open', target);
            const file = await port.open(target);
            opened.add(file);
            return wrap(file, target);
        },
        copyIn: async (source, target) => (check('copyIn', target), port.copyIn(source, target)),
        copy: async (from, target) => (check('copy', target), port.copy(from, target)),
        move: async (from, target) => (check('move', target), port.move!(from, target)),
        remove: async (target) => (check('remove', target), port.remove(target)),
    };
    return {
        port: crashing,
        openHandles: () => opened.size,
        kill: () => Promise.all([...opened].map((file) => file.close().catch(() => undefined))),
    };
}

const docDir = (doc: DocumentDirectory) => path.join(root, 'documents', doc.id);
const fileSize = async (doc: DocumentDirectory, name: string) => (await stat(path.join(docDir(doc), name))).size;
const currentText = async (doc: DocumentDirectory) => new TextDecoder().decode(await doc.read(0, doc.state().current?.length ?? 0));

async function crashDuring(
    doc: DocumentDirectory,
    at: (operation: string, target: string) => boolean,
    action: (crashed: DocumentDirectory) => Promise<unknown>,
    publication?: IPublicationPort,
) {
    await doc.close();
    const crash = crashingPort(createNodeStorePort(root), at);
    const crashed = await openDocument(store(crash.port, publication), doc.id);
    await expect(action(crashed)).rejects.toThrow('crashed at');
    await crash.kill();
}

describe('Node revision files', () => {
    it.each([false, true])('retains only read access between operations (existing: %s)', async (existing) => {
        const target = path.join(workDir, 'r1.pdf');
        if (existing) {
            await writeFile(target, 'old');
        }
        const realOpen = promises.open.bind(promises);
        const writers: Awaited<ReturnType<typeof promises.open>>[] = [];
        const opened = vi.spyOn(promises, 'open').mockImplementation(async (file, flags, mode) => {
            const handle = await realOpen(file, flags, mode);
            if (file === target && flags !== 'r') {
                writers.push(handle);
            }
            return handle;
        });
        let file: IStoreFile | undefined;
        const noWriters = () => expect(writers.map((handle) => handle.fd).filter((fd) => fd !== -1)).toEqual([]);
        try {
            file = await createNodeStorePort(workDir).open('r1.pdf');
            noWriters();
            await file.writeAt(0, encode('revision'));
            noWriters();
            await file.truncate(3);
            noWriters();
            await file.flush();
            noWriters();
            expect(await file.size()).toBe(3);
            expect(await file.readAt(0, 3)).toEqual(encode('rev'));
        } finally {
            await file?.close();
            opened.mockRestore();
        }
    });
});

describe('document directory', () => {
    it('reads the destination until the first edit copies it in, and reopens what was committed', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        expect(doc.state()).toMatchObject({current: null, baseline: await witnessOf(encode('v1')), dirty: false});
        expect(await readdir(docDir(doc))).toEqual(['manifest.json']);

        const appended = await doc.mutate(null, append(' +a'));
        expect(appended).toMatchObject({status: 'committed', revision: {id: 2, file: 'r1.pdf', length: 5}});
        expect(doc.state()).toMatchObject({history: [{id: 1, length: 2}], dirty: true});
        await doc.close();

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('v1 +a');
        expect(await readFile(destination, 'utf8')).toBe('v1');
    });

    it('takes a file the caller wrote in as the next revision without copying it', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        const output = path.join(docDir(doc), '.tool-output.pdf');
        await writeFile(output, 'v2 from a tool');
        const {ino} = await stat(output);

        expect(await doc.mutate(null, {kind: 'move', file: output, drafts: 'clear'})).toMatchObject({status: 'committed'});
        expect(await currentText(doc)).toBe('v2 from a tool');
        expect((await stat(path.join(docDir(doc), doc.state().current!.file))).ino).toBe(ino);
        await expect(stat(output)).rejects.toThrow();
        // The destination's bytes were not copied in: they stay revision 1, and undo reads them again.
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf']);
        expect(await doc.restore(2, 1)).toEqual({status: 'committed', revision: null});
    });

    it('takes a file in as the first revision once the destination changed, and Save refuses to publish over it', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        const output = path.join(docDir(doc), '.tool-output.pdf');
        await writeFile(output, 'v2 from a tool');
        await writeFile(destination, 'changed elsewhere');

        expect(await doc.mutate(null, {kind: 'move', file: output, drafts: 'clear'})).toMatchObject({
            status: 'committed',
            revision: {id: 2},
        });
        expect(await saveDocument(doc, {expected: 2})).toEqual({status: 'conflict'});
        expect(await readFile(destination, 'utf8')).toBe('changed elsewhere');
        expect(await currentText(doc)).toBe('v2 from a tool');
    });

    it('returns stale revisions and a changed destination as results', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        expect(await doc.mutate(7, append('x'))).toEqual({status: 'stale-revision', current: null});

        await writeFile(destination, 'changed elsewhere');
        expect(await doc.mutate(null, append('x'))).toEqual({status: 'conflict'});
        expect(await readdir(docDir(doc))).toEqual(['manifest.json']);
    });

    it('keeps the revisions the caller retains and the one the latest change replaced, and restores them without copying', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['aaaa'])});
        await doc.mutate(1, rewrite('bbbbbbbb'));
        await doc.mutate(2, rewrite('cccccccc'));
        expect(doc.state().history.map((revision) => revision.id)).toEqual([2]);
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf', 'r3.pdf']);
        expect(await doc.restore(3, 1)).toMatchObject({status: 'stale-revision'});

        await doc.retain([2, 3]);
        await doc.mutate(3, rewrite('dddd'));
        expect(
            doc
                .state()
                .history.map((revision) => revision.id)
                .sort(),
        ).toEqual([2, 3]);
        expect(await doc.restore(2, 2)).toMatchObject({status: 'stale-revision'});
        await doc.restore(4, 2);
        expect(await currentText(doc)).toBe('bbbbbbbb');
        await doc.restore(2, 4);
        expect(await currentText(doc)).toBe('dddd');
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf', 'r3.pdf', 'r4.pdf']);

        // A new edit after an undo: the caller drops the redo revision, and its file goes.
        await doc.restore(4, 3);
        await doc.retain([2, 3]);
        await doc.mutate(3, rewrite('eeee'));
        expect(
            doc
                .state()
                .history.map((revision) => revision.id)
                .sort(),
        ).toEqual([2, 3]);
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf', 'r3.pdf', 'r5.pdf']);
        await doc.retain([]);
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r5.pdf']);
    });

    it('rewrites a document without bytes of its own without copying it in, and undoes to its destination', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        expect(await doc.mutate(null, rewrite('v2'))).toMatchObject({status: 'committed', revision: {id: 2, file: 'r2.pdf'}});
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf']);
        expect(doc.state()).toMatchObject({history: [{id: 1}], dirty: true});

        expect(await doc.restore(2, 1)).toEqual({status: 'committed', revision: null});
        expect(doc.state()).toMatchObject({current: null, history: [{id: 2}], dirty: false});
        await doc.restore(null, 2);
        expect(await currentText(doc)).toBe('v2');

        await writeFile(destination, 'changed elsewhere');
        expect(await doc.restore(2, 1)).toEqual({status: 'conflict'});
        expect(await currentText(doc)).toBe('v2');
    });

    it('extends the file a caller appended to, and after an undo gives the redo revision a copy so the file holds what is current', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        const file = path.join(docDir(doc), 'r1.pdf');
        await writeFile(file, 'base+stale');
        expect(await doc.ownCurrentFile()).toMatchObject({id: 1, length: 4});
        expect(await readFile(file, 'utf8')).toBe('base');

        await writeFile(file, 'base+1');
        expect(await doc.mutate(1, {kind: 'extend', drafts: 'clear'})).toMatchObject({revision: {id: 2, file: 'r1.pdf', length: 6}});
        await doc.restore(2, 1);
        await doc.ownCurrentFile();
        expect(await readFile(file, 'utf8')).toBe('base');
        expect(doc.state().history).toMatchObject([{id: 2, file: 'r3.pdf', length: 6}]);
        await doc.restore(1, 2);
        expect(await currentText(doc)).toBe('base+1');

        // A writer that may still append to the file is left a file nobody reads.
        await writeFile(path.join(docDir(doc), 'r3.pdf'), 'base+1+late', {flag: 'w'});
        await doc.abandonCurrentFile();
        expect(doc.state().current).toMatchObject({id: 2, file: 'r4.pdf', length: 6});
        expect(await readFile(path.join(docDir(doc), 'r4.pdf'), 'utf8')).toBe('base+1');
    });

    it('appends after an undo into a new file, so the redo revision keeps its bytes', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await doc.mutate(1, append('+1'));
        await doc.restore(2, 1);
        expect(await doc.mutate(1, append('+2'))).toMatchObject({revision: {id: 3, file: 'r3.pdf'}});
        await doc.close();

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('base+2');
        await reopened.restore(3, 1);
        expect(await currentText(reopened)).toBe('base');
    });
});

describe('revision-file error paths', () => {
    it('closes a new revision when writing its replacement drafts fails', async () => {
        const fault = crashingPort(
            createNodeStorePort(root),
            (operation, target) => operation === 'writeAtomic' && path.basename(target).startsWith('drafts-'),
            false,
        );
        const doc = await create(store(fault.port), {ext: 'pdf', source: new Blob(['base'])});
        const manifest = await readFile(path.join(docDir(doc), 'manifest.json'));
        try {
            await expect(doc.mutate(1, {...rewrite('replacement'), drafts: {replace: {note: 'unsaved'}}})).rejects.toThrow(
                'fault at writeAtomic',
            );
            expect(await currentText(doc)).toBe('base');
            expect(await readFile(path.join(docDir(doc), 'manifest.json'))).toEqual(manifest);
            await doc.close();
            expect(fault.openHandles()).toBe(0);
        } finally {
            await doc.close();
            await fault.kill();
        }
    });

    it('closes a revision copy when truncating its uncommitted tail fails', async () => {
        const fault = crashingPort(
            createNodeStorePort(root),
            (operation, target) => operation === 'truncate' && target.endsWith('r2.pdf'),
            false,
        );
        const doc = await create(store(fault.port), {ext: 'pdf', source: new Blob(['base'])});
        await writeFile(path.join(docDir(doc), 'r1.pdf'), 'base+uncommitted');
        const manifest = await readFile(path.join(docDir(doc), 'manifest.json'));
        try {
            await expect(doc.abandonCurrentFile()).rejects.toThrow('fault at truncate');
            expect(await currentText(doc)).toBe('base');
            expect(await readFile(path.join(docDir(doc), 'manifest.json'))).toEqual(manifest);
            await doc.close();
            expect(fault.openHandles()).toBe(0);
        } finally {
            await doc.close();
            await fault.kill();
        }
    });

    it('closes and removes an uncommitted destination copy when its final witness fails', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'original');
        const fault = crashingPort(createNodeStorePort(root), () => false);
        const publication = filePublication();
        const doc = await create(
            store(fault.port, {
                ...publication,
                async witness(target, content) {
                    if ((await fault.port.list('documents/witness-failure')).includes('r1.pdf')) {
                        throw new Error('final witness failed');
                    }
                    return publication.witness(target, content);
                },
            }),
            {ext: 'pdf', id: 'witness-failure', destination},
        );
        const manifest = await readFile(path.join(docDir(doc), 'manifest.json'));
        try {
            await expect(doc.materialize()).rejects.toThrow('final witness failed');
            expect.soft(fault.openHandles()).toBe(0);
            expect.soft(await readdir(docDir(doc))).toEqual(['manifest.json']);
            expect(await readFile(path.join(docDir(doc), 'manifest.json'))).toEqual(manifest);
            expect(await readFile(destination, 'utf8')).toBe('original');
        } finally {
            await doc.close();
            await fault.kill();
        }
    });

    it('refuses a short retained revision in the current file without closing its handle or changing bytes', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await doc.mutate(1, append('+retained'));
        await doc.restore(2, 1);
        await doc.close();
        const revision = path.join(docDir(doc), 'r1.pdf');
        await truncate(revision, 4);
        const reopened = await open(store(), doc.id);
        const state = reopened.state();
        const manifest = await readFile(path.join(docDir(doc), 'manifest.json'));

        await expect.soft(reopened.restore(1, 2)).rejects.toThrow(/short/iu);
        expect.soft(reopened.state()).toEqual(state);
        expect.soft(await currentText(reopened)).toBe('base');
        expect.soft(await readFile(path.join(docDir(doc), 'manifest.json'))).toEqual(manifest);
        expect(await readFile(revision, 'utf8')).toBe('base');
    });

    it.each(['missing', 'short'] as const)(
        'refuses to restore a %s retained revision without writing or zero-padding bytes',
        async (damage) => {
            const doc = await create(store(), {ext: 'pdf', source: new Blob(['recorded revision'])});
            await doc.mutate(1, rewrite('current revision'));
            await doc.close();
            const revision = path.join(docDir(doc), 'r1.pdf');
            await (damage === 'missing' ? rm(revision) : truncate(revision, 3));
            const fault = crashingPort(createNodeStorePort(root), () => false);
            const reopened = await open(store(fault.port), doc.id);
            const files = async () =>
                Promise.all((await readdir(docDir(doc))).sort().map(async (name) => [name, await readFile(path.join(docDir(doc), name))]));
            const before = await files();
            const state = reopened.state();
            try {
                await expect.soft(reopened.restore(2, 1)).rejects.toThrow(/missing|short/iu);
                expect.soft(reopened.state()).toEqual(state);
                expect.soft(await currentText(reopened)).toBe('current revision');
                // Includes the manifest and every revision byte: a missing file must not be recreated,
                // and a short one must never be extended with zeros to its recorded length.
                expect.soft(await files()).toEqual(before);
                await reopened.close();
                expect(fault.openHandles()).toBe(0);
            } finally {
                await reopened.close();
                await fault.kill();
            }
        },
    );
});

describe('recovery after a crash', () => {
    it.each(['missing', 'cut short'] as const)(
        'leaves a directory whose current revision file is %s as it is until the file is back',
        async (damage) => {
            const destination = path.join(workDir, 'report.pdf');
            await writeFile(destination, 'saved');
            const doc = await create(store(), {ext: 'pdf', destination});
            await doc.mutate(null, append('-edited'));
            await doc.close();
            const revision = path.join(docDir(doc), 'r1.pdf');
            const bytes = await readFile(revision);
            await (damage === 'missing' ? rm(revision) : truncate(revision, 3));
            const files = async () =>
                Promise.all((await readdir(docDir(doc))).sort().map(async (name) => [name, await readFile(path.join(docDir(doc), name))]));
            const before = await files();

            const damaged = await open(store(), doc.id);
            expect(damaged.state()).toMatchObject({current: null, destination, dirty: true, damaged: true, drafts: undefined});
            await expect(damaged.mutate(null, append('-more'))).rejects.toThrow(DamagedDocumentError);
            await expect(damaged.setDrafts(null, {note: 'kept'})).rejects.toThrow(DamagedDocumentError);
            await expect(damaged.restore(null, 1)).rejects.toThrow(DamagedDocumentError);
            await expect(saveDocument(damaged, {expected: null})).rejects.toThrow(DamagedDocumentError);
            await damaged.close();
            expect(await files()).toEqual(before);
            expect(await readFile(destination, 'utf8')).toBe('saved');

            await writeFile(revision, bytes);
            const recovered = await open(store(), doc.id);
            expect(recovered.state()).toMatchObject({dirty: true, damaged: false});
            expect(await currentText(recovered)).toBe('saved-edited');
        },
    );

    it('cuts an append that crashed while writing', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await crashDuring(
            doc,
            (operation, target) => operation === 'writeAt' && target.endsWith('r1.pdf'),
            (crashed) => crashed.mutate(1, append('-appended')),
        );
        expect(await fileSize(doc, 'r1.pdf')).toBe(8);

        const reopened = await open(store(), doc.id);
        expect(reopened.state().current).toMatchObject({id: 1, length: 4});
        expect(await fileSize(doc, 'r1.pdf')).toBe(4);
    });

    it('cuts an append that was flushed but not yet named by the manifest', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await crashDuring(
            doc,
            (operation, target) => operation === 'writeAtomic' && target.endsWith('manifest.json'),
            (crashed) => crashed.mutate(1, append('-appended')),
        );
        expect(await fileSize(doc, 'r1.pdf')).toBe(13);

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('base');
        expect(await fileSize(doc, 'r1.pdf')).toBe(4);
    });

    it('deletes the file of a rewrite that crashed while writing', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await crashDuring(
            doc,
            (operation, target) => operation === 'writeAt' && target.endsWith('r2.pdf'),
            (crashed) =>
                crashed.mutate(1, {
                    kind: 'rewrite',
                    source: (file) => file.writeAt(0, encode('rewritten')),
                    drafts: 'clear',
                }),
        );
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r1.pdf', 'r2.pdf']);

        const reopened = await open(store(), doc.id);
        expect(await currentText(reopened)).toBe('base');
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r1.pdf']);
    });

    it('deletes a file taken in as the first revision when the move crashes before its manifest replace', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        const output = path.join(workDir, 'tool-output.pdf');
        await writeFile(output, 'v2 from a tool');
        await crashDuring(
            doc,
            (operation, target) => operation === 'writeAtomic' && target.endsWith('manifest.json'),
            (crashed) => crashed.mutate(null, {kind: 'move', file: output, drafts: 'clear'}),
        );
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r2.pdf']);

        const reopened = await open(store(), doc.id);
        expect(reopened.state()).toMatchObject({current: null, history: [], dirty: false});
        expect(await readdir(docDir(doc))).toEqual(['manifest.json']);
        expect(await readFile(destination, 'utf8')).toBe('v1');
    });

    it('continues from the manifest a failed replace left on disk, so the next append cannot overwrite committed bytes', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await doc.close();
        const port = createNodeStorePort(root);
        let manifestWrite: 'lands then fails' | 'fails' | 'unreadable' = 'lands then fails';
        const flaky: IStorePort = {
            ...port,
            async writeAtomic(target, bytes) {
                if (!target.endsWith('manifest.json')) {
                    return port.writeAtomic(target, bytes);
                }
                if (manifestWrite === 'lands then fails') {
                    await port.writeAtomic(target, bytes);
                }
                throw new Error(`manifest write ${manifestWrite}`);
            },
            read: async (target) =>
                manifestWrite === 'unreadable' && target.endsWith('manifest.json') ? Promise.reject(new Error('EIO')) : port.read(target),
        };
        const live = await open(store(flaky), doc.id);

        // The rename landed and the directory flush failed: the disk names AAA.
        await expect(live.mutate(1, append('AAA'))).rejects.toThrow('lands then fails');
        expect(live.state().current).toMatchObject({id: 2, length: 7});
        // The next append starts after AAA; its own manifest write fails before landing.
        manifestWrite = 'fails';
        await expect(live.mutate(2, append('BBB'))).rejects.toThrow('fails');
        expect(live.state().current).toMatchObject({id: 2, length: 7});
        manifestWrite = 'unreadable';
        await expect(live.mutate(2, append('CCC'))).rejects.toThrow('unreadable');
        await expect(live.mutate(2, append('DDD'))).rejects.toThrow('open it again');
        await live.close();

        expect(await currentText(await open(store(), doc.id))).toBe('baseAAA');
    });

    it('keeps the drafts a mutation keeps when it crashes right after its manifest replace', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await doc.setDrafts(1, {note: 'first'});
        let committed = false;
        await crashDuring(
            doc,
            (operation, target) => committed || ((committed = operation === 'writeAtomic' && target.endsWith('manifest.json')), false),
            async (crashed) => {
                await crashed.mutate(1, append('+bytes', 'keep'));
                await crashed.setDrafts(2, {note: 'lost'});
            },
        );

        const reopened = await open(store(), doc.id);
        expect(reopened.state()).toMatchObject({current: {id: 2}, drafts: {note: 'first'}, dirty: true});
        expect(await currentText(reopened)).toBe('base+bytes');
        expect((await readdir(docDir(doc))).filter((name) => name.startsWith('drafts-'))).toHaveLength(1);
    });

    it('commits the drafts a mutation replaces or clears with its bytes, and only those', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
        await doc.setDrafts(1, {note: 'first'});
        await crashDuring(
            doc,
            (operation, target) => operation === 'writeAtomic' && target.endsWith('manifest.json'),
            (crashed) => crashed.mutate(1, append('+note', {replace: {note: 'second'}})),
        );
        expect((await readdir(docDir(doc))).filter((name) => name.startsWith('drafts-'))).toHaveLength(2);

        const reopened = await open(store(), doc.id);
        expect(reopened.state()).toMatchObject({current: {id: 1}, drafts: {note: 'first'}});
        expect((await readdir(docDir(doc))).filter((name) => name.startsWith('drafts-'))).toHaveLength(1);
        await reopened.mutate(1, append('+note', {replace: {note: 'second'}}));
        expect(reopened.state()).toMatchObject({current: {id: 2}, drafts: {note: 'second'}});
        await reopened.mutate(2, append('+more'));
        expect(reopened.state().drafts).toBeUndefined();
        expect((await readdir(docDir(doc))).sort()).toEqual(['manifest.json', 'r1.pdf']);
    });

    it.each([
        ['before', false, 'three', ['manifest.json', 'r1.pdf', 'r2.pdf', 'r3.pdf']],
        ['right after', true, 'one', ['manifest.json', 'r1.pdf', 'r3.pdf']],
    ])(
        'leaves the old or the restored revision when an undo crashes %s its manifest replace',
        async (_label, afterReplace, text, files) => {
            const doc = await create(store(), {ext: 'pdf', source: new Blob(['one'])});
            await doc.mutate(1, rewrite('two'));
            await doc.retain([1]);
            await doc.mutate(2, rewrite('three'));
            let replaced = false;
            await crashDuring(
                doc,
                (operation, target) => {
                    const manifest = operation === 'writeAtomic' && target.endsWith('manifest.json');
                    if (!afterReplace || replaced) {
                        return manifest || replaced;
                    }
                    replaced = manifest;
                    return false;
                },
                async (crashed) => {
                    await crashed.restore(3, 1);
                    await crashed.setDrafts(1, {note: 'lost'});
                },
            );

            const reopened = await open(store(), doc.id);
            expect(await currentText(reopened)).toBe(text);
            expect((await readdir(docDir(doc))).sort()).toEqual(files);
        },
    );

    it.each([
        ['the new bytes', 'old new', true],
        ['the old bytes', 'old', false],
        ['foreign bytes', 'foreign', false],
    ])('settles a publish that crashed before its acknowledgement, with the destination holding %s', async (_label, onDisk, adopted) => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'old');
        const doc = await create(store(), {ext: 'pdf', destination});
        await doc.mutate(null, append(' new'));

        let published = false;
        await doc.close();
        const crash = crashingPort(
            createNodeStorePort(root),
            (operation, target) => published && operation === 'writeAtomic' && target.endsWith('manifest.json'),
        );
        const crashed = await openDocument(
            store(
                crash.port,
                filePublication(() => {
                    published = true;
                }),
            ),
            doc.id,
        );
        const unacknowledged = await saveDocument(crashed, {expected: 2});
        expect(unacknowledged).toMatchObject({
            status: 'saved',
            externalWriteCommitted: true,
            pendingPublish: {destination, witness: await witnessOf(encode('old new'))},
        });
        expect(unacknowledged.status === 'saved' && unacknowledged.acknowledgmentError).toBeInstanceOf(Error);
        await crash.kill();
        expect(await readFile(destination, 'utf8')).toBe('old new');
        await writeFile(destination, onDisk);

        const reopened = await open(store(), doc.id);
        expect(reopened.snapshot().pendingPublish).toBeUndefined();
        expect(reopened.state()).toMatchObject({
            baseline: await witnessOf(encode(adopted ? 'old new' : 'old')),
            dirty: !adopted,
        });
        const saved = await saveDocument(reopened, {expected: 2});
        expect(saved.status).toBe(onDisk === 'foreign' ? 'conflict' : 'saved');
        expect(await readFile(destination, 'utf8')).toBe(onDisk === 'foreign' ? 'foreign' : 'old new');
    });

    it('recovers a 2 GiB sparse revision after a crashed append without reading it', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['head'])});
        await doc.mutate(1, {
            kind: 'rewrite',
            async source(file) {
                // NTFS otherwise zero-fills the gap on the tail write instead of making a sparse fixture.
                if (process.platform === 'win32') {
                    execFileSync('fsutil.exe', ['sparse', 'setflag', path.join(docDir(doc), 'r2.pdf')], {windowsHide: true});
                }
                await file.truncate(TWO_GIB);
                await file.writeAt(TWO_GIB - 4, encode('tail'));
            },
            drafts: 'clear',
        });
        await crashDuring(
            doc,
            (operation, target) => operation === 'writeAt' && target.endsWith('r2.pdf'),
            (crashed) => crashed.mutate(2, append('-appended')),
        );
        expect(await fileSize(doc, 'r2.pdf')).toBe(TWO_GIB + 4);

        let bytesRead = 0;
        const port = createNodeStorePort(root);
        const counting: IStorePort = {
            ...port,
            read: async (target) => {
                const bytes = await port.read(target);
                bytesRead += bytes.byteLength;
                return bytes;
            },
            open: async (target) => {
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
        expect(reopened.state().current).toMatchObject({id: 2, length: TWO_GIB});
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
        const doc = await create(store(), {ext: 'pdf', destination});
        await doc.setDrafts(null, {note: 'unsaved'});
        // Drafts alone copy nothing: they apply to the destination.
        expect(doc.state()).toMatchObject({current: null, drafts: {note: 'unsaved'}, dirty: true});
        expect((await readdir(docDir(doc))).filter((name) => name.startsWith('r'))).toEqual([]);

        const saved = await saveDocument(doc, {expected: null, commit: append('+note')});
        expect(saved).toMatchObject({status: 'saved', revision: {id: 2}});
        expect(await readFile(destination, 'utf8')).toBe('v1+note');
        expect(doc.state()).toMatchObject({drafts: undefined, dirty: false});
        expect(await saveDocument(doc, {expected: 2})).toMatchObject({status: 'saved'});

        await doc.restore(2, 1);
        expect(doc.state().dirty).toBe(true);
        await doc.restore(1, 2);
        expect(doc.state().dirty).toBe(false);
    });

    it('builds a Save of drafts without bytes on a destination changed since, refuses it, and Save As rescues the edit', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        await doc.setDrafts(null, {note: 'unsaved'});
        await writeFile(path.join(workDir, 'foreign.pdf'), 'foreign v2');
        await rename(path.join(workDir, 'foreign.pdf'), destination);

        // Readers never meet bytes the person has not seen; a Save builds on them as they are now.
        expect(await doc.materialize()).toBeNull();
        expect(await doc.materialize(true)).toMatchObject({id: 1, witness: undefined});
        expect(await doc.setDrafts(null, {note: 'stale against foreign bytes'})).toEqual({
            status: 'stale-revision',
            current: expect.objectContaining({id: 1, witness: undefined}),
        });
        expect(await saveDocument(doc, {expected: 1, commit: append('+note')})).toEqual({status: 'conflict'});
        expect(await readFile(destination, 'utf8')).toBe('foreign v2');
        const copy = path.join(workDir, 'copy.pdf');
        expect(await saveDocument(doc, {expected: 2, saveAs: copy})).toMatchObject({status: 'saved'});
        expect(await readFile(copy, 'utf8')).toBe('foreign v2+note');
        expect(await readFile(destination, 'utf8')).toBe('foreign v2');
    });

    it('records the file a publish stages beside the destination before it exists, and drops the record when the publish fails first', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const temp = path.join(workDir, '.0123456789abcdef.tmp');
        const recorded: unknown[] = [];
        const publication: IPublicationPort = {
            ...filePublication(),
            async publish(_destination, _source, _expected, _stage, reserve) {
                await reserve?.(temp);
                recorded.push(JSON.parse(await readFile(path.join(docDir(doc), 'manifest.json'), 'utf8')).pendingPublish);
                throw new Error('copy failed');
            },
        };
        const doc = await create(store(undefined, publication), {ext: 'pdf', destination});
        await expect(saveDocument(doc, {expected: null, commit: rewrite('v2')})).rejects.toThrow('copy failed');
        expect(recorded).toEqual([{destination, temp}]);
        expect(doc.state()).toMatchObject({current: {id: 2}});
        expect(doc.snapshot().pendingPublish).toBeUndefined();
    });

    it('refuses a destination changed elsewhere and keeps the committed work', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        await doc.mutate(null, append('+mine'));
        await writeFile(destination, 'theirs');

        expect(await saveDocument(doc, {expected: 2, commit: append('+more')})).toEqual({status: 'conflict'});
        expect(await readFile(destination, 'utf8')).toBe('theirs');
        expect(await currentText(doc)).toBe('v1+mine+more');
        expect(doc.state()).toMatchObject({dirty: true, current: {id: 3}});
        expect(await saveDocument(doc, {expected: 2})).toMatchObject({status: 'stale-revision', current: {id: 3}});

        const copy = path.join(workDir, 'copy.pdf');
        expect(await saveDocument(doc, {expected: 3, saveAs: copy})).toMatchObject({status: 'saved'});
        expect(await readFile(copy, 'utf8')).toBe('v1+mine+more');
        expect(doc.state()).toMatchObject({destination: copy, dirty: false});
    });

    it("saves a document undone to its destination's bytes as those bytes, with nothing to write in place", async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const doc = await create(store(), {ext: 'pdf', destination});
        await doc.mutate(null, rewrite('v2'));
        await doc.restore(2, 1);
        expect(await saveDocument(doc, {expected: null})).toEqual({status: 'saved', revision: null});

        const copy = path.join(workDir, 'copy.pdf');
        const saved = await saveDocument(doc, {expected: null, saveAs: copy});
        expect(saved).toMatchObject({status: 'saved', revision: {id: 1, witness: await witnessOf(encode('v1'))}});
        expect(await readFile(copy, 'utf8')).toBe('v1');
        expect(doc.state()).toMatchObject({current: {id: 1}, destination: copy, dirty: false, history: [{id: 2}]});
        await doc.restore(1, 2);
        expect(await currentText(doc)).toBe('v2');
    });

    it.each([false, true])(
        "keeps the destination's bytes for undo when a Save replaces it or a Save As rebinds it (Save As: %s)",
        async (saveAs) => {
            const destination = path.join(workDir, 'paper.pdf');
            await writeFile(destination, 'v1');
            const doc = await create(store(), {ext: 'pdf', destination});
            await doc.mutate(null, rewrite('v2'));
            await doc.retain([1]);
            const copy = path.join(workDir, 'copy.pdf');
            expect(await saveDocument(doc, {expected: 2, ...(saveAs ? {saveAs: copy} : {})})).toMatchObject({status: 'saved'});
            expect(await readFile(saveAs ? copy : destination, 'utf8')).toBe('v2');
            await doc.close();

            const reopened = await open(store(), doc.id);
            expect(await reopened.restore(2, 1)).toMatchObject({status: 'committed', revision: {id: 1}});
            expect(await currentText(reopened)).toBe('v1');
            expect(reopened.state().dirty).toBe(true);
        },
    );

    it('starts an imported document clean, keeps it clean through an imported rewrite, and sends it to Save As', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['dropped']), imported: true});
        expect(doc.state()).toMatchObject({destination: null, baseline: await witnessOf(encode('dropped')), dirty: false});
        await doc.mutate(1, {...rewrite('decrypted'), imported: true});
        await doc.close();
        const reopened = await open(store(), doc.id);
        expect(reopened.state()).toMatchObject({baseline: await witnessOf(encode('decrypted')), history: [], dirty: false});
        expect(await saveDocument(reopened, {expected: 2})).toEqual({status: 'needs-save-as'});
        await reopened.mutate(2, append('+edit'));
        expect(reopened.state().dirty).toBe(true);
    });

    it('sends a document without a destination to Save As', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['scanned'])});
        expect(doc.state().dirty).toBe(true);
        expect(await saveDocument(doc, {expected: 1})).toEqual({status: 'needs-save-as'});
        const destination = path.join(workDir, 'scan.pdf');
        expect(await saveDocument(doc, {expected: 1, saveAs: destination})).toMatchObject({status: 'saved'});
        expect(await readFile(destination, 'utf8')).toBe('scanned');
        expect(doc.state().dirty).toBe(false);
    });
});

describe('fork', () => {
    it('clones the current bytes, destination, baseline and drafts into an independent directory', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const source = await create(store(), {ext: 'pdf', destination});
        await source.mutate(null, append('+a'));
        await source.mutate(2, append('+redo'));
        await source.restore(3, 2);
        await source.setDrafts(2, {note: 'unsaved'});

        const fork = keep(await forkDocument(store(), source.id));
        expect(fork.id).not.toBe(source.id);
        expect(fork.state()).toMatchObject({
            current: {id: 2, length: 4},
            history: [],
            destination,
            baseline: await witnessOf(encode('v1')),
            drafts: {note: 'unsaved'},
            dirty: true,
        });
        expect(await currentText(fork)).toBe('v1+a');

        await fork.mutate(2, append('+fork'));
        expect(await currentText(fork)).toBe('v1+a+fork');
        expect(await currentText(source)).toBe('v1+a');
        expect(source.state()).toMatchObject({current: {id: 2}, drafts: {note: 'unsaved'}});
        await fork.close();
        expect(await currentText(await open(store(), fork.id))).toBe('v1+a+fork');
        expect(await saveDocument(source, {expected: 2})).toMatchObject({status: 'saved'});
        expect(await readFile(destination, 'utf8')).toBe('v1+a');
    });

    it('creates and forks into the directory the caller names, so it can lock it before it exists', async () => {
        const named = keep(await create(store(), {ext: 'pdf', source: new Blob([encode('v1')]), imported: true, id: 'chosen-id'}));
        expect(named.id).toBe('chosen-id');
        const fork = keep(await forkDocument(store(), named.id, 'fork-id'));
        expect(fork.id).toBe('fork-id');
        expect(await currentText(fork)).toBe('v1');
        await expect(create(store(), {ext: 'pdf', source: new Blob([encode('v1')]), id: '../escape'})).rejects.toThrow(
            'Invalid document directory id',
        );
    });

    it('keeps the file name a document was created under through edits, forks and reopening, and opens a manifest without one', async () => {
        const named = await create(store(), {name: 'Scan 2.PDF', source: new Blob([encode('v1')])});
        await named.mutate(1, append('+a'));
        expect(named.snapshot()).toMatchObject({name: 'Scan 2.PDF', ext: 'pdf'});
        const fork = keep(await forkDocument(store(), named.id));
        await fork.close();
        expect((await open(store(), fork.id)).snapshot()).toMatchObject({name: 'Scan 2.PDF', ext: 'pdf'});
        expect((await create(store(), {name: 'notes', source: new Blob([encode('x')])})).snapshot()).toMatchObject({
            name: 'notes',
            ext: 'bin',
        });

        const unnamed = await create(store(), {ext: 'pdf', source: new Blob([encode('v1')])});
        await unnamed.close();
        expect((await open(store(), unnamed.id)).snapshot().name).toBeUndefined();
    });
});

describe('workspace checkpoints and collection', () => {
    it('removes clean unreferenced directories and what an interrupted open left, and keeps all other unsaved work', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'v1');
        const [unreferenced, referenced, held, openOnly, decrypted, drafted, edited] = await Promise.all([
            create(store(), {ext: 'pdf', destination}),
            create(store(), {ext: 'pdf', destination}),
            create(store(), {ext: 'pdf', destination}),
            create(store(), {ext: 'pdf', source: new Blob(['new']), openOnly: true}),
            create(store(), {ext: 'pdf', destination}),
            create(store(), {ext: 'pdf', source: new Blob(['new'])}),
            create(store(), {ext: 'pdf', source: new Blob(['new'])}),
        ]);
        // An open's own rewrite (decrypting, normalizing) marks itself `openOnly`, so an interrupted open can be collected.
        await decrypted.mutate(null, {...rewrite('decrypted'), openOnly: true});
        await drafted.setDrafts(1, {note: 'committed before any checkpoint named it'});
        await edited.mutate(1, append('+1'));
        await edited.mutate(2, append('+2'));
        const port = createNodeStorePort(root);
        await writeWorkspaceCheckpoint(port, 'window-1', {
            tabs: {a: {directory: referenced.id, view: {page: 3}}, b: {directory: referenced.id, view: {page: 9}}},
            layout: {panes: [['a', 'b']]},
        });
        expect((await readWorkspaceCheckpoints(port)).get('window-1')?.tabs.b).toEqual({directory: referenced.id, view: {page: 9}});

        await writeFile(path.join(root, 'workspaces', 'window-2.json'), '{"version":1,"tabs":{"a":{}}}');
        await writeFile(path.join(root, 'workspaces', 'window-1.json.crashed.tmp'), '{"version":1');
        const hold = async (id: string) => (id === held.id ? null : () => {});
        const unsaved = [openOnly.id, decrypted.id, drafted.id, edited.id].sort();
        const sorted = (result: {removed: string[]; unsaved: string[]}) => ({
            removed: result.removed.sort(),
            unsaved: result.unsaved.sort(),
        });
        // An unreadable checkpoint might name anything: nothing goes.
        expect(sorted(await collectDocuments(store(port), hold))).toEqual({removed: [], unsaved});

        await removeWorkspaceCheckpoint(port, 'window-2');
        expect(sorted(await collectDocuments(store(port), hold))).toEqual({
            removed: [unreferenced.id, openOnly.id, decrypted.id].sort(),
            unsaved: [drafted.id, edited.id].sort(),
        });
        expect((await readdir(path.join(root, 'documents'))).sort()).toEqual([referenced.id, held.id, drafted.id, edited.id].sort());
        expect(await readdir(path.join(root, 'workspaces'))).toEqual(['window-1.json']);
    });

    it('returns a directory another window holds as held, not as clean, and keeps it', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['new'])});
        await doc.setDrafts(1, {note: 'unsaved in a window that holds it'});
        await doc.close();
        const port = createNodeStorePort(root);
        const result = await collectDocuments(store(port), async () => null);
        expect(result).toMatchObject({removed: [], unsaved: [], held: [doc.id]});
        expect(await readdir(path.join(root, 'documents'))).toEqual([doc.id]);
    });

    it('decides and removes each directory while holding it', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob(['new']), imported: true});
        await doc.close();
        const port = createNodeStorePort(root);
        const steps: string[] = [];
        const watched: IStorePort = {...port, remove: async (target) => (steps.push(`remove ${target}`), port.remove(target))};
        await collectDocuments(store(watched), async (id) => (steps.push(`hold ${id}`), () => steps.push(`release ${id}`)));
        expect(steps).toEqual([`hold ${doc.id}`, `remove documents/${doc.id}`, `release ${doc.id}`]);
    });

    it('preserves an unnamed first byte edit (next: 3, no drafts, no publish) and older ambiguous dirty manifests when checkpoint naming fails', async () => {
        const destination = path.join(workDir, 'paper.pdf');
        await writeFile(destination, 'original-pdf');
        const port = createNodeStorePort(root);
        const docStore = store(port);

        // Fault-injected checkpoint write fails, yet the first byte edit still commits (next: 3, 0 drafts, 0 publish records).
        const failingCheckpointPort: IStorePort = {
            ...port,
            writeAtomic: async (target, bytes) => {
                if (target.startsWith('workspaces/')) {
                    throw new Error('Injected checkpoint write failure');
                }
                return port.writeAtomic(target, bytes);
            },
        };
        const firstAppend = await create(docStore, {ext: 'pdf', destination});
        await expect(
            writeWorkspaceCheckpoint(failingCheckpointPort, 'window-1', {
                tabs: {[firstAppend.id]: {directory: firstAppend.id, view: null}},
                layout: null,
            }),
        ).rejects.toThrow('Injected checkpoint write failure');
        await firstAppend.mutate(null, append('+first-edit'));
        const firstAppendSnap = firstAppend.snapshot();
        expect(firstAppendSnap.next).toBe(3);
        expect(firstAppendSnap.drafts).toBeUndefined();
        expect(firstAppendSnap.pendingPublish).toBeUndefined();
        expect(firstAppendSnap.unsettled).toBeUndefined();
        expect(firstAppendSnap.current?.openOnly).toBeUndefined();

        const firstRewrite = await create(docStore, {ext: 'pdf', destination});
        await firstRewrite.mutate(null, rewrite('first-rewrite'));

        // A subsequent open-time repair on an already-edited document must never downgrade it to openOnly.
        const repairedAfterEdit = await create(docStore, {ext: 'pdf', destination});
        await repairedAfterEdit.mutate(null, append('+user-edit'));
        await repairedAfterEdit.mutate(2, {...rewrite('repaired-user-edit'), openOnly: true});
        expect(repairedAfterEdit.snapshot().current?.openOnly).toBeUndefined();

        // Older ambiguous dirty manifest from a previous build (no `openOnly` field, next: 3, no drafts/publish).
        const legacyAmbiguous = await create(docStore, {ext: 'pdf', destination});
        await legacyAmbiguous.mutate(null, rewrite('legacy-unsaved'));
        const legacySnap = legacyAmbiguous.snapshot();
        expect(legacySnap.next).toBe(3);
        expect(legacySnap.current?.openOnly).toBeUndefined();
        const openOnlyInterrupted = await create(docStore, {ext: 'pdf', destination});
        await openOnlyInterrupted.mutate(null, {...rewrite('decrypted-open-only'), openOnly: true});

        await Promise.all([firstAppend, firstRewrite, repairedAfterEdit, legacyAmbiguous, openOnlyInterrupted].map((doc) => doc.close()));

        const result = await collectDocuments(docStore, async () => () => {});
        expect(result.removed).toEqual([openOnlyInterrupted.id]);
        expect(result.unsaved.sort()).toEqual([firstAppend.id, firstRewrite.id, repairedAfterEdit.id, legacyAmbiguous.id].sort());

        const reopened = await open(docStore, firstAppend.id);
        expect(await currentText(reopened)).toBe('original-pdf+first-edit');
    });
});

describe('OpenDocument shared revision and append lifecycle', () => {
    it('unifies numeric and browser revision token codecs, stale checks, staged appends, and restore', async () => {
        const destination = path.join(workDir, 'shared.pdf');
        await writeFile(destination, 'base');
        const doc = await create(store(), {ext: 'pdf', destination});
        const codec = createRevisionTokenCodec('browser');
        const numeric = createRevisionTokenCodec('numeric');
        let editNotified = 0;
        let active = true;
        const openDoc = new OpenDocument(doc, {
            codec,
            isActive: () => active,
            beforeEdit: async () => {
                editNotified += 1;
            },
        });

        const rev1 = openDoc.token();
        expect(rev1).toBe(`drt1:browser:${doc.id}:1`);
        expect(codec.parseId(doc.id, rev1)).toBe(1);
        expect(codec.parseId('other-doc', rev1)).toBe(-1);
        expect(numeric.format(doc.id, 2)).toBe('2');
        expect(numeric.parseId(doc.id, '2')).toBe(2);
        expect(numeric.parseId(doc.id, 'bad')).toBe(-1);

        expect(openDoc.checkRevision(null, {requireToken: true})).toMatchObject({status: 'missing-revision'});
        expect(openDoc.checkRevision(`drt1:browser:${doc.id}:9`)).toMatchObject({status: 'stale-revision', actual: rev1});

        const staged = await openDoc.stageAppend(
            rev1,
            async (file, base) => {
                await file.writeAt(base, encode('+staged'));
                return base + 7;
            },
            {requireToken: true},
        );
        expect(staged).toMatchObject({status: 'staged'});
        if (staged.status !== 'staged') {
            throw new Error('Expected staged append');
        }
        expect(openDoc.hasPendingAppend()).toBe(true);
        const committed = await openDoc.commitAppend(rev1, staged.lease, {requireToken: true});
        expect(committed).toMatchObject({status: 'committed', revision: {id: 2}, previousToken: rev1});
        expect(editNotified).toBe(1);
        expect(await currentText(doc)).toBe('base+staged');

        const rev2 = openDoc.token();
        expect(rev2).toBe(`drt1:browser:${doc.id}:2`);
        const restored = await openDoc.restore(rev2, rev1, {requireToken: true, ownCurrentFileAfterRestore: true});
        expect(restored).toMatchObject({status: 'committed', revision: {id: 1}, previousToken: rev2, currentToken: rev1});
        expect(await currentText(doc)).toBe('base');

        active = false;
        expect(openDoc.checkRevision(rev1)).toMatchObject({status: 'stale-revision'});
    });
});

describe('node store port', () => {
    it('creates missing directories when Node names the first one differently, as Windows does', async () => {
        const mkdir = promises.mkdir.bind(promises);
        const spy = vi.spyOn(promises, 'mkdir').mockImplementation((async (dir: string, options?: {recursive?: boolean}) => {
            const first = await mkdir(dir, options);
            return typeof first === 'string' ? `\\\\?\\${first}` : first;
        }) as typeof promises.mkdir);
        try {
            await createNodeStorePort(root).writeAtomic('documents/a/manifest.json', encode('{}'));
        } finally {
            spy.mockRestore();
        }
        expect(await readFile(path.join(root, 'documents', 'a', 'manifest.json'), 'utf8')).toBe('{}');
    }, 5_000);
});

it.each(['size', 'truncate'])('#1609 closes a fork copy when its %s fails', async (operation) => {
    const fault = crashingPort(
        createNodeStorePort(root),
        (op, target) => op === operation && target === 'documents/failed-fork/r1.pdf',
        false,
    );
    const doc = await create(store(fault.port), {ext: 'pdf', source: new Blob(['base'])});
    await writeFile(path.join(docDir(doc), 'r1.pdf'), 'base+uncommitted tail');
    const manifest = await readFile(path.join(docDir(doc), 'manifest.json'));
    try {
        await expect(forkDocument(store(fault.port), doc.id, 'failed-fork')).rejects.toThrow(`fault at ${operation}`);
        expect.soft(await currentText(doc)).toBe('base');
        expect.soft(await readFile(path.join(docDir(doc), 'manifest.json'))).toEqual(manifest);
        await doc.close();
        expect(fault.openHandles()).toBe(0);
    } finally {
        await doc.close();
        await fault.kill();
    }
});

it('accepts drafts expecting null after an unchanged baseline materialization (including post-undo), and rejects mutations or queued foreign saveAs', async () => {
    const unchangedPath = path.join(workDir, 'unchanged.pdf');
    await writeFile(unchangedPath, 'v1');
    const unchanged = await create(store(), {ext: 'pdf', destination: unchangedPath});
    const initialGuard = {
        byteRevision: unchanged.state().byteRevision,
        baseline: unchanged.state().baseline,
        foreignStaged: unchanged.state().current?.foreign === 'staged',
    };
    expect(unchanged.state().current).toBeNull();
    expect(await unchanged.materialize()).toMatchObject({id: 1, witness: initialGuard.baseline});
    expect(await unchanged.setDrafts(null, {note: 'with guard'}, initialGuard)).toMatchObject({status: 'stored', revision: {id: 1}});
    expect(await unchanged.setDrafts(null, {note: 'desktop symmetry'})).toMatchObject({status: 'stored', revision: {id: 1}});
    expect(unchanged.state().drafts).toEqual({note: 'desktop symmetry'});

    // Any actual revision advance (or rewrite + undo returning to 1) must be rejected as stale.
    expect(await unchanged.mutate(1, append('+v2'))).toMatchObject({status: 'committed', revision: {id: 2}});
    expect(await unchanged.setDrafts(null, {note: 'stale rev2'}, initialGuard)).toMatchObject({status: 'stale-revision', current: {id: 2}});
    expect(await unchanged.restore(2, 1)).toMatchObject({status: 'committed', revision: {id: 1}});
    expect(await unchanged.setDrafts(null, {note: 'stale after undo'}, initialGuard)).toMatchObject({
        status: 'stale-revision',
        current: {id: 1},
    });
    await unchanged.close();

    // Post-undo valid draft captured at current === null must still succeed when unchanged baseline later materializes.
    const postUndoPath = path.join(workDir, 'post-undo.pdf');
    await writeFile(postUndoPath, 'v1');
    const postUndo = await create(store(), {ext: 'pdf', destination: postUndoPath});
    const beforeRewriteGuard = {
        byteRevision: postUndo.state().byteRevision,
        baseline: postUndo.state().baseline,
        foreignStaged: postUndo.state().current?.foreign === 'staged',
    };
    expect(await postUndo.mutate(null, {kind: 'rewrite', source: new Blob(['v2']), drafts: 'clear'})).toMatchObject({
        status: 'committed',
        revision: {id: 2},
    });
    expect(await postUndo.restore(2, 1)).toMatchObject({status: 'committed', revision: null});
    expect(postUndo.state().current).toBeNull();
    expect(postUndo.state().byteRevision).toBeGreaterThan(beforeRewriteGuard.byteRevision);
    // Stale draft captured before rewrite + undo is rejected even though current returned to null.
    expect(await postUndo.setDrafts(null, {note: 'stale across rewrite+undo'}, beforeRewriteGuard)).toMatchObject({
        status: 'stale-revision',
        current: null,
    });
    // Fresh draft captured after undo succeeds even when unchanged baseline materializes null -> 1.
    const postUndoGuard = {
        byteRevision: postUndo.state().byteRevision,
        baseline: postUndo.state().baseline,
        foreignStaged: postUndo.state().current?.foreign === 'staged',
    };
    expect(await postUndo.materialize()).toMatchObject({id: 1, witness: postUndoGuard.baseline});
    expect(await postUndo.setDrafts(null, {note: 'valid post-undo draft'}, postUndoGuard)).toMatchObject({
        status: 'stored',
        revision: {id: 1},
    });
    expect(postUndo.state().drafts).toEqual({note: 'valid post-undo draft'});
    await postUndo.close();

    // Queued saveAs over externally modified bytes ahead of a 2-arg setDrafts(null, drafts) must reject old-bytes drafts.
    const replacedPath = path.join(workDir, 'replaced.pdf');
    const copyPath = path.join(workDir, 'replaced-copy.pdf');
    await writeFile(replacedPath, 'v1');
    const replaced = await create(store(), {ext: 'pdf', destination: replacedPath});
    const originalGuard = {
        byteRevision: replaced.state().byteRevision,
        baseline: replaced.state().baseline,
        foreignStaged: replaced.state().current?.foreign === 'staged',
    };
    await writeFile(path.join(workDir, 'foreign-next.pdf'), 'foreign v2');
    await rename(path.join(workDir, 'foreign-next.pdf'), replacedPath);
    const queuedSaveAs = saveDocument(replaced, {expected: null, saveAs: copyPath});
    expect(replaced.state().current).toBeNull();
    expect(replaced.state().baseline).toBe(originalGuard.baseline);
    const queuedTwoArgDraft = replaced.setDrafts(null, {note: 'stale queued 2-arg draft'});
    expect(await queuedSaveAs).toMatchObject({status: 'saved', revision: {id: 1, foreign: 'committed'}});
    expect(await queuedTwoArgDraft).toMatchObject({status: 'stale-revision', current: {id: 1, foreign: 'committed'}});
    expect(replaced.state().drafts).toBeUndefined();
    expect(await replaced.setDrafts(null, {note: 'stale after foreign saveAs'}, originalGuard)).toMatchObject({
        status: 'stale-revision',
        current: {id: 1, foreign: 'committed'},
    });
    await replaced.close();
});

it('keeps byteRevision stable across ownCurrentFile backing-file moves so queued drafts store cleanly', async () => {
    const doc = await create(store(), {ext: 'pdf', source: new Blob(['base'])});
    expect(await doc.mutate(1, append('+redo'))).toMatchObject({status: 'committed', revision: {id: 2}});
    await doc.retain([1, 2]);
    expect(await doc.restore(2, 1)).toMatchObject({status: 'committed', revision: {id: 1}});
    const beforeMove = doc.state();
    const move = doc.ownCurrentFile();
    const draft = doc.setDrafts(
        1,
        {note: 'queued behind ownCurrentFile'},
        {
            byteRevision: beforeMove.byteRevision,
            baseline: beforeMove.baseline,
            foreignStaged: beforeMove.current?.foreign === 'staged',
        },
    );
    expect(await move).toMatchObject({id: 1});
    expect(doc.state().byteRevision).toBe(beforeMove.byteRevision);
    expect(await draft).toMatchObject({status: 'stored', revision: {id: 1}});
    expect(doc.state().drafts).toEqual({note: 'queued behind ownCurrentFile'});
    await doc.close();
});

it('persists foreign staged/committed revision state across reopen, resolvePending adoption, and undo after append rescue without affecting untitled undo-to-r1', async () => {
    // 1. Foreign Save As: rejected during ensureCurrent(true), during staged pendingPublish, and after failed/conflicted publish; accepted once published and persisted across reopen.
    const foreignPath = path.join(workDir, 'foreign-saveas.pdf');
    const failCopy = path.join(workDir, 'foreign-fail-copy.pdf');
    const okCopy = path.join(workDir, 'foreign-ok-copy.pdf');
    await writeFile(foreignPath, 'v1');

    let failMode: 'none' | 'conflict' | 'throw' | 'crash-after-stage-unadopted' | 'crash-after-stage-adopted' = 'none';
    let pauseAfterStage: {started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void>} | null = null;
    const baseStore = store();
    const customStore: IDocumentStore = {
        port: baseStore.port,
        publication: {
            witness: (dest, content) => baseStore.publication.witness(dest, content),
            source: (dest) => baseStore.publication.source(dest),
            async publish(dest, source, expected, stage, reserve) {
                if (failMode === 'conflict') {
                    await stage('staged-witness-conflict');
                    return {status: 'conflict'};
                }
                if (failMode === 'throw') {
                    throw new Error('publish failed before stage');
                }
                if (failMode === 'crash-after-stage-unadopted') {
                    await stage('unmatched-staged-witness');
                    throw new Error('simulated crash before write');
                }
                if (failMode === 'crash-after-stage-adopted') {
                    const published = await baseStore.publication.publish(dest, source, expected, stage, reserve);
                    if (published.status !== 'published') {
                        return published;
                    }
                    // Simulate crash after destination holds the published witness, before saveDocument acknowledges.
                    throw new Error('simulated crash after publish');
                }
                if (pauseAfterStage) {
                    const paused = pauseAfterStage;
                    return baseStore.publication.publish(
                        dest,
                        source,
                        expected,
                        async (witness) => {
                            await stage(witness);
                            paused.started.resolve();
                            await paused.release.promise;
                        },
                        reserve,
                    );
                }
                return baseStore.publication.publish(dest, source, expected, stage, reserve);
            },
        },
    };

    const doc = await create(customStore, {ext: 'pdf', destination: foreignPath});
    await writeFile(path.join(workDir, 'foreign-src.pdf'), 'foreign v2');
    await rename(path.join(workDir, 'foreign-src.pdf'), foreignPath);

    // Pause right after ensureCurrent(true) -> foreign: 'staged' persists across close & reopen.
    expect(await doc.materialize(true)).toMatchObject({id: 1, witness: undefined, foreign: 'staged'});
    expect(doc.state().current?.foreign).toBe('staged');
    expect(await doc.setDrafts(1, {note: 'rejected while foreign staged'})).toMatchObject({
        status: 'stale-revision',
        current: {id: 1, foreign: 'staged'},
    });
    const docId = doc.id;
    await doc.close();

    // S5(a): Reopen with no pendingPublish preserves foreign: 'staged' and keeps rejecting drafts.
    const reopenedStaged = await openDocument(customStore, docId);
    expect(reopenedStaged.state().current).toMatchObject({id: 1, foreign: 'staged'});
    expect(reopenedStaged.state().current?.witness).toBeUndefined();
    expect(await reopenedStaged.setDrafts(1, {note: 'rejected after reopen while staged'})).toMatchObject({
        status: 'stale-revision',
        current: {id: 1, foreign: 'staged'},
    });

    // Failed/conflicted publish keeps foreign: 'staged' and keeps rejecting drafts.
    failMode = 'conflict';
    expect(await saveDocument(reopenedStaged, {expected: 1, saveAs: failCopy})).toEqual({status: 'conflict'});
    expect(reopenedStaged.state().current?.foreign).toBe('staged');
    expect(await reopenedStaged.setDrafts(1, {note: 'rejected after conflict'})).toMatchObject({
        status: 'stale-revision',
        current: {id: 1, foreign: 'staged'},
    });

    failMode = 'throw';
    await expect(saveDocument(reopenedStaged, {expected: 1, saveAs: failCopy})).rejects.toThrow('publish failed before stage');
    expect(reopenedStaged.state().current?.foreign).toBe('staged');
    expect(await reopenedStaged.setDrafts(1, {note: 'rejected after failed publish'})).toMatchObject({
        status: 'stale-revision',
        current: {id: 1, foreign: 'staged'},
    });

    // Pause inside publish() AFTER record() commits staged witness + pendingPublish: foreign: 'staged' stays set.
    failMode = 'none';
    pauseAfterStage = {started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>()};
    const saving = saveDocument(reopenedStaged, {expected: 1, saveAs: okCopy});
    await pauseAfterStage.started.promise;
    expect(reopenedStaged.snapshot().pendingPublish).toBeDefined();
    expect(reopenedStaged.state().current?.foreign).toBe('staged');
    const duringPending = reopenedStaged.setDrafts(1, {note: 'rejected during pendingPublish'});
    pauseAfterStage.release.resolve();
    expect(await saving).toMatchObject({status: 'saved', revision: {id: 1, foreign: 'committed'}});
    expect(await duringPending).toMatchObject({status: 'stale-revision', current: {id: 1, foreign: 'committed'}});
    expect(reopenedStaged.state().current?.foreign).toBe('committed');

    // Post-publication fresh draft succeeds and persists foreign: 'committed' across reopen.
    expect(await reopenedStaged.setDrafts(1, {note: 'valid post-publication draft'})).toMatchObject({
        status: 'stored',
        revision: {id: 1, foreign: 'committed'},
    });
    await reopenedStaged.close();
    const reopenedCommitted = await openDocument(customStore, docId);
    expect(reopenedCommitted.state().current).toMatchObject({id: 1, foreign: 'committed'});
    expect(reopenedCommitted.state().drafts).toEqual({note: 'valid post-publication draft'});
    await reopenedCommitted.close();

    // S5(b) & S5(c): Un-adopted vs adopted pendingPublish on reopen through resolvePending().
    const pendingPath = path.join(workDir, 'foreign-pending.pdf');
    const pendingCopy = path.join(workDir, 'foreign-pending-copy.pdf');
    await writeFile(pendingPath, 'v1');
    const pendingDoc = await create(customStore, {ext: 'pdf', destination: pendingPath});
    await writeFile(path.join(workDir, 'foreign-pending-src.pdf'), 'foreign v2');
    await rename(path.join(workDir, 'foreign-pending-src.pdf'), pendingPath);
    expect(await pendingDoc.materialize(true)).toMatchObject({id: 1, witness: undefined, foreign: 'staged'});

    failMode = 'crash-after-stage-unadopted';
    await expect(saveDocument(pendingDoc, {expected: 1, saveAs: pendingCopy})).rejects.toThrow('simulated crash before write');
    const pendingDocId = pendingDoc.id;
    await pendingDoc.close();
    const reopenedUnadopted = await openDocument(customStore, pendingDocId);
    expect(reopenedUnadopted.snapshot().pendingPublish).toBeUndefined();
    expect(reopenedUnadopted.state().current?.foreign).toBe('staged');
    expect(await reopenedUnadopted.setDrafts(1, {note: 'rejected after unadopted pendingPublish'})).toMatchObject({
        status: 'stale-revision',
        current: {id: 1, foreign: 'staged'},
    });

    failMode = 'crash-after-stage-adopted';
    await expect(saveDocument(reopenedUnadopted, {expected: 1, saveAs: pendingCopy})).rejects.toThrow('simulated crash after publish');
    await reopenedUnadopted.close();
    const reopenedAdopted = await openDocument(customStore, pendingDocId);
    expect(reopenedAdopted.snapshot().pendingPublish).toBeUndefined();
    expect(reopenedAdopted.state().destination).toBe(pendingCopy);
    expect(reopenedAdopted.state().current?.foreign).toBe('committed');
    expect(await reopenedAdopted.setDrafts(1, {note: 'accepted after adopted pendingPublish'})).toMatchObject({
        status: 'stored',
        revision: {id: 1, foreign: 'committed'},
    });
    await reopenedAdopted.close();

    // S6: Mutating r2 on top of staged foreign r1 archives r1 with foreign: 'committed' so undo restores foreign: 'committed' across reopen.
    const rescuePath = path.join(workDir, 'foreign-rescue.pdf');
    const rescueCopy = path.join(workDir, 'foreign-rescue-copy.pdf');
    await writeFile(rescuePath, 'v1');
    const rescueDoc = await create(store(), {ext: 'pdf', destination: rescuePath});
    await writeFile(path.join(workDir, 'foreign-rescue-src.pdf'), 'foreign v2');
    await rename(path.join(workDir, 'foreign-rescue-src.pdf'), rescuePath);
    expect(await rescueDoc.materialize(true)).toMatchObject({id: 1, witness: undefined, foreign: 'staged'});
    expect(await saveDocument(rescueDoc, {expected: 1, commit: append('+edit')})).toEqual({status: 'conflict'});
    await rescueDoc.retain([1, 2]);
    expect(await saveDocument(rescueDoc, {expected: 2, saveAs: rescueCopy})).toMatchObject({status: 'saved', revision: {id: 2}});
    expect(await rescueDoc.restore(2, 1)).toMatchObject({status: 'committed', revision: {id: 1, foreign: 'committed'}});
    expect(rescueDoc.state().current?.foreign).toBe('committed');
    const rescueDocId = rescueDoc.id;
    await rescueDoc.close();
    const reopenedRescue = await openDocument(store(), rescueDocId);
    expect(reopenedRescue.state().current).toMatchObject({id: 1, foreign: 'committed'});
    expect(await reopenedRescue.setDrafts(1, {note: 'valid draft on restored foreign r1'})).toMatchObject({
        status: 'stored',
        revision: {id: 1, foreign: 'committed'},
    });
    await reopenedRescue.close();

    // 2. Untitled doc -> mutate to r2 -> Save As -> undo back to r1 must NOT set foreign and must still accept drafts.
    const untitledCopy = path.join(workDir, 'untitled-saved.pdf');
    const untitled = await create(store(), {ext: 'pdf', source: new Blob(['untitled r1'])});
    expect(await untitled.mutate(1, append('+r2'))).toMatchObject({status: 'committed', revision: {id: 2}});
    await untitled.retain([1, 2]);
    expect(await saveDocument(untitled, {expected: 2, saveAs: untitledCopy})).toMatchObject({status: 'saved', revision: {id: 2}});
    expect(await untitled.restore(2, 1)).toMatchObject({status: 'committed', revision: {id: 1, witness: undefined}});
    expect(untitled.state().destination).toBe(untitledCopy);
    expect(untitled.state().current?.foreign).toBeUndefined();
    expect(await untitled.setDrafts(1, {note: 'valid draft on undone untitled r1'})).toMatchObject({status: 'stored', revision: {id: 1}});
    expect(untitled.state().drafts).toEqual({note: 'valid draft on undone untitled r1'});
    await untitled.close();
});

it('refuses queued and later operations on a closed DocumentDirectory without touching the manifest', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'evb-docstore-closed-'));
    try {
        const docStore = store();
        const doc = await create(docStore, {ext: 'pdf', source: new Blob(['closed-test-v1'])});
        await doc.mutate(1, append('+v2'));
        await doc.retain([1, 2]);
        const manifestBefore = new TextDecoder().decode(await docStore.port.read(`documents/${doc.id}/manifest.json`));

        await doc.close();

        await expect(doc.ownCurrentFile()).rejects.toThrow(/is closed/u);
        await expect(doc.restore(2, 1)).rejects.toThrow(/is closed/u);
        await expect(saveDocument(doc, {expected: 2, saveAs: path.join(workDir, 'out.pdf')})).rejects.toThrow(/is closed/u);

        const manifestAfter = new TextDecoder().decode(await docStore.port.read(`documents/${doc.id}/manifest.json`));
        expect(manifestAfter).toBe(manifestBefore);
    } finally {
        await rm(workDir, {recursive: true, force: true});
    }
});

describe('save publication facts under fault injection', () => {
    it('returns saved with externalWriteCommitted=true and preserves pendingPublish when final manifest acknowledgement fails', async () => {
        const destination = path.join(workDir, 'ack-fail.pdf');
        await writeFile(destination, 'v1');
        let failAck = false;
        const basePort = createNodeStorePort(root);
        const port: IStorePort = {
            ...basePort,
            writeAtomic: async (target, bytes) => {
                if (failAck && target.endsWith('manifest.json')) {
                    failAck = false;
                    throw new Error('ENOSPC: manifest acknowledgement failed');
                }
                return basePort.writeAtomic(target, bytes);
            },
        };
        const publication = filePublication(() => {
            failAck = true;
        });
        const doc = await create(store(port, publication), {ext: 'pdf', destination});
        await doc.mutate(null, append('+edited'));

        const saved = await saveDocument(doc, {expected: 2});
        const expectedWitness = await witnessOf(encode('v1+edited'));
        expect(saved).toMatchObject({
            status: 'saved',
            externalWriteCommitted: true,
            revision: {id: 2, witness: expectedWitness},
            pendingPublish: {destination, witness: expectedWitness},
        });
        expect(saved.status === 'saved' && saved.acknowledgmentError).toBeInstanceOf(Error);
        expect(await readFile(destination, 'utf8')).toBe('v1+edited');

        const manifestOnDisk = JSON.parse(await readFile(path.join(docDir(doc), 'manifest.json'), 'utf8')) as {
            pendingPublish?: {destination: string; witness?: string};
        };
        expect(manifestOnDisk.pendingPublish).toEqual({destination, witness: expectedWitness});

        // The next save settles the surviving pending witness without a false conflict and clears dirty state.
        const settled = await saveDocument(doc, {expected: 2});
        expect(settled).toMatchObject({status: 'saved', revision: {id: 2, witness: expectedWitness}});
        expect(settled.status === 'saved' && settled.acknowledgmentError).toBeUndefined();
        expect(doc.snapshot().pendingPublish).toBeUndefined();
        expect(doc.state().dirty).toBe(false);
    });

    it('reports externalWriteCommitted=null and preserves pendingPublish when publish throws after staging completes', async () => {
        const destination = path.join(workDir, 'unverified.pdf');
        await writeFile(destination, 'v1');
        const basePublication = filePublication();
        const publication: IPublicationPort = {
            ...basePublication,
            async publish(dest, source, expected, stage, reserve) {
                const bytes = await source.file.readAt(0, source.length);
                const witness = await witnessOf(bytes);
                await reserve?.(path.join(workDir, '.0123456789abcdef.tmp'));
                await stage(witness);
                throw new Error('I/O failure during close: write outcome unknown');
            },
        };
        const doc = await create(store(undefined, publication), {ext: 'pdf', destination});
        await doc.mutate(null, append('+uncertain'));

        let caught: unknown;
        try {
            await saveDocument(doc, {expected: 2});
        } catch (error) {
            caught = error;
        }
        const expectedWitness = await witnessOf(encode('v1+uncertain'));
        expect(caught).toBeInstanceOf(SavePublicationError);
        expect(caught).toMatchObject({
            externalWriteCommitted: null,
            pendingPublish: {destination, witness: expectedWitness},
            message: 'I/O failure during close: write outcome unknown',
        });
        expect(doc.snapshot().pendingPublish).toMatchObject({destination, witness: expectedWitness});
    });

    it('reports externalWriteCommitted=false and preserves errno code when publish fails before staging completes', async () => {
        const destination = path.join(workDir, 'pre-stage.pdf');
        await writeFile(destination, 'v1');
        const basePublication = filePublication();
        const publication: IPublicationPort = {
            ...basePublication,
            async publish(_dest, _source, _expected, _stage, reserve) {
                await reserve?.(path.join(workDir, '.fedcba9876543210.tmp'));
                throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
            },
        };
        const doc = await create(store(undefined, publication), {ext: 'pdf', destination});
        await doc.mutate(null, append('+denied'));

        let caught: unknown;
        try {
            await saveDocument(doc, {expected: 2});
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(SavePublicationError);
        expect(caught).toMatchObject({
            externalWriteCommitted: false,
            pendingPublish: undefined,
            code: 'EACCES',
        });
        expect(doc.snapshot().pendingPublish).toBeUndefined();
    });

    it('reports externalWriteCommitted=false when the staging manifest commit itself fails before any write starts', async () => {
        const destination = path.join(workDir, 'stage-commit-fail.pdf');
        await writeFile(destination, 'v1');
        const basePort = createNodeStorePort(root);
        let failNextStage = false;
        const port: IStorePort = {
            ...basePort,
            writeAtomic: async (target, bytes) => {
                if (failNextStage && target.endsWith('manifest.json')) {
                    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {pendingPublish?: {witness?: string}};
                    if (parsed.pendingPublish?.witness !== undefined) {
                        failNextStage = false;
                        throw new Error('ENOSPC: could not record staged witness');
                    }
                }
                return basePort.writeAtomic(target, bytes);
            },
        };
        const doc = await create(store(port), {ext: 'pdf', destination});
        await doc.mutate(null, append('+edit'));
        failNextStage = true;

        let caught: unknown;
        try {
            await saveDocument(doc, {expected: 2});
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(SavePublicationError);
        expect(caught).toMatchObject({
            externalWriteCommitted: false,
            message: 'ENOSPC: could not record staged witness',
        });
        expect(await readFile(destination, 'utf8')).toBe('v1');
        expect(doc.snapshot().pendingPublish).toBeUndefined();
    });

    it('throws SavePublicationError(externalWriteCommitted=true) when Save As manifest acknowledgement fails before adopting the new destination', async () => {
        const original = path.join(workDir, 'original.pdf');
        const copy = path.join(workDir, 'copy.pdf');
        await writeFile(original, 'v1');
        let failAck = false;
        const basePort = createNodeStorePort(root);
        const port: IStorePort = {
            ...basePort,
            writeAtomic: async (target, bytes) => {
                if (failAck && target.endsWith('manifest.json')) {
                    failAck = false;
                    throw new Error('ENOSPC: Save As manifest acknowledgement failed');
                }
                return basePort.writeAtomic(target, bytes);
            },
        };
        const doc = await create(
            store(
                port,
                filePublication(() => {
                    failAck = true;
                }),
            ),
            {ext: 'pdf', destination: original},
        );
        await doc.mutate(null, append('+copy-edit'));

        let caught: unknown;
        try {
            await saveDocument(doc, {expected: 2, saveAs: copy});
        } catch (error) {
            caught = error;
        }
        const expectedWitness = await witnessOf(encode('v1+copy-edit'));
        expect(caught).toBeInstanceOf(SavePublicationError);
        expect(caught).toMatchObject({
            externalWriteCommitted: true,
            pendingPublish: {destination: copy, witness: expectedWitness},
            message: 'ENOSPC: Save As manifest acknowledgement failed',
        });
        expect(await readFile(copy, 'utf8')).toBe('v1+copy-edit');
        expect(await readFile(original, 'utf8')).toBe('v1');
        // Manifest still names `original`, so adoption was NOT reported as complete.
        expect(doc.state().destination).toBe(original);
        expect(doc.snapshot().pendingPublish).toEqual({destination: copy, witness: expectedWitness});

        // After another edit, plain Save settles leftovers without silently switching destination to `copy.pdf`.
        await doc.mutate(2, append('+followup'));
        const plainSaved = await saveDocument(doc, {expected: 3});
        expect(plainSaved).toMatchObject({status: 'saved', revision: {id: 3}});
        expect(doc.state().destination).toBe(original);
        expect(await readFile(original, 'utf8')).toBe('v1+copy-edit+followup');
        expect(await readFile(copy, 'utf8')).toBe('v1+copy-edit');
    });

    it('attaches surviving pendingPublish with externalWriteCommitted=false when staging manifest flush fails after rename', async () => {
        const destination = path.join(workDir, 'stage-flush-fail.pdf');
        await writeFile(destination, 'v1');
        const basePort = createNodeStorePort(root);
        let failAfterStageWrite = false;
        const port: IStorePort = {
            ...basePort,
            writeAtomic: async (target, bytes) => {
                await basePort.writeAtomic(target, bytes);
                if (failAfterStageWrite && target.endsWith('manifest.json')) {
                    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {pendingPublish?: {witness?: string}};
                    if (parsed.pendingPublish?.witness !== undefined) {
                        failAfterStageWrite = false;
                        throw new Error('EIO: directory flush failed after staging manifest rename');
                    }
                }
            },
        };
        const doc = await create(store(port), {ext: 'pdf', destination});
        await doc.mutate(null, append('+edit'));
        failAfterStageWrite = true;

        let caught: unknown;
        try {
            await saveDocument(doc, {expected: 2});
        } catch (error) {
            caught = error;
        }
        const expectedWitness = await witnessOf(encode('v1+edit'));
        expect(caught).toBeInstanceOf(SavePublicationError);
        expect(caught).toMatchObject({
            externalWriteCommitted: false,
            pendingPublish: {destination, witness: expectedWitness},
            message: 'EIO: directory flush failed after staging manifest rename',
        });
        expect(await readFile(destination, 'utf8')).toBe('v1');
        expect(doc.snapshot().pendingPublish).toEqual({destination, witness: expectedWitness});
    });

    it('retains conflict and keptOriginal when clearing staged pendingPublish fails after a publication conflict', async () => {
        const destination = path.join(workDir, 'conflict-cleanup-fail.pdf');
        const keptOriginal = path.join(workDir, 'conflict-cleanup-fail (original).pdf');
        await writeFile(destination, 'v1');
        const basePort = createNodeStorePort(root);
        let failConflictCleanup = false;
        const port: IStorePort = {
            ...basePort,
            writeAtomic: async (target, bytes) => {
                if (failConflictCleanup && target.endsWith('manifest.json')) {
                    failConflictCleanup = false;
                    throw new Error('ENOSPC: conflict cleanup manifest write failed');
                }
                return basePort.writeAtomic(target, bytes);
            },
        };
        const basePublication = filePublication();
        const publication: IPublicationPort = {
            ...basePublication,
            async publish(_dest, source, _expected, stage) {
                const bytes = await source.file.readAt(0, source.length);
                await stage(await witnessOf(bytes));
                failConflictCleanup = true;
                return {status: 'conflict', keptOriginal};
            },
        };
        const doc = await create(store(port, publication), {ext: 'pdf', destination});
        await doc.mutate(null, append('+edit'));

        const result = await saveDocument(doc, {expected: 2});
        const expectedWitness = await witnessOf(encode('v1+edit'));
        expect(result).toMatchObject({
            status: 'conflict',
            keptOriginal,
            pendingPublish: {destination, witness: expectedWitness},
        });
        expect(result.status === 'conflict' && result.acknowledgmentError).toBeInstanceOf(Error);
        expect(doc.snapshot().pendingPublish).toEqual({destination, witness: expectedWitness});
    });

    it('exposes readonly state and snapshot types at compile time', async () => {
        const doc = await create(store(), {ext: 'pdf', source: new Blob([encode('v1')]), imported: true});
        const state = doc.state();
        const manifest = doc.snapshot();

        const _checkReadonly = () => {
            // @ts-expect-error state fields are readonly
            state.dirty = false;
            // @ts-expect-error state history array is readonly
            state.history.push({id: 1, witness: 'w'});
            if (state.current) {
                // @ts-expect-error revision fields are readonly
                state.current.length = 0;
            }
            // @ts-expect-error manifest fields are readonly
            manifest.next = 99;
            // @ts-expect-error manifest history array is readonly
            manifest.history.pop();
            if (manifest.unsettled) {
                // @ts-expect-error manifest unsettled array is readonly
                manifest.unsettled.push({destination: 'x'});
            }
        };

        expect(typeof _checkReadonly).toBe('function');
        expect(state.id).toBe(doc.id);
        expect(manifest.version).toBe(1);
    });
});

describe('copyNewFile exclusive staging', () => {
    let dir = '';

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'evb-copy-new-file-'));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(dir, {recursive: true, force: true});
    });

    it.each(['file', 'directory', 'symlink-to-directory'] as const)(
        'rejects existing %s targets without overwriting or writing inside them',
        async (competitorKind) => {
            if (competitorKind === 'symlink-to-directory' && process.platform === 'win32') {
                return;
            }
            const source = path.join(dir, 'source.pdf');
            const target = path.join(dir, 'target.pdf');
            const symlinkDestDir = path.join(dir, 'symlink-dest');
            await writeFile(source, 'source-bytes', 'utf8');
            if (competitorKind === 'file') {
                await writeFile(target, 'competitor-bytes', 'utf8');
            } else if (competitorKind === 'directory') {
                await mkdir(target);
            } else {
                await mkdir(symlinkDestDir);
                await symlink(symlinkDestDir, target);
            }

            await expect(copyNewFile(source, target)).rejects.toMatchObject(
                process.platform === 'win32' && competitorKind === 'directory'
                    ? {code: expect.stringMatching(/^(?:EEXIST|EPERM)$/u)}
                    : {code: 'EEXIST'},
            );

            if (competitorKind === 'file') {
                expect(await readFile(target, 'utf8')).toBe('competitor-bytes');
            } else if (competitorKind === 'directory') {
                expect((await promises.lstat(target)).isDirectory()).toBe(true);
                expect(await readdir(target)).toEqual([]);
            } else {
                expect((await promises.lstat(target)).isSymbolicLink()).toBe(true);
                expect(await readdir(symlinkDestDir)).toEqual([]);
            }
        },
    );

    it.skipIf(process.platform !== 'darwin').each(['file', 'directory', 'symlink-to-directory'] as const)(
        'rejects with EEXIST without writing through or deleting a competing %s inserted after macOS lstat',
        async (competitorKind) => {
            const source = path.join(dir, 'source.pdf');
            const target = path.join(dir, 'target.pdf');
            const symlinkDestDir = path.join(dir, 'symlink-dest');
            await writeFile(source, 'source-bytes', 'utf8');
            if (competitorKind === 'symlink-to-directory') {
                await mkdir(symlinkDestDir);
            }

            const realLstat = promises.lstat.bind(promises);
            let inserted = false;
            vi.spyOn(promises, 'lstat').mockImplementation(async (candidate, options) => {
                if (!inserted && String(candidate) === target) {
                    inserted = true;
                    try {
                        return await realLstat(candidate, options);
                    } catch (error) {
                        if (competitorKind === 'file') {
                            await writeFile(target, 'competitor-bytes', 'utf8');
                        } else if (competitorKind === 'directory') {
                            await mkdir(target);
                        } else {
                            await symlink(symlinkDestDir, target);
                        }
                        throw error;
                    }
                }
                return realLstat(candidate, options);
            });

            await expect(copyNewFile(source, target)).rejects.toMatchObject(
                process.platform === 'win32' && competitorKind === 'directory'
                    ? {code: expect.stringMatching(/^(?:EEXIST|EPERM)$/u)}
                    : {code: 'EEXIST'},
            );

            if (competitorKind === 'file') {
                expect(await readFile(target, 'utf8')).toBe('competitor-bytes');
            } else if (competitorKind === 'directory') {
                expect((await realLstat(target)).isDirectory()).toBe(true);
                expect(await readdir(target)).toEqual([]);
            } else {
                expect((await realLstat(target)).isSymbolicLink()).toBe(true);
                expect(await readdir(symlinkDestDir)).toEqual([]);
            }
            // Private staging directories must be cleaned up on failure.
            expect((await readdir(dir)).filter((entry) => entry.startsWith('.evb-clone-'))).toEqual([]);
        },
    );
});
