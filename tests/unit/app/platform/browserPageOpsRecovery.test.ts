import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {afterEach, expect, it, onTestFinished, vi} from 'vitest';
import type * as TBrowserDocumentStore from '@app/platform/browserDocumentStore';
import {BROWSER_MAX_FULL_READ_BYTES, BrowserDocumentStore} from '@app/platform/browserDocumentStore';
import {browserPublication} from '@app/platform/browser/browserPublication';
import {openDocument} from '@document-store/documentDirectory';
import {createNodeStorePort} from '@document-store/nodeStorePort';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createBrowserPageOpsCapability} from '@app/platform/browser-api/createBrowserPageOpsCapability';
import {createFileSystemFileHandle, MemoryStorage} from '@tests/unit/app/platform/browserPlatformTestDoubles';

const state = vi.hoisted(() => ({
    store: null as BrowserDocumentStore | null,
    worker: vi.fn(),
    canUseWorker: vi.fn(() => true),
}));
vi.mock('@app/platform/browserDocumentStore', async (original) => ({
    ...(await original<typeof TBrowserDocumentStore>()),
    get browserDocumentStore() {
        if (!state.store) {
            throw new Error('Missing test store');
        }
        return state.store;
    },
}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', async (original) => ({
    ...(await original<typeof import('@app/platform/browser-api/browserPageOpsWorkerClient')>()),
    canUseBrowserPageOpsWorker: () => state.canUseWorker(),
    runBrowserPageOpsWorkerRequest: (...args: unknown[]) => state.worker(...args),
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it.each([false, true])('browser recovery keeps the source and rolls back a refused retry: %s', async (refuseRetry) => {
    vi.stubGlobal('window', {localStorage: new MemoryStorage()});
    vi.stubGlobal('document', {cookie: ''});
    const store = (state.store = new BrowserDocumentStore());
    const fixtures = resolve('native/pdf-page-ops/tests/fixtures/damaged-recovery');
    const original = new Uint8Array(await readFile(resolve(fixtures, 'object-identity.pdf')));
    const healthy = new Uint8Array(await readFile(resolve(fixtures, 'healthy.pdf')));
    const ref = await store.createStoredDocument('damaged.pdf', original, {mimeType: 'application/pdf', kind: 'working', saveKind: 'pdf'});
    onTestFinished(() => store.release(ref));
    const before = await store.getDocumentRevision(ref);
    state.worker.mockImplementation(async (_type: string, request: {sources: Blob[]}) => {
        const bytes = new Uint8Array(await request.sources[0]!.arrayBuffer());
        if (new TextDecoder().decode(bytes).includes('99 0 obj') || refuseRetry) {
            return {status: 'failed', error: {code: 'corrupt-xref', message: 'PDF object 7 0 is not at its xref offset'}};
        }
        const pdf = await PDFDocument.load(bytes);
        pdf.removePage(0);
        const data = await pdf.save();
        return {status: 'written', pageCount: 1, length: data.byteLength, data};
    });
    const repairWorkingCopy = vi.fn(async () => {
        await store.write(ref, healthy, {expectedDocumentRevisionToken: (await store.getDocumentRevision(ref)).token});
        return true;
    });
    const unused = async () => {
        throw new Error('Unexpected picker');
    };
    const api = createBrowserPageOpsCapability({
        clearSearchCaches: () => {},
        openInputAccept: '.pdf',
        pickFiles: unused,
        buildOpenPdfPickerTypes: () => [],
        createCombinedPdfFromPaths: unused,
        pickSaveTarget: unused,
        saveBytesToPickerOrDownload: unused,
        writeBytesToHandle: unused,
        repairWorkingCopy,
    });
    const pending = api.delete(ref, [1], 2, {expectedDocumentRevisionToken: before.token});
    if (refuseRetry) {
        await expect(pending).rejects.toThrow('not at its xref offset');
        expect((await store.getDocumentRevision(ref)).token).toBe(before.token);
        expect(await store.read(ref)).toEqual(original);
        await store.write(ref, healthy, {expectedDocumentRevisionToken: before.token});
        expect((await PDFDocument.load(await store.read(ref))).getPageCount()).toBe(2);
    } else {
        await expect(pending).resolves.toMatchObject({success: true, pageCount: 1});
        expect((await PDFDocument.load(await store.read(ref))).getPageCount()).toBe(1);
    }
    expect(state.worker).toHaveBeenCalledTimes(2);
    expect(repairWorkingCopy).toHaveBeenCalledTimes(1);
    expect(original).toEqual(new Uint8Array(await readFile(resolve(fixtures, 'object-identity.pdf'))));
});

it('refuses main-thread getPageGeometry fallback on oversized Blobs without calling Blob.arrayBuffer()', async () => {
    vi.stubGlobal('window', {localStorage: new MemoryStorage()});
    vi.stubGlobal('document', {cookie: ''});
    state.canUseWorker.mockReturnValue(false);
    const store = (state.store = new BrowserDocumentStore());
    const oversizedBlob = new Blob([]);
    Object.defineProperty(oversizedBlob, 'size', {value: BROWSER_MAX_FULL_READ_BYTES + 1});
    const arrayBufferSpy = vi
        .spyOn(oversizedBlob, 'arrayBuffer')
        .mockRejectedValue(new Error('main-thread fallback must never call arrayBuffer on an oversized Blob'));
    vi.spyOn(store, 'readableBlob').mockResolvedValue(oversizedBlob);
    const unused = async () => {
        throw new Error('Unexpected picker');
    };
    const api = createBrowserPageOpsCapability({
        clearSearchCaches: () => {},
        openInputAccept: '.pdf',
        pickFiles: unused,
        buildOpenPdfPickerTypes: () => [],
        createCombinedPdfFromPaths: unused,
        pickSaveTarget: unused,
        saveBytesToPickerOrDownload: unused,
        writeBytesToHandle: unused,
        repairWorkingCopy: async () => false,
    });

    await expect(api.getPageGeometry(requireDocumentRef('browser://documents/oversized.pdf'), requirePageNumber(1))).rejects.toMatchObject({
        code: 'too-large',
    });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(state.worker).not.toHaveBeenCalled();
});

it('rejects rotate on an externally replaced handle-backed PDF without committing foreign revision 1:s', async () => {
    vi.stubGlobal('window', {localStorage: new MemoryStorage()});
    vi.stubGlobal('document', {cookie: ''});
    const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'browser-pageops-foreign-'));
    onTestFinished(() => rm(root, {recursive: true, force: true}));
    const store = (state.store = new BrowserDocumentStore());
    const docStore = {port: createNodeStorePort(root), publication: browserPublication};
    vi.spyOn(store, 'stores').mockResolvedValue({durable: docStore, memory: docStore});

    const pdfDocA = await PDFDocument.create();
    pdfDocA.addPage([200, 300]);
    const pdfA = new Uint8Array(await pdfDocA.save());
    const pdfDocB = await PDFDocument.create();
    pdfDocB.addPage([400, 500]);
    pdfDocB.addPage([400, 500]);
    const pdfB = new Uint8Array(await pdfDocB.save());

    const disk = {bytes: pdfA, lastModified: 100};
    const handle = createFileSystemFileHandle({
        name: 'handle-rotate.pdf',
        getFile: async () => new File([disk.bytes], 'handle-rotate.pdf', {type: 'application/pdf', lastModified: disk.lastModified}),
    });
    const sourceRef = await store.registerFile(
        new File([disk.bytes], 'handle-rotate.pdf', {type: 'application/pdf', lastModified: disk.lastModified}),
        {
            saveKind: 'pdf',
            saveHandle: handle,
        },
    );
    const workingRef = await store.cloneAsWorkingCopy(sourceRef);
    onTestFinished(() => store.release(workingRef));
    const entry = await store.requireEntry(workingRef);
    const docId = entry.doc!.id;
    const before = await store.getDocumentRevision(workingRef);

    // Replace the picked file externally before any private bytes exist.
    disk.bytes = pdfB;
    disk.lastModified = 200;

    const unused = async () => {
        throw new Error('Unexpected picker');
    };
    const api = createBrowserPageOpsCapability({
        clearSearchCaches: () => {},
        openInputAccept: '.pdf',
        pickFiles: unused,
        buildOpenPdfPickerTypes: () => [],
        createCombinedPdfFromPaths: unused,
        pickSaveTarget: unused,
        saveBytesToPickerOrDownload: unused,
        writeBytesToHandle: unused,
        repairWorkingCopy: async () => false,
    });

    await expect(api.rotate(workingRef, [1], 1, 90, {expectedDocumentRevisionToken: before.token})).rejects.toMatchObject({
        name: 'BrowserDocumentSourceChangedError',
    });

    expect(entry.doc!.state().current).toBeNull();
    expect((await store.getDocumentRevision(workingRef)).token).toBe(before.token);

    // Recovery/reload must not see replacement PDF B materialized as revision 1:s.
    await entry.doc!.close();
    const reopened = await openDocument(docStore, docId);
    expect(reopened.state().current).toBeNull();
    await reopened.close();
});
