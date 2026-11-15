import type * as TBrowserWindowTabs from '@app/platform/browserWindowTabs';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDocuments } from '@document-store/collectDocuments';
import {
    decodeManifest,
    type IManifest,
    isDirty,
} from '@document-store/documentDirectory';
import { createNodeStorePort } from '@document-store/nodeStorePort';
import { readWorkspaceCheckpoints } from '@document-store/workspaceCheckpoint';
import { browserDocumentStore as windowDocumentStore } from '@app/platform/browser/browserDocumentRepository';
import { browserPublication } from '@app/platform/browser/browserPublication';
import { createMemoryStorePort } from '@app/platform/browser/browserStorePort';
import { nameBrowserWorkspaceDirectory } from '@app/platform/browser/browserWorkspaceRecovery';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    createFileSystemFileHandle,
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {MAX_DOCUMENT_ALLOCATION_BYTES} from '@contracts/electronApiDocuments';
import {PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';
import type {IBrowserBatchOpenProgress} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import type * as TBrowserDocumentStore from '@app/platform/browserDocumentStore';
import {BrowserDocumentStore} from '@app/platform/browserDocumentStore';
import * as workingCopyService from '@app/platform/browser-api/browserWorkingCopyService';

const serviceState = vi.hoisted(() => ({store: null as BrowserDocumentStore | null}));

vi.mock('@app/platform/browserWindowTabs', async importOriginal => ({
    ...await importOriginal<typeof TBrowserWindowTabs>(),
    reserveBrowserDocumentWorkingCopy: async (fileName: string) => {
        const {createBrowserDocumentRef} = await import('@app/platform/browser/browserDocumentRefs');
        return createBrowserDocumentRef(fileName);
    },
    retireBrowserDocumentWorkingCopy: async () => {},
}));

vi.mock('@app/platform/browserDocumentStore', async importOriginal => ({
    ...await importOriginal<typeof TBrowserDocumentStore>(),
    get browserDocumentStore() {
        if (!serviceState.store) throw new Error('Missing working-copy test store');
        return serviceState.store;
    },
}));

const wasmRun = vi.hoisted(() => vi.fn());
const combinedPdfRun = vi.hoisted(() => vi.fn());
const emitBatchOpenProgressMock = vi.hoisted(() => vi.fn((
    options: {onProgress?: (progress: IBrowserBatchOpenProgress) => void} | undefined,
) => {
    options?.onProgress?.({
        processed: 0,
        total: 1,
        percent: 0,
        elapsedMs: 0,
        estimatedRemainingMs: null,
    });
}));

vi.mock('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm', () => ({
    isBrowserPageOpsWasmFailure: (value: unknown) => (
        typeof value === 'object'
        && value !== null
        && 'status' in value
        && value.status === 'failed'
        && 'error' in value
    ),
    tryRunBrowserPageOpsWithWasm: wasmRun,
}));
// The combine stores its output as the document the caller names; here its bytes come from `combinedPdfRun`.
vi.mock('@app/platform/browser-api/createCombinedPdfFromPaths', () => ({
    createCombinedPdfFromPaths: async (paths: string[], progress: unknown, output: {fileName: string}) => serviceState.store!.createStoredDocument(
        output.fileName,
        await combinedPdfRun(paths, progress),
        {...output, mimeType: 'application/pdf', saveKind: 'pdf'},
    ),
    emitBatchOpenProgress: emitBatchOpenProgressMock,
}));
const PDF_SOURCE_OPTIONS = {
    mimeType: 'application/pdf',
    kind: 'source',
    saveKind: 'pdf',
} as const;
const ENCRYPTED_PDF = Uint8Array.from(
    new TextEncoder().encode('%PDF-1.7\n/Encrypt 1 0 R\n'),
);
const DECRYPTED_PDF = Uint8Array.from(
    new TextEncoder().encode('%PDF-1.7\nplain document\n'),
);

function loadService() {
    if (!serviceState.store) throw new Error('Missing working-copy test store');
    return {
        browserDocumentStore: serviceState.store,
        ...workingCopyService,
    };
}

describe('browser working-copy decryption', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        vi.stubGlobal('document', {cookie: ''});
        serviceState.store = new BrowserDocumentStore();
        wasmRun.mockReset();
        combinedPdfRun.mockReset();
        emitBatchOpenProgressMock.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('passes the transient password to the writer and replaces the working copy only after success', async () => {
        const {
            browserDocumentStore,
            decryptBrowserWorkingCopy,
        } = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument(
            'protected.pdf',
            ENCRYPTED_PDF,
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        wasmRun.mockResolvedValueOnce({
            data: DECRYPTED_PDF,
            pageCount: 1,
        });

        await expect(decryptBrowserWorkingCopy(workingPath, 'correct-password')).resolves.toEqual({
            outcome: 'decrypted',
            wasEncrypted: true,
        });
        expect(wasmRun).toHaveBeenCalledWith('decrypt', {
            data: ENCRYPTED_PDF,
            password: 'correct-password',
        }, expect.any(Function));
        await expect(browserDocumentStore.read(workingPath)).resolves.toEqual(DECRYPTED_PDF);
    });

    it('opens encrypted PDFs without making them recoverable: no file starts clean, a picked file stays unnamed until its first edit', async () => {
        const {
            browserDocumentStore,
            openDocumentPaths,
        } = await loadService();
        // A durable store on disk, shared with the window checkpoint writer, so its persisted checkpoint can be read.
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'working-copy-open-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const durable = {port: createNodeStorePort(root), publication: browserPublication};
        const stores = {durable, memory: {port: createMemoryStorePort(), publication: browserPublication}};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue(stores);
        vi.spyOn(windowDocumentStore, 'stores').mockResolvedValue(stores);
        const windowId = 'opened-documents-window';
        browserDocumentStore.onDirectoryEdited = id => nameBrowserWorkspaceDirectory(windowId, id);
        const named = async () => Object.values((await readWorkspaceCheckpoints(durable.port)).get(windowId)?.tabs ?? {}).map(tab => tab.directory);
        // What a reload's collection does with `id` alone: removed, kept as unsaved work for recovery, or neither.
        const collect = (id: string) => collectDocuments(durable, async other => (other === id ? () => {} : null));
        const sourcePath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, PDF_SOURCE_OPTIONS);
        const manifests: IManifest[] = [];
        const writeAtomic = durable.port.writeAtomic.bind(durable.port);
        vi.spyOn(durable.port, 'writeAtomic').mockImplementation(async (path, bytes) => {
            if (path.endsWith('/manifest.json')) manifests.push(decodeManifest(bytes));
            return writeAtomic(path, bytes);
        });
        const openPicked = async () => {
            const handle = createFileSystemFileHandle({
                name: 'picked.pdf',
                getFile: async () => new File([ENCRYPTED_PDF], 'picked.pdf', {lastModified: 1}),
            });
            const pickedPath = await browserDocumentStore.registerFile(await handle.getFile(), {...PDF_SOURCE_OPTIONS, saveHandle: handle});
            wasmRun.mockResolvedValueOnce({data: DECRYPTED_PDF, pageCount: 1});
            const opened = await openDocumentPaths([pickedPath], undefined, 'correct-password');
            if (opened?.kind !== 'pdf') throw new Error('Expected an opened PDF');
            return {workingPath: opened.workingPath, doc: (await browserDocumentStore.requireEntry(opened.workingPath)).doc!};
        };
        wasmRun.mockResolvedValueOnce({
            data: DECRYPTED_PDF,
            pageCount: 1,
        });

        const result = await openDocumentPaths([sourcePath], undefined, 'correct-password');
        if (result?.kind !== 'pdf') throw new Error('Expected an opened PDF');

        expect(result).toMatchObject({wasEncrypted: true});
        expect(manifests).not.toHaveLength(0);
        expect(manifests.filter(isDirty)).toEqual([]);
        await expect(browserDocumentStore.read(result.workingPath)).resolves.toEqual(DECRYPTED_PDF);
        const unedited = await openPicked();
        // The picked file stays the baseline Save checks, so the decrypted copy differs from it, yet no edit named it.
        expect(unedited.doc.state()).toMatchObject({dirty: true, destination: expect.stringMatching(/^handle:/u)});
        expect((await browserDocumentStore.requireEntry(unedited.workingPath)).memoryOnly).toBe(false);
        expect(await named()).toEqual([]);
        expect((await collect(unedited.doc.id)).removed).toEqual([unedited.doc.id]);
        const noFile = (await browserDocumentStore.requireEntry(result.workingPath)).doc!;
        expect((await collect(noFile.id)).removed).toEqual([noFile.id]);

        const edited = await openPicked();
        const {token} = await browserDocumentStore.getDocumentRevision(edited.workingPath);
        await browserDocumentStore.write(edited.workingPath, new TextEncoder().encode('%PDF-1.7\nedited\n'), {expectedDocumentRevisionToken: token});
        expect(await named()).toEqual([edited.doc.id]);
        expect(await collect(edited.doc.id)).toEqual({removed: [], unsaved: [edited.doc.id], unreadable: []});
    });

    it('returns a typed wrong-password result without changing the encrypted working copy', async () => {
        const {
            browserDocumentStore,
            decryptBrowserWorkingCopy,
        } = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument(
            'protected.pdf',
            ENCRYPTED_PDF,
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        wasmRun.mockResolvedValueOnce({
            status: 'failed',
            error: {
                code: 'needs-password',
                message: 'password rejected',
            },
        });

        await expect(decryptBrowserWorkingCopy(workingPath, 'wrong-password')).resolves.toEqual({
            outcome: 'needs-password',
            wasEncrypted: true,
        });
        await expect(browserDocumentStore.read(workingPath)).resolves.toEqual(ENCRYPTED_PDF);
    });

    it('returns unsupported-handler failures without trying a browser fallback', async () => {
        const {
            browserDocumentStore,
            decryptBrowserWorkingCopy,
        } = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument(
            'protected.pdf',
            ENCRYPTED_PDF,
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        wasmRun.mockResolvedValueOnce({
            status: 'failed',
            error: {
                code: 'unsupported-filter',
                message: 'public-key handler',
            },
        });

        await expect(decryptBrowserWorkingCopy(workingPath)).resolves.toEqual({
            outcome: 'unsupported',
            wasEncrypted: true,
        });
        expect(wasmRun).toHaveBeenCalledOnce();
        await expect(browserDocumentStore.read(workingPath)).resolves.toEqual(ENCRYPTED_PDF);
    });

    it('removes a failed browser working copy after a password attempt', async () => {
        const {
            browserDocumentStore,
            createBrowserWorkingCopyFromBytes,
        } = await loadService();
        const remove = vi.spyOn(browserDocumentStore, 'remove');
        wasmRun.mockResolvedValueOnce({
            status: 'failed',
            error: {
                code: 'needs-password',
                message: 'password rejected',
            },
        });

        await expect(createBrowserWorkingCopyFromBytes({
            fileName: 'protected.pdf',
            data: ENCRYPTED_PDF,
            password: 'wrong-password',
        })).rejects.toThrow('PDF decryption requires a password');
        expect(remove).toHaveBeenCalledOnce();
        await expect(browserDocumentStore.requireEntry(remove.mock.calls[0]![0])).rejects.toThrow();
    });

    it('removes a browser working copy when decryption fails before producing a typed outcome', async () => {
        const {
            browserDocumentStore,
            createBrowserWorkingCopyFromBytes,
        } = await loadService();
        const remove = vi.spyOn(browserDocumentStore, 'remove');
        wasmRun.mockResolvedValueOnce({
            status: 'failed',
            error: {
                code: 'invalid-request',
                message: 'malformed PDF',
            },
        });

        await expect(createBrowserWorkingCopyFromBytes({
            fileName: 'malformed.pdf',
            data: ENCRYPTED_PDF,
        })).rejects.toThrow('malformed PDF');
        expect(remove).toHaveBeenCalledOnce();
        await expect(browserDocumentStore.requireEntry(remove.mock.calls[0]![0])).rejects.toThrow();
    });

    it('refuses an encrypted input above the unlock budget before reading it, naming the desktop app', async () => {
        const {
            browserDocumentStore,
            decryptBrowserWorkingCopy,
        } = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument(
            'large.pdf',
            new TextEncoder().encode('%PDF-1.7\n/Encrypt'),
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({size: MAX_DOCUMENT_ALLOCATION_BYTES + 1, modifiedAt: 0});
        const read = vi.spyOn(browserDocumentStore, 'read');

        await expect(decryptBrowserWorkingCopy(workingPath)).rejects.toThrow('Open it in the desktop app');
        expect(read).not.toHaveBeenCalled();
        expect(wasmRun).not.toHaveBeenCalled();
    });

    it('rejects an oversized password before invoking the browser writer', async () => {
        const {
            browserDocumentStore,
            decryptBrowserWorkingCopy,
        } = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument(
            'protected.pdf',
            ENCRYPTED_PDF,
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );

        await expect(decryptBrowserWorkingCopy(
            workingPath,
            'p'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1),
        )).rejects.toThrow(`${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        expect(wasmRun).not.toHaveBeenCalled();
    });

    it('removes the working copy when publication fails after decryption', async () => {
        const {
            browserDocumentStore,
            openDocumentPaths,
        } = await loadService();
        const sourcePath = await browserDocumentStore.createStoredDocument(
            'protected.pdf',
            ENCRYPTED_PDF,
            PDF_SOURCE_OPTIONS,
        );
        wasmRun.mockResolvedValueOnce({
            data: DECRYPTED_PDF,
            pageCount: 1,
        });
        const remove = vi.spyOn(browserDocumentStore, 'remove');

        await expect(openDocumentPaths([sourcePath], {onProgress: () => {
            throw new Error('progress consumer failed');
        }})).rejects.toThrow('progress consumer failed');

        expect(remove).toHaveBeenCalledOnce();
        const failedWorkingPath = remove.mock.calls[0]![0];
        expect(failedWorkingPath).not.toBe(sourcePath);
        await expect(browserDocumentStore.requireEntry(failedWorkingPath)).rejects.toThrow();
    });

    it('opens a memory-only PDF when exposed IndexedDB refuses access without touching Recent Files', async () => {
        vi.stubGlobal('indexedDB', {open: () => { throw new Error('IndexedDB access denied'); }});
        const {
            browserDocumentStore,
            openDocumentPaths,
        } = await loadService();
        const sourcePath = await browserDocumentStore.registerFile(
            new File(
                [DECRYPTED_PDF],
                'volatile.pdf',
                {type: 'application/pdf'},
            ),
            PDF_SOURCE_OPTIONS,
        );

        const result = await openDocumentPaths([sourcePath]);

        expect(result).toEqual(expect.objectContaining({
            kind: 'pdf',
            originalPath: sourcePath,
        }));
        expect((await browserDocumentStore.requireEntry(sourcePath)).memoryOnly).toBe(true);
        expect(browserDocumentStore.getRecentFiles()).toEqual([]);
    });

    it('opens a memory-only DjVu when exposed IndexedDB refuses access without touching Recent Files', async () => {
        vi.stubGlobal('indexedDB', {open: () => { throw new Error('IndexedDB access denied'); }});
        const {
            browserDocumentStore,
            openDocumentPaths,
        } = await loadService();
        const sourcePath = await browserDocumentStore.registerFile(
            new File(
                [Uint8Array.of(1, 2, 3)],
                'volatile.djvu',
                {type: 'image/vnd.djvu'},
            ),
            {
                kind: 'source',
                saveKind: 'generic',
            },
        );

        const result = await openDocumentPaths([sourcePath]);

        expect(result).toEqual({
            kind: 'djvu',
            workingPath: '',
            originalPath: sourcePath,
        });
        expect((await browserDocumentStore.requireEntry(sourcePath)).memoryOnly).toBe(true);
        expect(browserDocumentStore.getRecentFiles()).toEqual([]);
    });

    it('opens a generated PDF in memory when exposed IndexedDB refuses access', async () => {
        vi.stubGlobal('indexedDB', {open: () => { throw new Error('IndexedDB access denied'); }});
        combinedPdfRun.mockResolvedValueOnce(DECRYPTED_PDF);
        const {
            browserDocumentStore,
            openDocumentPaths,
        } = await loadService();
        const sourcePath = await browserDocumentStore.registerFile(
            new File([DECRYPTED_PDF], 'volatile-source.pdf', {type: 'application/pdf'}),
            PDF_SOURCE_OPTIONS,
        );

        const result = await openDocumentPaths([
            sourcePath,
            sourcePath,
        ]);
        if (!result || result.kind !== 'pdf') {
            throw new Error('Expected generated PDF result');
        }

        expect(result).toEqual(expect.objectContaining({
            kind: 'pdf',
            isGenerated: true,
        }));
        expect((await browserDocumentStore.requireEntry(result.originalPath)).memoryOnly).toBe(true);
        expect((await browserDocumentStore.requireEntry(result.workingPath)).memoryOnly).toBe(true);
    });
    it('rejects decrypted output for an input revision changed while CPU work was pending', async () => {
        const {
            browserDocumentStore, decryptBrowserWorkingCopy,
        } = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const writerStarted = Promise.withResolvers<undefined>();
        const writerResult = Promise.withResolvers<{
            data: Uint8Array;
            pageCount: number
        }>();
        wasmRun.mockImplementationOnce(() => {
            writerStarted.resolve(undefined);
            return writerResult.promise;
        });
        const decryption = decryptBrowserWorkingCopy(workingPath, 'correct-password');
        await writerStarted.promise;
        const revision = await browserDocumentStore.getDocumentRevision(workingPath);
        const replacement = new TextEncoder().encode('%PDF-1.7\nNew accepted bytes');
        await browserDocumentStore.write(workingPath, replacement, {expectedDocumentRevisionToken: revision.token});
        const rejection = expect(decryption).rejects.toThrow('STALE_REVISION');
        writerResult.resolve({
            data: DECRYPTED_PDF,
            pageCount: 1,
        });
        await rejection;
        await expect(browserDocumentStore.read(workingPath)).resolves.toEqual(replacement);
    });

});
