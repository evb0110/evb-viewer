import type * as TBrowserWindowTabs from '@app/platform/browserWindowTabs';
import type * as TBrowserPageOpsWorkerClient from '@app/platform/browser-api/browserPageOpsWorkerClient';
import type * as TBrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectDocuments} from '@document-store/collectDocuments';
import {decodeManifest, type IManifest, isDirty} from '@document-store/documentDirectory';
import {createNodeStorePort} from '@document-store/nodeStorePort';
import {readWorkspaceCheckpoints} from '@document-store/workspaceCheckpoint';
import {browserDocumentStore as windowDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {browserPublication} from '@app/platform/browser/browserPublication';
import {createMemoryStorePort} from '@app/platform/browser/browserStorePort';
import {nameBrowserWorkspaceDirectory} from '@app/platform/browser/browserWorkspaceRecovery';
import {afterEach, beforeEach, describe, expect, it, onTestFinished, vi} from 'vitest';
import {createFileSystemFileHandle, MemoryStorage} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {createBrowserExtensionViewerUrl} from '@contracts/browserExtensionLaunch';
import {MAX_DOCUMENT_ALLOCATION_BYTES} from '@contracts/electronApiDocuments';
import {PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';
import type {IBrowserBatchOpenProgress} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import type * as TBrowserDocumentStore from '@app/platform/browserDocumentStore';
import {BrowserDocumentStore} from '@app/platform/browserDocumentStore';
import * as workingCopyService from '@app/platform/browser-api/browserWorkingCopyService';

const serviceState = vi.hoisted(() => ({store: null as BrowserDocumentStore | null}));

vi.mock('@app/platform/browserWindowTabs', async (importOriginal) => ({
    ...(await importOriginal<typeof TBrowserWindowTabs>()),
    reserveBrowserDocumentWorkingCopy: async (fileName: string) => {
        const {createBrowserDocumentRef} = await import('@app/platform/browser/browserDocumentRefs');
        return createBrowserDocumentRef(fileName);
    },
    retireBrowserDocumentWorkingCopy: async () => {},
}));

vi.mock('@app/platform/browserDocumentStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TBrowserDocumentStore>()),
    get browserDocumentStore() {
        if (!serviceState.store) {
            throw new Error('Missing working-copy test store');
        }
        return serviceState.store;
    },
}));

const wasmRun = vi.hoisted(() => vi.fn());
// Node runs no engine worker; tests that open a PDF see the input its append admission was given.
const normalizeAppendBaseRun = vi.hoisted(() => vi.fn());
vi.mock('@app/platform/browser-api/browserQpdfEngineClient', async (importOriginal) => {
    const original = await importOriginal<typeof TBrowserQpdfEngineClient>();
    return {
        ...original,
        normalizeBrowserPdfAppendBase: normalizeAppendBaseRun,
        runBrowserQpdfCommand: vi.fn(original.runBrowserQpdfCommand),
    };
});
const combinedPdfRun = vi.hoisted(() => vi.fn());
const emitBatchOpenProgressMock = vi.hoisted(() =>
    vi.fn((options: {onProgress?: (progress: IBrowserBatchOpenProgress) => void} | undefined) => {
        options?.onProgress?.({
            processed: 0,
            total: 1,
            percent: 0,
            elapsedMs: 0,
            estimatedRemainingMs: null,
        });
    }),
);

const pageOpsWorkerOverride = vi.hoisted(() => ({
    run: null as ((type: string, payload: unknown, options?: unknown) => Promise<unknown>) | null,
}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', async (importOriginal) => {
    const original = await importOriginal<typeof TBrowserPageOpsWorkerClient>();
    return {
        ...original,
        runBrowserPageOpsWorkerRequest: (type: string, payload: unknown, options?: unknown) =>
            pageOpsWorkerOverride.run
                ? pageOpsWorkerOverride.run(type, payload, options)
                : original.runBrowserPageOpsWorkerRequest(type as never, payload as never, options as never),
    };
});

vi.mock('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm', () => ({
    isBrowserPageOpsWasmFailure: (value: unknown) =>
        typeof value === 'object' && value !== null && 'status' in value && value.status === 'failed' && 'error' in value,
    tryRunBrowserPageOpsWithWasm: wasmRun,
}));
// The combine stores its output as the document the caller names; here its bytes come from `combinedPdfRun`.
vi.mock('@app/platform/browser-api/createCombinedPdfFromPaths', () => ({
    createCombinedPdfFromPaths: async (paths: string[], progress: unknown, output: {fileName: string}) =>
        serviceState.store!.createStoredDocument(output.fileName, await combinedPdfRun(paths, progress), {
            ...output,
            mimeType: 'application/pdf',
            saveKind: 'pdf',
        }),
    emitBatchOpenProgress: emitBatchOpenProgressMock,
}));
const PDF_SOURCE_OPTIONS = {
    mimeType: 'application/pdf',
    kind: 'source',
    saveKind: 'pdf',
} as const;
const ENCRYPTED_PDF = Uint8Array.from(new TextEncoder().encode('%PDF-1.7\n/Encrypt 1 0 R\n'));
const DECRYPTED_PDF = Uint8Array.from(new TextEncoder().encode('%PDF-1.7\nplain document\n'));

/** Closes the files the test's store holds open; Node fails a test run whose file handles are only collected. */
async function closeStoreDocuments() {
    await Promise.all(serviceState.store?.openEntries().map((entry) => entry.doc?.close()) ?? []);
}

function loadService() {
    if (!serviceState.store) {
        throw new Error('Missing working-copy test store');
    }
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
        pageOpsWorkerOverride.run = null;
        normalizeAppendBaseRun.mockReset();
        normalizeAppendBaseRun.mockImplementation(async () => {
            const {BrowserQpdfEngineUnavailableError} = await import('@app/platform/browser-api/browserQpdfEngineClient');
            throw new BrowserQpdfEngineUnavailableError('This browser cannot run the qpdf engine worker');
        });
        combinedPdfRun.mockReset();
        emitBatchOpenProgressMock.mockClear();
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await closeStoreDocuments();
    });

    it('passes the transient password to the writer and replaces the working copy only after success', async () => {
        const {browserDocumentStore, decryptBrowserWorkingCopy} = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        wasmRun.mockResolvedValueOnce({
            data: DECRYPTED_PDF,
            pageCount: 1,
        });

        await expect(decryptBrowserWorkingCopy(workingPath, 'correct-password')).resolves.toEqual({
            outcome: 'decrypted',
            wasEncrypted: true,
        });
        expect(wasmRun).toHaveBeenCalledWith(
            'decrypt',
            {
                data: ENCRYPTED_PDF,
                password: 'correct-password',
            },
            expect.any(Function),
        );
        await expect(browserDocumentStore.read(workingPath)).resolves.toEqual(DECRYPTED_PDF);
    });

    it('opens encrypted PDFs without making them recoverable: no file starts clean, a picked file stays unnamed until its first edit', async () => {
        const {browserDocumentStore, openDocumentPaths} = await loadService();
        // A durable store on disk, shared with the window checkpoint writer, so its persisted checkpoint can be read.
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'working-copy-open-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const durable = {port: createNodeStorePort(root), publication: browserPublication};
        const stores = {durable, memory: {port: createMemoryStorePort(), publication: browserPublication}};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue(stores);
        vi.spyOn(windowDocumentStore, 'stores').mockResolvedValue(stores);
        const windowId = 'opened-documents-window';
        browserDocumentStore.onDirectoryEdited = (id) => nameBrowserWorkspaceDirectory(windowId, id);
        const named = async () =>
            Object.values((await readWorkspaceCheckpoints(durable.port)).get(windowId)?.tabs ?? {}).map((tab) => tab.directory);
        // What a reload's collection does with `id` alone: removed, kept as unsaved work for recovery, or neither.
        const collect = (id: string) => collectDocuments(durable, async (other) => (other === id ? () => {} : null));
        const sourcePath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, PDF_SOURCE_OPTIONS);
        const manifests: IManifest[] = [];
        const writeAtomic = durable.port.writeAtomic.bind(durable.port);
        vi.spyOn(durable.port, 'writeAtomic').mockImplementation(async (path, bytes) => {
            if (path.endsWith('/manifest.json')) {
                manifests.push(decodeManifest(bytes));
            }
            return writeAtomic(path, bytes);
        });
        const openPicked = async () => {
            const handle = createFileSystemFileHandle({
                name: 'picked.pdf',
                getFile: async () => new File([ENCRYPTED_PDF], 'picked.pdf', {lastModified: 1}),
            });
            const pickedPath = await browserDocumentStore.registerFile(await handle.getFile(), {...PDF_SOURCE_OPTIONS, saveHandle: handle});
            wasmRun.mockResolvedValueOnce({data: DECRYPTED_PDF, pageCount: 1});
            const opened = await openDocumentPaths([pickedPath], undefined, {password: 'correct-password'});
            if (opened?.kind !== 'pdf') {
                throw new Error('Expected an opened PDF');
            }
            return {workingPath: opened.workingPath, doc: (await browserDocumentStore.requireEntry(opened.workingPath)).doc!};
        };
        wasmRun.mockResolvedValueOnce({
            data: DECRYPTED_PDF,
            pageCount: 1,
        });

        const result = await openDocumentPaths([sourcePath], undefined, {password: 'correct-password'});
        if (result?.kind !== 'pdf') {
            throw new Error('Expected an opened PDF');
        }

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
        await browserDocumentStore.write(edited.workingPath, new TextEncoder().encode('%PDF-1.7\nedited\n'), {
            expectedDocumentRevisionToken: token,
        });
        expect(await named()).toEqual([edited.doc.id]);
        expect(await collect(edited.doc.id)).toMatchObject({removed: [], unsaved: [edited.doc.id], unreadable: []});
    });

    it('returns a typed wrong-password result without changing the encrypted working copy', async () => {
        const {browserDocumentStore, decryptBrowserWorkingCopy} = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
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
        const {browserDocumentStore, decryptBrowserWorkingCopy} = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
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
        const {browserDocumentStore, createBrowserWorkingCopyFromBytes} = await loadService();
        const remove = vi.spyOn(browserDocumentStore, 'remove');
        wasmRun.mockResolvedValueOnce({
            status: 'failed',
            error: {
                code: 'needs-password',
                message: 'password rejected',
            },
        });

        await expect(
            createBrowserWorkingCopyFromBytes({
                fileName: 'protected.pdf',
                data: ENCRYPTED_PDF,
                password: 'wrong-password',
            }),
        ).rejects.toThrow('PDF decryption requires a password');
        expect(remove).toHaveBeenCalledOnce();
        await expect(browserDocumentStore.requireEntry(remove.mock.calls[0]![0])).rejects.toThrow();
    });

    it('removes a browser working copy when decryption fails before producing a typed outcome', async () => {
        const {browserDocumentStore, createBrowserWorkingCopyFromBytes} = await loadService();
        const remove = vi.spyOn(browserDocumentStore, 'remove');
        wasmRun.mockResolvedValueOnce({
            status: 'failed',
            error: {
                code: 'invalid-request',
                message: 'malformed PDF',
            },
        });

        await expect(
            createBrowserWorkingCopyFromBytes({
                fileName: 'malformed.pdf',
                data: ENCRYPTED_PDF,
            }),
        ).rejects.toThrow('malformed PDF');
        expect(remove).toHaveBeenCalledOnce();
        await expect(browserDocumentStore.requireEntry(remove.mock.calls[0]![0])).rejects.toThrow();
    });

    it('refuses an encrypted input above the unlock budget before reading it, naming the desktop app', async () => {
        const {browserDocumentStore, decryptBrowserWorkingCopy} = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument('large.pdf', new TextEncoder().encode('%PDF-1.7\n/Encrypt'), {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({size: MAX_DOCUMENT_ALLOCATION_BYTES + 1, modifiedAt: 0});
        const read = vi.spyOn(browserDocumentStore, 'read');

        await expect(decryptBrowserWorkingCopy(workingPath)).rejects.toThrow('Open it in the desktop app');
        expect(read).not.toHaveBeenCalled();
        expect(wasmRun).not.toHaveBeenCalled();
    });

    it('rejects an oversized password before invoking the browser writer', async () => {
        const {browserDocumentStore, decryptBrowserWorkingCopy} = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });

        await expect(decryptBrowserWorkingCopy(workingPath, 'p'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1))).rejects.toThrow(
            `${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`,
        );
        expect(wasmRun).not.toHaveBeenCalled();
    });

    it('removes the working copy when publication fails after decryption', async () => {
        const {browserDocumentStore, openDocumentPaths} = await loadService();
        const sourcePath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, PDF_SOURCE_OPTIONS);
        wasmRun.mockResolvedValueOnce({
            data: DECRYPTED_PDF,
            pageCount: 1,
        });
        const remove = vi.spyOn(browserDocumentStore, 'remove');

        await expect(
            openDocumentPaths([sourcePath], {
                onProgress: () => {
                    throw new Error('progress consumer failed');
                },
            }),
        ).rejects.toThrow('progress consumer failed');

        expect(remove).toHaveBeenCalledOnce();
        const failedWorkingPath = remove.mock.calls[0]![0];
        expect(failedWorkingPath).not.toBe(sourcePath);
        await expect(browserDocumentStore.requireEntry(failedWorkingPath)).rejects.toThrow();
    });

    it("keeps a restored document's Recent Files time and place, while a reader's open moves it to now", async () => {
        const {browserDocumentStore, openDocumentPaths} = await loadService();
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'restored-recent-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({
            durable: {port: createNodeStorePort(root), publication: browserPublication},
            memory: {port: createMemoryStorePort(), publication: browserPublication},
        });
        vi.useFakeTimers({toFake: ['Date']});
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const djvuSource = {
            mimeType: 'image/vnd.djvu',
            kind: 'source',
            saveKind: 'generic',
        } as const;
        const older = await browserDocumentStore.createStoredDocument('older.djvu', Uint8Array.of(1), djvuSource);
        const newer = await browserDocumentStore.createStoredDocument('newer.djvu', Uint8Array.of(2), djvuSource);
        const threeDaysAgo = Date.UTC(2026, 10, 20, 9);
        const twoDaysAgo = Date.UTC(2026, 10, 21, 9);
        const now = Date.UTC(2026, 10, 23, 9);
        const listed = () => browserDocumentStore.getRecentFiles().map((file) => [file.originalPath, file.timestamp]);
        vi.setSystemTime(threeDaysAgo);
        await openDocumentPaths([older]);
        vi.setSystemTime(twoDaysAgo);
        await openDocumentPaths([newer]);
        expect(listed()).toEqual([
            [newer, twoDaysAgo],
            [older, threeDaysAgo],
        ]);

        vi.setSystemTime(now);
        await expect(openDocumentPaths([older], undefined, {recordRecent: false})).resolves.toMatchObject({kind: 'djvu'});
        expect(listed()).toEqual([
            [newer, twoDaysAgo],
            [older, threeDaysAgo],
        ]);

        await openDocumentPaths([older]);
        expect(listed()).toEqual([
            [older, now],
            [newer, twoDaysAgo],
        ]);
    });

    it('opens a memory-only PDF when exposed IndexedDB refuses access without touching Recent Files', async () => {
        vi.stubGlobal('indexedDB', {
            open: () => {
                throw new Error('IndexedDB access denied');
            },
        });
        const {browserDocumentStore, openDocumentPaths} = await loadService();
        const sourcePath = await browserDocumentStore.registerFile(
            new File([DECRYPTED_PDF], 'volatile.pdf', {type: 'application/pdf'}),
            PDF_SOURCE_OPTIONS,
        );

        const result = await openDocumentPaths([sourcePath]);

        expect(result).toEqual(
            expect.objectContaining({
                kind: 'pdf',
                originalPath: sourcePath,
            }),
        );
        expect((await browserDocumentStore.requireEntry(sourcePath)).memoryOnly).toBe(true);
        expect(browserDocumentStore.getRecentFiles()).toEqual([]);
    });

    it('opens a memory-only DjVu when exposed IndexedDB refuses access without touching Recent Files', async () => {
        vi.stubGlobal('indexedDB', {
            open: () => {
                throw new Error('IndexedDB access denied');
            },
        });
        const {browserDocumentStore, openDocumentPaths} = await loadService();
        const sourcePath = await browserDocumentStore.registerFile(
            new File([Uint8Array.of(1, 2, 3)], 'volatile.djvu', {type: 'image/vnd.djvu'}),
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
        vi.stubGlobal('indexedDB', {
            open: () => {
                throw new Error('IndexedDB access denied');
            },
        });
        combinedPdfRun.mockResolvedValueOnce(DECRYPTED_PDF);
        const {browserDocumentStore, openDocumentPaths} = await loadService();
        const sourcePath = await browserDocumentStore.registerFile(
            new File([DECRYPTED_PDF], 'volatile-source.pdf', {type: 'application/pdf'}),
            PDF_SOURCE_OPTIONS,
        );

        const result = await openDocumentPaths([sourcePath, sourcePath]);
        if (!result || result.kind !== 'pdf') {
            throw new Error('Expected generated PDF result');
        }

        expect(result).toEqual(
            expect.objectContaining({
                kind: 'pdf',
                isGenerated: true,
            }),
        );
        expect((await browserDocumentStore.requireEntry(result.originalPath)).memoryOnly).toBe(true);
        expect((await browserDocumentStore.requireEntry(result.workingPath)).memoryOnly).toBe(true);
    });

    it('marks a single browser output PDF as generated without adding it to Recent Files', async () => {
        const {browserDocumentStore, openDocumentPaths} = await loadService();
        const outputPath = await browserDocumentStore.createStoredDocument('scan-cleaned.pdf', DECRYPTED_PDF, {
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'output',
            retention: 'transient',
        });

        const result = await openDocumentPaths([outputPath]);

        expect(result).toMatchObject({
            kind: 'pdf',
            originalPath: outputPath,
            isGenerated: true,
        });
        expect(browserDocumentStore.getRecentFiles()).toEqual([]);
    });
    it('rejects decrypted output for an input revision changed while CPU work was pending', async () => {
        const {browserDocumentStore, decryptBrowserWorkingCopy} = await loadService();
        const workingPath = await browserDocumentStore.createStoredDocument('protected.pdf', ENCRYPTED_PDF, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const writerStarted = Promise.withResolvers<undefined>();
        const writerResult = Promise.withResolvers<{
            data: Uint8Array;
            pageCount: number;
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

    // Undo brings a revision's token back, so a token read apart from the bytes could name bytes it never held.
    it('refuses a repair whose working copy was edited and undone while its input was read', async () => {
        const {browserDocumentStore, repairBrowserWorkingCopy} = loadService();
        const damaged = new TextEncoder().encode('%PDF-1.7\nrevision A, damaged\n');
        const working = await browserDocumentStore.createStoredDocument('damaged.pdf', damaged, {...PDF_SOURCE_OPTIONS, kind: 'working'});
        const revisionA = (await browserDocumentStore.getDocumentRevision(working)).token;
        const readableBlob = browserDocumentStore.readableBlob.bind(browserDocumentStore);
        vi.spyOn(browserDocumentStore, 'readableBlob').mockImplementationOnce(async (ref) => {
            await browserDocumentStore.write(working, new TextEncoder().encode('%PDF-1.7\nedit B\n'), {
                expectedDocumentRevisionToken: revisionA,
            });
            const blob = await readableBlob(ref);
            await browserDocumentStore.restoreRevision(working, revisionA, (await browserDocumentStore.getDocumentRevision(working)).token);
            return blob;
        });
        const {runBrowserQpdfCommand} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const rewrite = vi.mocked(runBrowserQpdfCommand).mockImplementationOnce(async () => ({
            exitCode: 0,
            stdout: '',
            stderr: '',
            output: new TextEncoder().encode('%PDF-1.7\nrepaired\n'),
        }));

        await expect(repairBrowserWorkingCopy(working)).rejects.toMatchObject({code: 'STALE_REVISION'});
        expect(rewrite).not.toHaveBeenCalled();
        await expect(browserDocumentStore.read(working)).resolves.toEqual(damaged);
        await expect(browserDocumentStore.getDocumentRevision(working)).resolves.toMatchObject({token: revisionA});
    });

    it('rejects repair when a concurrent stageAppend materializes changed picked bytes while qpdf runs', async () => {
        const {browserDocumentStore, repairBrowserWorkingCopy} = loadService();
        const bytesA = new TextEncoder().encode('%PDF-1.7\nrevision A, damaged\n');
        const bytesB = new TextEncoder().encode('%PDF-1.7\nchanged picked file B, longer content\n');
        let currentFile = new File([bytesA], 'picked.pdf', {
            type: 'application/pdf',
            lastModified: 1,
        });
        const handle = createFileSystemFileHandle({
            name: 'picked.pdf',
            getFile: async () => currentFile,
        });
        const picked = await browserDocumentStore.registerFile(currentFile, {
            ...PDF_SOURCE_OPTIONS,
            saveHandle: handle,
        });
        const working = await browserDocumentStore.cloneAsWorkingCopy(picked);
        const tokenA = (await browserDocumentStore.getDocumentRevision(working)).token;

        const {runBrowserQpdfCommand} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const qpdfStarted = Promise.withResolvers<undefined>();
        const qpdfResult = Promise.withResolvers<{
            exitCode: number;
            stdout: string;
            stderr: string;
            output: Uint8Array | null;
        }>();
        vi.mocked(runBrowserQpdfCommand)
            .mockReset()
            .mockImplementationOnce(async () => {
                qpdfStarted.resolve(undefined);
                return qpdfResult.promise;
            });

        const repair = repairBrowserWorkingCopy(working);
        await qpdfStarted.promise;

        currentFile = new File([bytesB], 'picked.pdf', {
            type: 'application/pdf',
            lastModified: 2,
        });
        const appendedTail = new TextEncoder().encode('\n% staged append');
        const lease = await browserDocumentStore.stageAppend(
            working,
            tokenA,
            async (file, base) => {
                await file.writeAt(base, appendedTail);
                return base + appendedTail.byteLength;
            },
            {allowForeignBase: true},
        );
        expect(lease).toEqual(expect.any(String));
        const stagedToken = (await browserDocumentStore.getDocumentRevision(working)).token;
        expect(stagedToken).toMatch(/:1:s$/u);

        qpdfResult.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            output: new TextEncoder().encode('%PDF-1.7\nrepaired A\n'),
        });

        await expect(repair).rejects.toMatchObject({code: 'STALE_REVISION'});
        await expect(browserDocumentStore.getDocumentRevision(working)).resolves.toMatchObject({token: stagedToken});
        const stagedBlob = await browserDocumentStore.appendedContent(working, lease!);
        expect(new Uint8Array(await stagedBlob.arrayBuffer())).toEqual(new Uint8Array([...bytesB, ...appendedTail]));
        await expect(browserDocumentStore.read(working)).resolves.toEqual(bytesB);
    });

    it('rejects repair when an ordinary stageAppend is pending while qpdf runs and keeps the append lease usable', async () => {
        const {browserDocumentStore, repairBrowserWorkingCopy} = loadService();
        const bytesA = new TextEncoder().encode('%PDF-1.7\nrevision A, damaged\n');
        const working = await browserDocumentStore.createStoredDocument('damaged.pdf', bytesA, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const tokenA = (await browserDocumentStore.getDocumentRevision(working)).token;

        const {runBrowserQpdfCommand} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const qpdfStarted = Promise.withResolvers<undefined>();
        const qpdfResult = Promise.withResolvers<{
            exitCode: number;
            stdout: string;
            stderr: string;
            output: Uint8Array | null;
        }>();
        vi.mocked(runBrowserQpdfCommand)
            .mockReset()
            .mockImplementationOnce(async () => {
                qpdfStarted.resolve(undefined);
                return qpdfResult.promise;
            });

        const repair = repairBrowserWorkingCopy(working);
        await qpdfStarted.promise;

        const appendedTail = new TextEncoder().encode('\n% ordinary staged append');
        const lease = await browserDocumentStore.stageAppend(working, tokenA, async (file, base) => {
            await file.writeAt(base, appendedTail);
            return base + appendedTail.byteLength;
        });
        expect(lease).toEqual(expect.any(String));

        qpdfResult.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            output: new TextEncoder().encode('%PDF-1.7\nrepaired A\n'),
        });

        await expect(repair).rejects.toMatchObject({code: 'STALE_REVISION'});
        await browserDocumentStore.commitAppend(working, tokenA, lease!);
        await expect(browserDocumentStore.read(working)).resolves.toEqual(new Uint8Array([...bytesA, ...appendedTail]));
    });

    it('rejects a queued ordinary write derived from file A when stageAppend materializes changed picked file B', async () => {
        const {browserDocumentStore} = loadService();
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'working-copy-queued-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const durable = {port: createNodeStorePort(root), publication: browserPublication};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({
            durable,
            memory: {port: createMemoryStorePort(), publication: browserPublication},
        });
        const bytesA = new TextEncoder().encode('%PDF-1.7\nrevision A\n');
        const bytesB = new TextEncoder().encode('%PDF-1.7\nchanged picked file B, longer content\n');
        let currentFile = new File([bytesA], 'picked.pdf', {
            type: 'application/pdf',
            lastModified: 1,
        });
        const handle = createFileSystemFileHandle({
            name: 'picked.pdf',
            getFile: async () => currentFile,
        });
        const picked = await browserDocumentStore.registerFile(currentFile, {
            ...PDF_SOURCE_OPTIONS,
            saveHandle: handle,
        });
        const working = await browserDocumentStore.cloneAsWorkingCopy(picked);
        const tokenA = (await browserDocumentStore.getDocumentRevision(working)).token;

        const editedStarted = Promise.withResolvers<undefined>();
        const editedRelease = Promise.withResolvers<undefined>();
        browserDocumentStore.onDirectoryEdited = async () => {
            editedStarted.resolve(undefined);
            await editedRelease.promise;
        };

        let lease: string | null = null;
        const appendedTail = new TextEncoder().encode('\n% staged append on B');
        try {
            const writeFailure = browserDocumentStore
                .write(working, new TextEncoder().encode('%PDF-1.7\nwrite derived from A\n'), {expectedDocumentRevisionToken: tokenA})
                .then(
                    () => null,
                    (error: unknown) => error,
                );
            await editedStarted.promise;

            currentFile = new File([bytesB], 'picked.pdf', {
                type: 'application/pdf',
                lastModified: 2,
            });
            lease = await browserDocumentStore.stageAppend(
                working,
                tokenA,
                async (file, base) => {
                    await file.writeAt(base, appendedTail);
                    return base + appendedTail.byteLength;
                },
                {allowForeignBase: true},
            );
            expect(lease).toEqual(expect.any(String));

            editedRelease.resolve(undefined);
            await expect(writeFailure).resolves.toMatchObject({code: 'STALE_REVISION'});

            await browserDocumentStore.commitAppend(working, tokenA, lease!);
            await expect(browserDocumentStore.read(working)).resolves.toEqual(new Uint8Array([...bytesB, ...appendedTail]));
        } finally {
            editedRelease.resolve(undefined);
            browserDocumentStore.onDirectoryEdited = async () => {};
        }
    });

    it('rejects a strict repair write queued inside doc.run before pendingAppend is set and keeps the lease usable', async () => {
        const {browserDocumentStore} = loadService();
        const bytesA = new TextEncoder().encode('%PDF-1.7\nrevision A, damaged\n');
        const working = await browserDocumentStore.createStoredDocument('damaged.pdf', bytesA, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const {token: tokenA, byteRevision} = await browserDocumentStore.readableRevision(working);

        const appendedTail = new TextEncoder().encode('\n% ordinary staged append');
        let queuedStrictFailure: Promise<unknown> | null = null;
        const lease = await browserDocumentStore.stageAppend(working, tokenA, async (file, base) => {
            // Queue the strict write while stageAppend holds doc.run and before pendingAppend is set.
            queuedStrictFailure = browserDocumentStore
                .write(working, new TextEncoder().encode('%PDF-1.7\nrepaired A\n'), {
                    expectedDocumentRevisionToken: tokenA,
                    strictRevisionToken: true,
                    ...(byteRevision === undefined ? {} : {expectedByteRevision: byteRevision}),
                })
                .then(
                    () => null,
                    (error: unknown) => error,
                );
            await file.writeAt(base, appendedTail);
            return base + appendedTail.byteLength;
        });

        expect(lease).toEqual(expect.any(String));
        expect(queuedStrictFailure).not.toBeNull();
        await expect(queuedStrictFailure!).resolves.toMatchObject({code: 'STALE_REVISION'});
        const stagedBlob = await browserDocumentStore.appendedContent(working, lease!);
        expect(new Uint8Array(await stagedBlob.arrayBuffer())).toEqual(new Uint8Array([...bytesA, ...appendedTail]));
        await browserDocumentStore.commitAppend(working, tokenA, lease!);
        await expect(browserDocumentStore.read(working)).resolves.toEqual(new Uint8Array([...bytesA, ...appendedTail]));
    });

    it('rejects validateBrowserPdfPath and analyzeBrowserPdfConformance when stageAppend materializes a changed picked file', async () => {
        const {browserDocumentStore} = loadService();
        const {analyzeBrowserPdfConformance, validateBrowserPdfPath} = await import('@app/platform/browser-api/browserPdfValidation');
        const {runBrowserQpdfCommand} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const bytesA = new TextEncoder().encode('%PDF-1.7\nrevision A\n');
        const bytesB = new TextEncoder().encode('%PDF-1.7\nchanged picked file B, longer content\n');
        const appendedTail = new TextEncoder().encode('\n% staged append on B');

        let currentFile1 = new File([bytesA], 'picked-validate.pdf', {
            type: 'application/pdf',
            lastModified: 1,
        });
        const handle1 = createFileSystemFileHandle({
            name: 'picked-validate.pdf',
            getFile: async () => currentFile1,
        });
        const picked1 = await browserDocumentStore.registerFile(currentFile1, {
            ...PDF_SOURCE_OPTIONS,
            saveHandle: handle1,
        });
        const working1 = await browserDocumentStore.cloneAsWorkingCopy(picked1);
        const token1 = (await browserDocumentStore.getDocumentRevision(working1)).token;

        const qpdfStarted = Promise.withResolvers<undefined>();
        const qpdfResult = Promise.withResolvers<{
            exitCode: number;
            stdout: string;
            stderr: string;
            output: Uint8Array | null;
        }>();
        vi.mocked(runBrowserQpdfCommand)
            .mockReset()
            .mockImplementationOnce(async () => {
                qpdfStarted.resolve(undefined);
                return qpdfResult.promise;
            });

        const validationFailure = validateBrowserPdfPath(working1).then(
            () => null,
            (error: unknown) => error,
        );
        await qpdfStarted.promise;
        currentFile1 = new File([bytesB], 'picked-validate.pdf', {
            type: 'application/pdf',
            lastModified: 2,
        });
        const lease1 = await browserDocumentStore.stageAppend(
            working1,
            token1,
            async (file, base) => {
                await file.writeAt(base, appendedTail);
                return base + appendedTail.byteLength;
            },
            {allowForeignBase: true},
        );
        expect(lease1).toEqual(expect.any(String));
        qpdfResult.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            output: null,
        });
        await expect(validationFailure).resolves.toMatchObject({code: 'STALE_REVISION'});

        let currentFile2 = new File([bytesA], 'picked-conformance.pdf', {
            type: 'application/pdf',
            lastModified: 1,
        });
        const handle2 = createFileSystemFileHandle({
            name: 'picked-conformance.pdf',
            getFile: async () => currentFile2,
        });
        const picked2 = await browserDocumentStore.registerFile(currentFile2, {
            ...PDF_SOURCE_OPTIONS,
            saveHandle: handle2,
        });
        const working2 = await browserDocumentStore.cloneAsWorkingCopy(picked2);
        const token2 = (await browserDocumentStore.getDocumentRevision(working2)).token;

        const confStarted = Promise.withResolvers<undefined>();
        const confFacts = Promise.withResolvers<{
            isSigned: boolean;
            isEncrypted: boolean;
            isTagged: boolean;
            hasAcroForm: boolean;
            hasXfa: boolean;
        }>();
        pageOpsWorkerOverride.run = async () => {
            confStarted.resolve(undefined);
            return confFacts.promise;
        };
        try {
            const conformanceFailure = analyzeBrowserPdfConformance(working2, {purpose: 'save-restrictions'}).then(
                () => null,
                (error: unknown) => error,
            );
            await confStarted.promise;
            currentFile2 = new File([bytesB], 'picked-conformance.pdf', {
                type: 'application/pdf',
                lastModified: 2,
            });
            const lease2 = await browserDocumentStore.stageAppend(
                working2,
                token2,
                async (file, base) => {
                    await file.writeAt(base, appendedTail);
                    return base + appendedTail.byteLength;
                },
                {allowForeignBase: true},
            );
            expect(lease2).toEqual(expect.any(String));
            confFacts.resolve({
                isSigned: false,
                isEncrypted: false,
                isTagged: false,
                hasAcroForm: false,
                hasXfa: false,
            });
            await expect(conformanceFailure).resolves.toMatchObject({code: 'STALE_REVISION'});
        } finally {
            pageOpsWorkerOverride.run = null;
        }
    });

    it('rejects an ordinary write derived from A when submitted after stageAppend materializes changed picked file B', async () => {
        const {browserDocumentStore} = loadService();
        const bytesA = new TextEncoder().encode('%PDF-1.7\nrevision A\n');
        const bytesB = new TextEncoder().encode('%PDF-1.7\nchanged picked file B, longer content\n');
        const appendedTail = new TextEncoder().encode('\n% staged append on B');
        let currentFile = new File([bytesA], 'post-stage.pdf', {
            type: 'application/pdf',
            lastModified: 1,
        });
        const handle = createFileSystemFileHandle({
            name: 'post-stage.pdf',
            getFile: async () => currentFile,
        });
        const picked = await browserDocumentStore.registerFile(currentFile, {
            ...PDF_SOURCE_OPTIONS,
            saveHandle: handle,
        });
        const working = await browserDocumentStore.cloneAsWorkingCopy(picked);
        const tokenA = (await browserDocumentStore.getDocumentRevision(working)).token;

        currentFile = new File([bytesB], 'post-stage.pdf', {
            type: 'application/pdf',
            lastModified: 2,
        });
        const lease = await browserDocumentStore.stageAppend(
            working,
            tokenA,
            async (file, base) => {
                await file.writeAt(base, appendedTail);
                return base + appendedTail.byteLength;
            },
            {allowForeignBase: true},
        );
        expect(lease).toEqual(expect.any(String));

        await expect(
            browserDocumentStore.write(working, new TextEncoder().encode('%PDF-1.7\nwrite derived from A\n'), {
                expectedDocumentRevisionToken: tokenA,
            }),
        ).rejects.toMatchObject({code: 'STALE_REVISION'});

        await browserDocumentStore.commitAppend(working, tokenA, lease!);
        await expect(browserDocumentStore.read(working)).resolves.toEqual(new Uint8Array([...bytesB, ...appendedTail]));
    });

    it("rejects an ordinary write paused in nameEdited after an edit and undo restore A's token while advancing byteRevision", async () => {
        const {browserDocumentStore} = loadService();
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'working-copy-undo-epoch-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const durable = {port: createNodeStorePort(root), publication: browserPublication};
        const memory = {port: createMemoryStorePort(), publication: browserPublication};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({durable, memory});
        const bytesA = new TextEncoder().encode('%PDF-1.7\nrevision A\n');
        const bytesEdit = new TextEncoder().encode('%PDF-1.7\nintermediate edit\n');
        const working = await browserDocumentStore.createStoredDocument('undo-epoch.pdf', bytesA, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const tokenA = (await browserDocumentStore.getDocumentRevision(working)).token;

        const editedStarted = Promise.withResolvers<undefined>();
        const editedRelease = Promise.withResolvers<undefined>();
        let pausedFirst = false;
        browserDocumentStore.onDirectoryEdited = async () => {
            if (!pausedFirst) {
                pausedFirst = true;
                editedStarted.resolve(undefined);
                await editedRelease.promise;
            }
        };

        try {
            const firstWrite = browserDocumentStore
                .write(working, new TextEncoder().encode('%PDF-1.7\nwrite derived from first A\n'), {expectedDocumentRevisionToken: tokenA})
                .then(
                    () => null,
                    (error: unknown) => error,
                );
            await editedStarted.promise;

            const edited = await browserDocumentStore.write(working, bytesEdit, {expectedDocumentRevisionToken: tokenA});
            expect(edited).toBe(true);
            const tokenEdit = (await browserDocumentStore.getDocumentRevision(working)).token;
            expect(tokenEdit).not.toBe(tokenA);

            await browserDocumentStore.restoreRevision(working, tokenA, tokenEdit);
            expect((await browserDocumentStore.getDocumentRevision(working)).token).toBe(tokenA);

            editedRelease.resolve(undefined);
            await expect(firstWrite).resolves.toMatchObject({code: 'STALE_REVISION'});
            await expect(browserDocumentStore.read(working)).resolves.toEqual(bytesA);
        } finally {
            editedRelease.resolve(undefined);
            browserDocumentStore.onDirectoryEdited = async () => {};
        }
    });

    it('rejects a strict write resumed in nameEdited after release and lock acquisition in another store', async () => {
        const {browserDocumentStore} = loadService();
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'working-copy-owner-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const durable = {port: createNodeStorePort(root), publication: browserPublication};
        const memory = {port: createMemoryStorePort(), publication: browserPublication};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({durable, memory});
        const secondStore = new BrowserDocumentStore();
        vi.spyOn(secondStore, 'stores').mockResolvedValue({durable, memory});

        const bytesA = new TextEncoder().encode('%PDF-1.7\nowner revision A\n');
        const working = await browserDocumentStore.createStoredDocument('owner-handoff.pdf', bytesA, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const {token: tokenA, byteRevision} = await browserDocumentStore.readableRevision(working);

        const editedStarted = Promise.withResolvers<undefined>();
        const editedRelease = Promise.withResolvers<undefined>();
        browserDocumentStore.onDirectoryEdited = async () => {
            editedStarted.resolve(undefined);
            await editedRelease.promise;
        };

        try {
            const staleWrite = browserDocumentStore
                .write(working, new TextEncoder().encode('%PDF-1.7\nstale repair\n'), {
                    expectedDocumentRevisionToken: tokenA,
                    strictRevisionToken: true,
                    ...(byteRevision === undefined ? {} : {expectedByteRevision: byteRevision}),
                })
                .then(
                    () => null,
                    (error: unknown) => error,
                );
            await editedStarted.promise;

            await browserDocumentStore.release(working);
            await expect(secondStore.getDocumentRevision(working)).resolves.toMatchObject({contentRevision: 1});
            await expect(secondStore.read(working)).resolves.toEqual(bytesA);

            editedRelease.resolve(undefined);
            await expect(staleWrite).resolves.toMatchObject({code: 'STALE_REVISION'});
            await expect(secondStore.getDocumentRevision(working)).resolves.toMatchObject({contentRevision: 1});
            await expect(secondStore.read(working)).resolves.toEqual(bytesA);
        } finally {
            editedRelease.resolve(undefined);
            browserDocumentStore.onDirectoryEdited = async () => {};
            await secondStore.release(working);
        }
    });

    it('rejects validateBrowserPdfPath and analyzeBrowserPdfConformance after release and reopen of the same ref exposes changed picked file B', async () => {
        const {browserDocumentStore} = loadService();
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'working-copy-reopen-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const durable = {port: createNodeStorePort(root), publication: browserPublication};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({
            durable,
            memory: {port: createMemoryStorePort(), publication: browserPublication},
        });
        const {analyzeBrowserPdfConformance, validateBrowserPdfPath} = await import('@app/platform/browser-api/browserPdfValidation');
        const {runBrowserQpdfCommand} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const bytesA = new TextEncoder().encode('%PDF-1.7\npicked A\n');
        const bytesB = new TextEncoder().encode('%PDF-1.7\nreplaced picked B\n');

        let currentFile = new File([bytesA], 'reopened-picked.pdf', {
            type: 'application/pdf',
            lastModified: 1,
        });
        const handle = createFileSystemFileHandle({
            name: 'reopened-picked.pdf',
            getFile: async () => currentFile,
        });
        const picked = await browserDocumentStore.registerFile(currentFile, {
            ...PDF_SOURCE_OPTIONS,
            saveHandle: handle,
        });
        const working = await browserDocumentStore.cloneAsWorkingCopy(picked);
        const tokenA = (await browserDocumentStore.getDocumentRevision(working)).token;

        const qpdfStarted = Promise.withResolvers<undefined>();
        const qpdfResult = Promise.withResolvers<{
            exitCode: number;
            stdout: string;
            stderr: string;
            output: Uint8Array | null;
        }>();
        vi.mocked(runBrowserQpdfCommand)
            .mockReset()
            .mockImplementationOnce(async () => {
                qpdfStarted.resolve(undefined);
                return qpdfResult.promise;
            });

        const validationFailure = validateBrowserPdfPath(working).then(
            () => null,
            (error: unknown) => error,
        );
        await qpdfStarted.promise;

        await browserDocumentStore.release(working);
        currentFile = new File([bytesB], 'reopened-picked.pdf', {
            type: 'application/pdf',
            lastModified: 2,
        });
        browserDocumentStore.nameSource(working, picked);
        await expect(browserDocumentStore.getDocumentRevision(working)).resolves.toMatchObject({token: tokenA});
        await expect(browserDocumentStore.read(working)).resolves.toEqual(bytesB);

        qpdfResult.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            output: null,
        });
        await expect(validationFailure).resolves.toMatchObject({code: 'STALE_REVISION'});

        const confStarted = Promise.withResolvers<undefined>();
        const confFacts = Promise.withResolvers<{
            isSigned: boolean;
            isEncrypted: boolean;
            isTagged: boolean;
            hasAcroForm: boolean;
            hasXfa: boolean;
        }>();
        pageOpsWorkerOverride.run = async () => {
            confStarted.resolve(undefined);
            return confFacts.promise;
        };
        try {
            const conformanceFailure = analyzeBrowserPdfConformance(working, {purpose: 'save-restrictions'}).then(
                () => null,
                (error: unknown) => error,
            );
            await confStarted.promise;

            await browserDocumentStore.release(working);
            currentFile = new File([bytesA], 'reopened-picked.pdf', {
                type: 'application/pdf',
                lastModified: 3,
            });
            browserDocumentStore.nameSource(working, picked);
            await expect(browserDocumentStore.getDocumentRevision(working)).resolves.toMatchObject({token: tokenA});
            await expect(browserDocumentStore.read(working)).resolves.toEqual(bytesA);

            confFacts.resolve({
                isSigned: false,
                isEncrypted: false,
                isTagged: false,
                hasAcroForm: false,
                hasXfa: false,
            });
            await expect(conformanceFailure).resolves.toMatchObject({code: 'STALE_REVISION'});
        } finally {
            pageOpsWorkerOverride.run = null;
        }
    });

    it('rejects save({commit}) and stageAppend after release and lock handoff without mutating the second store', async () => {
        const {browserDocumentStore} = loadService();
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'working-copy-save-handoff-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const basePort = createNodeStorePort(root);
        let pauseWriteAtomic: {started: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined>} | null = null;
        const durablePort: typeof basePort = {
            ...basePort,
            async writeAtomic(path, bytes) {
                if (pauseWriteAtomic && path.endsWith('/manifest.json')) {
                    const paused = pauseWriteAtomic;
                    pauseWriteAtomic = null;
                    await basePort.writeAtomic(path, bytes);
                    paused.started.resolve(undefined);
                    await paused.release.promise;
                    return;
                }
                await basePort.writeAtomic(path, bytes);
            },
        };
        const durable = {port: durablePort, publication: browserPublication};
        const memory = {port: createMemoryStorePort(), publication: browserPublication};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({durable, memory});
        const secondStore = new BrowserDocumentStore();
        vi.spyOn(secondStore, 'stores').mockResolvedValue({durable, memory});

        const bytesA = new TextEncoder().encode('%PDF-1.7\nsave handoff A\n');
        const appendedTail = new TextEncoder().encode('%appended-tail\n');
        const working = await browserDocumentStore.createStoredDocument('save-handoff.pdf', bytesA, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const tokenA = (await browserDocumentStore.getDocumentRevision(working)).token;
        const lease = await browserDocumentStore.stageAppend(working, tokenA, async (file, base) => {
            await file.writeAt(base, appendedTail);
            return base + appendedTail.byteLength;
        });
        expect(lease).toEqual(expect.any(String));

        pauseWriteAtomic = {
            started: Promise.withResolvers<undefined>(),
            release: Promise.withResolvers<undefined>(),
        };
        const pausedCommit = pauseWriteAtomic;
        const staleSave = browserDocumentStore.save(working, tokenA, {commit: lease!}).then(
            () => null,
            (error: unknown) => error,
        );
        await pausedCommit.started.promise;

        const releasing = browserDocumentStore.release(working);
        pausedCommit.release.resolve(undefined);
        await releasing;

        // A second store takes over the directory and owns it exclusively.
        const secondBytes = await secondStore.read(working);
        expect(secondBytes).toEqual(new Uint8Array([...bytesA, ...appendedTail]));
        await expect(staleSave).resolves.toMatchObject({code: 'STALE_REVISION'});
        await secondStore.release(working);

        // Also verify restoreRevision paused in nameEdited rejects cleanly after release or byteRevision advance.
        const undoWorking = await browserDocumentStore.createStoredDocument('restore-guard.pdf', bytesA, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'working',
        });
        const token1 = (await browserDocumentStore.getDocumentRevision(undoWorking)).token;
        await browserDocumentStore.write(undoWorking, new TextEncoder().encode('%PDF-1.7\nedit B\n'), {
            expectedDocumentRevisionToken: token1,
        });
        const token2 = (await browserDocumentStore.getDocumentRevision(undoWorking)).token;

        const editedStarted = Promise.withResolvers<undefined>();
        const editedRelease = Promise.withResolvers<undefined>();
        browserDocumentStore.onDirectoryEdited = async () => {
            editedStarted.resolve(undefined);
            await editedRelease.promise;
        };
        try {
            const staleRestore = browserDocumentStore.restoreRevision(undoWorking, token1, token2).then(
                () => null,
                (error: unknown) => error,
            );
            await editedStarted.promise;
            await browserDocumentStore.release(undoWorking);
            editedRelease.resolve(undefined);
            await expect(staleRestore).resolves.toMatchObject({code: 'STALE_REVISION'});
        } finally {
            editedRelease.resolve(undefined);
            browserDocumentStore.onDirectoryEdited = async () => {};
        }
    });
});

// The Chrome extension's viewer page downloads the document it was launched with straight into the store.
describe('Chrome extension launch', () => {
    const DOCUMENT_URL = 'https://papers.example/download?id=7';
    const CHUNK_SIZES = [1, 700, 65_536, 300_000, 7, 131_072];

    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        vi.stubGlobal('document', {cookie: ''});
        serviceState.store = new BrowserDocumentStore();
        normalizeAppendBaseRun.mockReset();
        normalizeAppendBaseRun.mockResolvedValue({verdict: 'appendable', output: null, stderr: ''});
        const viewerUrl = new URL(createBrowserExtensionViewerUrl('chrome-extension://evb-viewer-test/', DOCUMENT_URL));
        vi.stubGlobal('location', viewerUrl);
        const history = {state: null as unknown, replaceState: (state: unknown) => void (history.state = state)};
        vi.stubGlobal('history', history);
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await closeStoreDocuments();
    });

    // A document-sized deep equality would compare element by element.
    const sameBytes = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(Buffer.from(right));

    /**
     * The durable store on disk, recording each write into a document's revision file and how much was written. As
     * the origin private file system does, it refuses to remove a directory while a file in it is open. `failManifest`
     * makes the next manifest write report failure after it replaced the manifest, as a failed flush does;
     * `failRevisionOpen` refuses to open the next revision file, before the store reads anything into it.
     */
    async function recordingStore() {
        const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'extension-launch-'));
        onTestFinished(() => rm(root, {recursive: true, force: true}));
        const port = createNodeStorePort(root);
        const writes: number[] = [];
        const opened = new Map<string, number>();
        let manifestFault = false;
        let revisionOpenFault = false;
        const open = port.open.bind(port);
        const recorded = {
            ...port,
            open: async (path: string) => {
                if (revisionOpenFault && /\/r\d+\.pdf$/u.test(path)) {
                    revisionOpenFault = false;
                    throw new DOMException('The revision file could not be opened', 'NoModificationAllowedError');
                }
                const file = await open(path);
                opened.set(path, (opened.get(path) ?? 0) + 1);
                const close = async () => {
                    await file.close();
                    opened.set(path, opened.get(path)! - 1);
                };
                if (!/\/r\d+\.pdf$/u.test(path)) {
                    return {...file, close};
                }
                return {
                    ...file,
                    close,
                    writeAt: async (offset: number, bytes: Uint8Array) => {
                        await file.writeAt(offset, bytes);
                        writes.push(bytes.byteLength);
                    },
                };
            },
            remove: async (path: string) => {
                if ([...opened].some(([file, count]) => count > 0 && (file === path || file.startsWith(`${path}/`)))) {
                    throw new DOMException('A file in it is open', 'NoModificationAllowedError');
                }
                await port.remove(path);
            },
            writeAtomic: async (path: string, bytes: Uint8Array) => {
                await port.writeAtomic(path, bytes);
                if (manifestFault && path.endsWith('/manifest.json')) {
                    manifestFault = false;
                    throw new DOMException('The manifest could not be flushed', 'InvalidStateError');
                }
            },
        };
        const durable = {port: recorded, publication: browserPublication};
        vi.spyOn(serviceState.store!, 'stores').mockResolvedValue({
            durable,
            memory: {port: createMemoryStorePort(), publication: browserPublication},
        });
        const manifests = async () =>
            (
                await Promise.all(
                    (await port.list('documents')).map(async (id) => (await port.list(`documents/${id}`)).includes('manifest.json')),
                )
            ).filter(Boolean).length;
        return {
            writes,
            written: () => writes.reduce((total, size) => total + size, 0),
            manifests,
            documents: () => port.list('documents'),
            failManifest: () => void (manifestFault = true),
            failRevisionOpen: () => void (revisionOpenFault = true),
        };
    }

    /** A response body served in uneven network chunks as the reader asks for them; `fail` errors it at that offset. */
    function servedBody(bytes: Uint8Array, written: () => number, fail?: number) {
        let offset = 0;
        let chunk = 0;
        let mostHeld = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            pull(controller) {
                mostHeld = Math.max(mostHeld, offset - written());
                if (fail !== undefined && offset >= fail) {
                    controller.error(new TypeError('network error'));
                    return;
                }
                if (offset === bytes.byteLength) {
                    controller.close();
                    return;
                }
                const size = CHUNK_SIZES[chunk++ % CHUNK_SIZES.length]!;
                controller.enqueue(bytes.slice(offset, offset + size));
                offset = Math.min(bytes.byteLength, offset + size);
            },
        });
        return {body, mostHeld: () => mostHeld, cancelled: () => cancelled};
    }

    function serve(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, status = 200) {
        const fetchMock = vi.fn(async () => new Response(body, {headers, status}));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    function chromeRuntime() {
        const sendMessage = vi.fn(async () => true);
        vi.stubGlobal('chrome', {runtime: {sendMessage}});
        return sendMessage;
    }

    it('streams a downloaded PDF into the store byte for byte, holding one batch of it at a time, and opens it from its file', async () => {
        const {BROWSER_DOCUMENT_CHUNK_SIZE} = await import('@app/platform/browserDocumentStore');
        const {openBrowserExtensionDocument} = await import('@app/platform/browser-api/openBrowserExtensionDocument');
        const store = await recordingStore();
        const pdf = new TextEncoder().encode(`%PDF-1.7\n${'0123456789'.repeat(950_000)}\n%%EOF\n`);
        const served = servedBody(pdf, store.written);
        const fetchMock = serve(served.body, {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="report.pdf"',
        });
        const sendMessage = chromeRuntime();

        await openBrowserExtensionDocument();

        expect(fetchMock).toHaveBeenCalledWith(DOCUMENT_URL, {credentials: 'include'});
        expect(sendMessage).not.toHaveBeenCalled();
        const ref = (history.state as {evbExtensionDocument: string}).evbExtensionDocument;
        const entry = await serviceState.store!.requireEntry(ref);
        expect(entry).toMatchObject({kind: 'source', fileName: 'report.pdf', mimeType: 'application/pdf'});
        expect(sameBytes(await serviceState.store!.read(ref, {maxBytes: pdf.byteLength}), pdf)).toBe(true);
        expect(entry.doc!.state()).toMatchObject({dirty: false});
        // Batches of at most one store chunk, and no more than about one batch held beyond what reached the store.
        expect(store.writes).toHaveLength(Math.ceil(pdf.byteLength / BROWSER_DOCUMENT_CHUNK_SIZE));
        expect(Math.max(...store.writes)).toBeLessThanOrEqual(BROWSER_DOCUMENT_CHUNK_SIZE);
        expect(served.mostHeld()).toBeLessThanOrEqual(BROWSER_DOCUMENT_CHUNK_SIZE + 2 * Math.max(...CHUNK_SIZES));

        // Opening it as the workspace does hands the append admission the stored file, not bytes read into the window.
        const read = vi.spyOn(serviceState.store!, 'read');
        const {openDocumentPaths} = await loadService();
        const opened = await openDocumentPaths([ref]);
        expect(opened).toMatchObject({kind: 'pdf'});
        expect(read).not.toHaveBeenCalled();
        const [input] = normalizeAppendBaseRun.mock.calls[0]! as [unknown];
        expect(input).toBeInstanceOf(Blob);
        expect(sameBytes(new Uint8Array(await (input as Blob).arrayBuffer()), pdf)).toBe(true);
    });

    it('hands Chrome a response that is not a document, or one whose download fails part way, and keeps nothing of it', async () => {
        const {openBrowserExtensionDocument} = await import('@app/platform/browser-api/openBrowserExtensionDocument');
        const store = await recordingStore();
        const sendMessage = chromeRuntime();
        serve(servedBody(new TextEncoder().encode('<!doctype html><title>Sign in</title>'), store.written).body, {
            'content-type': 'application/pdf',
        });
        await openBrowserExtensionDocument();
        expect(sendMessage).toHaveBeenLastCalledWith({type: expect.any(String), url: DOCUMENT_URL});

        // The connection drops after the first batch of it reached the store.
        const pdf = new TextEncoder().encode(`%PDF-1.7\n${'0123456789'.repeat(600_000)}`);
        serve(servedBody(pdf, store.written, 5_000_000).body, {'content-type': 'application/pdf'});
        await openBrowserExtensionDocument();
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(history.state).toBeNull();
        expect(await store.manifests()).toBe(0);
        // Nor its directory.
        expect(store.writes).toHaveLength(1);
        expect(await store.documents()).toEqual([]);

        // The whole document arrives, and its first manifest replaces the old one but reports failure.
        store.failManifest();
        serve(servedBody(pdf, store.written).body, {'content-type': 'application/pdf'});
        await openBrowserExtensionDocument();
        expect(sendMessage).toHaveBeenCalledTimes(3);
        expect(history.state).toBeNull();
        expect(store.writes.length).toBeGreaterThan(1);
        // Neither its revision file, nor its manifest, nor its directory.
        expect(await store.manifests()).toBe(0);
        expect(await store.documents()).toEqual([]);
        expect(serviceState.store!.openEntries()).toEqual([]);
    });

    it('stops the download of a document the store refuses before reading any of it, and hands Chrome its URL', async () => {
        const {openBrowserExtensionDocument} = await import('@app/platform/browser-api/openBrowserExtensionDocument');
        const store = await recordingStore();
        const sendMessage = chromeRuntime();
        const served = servedBody(new TextEncoder().encode(`%PDF-1.7\n${'0123456789'.repeat(100_000)}`), store.written);
        serve(served.body, {'content-type': 'application/pdf'});
        store.failRevisionOpen();

        await openBrowserExtensionDocument();

        expect(sendMessage).toHaveBeenCalledExactlyOnceWith({type: expect.any(String), url: DOCUMENT_URL});
        expect(served.cancelled()).toBe(true);
        expect(history.state).toBeNull();
        expect(store.writes).toEqual([]);
        expect(await store.documents()).toEqual([]);
    });

    // A part of a PDF: 206 with or without its range, a range on a 200, a 416 naming the whole length; and an error page.
    it.each([
        {status: 206, headers: {'content-range': 'bytes 0-4095/10000'}},
        {status: 206, headers: {}},
        {status: 200, headers: {'content-range': 'bytes 0-4095/10000'}},
        {status: 416, headers: {'content-range': 'bytes */10000'}},
        {status: 500, headers: {}},
    ])('hands Chrome a $status response to a PDF, stops its download and keeps nothing of it ($headers)', async ({status, headers}) => {
        const {openBrowserExtensionDocument} = await import('@app/platform/browser-api/openBrowserExtensionDocument');
        const store = await recordingStore();
        const sendMessage = chromeRuntime();
        const range = new TextEncoder().encode(`%PDF-1.7\n${'0'.repeat(4086)}`);
        const served = servedBody(range, store.written);
        serve(served.body, {'content-type': 'application/pdf', ...headers}, status);
        await openBrowserExtensionDocument();
        expect(sendMessage).toHaveBeenCalledExactlyOnceWith({type: expect.any(String), url: DOCUMENT_URL});
        expect(served.cancelled()).toBe(true);
        expect(history.state).toBeNull();
        expect(store.writes).toEqual([]);
        expect(await store.documents()).toEqual([]);
    });
});
