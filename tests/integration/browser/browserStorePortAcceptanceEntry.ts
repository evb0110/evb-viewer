// fallow-ignore-file unused-file -- bundled by browserStorePortAcceptance.test.ts for every browser engine.

import {createWorkerStorePort} from '@app/platform/browser/browserStorePort';
import {
    createDocument,
    type IDocumentStore,
    openDocument,
} from '@document-store/documentDirectory';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const publication: IDocumentStore['publication'] = {
    witness: async () => null,
    source: async () => {
        throw new Error('No destination in this acceptance');
    },
    publish: async () => ({status: 'published', witness: 'unused'}),
};

function openPort() {
    return createWorkerStorePort(new Worker('/opfs-store-worker.js', {type: 'module'}));
}

function settle<T>(promise: Promise<T>) {
    return promise.then(value => ({ok: true as const, value}), (error: unknown) => ({
        ok: false as const,
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
    }));
}

/** Each port operation on the origin private file system, as the core uses them. */
async function portBasics() {
    const port = openPort();
    await port.remove('acceptance');
    await port.writeAtomic('acceptance/doc/manifest.json', encoder.encode('{"v":1}'));
    await port.writeAtomic('acceptance/doc/manifest.json', encoder.encode('{"v":2}'));
    const manifest = decoder.decode(await port.read('acceptance/doc/manifest.json'));
    const afterReplace = (await port.list('acceptance/doc')).sort();
    const file = await port.open('acceptance/doc/r1.bin');
    await file.writeAt(0, Uint8Array.from({length: 10}, (_, index) => index));
    await file.writeAt(10, Uint8Array.of(10, 11, 12));
    const grown = await file.size();
    const middle = Array.from(await file.readAt(5, 4));
    const pastEnd = Array.from(await file.readAt(11, 10));
    await file.truncate(4);
    const truncated = await file.size();
    await file.flush();
    // The core forks a document whose current file it holds open.
    await port.copy('acceptance/doc/r1.bin', 'acceptance/doc/r2.bin');
    await file.close();
    await port.copyIn(new Blob([Uint8Array.of(7, 8, 9)]), 'acceptance/doc/r3.bin');
    const copied = await port.open('acceptance/doc/r2.bin');
    const copiedBytes = Array.from(await copied.readAt(0, 10));
    await copied.close();
    const copiedIn = await port.open('acceptance/doc/r3.bin');
    const copiedInBytes = Array.from(await copiedIn.readAt(0, 10));
    await copiedIn.close();
    const copyOntoExisting = await settle(port.copyIn(new Blob([Uint8Array.of(1)]), 'acceptance/doc/r3.bin'));
    const listed = (await port.list('acceptance/doc')).sort();
    const missingRead = await settle(port.read('acceptance/missing.json'));
    await port.remove('acceptance/doc');
    return {
        manifest,
        afterReplace,
        grown,
        middle,
        pastEnd,
        truncated,
        copiedBytes,
        copiedInBytes,
        copyOntoExisting: copyOntoExisting.ok,
        listed,
        missingList: await port.list('acceptance/missing'),
        missingRead: missingRead.ok,
        afterRemove: await port.list('acceptance'),
    };
}

/** The core's recovery over the port: an unfinished append is cut and unnamed files go; drafts stay. */
async function coreRecovery() {
    const port = openPort();
    const store: IDocumentStore = {port, publication};
    const original = Uint8Array.from({length: 200_000}, (_, index) => index % 251);
    const tail = encoder.encode('%appended edit\n');
    const doc = await createDocument(store, {ext: 'pdf', source: new Blob([original]), imported: true});
    const appended = await doc.mutate(1, {kind: 'append', bytes: tail, drafts: 'keep'});
    const drafts = await doc.setDrafts(appended.status === 'committed' ? appended.revision.id : null, {note: 'unsaved note'});
    await doc.close();
    // What a crash leaves: bytes past the committed length, and files no manifest names.
    const dir = `documents/${doc.id}`;
    const file = await port.open(`${dir}/r1.pdf`);
    await file.writeAt(original.byteLength + tail.byteLength, encoder.encode('torn append'));
    await file.close();
    await (await port.open(`${dir}/r9.pdf`)).close();
    await (await port.open(`${dir}/manifest.json.crashed.tmp`)).close();
    const reopened = await openDocument(store, doc.id);
    const state = reopened.state();
    const bytes = await reopened.read(0, state.current!.length);
    const expected = new Uint8Array(original.byteLength + tail.byteLength);
    expected.set(original);
    expected.set(tail, original.byteLength);
    const files = (await port.list(dir)).filter(name => !name.startsWith('drafts-')).sort();
    await reopened.close();
    await port.remove(dir);
    return {
        appended: appended.status,
        drafts: drafts.status,
        length: state.current?.length,
        expectedLength: expected.byteLength,
        bytesIntact: bytes.every((byte, index) => byte === expected[index]) && bytes.byteLength === expected.byteLength,
        draftsAfter: state.drafts,
        dirty: state.dirty,
        files,
    };
}

/** One writer per file: a second context is refused while the first holds it, and gets it once released. */
async function exclusive() {
    const first = openPort();
    const second = openPort();
    const held = await first.open('acceptance-exclusive/f.bin');
    const otherContext = await settle(second.open('acceptance-exclusive/f.bin'));
    const sameContext = await settle(first.open('acceptance-exclusive/f.bin'));
    await held.close();
    const afterRelease = await settle(second.open('acceptance-exclusive/f.bin'));
    if (afterRelease.ok) await afterRelease.value.close();
    await first.remove('acceptance-exclusive');
    return {
        otherContext: otherContext.ok ? 'opened' : otherContext.name,
        sameContext: sameContext.ok ? 'opened' : 'refused',
        afterRelease: afterRelease.ok,
    };
}

/** A large document read the way the viewer reads it: page-sized ranges, in order and at random. */
async function largeRead(mib: number) {
    const port = openPort();
    const size = mib * 1024 * 1024;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const file = await port.open('acceptance-large/f.bin');
    const writeStart = performance.now();
    for (let offset = 0; offset < size; offset += chunk.byteLength) {
        chunk[0] = (offset / chunk.byteLength) % 256;
        await file.writeAt(offset, chunk);
    }
    await file.flush();
    const writeMs = performance.now() - writeStart;
    const page = 256 * 1024;
    const sequentialStart = performance.now();
    let readBytes = 0;
    for (let offset = 0; offset < size; offset += page) {
        readBytes += (await file.readAt(offset, page)).byteLength;
    }
    const sequentialMs = performance.now() - sequentialStart;
    const randomStart = performance.now();
    let randomBytes = 0;
    for (let index = 0; index < 512; index += 1) {
        const offset = Math.floor(Math.random() * (size - page));
        randomBytes += (await file.readAt(offset, page)).byteLength;
    }
    const randomMs = performance.now() - randomStart;
    const firstOfChunk = Array.from(await file.readAt(8 * 1024 * 1024 * 3, 1));
    await file.close();
    await port.remove('acceptance-large');
    const rate = (bytes: number, ms: number) => Math.round(bytes / (1024 * 1024) / (ms / 1000));
    return {
        readBytes,
        randomBytes,
        firstOfChunk,
        writeMiBPerSecond: rate(size, writeMs),
        sequentialMiBPerSecond: rate(readBytes, sequentialMs),
        sequentialPagesPerSecond: Math.round((size / page) / (sequentialMs / 1000)),
        randomPagesPerSecond: Math.round(512 / (randomMs / 1000)),
    };
}

Reflect.set(globalThis, '__evbStorePortAcceptance', {portBasics, coreRecovery, exclusive, largeRead});
