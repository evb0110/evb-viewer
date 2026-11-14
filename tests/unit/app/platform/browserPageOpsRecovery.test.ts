import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {afterEach, expect, it, onTestFinished, vi} from 'vitest';
import type * as TBrowserDocumentStore from '@app/platform/browserDocumentStore';
import {BrowserDocumentStore} from '@app/platform/browserDocumentStore';
import {createBrowserPageOpsCapability} from '@app/platform/browser-api/createBrowserPageOpsCapability';
import {MemoryStorage} from '@tests/unit/app/platform/browserPlatformTestDoubles';

const state = vi.hoisted(() => ({store: null as BrowserDocumentStore | null, worker: vi.fn()}));
vi.mock('@app/platform/browserDocumentStore', async original => ({
    ...await original<typeof TBrowserDocumentStore>(),
    get browserDocumentStore() {
        if (!state.store) throw new Error('Missing test store');
        return state.store;
    },
}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: (...args: unknown[]) => state.worker(...args)}));

afterEach(() => {vi.unstubAllGlobals(); vi.clearAllMocks();});

it.each([false, true])('browser recovery keeps the source and rolls back a refused retry: %s', async refuseRetry => {
    vi.stubGlobal('window', {localStorage: new MemoryStorage()});
    vi.stubGlobal('document', {cookie: ''});
    const store = state.store = new BrowserDocumentStore();
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
    const unused = async () => {throw new Error('Unexpected picker');};
    const api = createBrowserPageOpsCapability({
        clearSearchCaches: () => {}, openInputAccept: '.pdf', pickFiles: unused,
        buildOpenPdfPickerTypes: () => [], createCombinedPdfFromPaths: unused,
        pickSaveTarget: unused, saveBytesToPickerOrDownload: unused,
        writeBytesToHandle: unused, repairWorkingCopy,
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
