import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA} from '@contracts/documentOpenErrors';
import type {IPdfValidationResult} from '@contracts/pdfConformance';
import {findSerializableErrorEnvelope, SERIALIZABLE_ERROR_ENVELOPE_SCHEMA} from '@contracts/serializableError';

const loggerMock = vi.hoisted(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
}));

const VALID_PDF: IPdfValidationResult = {
    isValid: true,
    tool: 'qpdf',
    errors: [],
    warnings: [],
};

vi.mock('electron', () => ({
    app: {getPath: vi.fn(() => tempRoot)},
    webContents: {fromId: vi.fn(() => undefined)},
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => loggerMock}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({
    validatePdfFile: vi.fn(async () => VALID_PDF),
    validatePdfFileForSave: vi.fn(async () => VALID_PDF),
}));
vi.mock('@electron/features/documents/public/pdfSaveAsOptimization', () => ({
    optimizePdfForSaveAs: vi.fn(async () => null),
}));
vi.mock('@electron/features/documents/main/pdfSaveAsOptimization', () => ({
    optimizeLargePdfForOrdinarySave: vi.fn(async () => VALID_PDF),
    optimizePdfForSave: vi.fn(async () => VALID_PDF),
}));
vi.mock('@electron/pdf/pdfAppendBase', () => ({
    rewritePdfWithQpdf: vi.fn(async (sourcePath: string, outputPath: string) => {
        await copyFile(sourcePath, outputPath);
    }),
    normalizePdfAppendBase: vi.fn(async () => undefined),
    pdfNeedsAppendBaseRewrite: vi.fn(async () => false),
}));
vi.mock('@electron/recentFiles', () => ({
    addRecentFile: vi.fn(async () => undefined),
}));
vi.mock('@electron/menu', () => ({
    updateRecentFilesMenu: vi.fn(),
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: vi.fn(),
}));

const store = await import('@electron/file-access/documentStore');
const {handleFileSaveStructured, handleOptimizePdfForInteraction, handleRepairPdfSave, toDocumentSaveResult} =
    await import('@electron/features/documents/main/workingCopySave');
const {savePdfAs} = await import('@electron/features/documents/main/documentSave.service');
const {handleCreateWorkingCopyFromPath} = await import('@electron/features/documents/main/documentWorkingCopyHandlers');
const {addRecentFile} = await import('@electron/recentFiles');
const {handleCommitStagedPdfNativeMutations} = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');
const {createOpaqueNativePdfStagedArtifact} = await import('@electron/features/documents/main/managedTempFileHandles');
const {getAppTempDirPath} = await import('@electron/utils/appTempDir');
const {resetPathValidatorCachesForTests} = await import('@electron/utils/pathValidator');

const ORIGINAL = new TextEncoder().encode('%PDF-1.7\noriginal bytes\n%%EOF\n');
const EDITED = new TextEncoder().encode('%PDF-1.7\nedited bytes\n%%EOF\n');

let tempRoot = '';
let testStoreRoot = '';

beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'evb-working-copy-save-'));
    testStoreRoot = join(getAppTempDirPath(), `working-copy-save-${randomUUID()}`);
    await mkdir(testStoreRoot, {recursive: true});
    resetPathValidatorCachesForTests();
    await store.setDocumentStoreRootForTests(testStoreRoot);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await store.setDocumentStoreRootForTests(null);
    resetPathValidatorCachesForTests();
    await rm(testStoreRoot, {recursive: true, force: true});
    await rm(tempRoot, {recursive: true, force: true});
});

describe('workingCopySave publication facts', () => {
    it('preserves externalWriteCommitted=true, pendingPublish, and refresh-failed warning when final manifest acknowledgement fails', async () => {
        const pdfPath = join(tempRoot, 'paper.pdf');
        await writeFile(pdfPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(pdfPath, {ownerWebContentsId: 42});
        const editedPath = join(tempRoot, 'edited.pdf');
        await writeFile(editedPath, EDITED);
        await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: editedPath}, 'write');

        const docStore = store.getDocumentStore();
        const realWriteAtomic = docStore.port.writeAtomic.bind(docStore.port);
        let sawStagedPendingPublish = false;
        let injectedAckFailure = false;
        vi.spyOn(docStore.port, 'writeAtomic').mockImplementation(async (target, bytes) => {
            if (target.endsWith('manifest.json')) {
                const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {pendingPublish?: {witness?: string}};
                if (parsed.pendingPublish?.witness !== undefined) {
                    sawStagedPendingPublish = true;
                } else if (sawStagedPendingPublish && !injectedAckFailure) {
                    injectedAckFailure = true;
                    throw new Error('ENOSPC: manifest acknowledgement failed');
                }
            }
            return realWriteAtomic(target, bytes);
        });

        const result = await handleFileSaveStructured({senderId: 42}, entry.ref, {
            expectedDocumentRevisionToken: store.documentRevisionToken(entry),
        });

        expect(injectedAckFailure).toBe(true);
        expect(result).toEqual({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: false,
            documentRevision: expect.objectContaining({token: store.documentRevisionToken(entry)}),
            validation: VALID_PDF,
            warning: {
                reason: 'refresh-failed',
                message: 'ENOSPC: manifest acknowledgement failed',
            },
        });
        expect(await readFile(pdfPath)).toEqual(Buffer.from(EDITED));
        expect(entry.doc.snapshot().pendingPublish).toMatchObject({
            destination: pdfPath,
            witness: expect.any(String),
        });
    });

    it('reports externalWriteCommitted=null and preserves pendingPublish when publish fails after staging completes', async () => {
        const pdfPath = join(tempRoot, 'unverified.pdf');
        await writeFile(pdfPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(pdfPath, {ownerWebContentsId: 42});
        const editedPath = join(tempRoot, 'edited.pdf');
        await writeFile(editedPath, EDITED);
        await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: editedPath}, 'write');

        const docStore = store.getDocumentStore();
        vi.spyOn(docStore.publication, 'publish').mockImplementation(async (_destination, _source, _expected, stage) => {
            await stage('file-v2:staged-witness');
            throw new Error('EIO: destination rename outcome unknown');
        });

        const result = await handleFileSaveStructured({senderId: 42}, entry.ref, {
            expectedDocumentRevisionToken: store.documentRevisionToken(entry),
        });

        expect(result).toEqual({
            ok: false,
            reason: 'write-failed',
            message: 'EIO: destination rename outcome unknown',
            externalWriteCommitted: null,
            validation: null,
        });
        expect(entry.doc.snapshot().pendingPublish).toMatchObject({
            destination: pdfPath,
            witness: 'file-v2:staged-witness',
        });
    });

    it('reports externalWriteCommitted=false and preserves EACCES write-refusal explanation when publish fails before staging', async () => {
        const pdfPath = join(tempRoot, 'denied.pdf');
        await writeFile(pdfPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(pdfPath, {ownerWebContentsId: 42});
        const editedPath = join(tempRoot, 'edited.pdf');
        await writeFile(editedPath, EDITED);
        await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: editedPath}, 'write');

        const docStore = store.getDocumentStore();
        vi.spyOn(docStore.publication, 'publish').mockRejectedValueOnce(
            Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'}),
        );

        const result = await handleFileSaveStructured({senderId: 42}, entry.ref, {
            expectedDocumentRevisionToken: store.documentRevisionToken(entry),
        });

        expect(result).toEqual({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('EACCES: permission denied'),
            externalWriteCommitted: false,
            validation: null,
        });
        expect(entry.doc.snapshot().pendingPublish).toBeUndefined();
    });

    it('keeps externalWriteCommitted=true on toDocumentSaveResult when keptOriginal accompanies an unacknowledged save', async () => {
        const pdfPath = join(tempRoot, 'kept.pdf');
        await writeFile(pdfPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(pdfPath, {ownerWebContentsId: 42});

        const mapped = toDocumentSaveResult(
            entry,
            {
                status: 'saved',
                revision: null,
                keptOriginal: join(tempRoot, 'kept (original).pdf'),
                externalWriteCommitted: true,
                acknowledgmentError: new Error('manifest write failed'),
            },
            VALID_PDF,
        );

        expect(mapped).toEqual({
            ok: false,
            reason: 'original-changed',
            keptFilePath: join(tempRoot, 'kept (original).pdf'),
            externalWriteCommitted: true,
            validation: VALID_PDF,
        });
    });

    it('preserves original-changed and keptFilePath when conflict manifest cleanup fails', async () => {
        const pdfPath = join(tempRoot, 'conflict-kept.pdf');
        const keptPath = join(tempRoot, 'conflict-kept (original).pdf');
        await writeFile(pdfPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(pdfPath, {ownerWebContentsId: 42});
        const editedPath = join(tempRoot, 'edited.pdf');
        await writeFile(editedPath, EDITED);
        await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: editedPath}, 'write');

        const docStore = store.getDocumentStore();
        const realWriteAtomic = docStore.port.writeAtomic.bind(docStore.port);
        let failCleanup = false;
        vi.spyOn(docStore.port, 'writeAtomic').mockImplementation(async (target, bytes) => {
            if (failCleanup && target.endsWith('manifest.json')) {
                failCleanup = false;
                throw new Error('ENOSPC: conflict cleanup failed');
            }
            return realWriteAtomic(target, bytes);
        });
        vi.spyOn(docStore.publication, 'publish').mockImplementation(async (_destination, _source, _expected, stage) => {
            await stage('file-v2:staged-conflict');
            failCleanup = true;
            return {status: 'conflict', keptOriginal: keptPath};
        });

        const result = await handleFileSaveStructured({senderId: 42}, entry.ref, {
            expectedDocumentRevisionToken: store.documentRevisionToken(entry),
        });

        expect(result).toEqual({
            ok: false,
            reason: 'original-changed',
            keptFilePath: keptPath,
            externalWriteCommitted: false,
            validation: null,
        });
        expect(entry.doc.snapshot().pendingPublish).toMatchObject({
            destination: pdfPath,
            witness: 'file-v2:staged-conflict',
        });
    });

    it('serializes externalWriteCommitted=true across IPC when desktop Save As writes copy.pdf but manifest acknowledgement fails', async () => {
        const originalPath = join(tempRoot, 'original.pdf');
        const copyPath = join(tempRoot, 'copy.pdf');
        await writeFile(originalPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(originalPath, {ownerWebContentsId: 42});
        const editedPath = join(tempRoot, 'edited.pdf');
        await writeFile(editedPath, EDITED);
        await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: editedPath}, 'write');

        const docStore = store.getDocumentStore();
        const realWriteAtomic = docStore.port.writeAtomic.bind(docStore.port);
        let sawStagedPending = false;
        let injected = false;
        vi.spyOn(docStore.port, 'writeAtomic').mockImplementation(async (target, bytes) => {
            if (target.endsWith('manifest.json')) {
                const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {pendingPublish?: {witness?: string}};
                if (parsed.pendingPublish?.witness !== undefined) {
                    sawStagedPending = true;
                } else if (sawStagedPending && !injected) {
                    injected = true;
                    throw new Error('ENOSPC: Save As manifest ack failed');
                }
            }
            return realWriteAtomic(target, bytes);
        });

        let caught: unknown;
        try {
            await savePdfAs({senderId: 42, sender: {} as never, parentWindow: null}, entry.ref, undefined, async () => copyPath, {
                expectedDocumentRevisionToken: store.documentRevisionToken(entry),
            });
        } catch (error) {
            caught = error;
        }
        expect(injected).toBe(true);
        expect(await readFile(copyPath)).toEqual(Buffer.from(EDITED));
        expect(entry.originalPath).toBe(originalPath);
        const envelope = findSerializableErrorEnvelope(caught, SERIALIZABLE_ERROR_ENVELOPE_SCHEMA);
        expect(envelope).toMatchObject({
            code: 'save-publication-outcome',
            message: expect.stringContaining('Saved copy "copy.pdf" was written, but document adoption failed'),
            details: {externalWriteCommitted: true},
        });
    });

    it('returns externalWriteCommitted=null in native commit result when post-staging EIO occurs', async () => {
        const pdfPath = join(tempRoot, 'staged-native.pdf');
        await writeFile(pdfPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(pdfPath, {ownerWebContentsId: 42});
        const stagedPath = await store.prepareDocumentAppend(entry);
        await writeFile(stagedPath, EDITED);
        const artifact = await createOpaqueNativePdfStagedArtifact({senderId: 42}, stagedPath, {
            qpdfCheck: true,
            qpdfResult: VALID_PDF,
            tailCheck: true,
            semanticCheck: false,
            fsynced: true,
        });

        const docStore = store.getDocumentStore();
        vi.spyOn(docStore.publication, 'publish').mockImplementation(async (_destination, _source, _expected, stage) => {
            await stage('file-v2:native-staged');
            throw new Error('EIO: rename outcome unknown');
        });

        const result = await handleCommitStagedPdfNativeMutations({senderId: 42}, entry.ref, artifact, {
            expectedDocumentRevisionToken: store.documentRevisionToken(entry),
        });

        expect(result).toEqual({
            applied: false,
            validation: null,
            externalWriteCommitted: null,
            error: {
                code: 'io',
                message: 'EIO: rename outcome unknown',
            },
        });
    });

    it('still returns the saved Save As destination when addRecentFile fails with ENOSPC after commit', async () => {
        const originalPath = join(tempRoot, 'recent-orig.pdf');
        const copyPath = join(tempRoot, 'recent-copy.pdf');
        await writeFile(originalPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(originalPath, {ownerWebContentsId: 42});
        const editedPath = join(tempRoot, 'recent-edited.pdf');
        await writeFile(editedPath, EDITED);
        await store.commitDocumentMutation(entry, store.documentRevisionToken(entry), {kind: 'rewrite', source: editedPath}, 'write');

        vi.mocked(addRecentFile).mockRejectedValueOnce(new Error('ENOSPC: recent files write failed'));

        const savedRef = await savePdfAs(
            {senderId: 42, sender: {} as never, parentWindow: null},
            entry.ref,
            undefined,
            async () => copyPath,
            {expectedDocumentRevisionToken: store.documentRevisionToken(entry)},
        );

        expect(savedRef).toBe(copyPath);
        expect(await readFile(copyPath)).toEqual(Buffer.from(EDITED));
        expect(entry.originalPath).toBe(copyPath);
        expect(loggerMock.warn).toHaveBeenCalledWith(
            'Save As succeeded, but updating recent files failed',
            expect.objectContaining({targetPath: copyPath}),
        );
    });

    it.each([
        ['repair', handleRepairPdfSave],
        ['optimize', handleOptimizePdfForInteraction],
    ] as const)('serializes externalWriteCommitted=null across IPC on post-staging EIO during desktop %s', async (_label, handler) => {
        const pdfPath = join(tempRoot, `rewrite-${_label}.pdf`);
        await writeFile(pdfPath, ORIGINAL);
        const entry = await store.openDocumentFromFile(pdfPath, {ownerWebContentsId: 42});

        const docStore = store.getDocumentStore();
        vi.spyOn(docStore.publication, 'publish').mockImplementation(async (_destination, _source, _expected, stage) => {
            await stage('file-v2:rewrite-staged');
            throw new Error('EIO: post-staging rewrite failure');
        });

        let caught: unknown;
        try {
            await handler({senderId: 42}, entry.ref, {expectedDocumentRevisionToken: store.documentRevisionToken(entry)});
        } catch (error) {
            caught = error;
        }
        const envelope = findSerializableErrorEnvelope(caught, SERIALIZABLE_ERROR_ENVELOPE_SCHEMA);
        expect(envelope).toMatchObject({
            code: 'save-publication-outcome',
            details: {externalWriteCommitted: null},
        });
    });

    it('encodes structured not-found refusal across IPC when a desktop PDF disappears before openDocumentFromFile stat', async () => {
        const missingPath = join(tempRoot, 'vanished.pdf');
        let caught: unknown;
        try {
            await handleCreateWorkingCopyFromPath({senderId: 42}, missingPath as never);
        } catch (error) {
            caught = error;
        }
        const envelope = findSerializableErrorEnvelope(caught, DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA);
        expect(envelope).toEqual({
            code: 'not-found',
            message: 'not-found',
            fileName: 'vanished.pdf',
        });
    });
});
